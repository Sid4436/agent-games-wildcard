/**
 * Agent HTTP server.
 *
 * Routes:
 *   GET  /health  -> {"status":"ok"} (must answer in < 3s; it is instant)
 *   POST /agent   -> signed task endpoint (preflight, gatekeeper, steal-the-vfy)
 *
 * Protocol rules enforced here (https://agentgames.zkverify.io/build):
 * - HMAC is verified against the RAW body BEFORE task envelopes are acted
 *   on. The preflight handshake is the exception: it carries no task, so it
 *   is answered (signed when the platform secret is configured) without
 *   requiring a request signature.
 * - Every response is signed with x-agent-games-signature over the raw body.
 * - 60s hard deadline: if the work cannot finish before deadline_at, the
 *   agent fails closed (REJECT / HOLD) instead of timing out.
 * - task_id / (matchId, turn) are idempotency keys: retries return the
 *   stored response.
 * - Secrets are never logged.
 *
 * Demo mode: if AGENT_GAMES_HMAC_SECRET is not set, HMAC verification is
 * skipped and responses are unsigned. A loud warning is logged on every
 * request. NEVER deploy demo mode.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { signBody, verifySignature } from "./hmac.js";
import {
  decideGatekeeper,
  decideVfyMove,
  gatekeeperCircuitInput,
  DEFAULT_STRATEGY_PARAMS,
  type GatekeeperTaskInput,
  type VfyState,
} from "./decision.js";
import {
  proveGatekeeper,
  proveVfyPolicy,
  registeredVkHash,
  VfyPolicyBlockedError,
  type Groth16Proof,
} from "./prover.js";
import { computePublicInputsHash, stringToField } from "./encoding.js";
import type { AgentConfig } from "./config.js";
import type { SubmissionProvider, SubmissionReceipt } from "./submission.js";

const MAX_BODY_BYTES = 1_000_000;

export interface AgentServer {
  listen(): Promise<void>;
  close(): Promise<void>;
  readonly port: number;
}

interface StoredResponse {
  status: number;
  body: string;
}

export function createAgentServer(
  config: AgentConfig,
  provider: SubmissionProvider,
): AgentServer {
  const seenProofs = new Set<string>();
  const idempotency = new Map<string, StoredResponse>();
  const seenPath = path.join(config.dataDir, "seen-proofs.json");
  let seenLoaded = false;

  async function loadSeen(): Promise<void> {
    if (seenLoaded) return;
    seenLoaded = true;
    try {
      const raw = await readFile(seenPath, "utf8");
      const list = JSON.parse(raw) as string[];
      for (const item of list) seenProofs.add(item);
    } catch {
      // No persisted file yet — start empty.
    }
  }

  async function persistSeen(): Promise<void> {
    try {
      await mkdir(config.dataDir, { recursive: true });
      await writeFile(seenPath, JSON.stringify([...seenProofs], null, 2));
    } catch (error) {
      console.error("[agent] failed to persist seen proofs:", error);
    }
  }

  function log(...args: unknown[]): void {
    console.log("[agent]", ...args);
  }

  function send(
    res: ServerResponse,
    status: number,
    bodyObj: Record<string, unknown>,
    idempotencyKey?: string,
  ): void {
    const body = JSON.stringify(bodyObj);
    if (config.hmacSecret) {
      res.setHeader("x-agent-games-signature", signBody(config.hmacSecret, body));
    }
    res.writeHead(status, { "content-type": "application/json" });
    res.end(body);
    if (idempotencyKey) idempotency.set(idempotencyKey, { status, body });
  }

  function readRawBody(req: IncomingMessage): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      req.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          reject(new Error("request body too large"));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", () => resolve(Buffer.concat(chunks)));
      req.on("error", reject);
    });
  }

  function msUntil(deadlineAt: string | undefined): number {
    if (!deadlineAt) return 60_000;
    const ms = new Date(deadlineAt).getTime() - Date.now();
    return Number.isFinite(ms) ? ms : 60_000;
  }

  async function handleGatekeeper(
    envelope: Record<string, any>,
    res: ServerResponse,
  ): Promise<void> {
    const taskId = String(envelope.task_id ?? "");
    const input = envelope.input as GatekeeperTaskInput;
    const deadlineMs = msUntil(envelope.deadline_at);
    if (!taskId || !input) {
      send(res, 400, { error: "missing task_id or input" });
      return;
    }
    const cached = idempotency.get(`gk:${taskId}`);
    if (cached) {
      log(`gatekeeper ${taskId}: replaying stored response (idempotent retry)`);
      res.writeHead(cached.status, { "content-type": "application/json" });
      res.end(cached.body);
      return;
    }
    const verdict = decideGatekeeper(input, (tx) => seenProofs.has(tx));
    log(`gatekeeper ${taskId}: ${verdict.decision} (${verdict.reason_code})`);

    let proof: Groth16Proof | undefined;
    let publicSignals: string[] | undefined;
    let receipt: SubmissionReceipt | undefined;

    // PROOF_REUSED tasks have no proof to submit (event page: excluded from
    // the reliability bonus). All other verdicts carry a proof.
    if (verdict.reason_code !== "PROOF_REUSED") {
      if (deadlineMs < 10_000) {
        // Not enough time to prove (~2s) and answer — fail closed.
        log(`gatekeeper ${taskId}: deadline too close (${deadlineMs}ms), failing closed`);
        send(res, 200, {
          decision: "REJECT",
          reason_code: "TIMEOUT",
          proof_tx: input.proof_tx,
        });
        return;
      }
      const circuitInput = gatekeeperCircuitInput(
        taskId,
        input,
        verdict,
        config.gatekeeperSalt,
      );
      try {
        const result = await proveGatekeeper(config.rootDir, circuitInput);
        proof = result.proof;
        publicSignals = result.publicSignals;
        log(`gatekeeper ${taskId}: proof generated in ${result.proveMs}ms`);
        // Submit with a budget that leaves 5s to answer before the deadline.
        const budgetMs = Math.max(1_000, deadlineMs - 5_000);
        receipt = await withTimeout(
          provider.submit(
            "gatekeeper",
            proof,
            publicSignals,
            registeredVkHash("gatekeeper"),
          ),
          budgetMs,
        ).catch((error) => ({
          status: "Failed" as const,
          detail: `submission timed out or failed: ${error instanceof Error ? error.message : String(error)}`,
        }));
        log(`gatekeeper ${taskId}: submission ${receipt.status} — ${receipt.detail}`);
      } catch (error) {
        // Proof generation failed: the decision stands, but without a valid
        // proof the platform scores -2 for the missing proof. Log loudly.
        log(`gatekeeper ${taskId}: PROOF GENERATION FAILED:`, error);
      }
    }

    if (verdict.decision === "APPROVE") {
      seenProofs.add(input.proof_tx);
      await persistSeen();
    }
    send(res, 200, {
      decision: verdict.decision,
      reason_code: verdict.reason_code,
      proof_tx: input.proof_tx,
      ...(proof && publicSignals
        ? { proof, public_signals: publicSignals }
        : {}),
      ...(receipt?.proofReference ? { proofReference: receipt.proofReference } : {}),
    }, `gk:${taskId}`);
  }

  async function handleVfyTurn(
    envelope: Record<string, any>,
    res: ServerResponse,
  ): Promise<void> {
    const matchId = String(envelope.matchId ?? "");
    const turn = Number(envelope.turn ?? 0);
    const state = envelope.state as VfyState;
    const commitment = envelope.strategyCommitment?.hash as string | undefined;
    if (!matchId || !state || !commitment) {
      send(res, 400, { error: "missing matchId, state, or strategyCommitment" });
      return;
    }
    const key = `vfy:${matchId}:${turn}`;
    const cached = idempotency.get(key);
    if (cached) {
      log(`vfy ${matchId} turn ${turn}: replaying stored response`);
      res.writeHead(cached.status, { "content-type": "application/json" });
      res.end(cached.body);
      return;
    }
    const move = decideVfyMove(state, turn, DEFAULT_STRATEGY_PARAMS);
    const actionCode = { HOLD: 0, FORTIFY: 1, EXTRACT: 2 }[move.action] as 0 | 1 | 2;
    const amount = move.action === "EXTRACT" ? (move.amount ?? 5) : 0;
    const publicInputsHash = computePublicInputsHash({
      commitment,
      matchId,
      turn,
      selfBalance: Number(state.selfBalance),
      opponentBalance: Number(state.opponentBalance),
      action: move.action,
      amount,
      circuitVersion: 1,
    });
    log(`vfy ${matchId} turn ${turn}: ${move.action}${move.action === "EXTRACT" ? ` ${amount}` : ""}`);

    let proof: Groth16Proof | undefined;
    let publicSignals: string[] | undefined;
    // matchId is a UUID in production; encode it as the field element the
    // platform uses (UUID dashes removed, hex -> integer). Fall back to a
    // string hash for non-UUID ids (tests / demos).
    let matchIdField: string;
    try {
      matchIdField = String(BigInt(`0x${matchId.replace(/-/g, "")}`));
    } catch {
      matchIdField = stringToField(matchId);
    }
    try {
      const result = await proveVfyPolicy(config.rootDir, {
        commitment,
        matchId: matchIdField,
        turnNumber: String(turn),
        selfBalance: String(state.selfBalance),
        opponentBalance: String(state.opponentBalance),
        action: String(actionCode),
        amount: String(amount),
        circuitVersion: "1",
        strategyParams: DEFAULT_STRATEGY_PARAMS.map(String),
        salt: config.gatekeeperSalt,
      });
      proof = result.proof;
      publicSignals = result.publicSignals;
      log(`vfy ${matchId} turn ${turn}: policy proof generated in ${result.proveMs}ms`);
    } catch (error) {
      if (error instanceof VfyPolicyBlockedError) {
        // Documented blocker: the official vfy-policy circuit's strategy
        // semantics are unpublished, so no proof can be produced yet. The
        // platform resolves a proof-less turn as HOLD (-2). Return the
        // decided action with the computable audit fields and no proof.
        log(`vfy ${matchId} turn ${turn}: policy proof BLOCKED — ${error.message}`);
      } else {
        throw error;
      }
    }

    const response: Record<string, unknown> = {
      matchId,
      turn,
      action:
        move.action === "EXTRACT"
          ? { type: "EXTRACT", amount }
          : { type: move.action },
      policyProof: {
        circuitVersion: "v1",
        ...(proof && publicSignals ? { proof, public_signals: publicSignals } : {}),
        publicInputsHash,
      },
      agentTimestamp: new Date().toISOString(),
      idempotencyKey: `${matchId}-${turn}`,
    };
    send(res, 200, response, key);
  }

  const server = createServer(async (req, res) => {
    try {
      await loadSeen();
      if (req.method === "GET" && req.url === "/health") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ status: "ok" }));
        return;
      }
      if (req.method === "GET" && req.url === "/agent") {
        // Preflight handshake: the platform probes the endpoint (GET) before
        // accepting it. Answer signed protocol-v1 JSON (signed when the
        // platform secret is configured; the platform requires a signature).
        send(res, 200, { ok: true, protocolVersion: "v1" });
        if (!config.hmacSecret) {
          log("WARNING: preflight served unsigned (no AGENT_GAMES_HMAC_SECRET) — the platform requires a signed response");
        }
        return;
      }
      if (req.method !== "POST" || req.url !== "/agent") {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "not found" }));
        return;
      }
      const rawBody = await readRawBody(req);
      // Lenient preflight: the platform may probe with an empty body, {},
      // {"type":"preflight"}, or the full "agent-games.preflight.v1"
      // envelope. Answer those with signed protocol-v1 JSON without
      // requiring a request signature (the handshake carries no task;
      // authenticity is proven by the signed response).
      let envelope: Record<string, any>;
      try {
        envelope = rawBody.length === 0 ? {} : JSON.parse(rawBody.toString("utf8"));
      } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "invalid JSON" }));
        return;
      }
      const envelopeType =
        typeof envelope.type === "string" ? envelope.type : "";
      if (
        Object.keys(envelope).length === 0 ||
        envelopeType === "preflight" ||
        envelopeType === "agent-games.preflight.v1" ||
        envelopeType.toLowerCase().includes("preflight")
      ) {
        log(`preflight from ${envelope.agent_id ?? "unknown agent"}`);
        send(res, 200, { ok: true, protocolVersion: "v1" });
        if (!config.hmacSecret) {
          log("WARNING: preflight served unsigned (no AGENT_GAMES_HMAC_SECRET) — the platform requires a signed response");
        }
        return;
      }
      const signature = req.headers["x-agent-games-signature"] as string | undefined;
      if (config.hmacSecret) {
        if (!verifySignature(config.hmacSecret, rawBody, signature)) {
          log("rejected request: bad or missing HMAC signature");
          res.writeHead(401, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "invalid signature" }));
          return;
        }
      } else {
        log("WARNING: running in DEMO mode (no AGENT_GAMES_HMAC_SECRET) — HMAC verification skipped");
      }
      if (envelope.type === "agent-games.proof-gatekeeper.v1") {
        await handleGatekeeper(envelope, res);
        return;
      }
      if (envelope.eventId === "steal-the-vfy") {
        await handleVfyTurn(envelope, res);
        return;
      }
      send(res, 400, { error: "unknown task type" });
    } catch (error) {
      console.error("[agent] handler error:", error);
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "internal error" }));
      }
    }
  });

  let boundPort = config.port;

  return {
    get port() {
      return boundPort;
    },
    listen() {
      return new Promise<void>((resolve) => {
        server.listen(config.port, config.host, () => {
          const addr = server.address();
          if (addr && typeof addr === "object") boundPort = addr.port;
          log(
            `listening on ${config.host}:${boundPort} ` +
              `(provider=${provider.name}, hmac=${config.hmacSecret ? "configured" : "DEMO MODE"})`,
          );
          resolve();
        });
      });
    },
    close() {
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new Error("timed out")), ms);
  });
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    timeout,
  ]) as Promise<T>;
}
