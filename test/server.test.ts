/**
 * Server integration tests: health, preflight, HMAC enforcement, gatekeeper
 * task handling (with a real proof), idempotent retries, and the vfy turn
 * path (proof blocked -> HOLD without proof).
 *
 * Servers run on ephemeral ports with a scratch DATA_DIR. Demo mode (no
 * HMAC secret) and live mode (HMAC secret set) are both covered.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, findRootDir, type AgentConfig } from "../src/config.js";
import { createAgentServer, type AgentServer } from "../src/server.js";
import { OfflineSubmissionProvider } from "../src/submission.js";
import { signBody } from "../src/hmac.js";

const rootDir = findRootDir(path.dirname(fileURLToPath(import.meta.url)));
const SECRET = "test-hmac-secret-32-bytes!!";

const VK_A =
  "0x7d3a11aa22bb33cc44dd55ee66ff77889900aabbccddeeff00112233445566778899";
const ADDR = "0xDe42000000000000000000000000000000009f01";

function gatekeeperEnvelope(taskId = "gk_test_1") {
  return {
    type: "agent-games.proof-gatekeeper.v1",
    task_id: taskId,
    mode: "competition",
    issued_at: new Date().toISOString(),
    deadline_at: new Date(Date.now() + 60_000).toISOString(),
    input: {
      registered_vk: VK_A,
      proof_vk: VK_A,
      minimum: "1000",
      public_balance: "1460",
      expiry_block: 19842201,
      current_block: 19832000,
      recipient: ADDR,
      condition_recipient: ADDR,
      amount: "500",
      max_transfer: "1000",
      proof_tx: "0xproof-test-1",
    },
  };
}

async function withServer(
  overrides: Partial<AgentConfig>,
  fn: (base: string, server: AgentServer) => Promise<void>,
): Promise<void> {
  const dataDir = await mkdtemp(path.join(tmpdir(), "agent-games-test-"));
  const config: AgentConfig = {
    ...loadConfig(),
    rootDir,
    port: 0,
    host: "127.0.0.1",
    dataDir,
    ...overrides,
  };
  const server = createAgentServer(config, new OfflineSubmissionProvider(rootDir));
  await server.listen();
  const base = `http://127.0.0.1:${server.port}`;
  try {
    await fn(base, server);
  } finally {
    await server.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

async function postAgent(
  base: string,
  body: unknown,
  secret?: string,
): Promise<{ status: number; json: Record<string, any>; headers: Headers }> {
  const raw = JSON.stringify(body);
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (secret) headers["x-agent-games-signature"] = signBody(secret, raw);
  const res = await fetch(`${base}/agent`, { method: "POST", headers, body: raw });
  return { status: res.status, json: (await res.json()) as Record<string, any>, headers: res.headers };
}

test("GET /health returns ok (demo mode)", async () => {
  await withServer({ hmacSecret: undefined }, async (base) => {
    const res = await fetch(`${base}/health`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { status: "ok" });
  });
});

test("preflight succeeds and the response is signed (live mode)", async () => {
  await withServer({ hmacSecret: SECRET }, async (base) => {
    const body = { type: "agent-games.preflight.v1", agent_id: "agt_test", issued_at: new Date().toISOString(), nonce: "abc123" };
    const { status, json, headers } = await postAgent(base, body, SECRET);
    assert.equal(status, 200);
    assert.deepEqual(json, { ok: true, protocolVersion: "v1" });
    const sig = headers.get("x-agent-games-signature");
    assert.ok(sig, "response must carry x-agent-games-signature");
    assert.equal(sig, signBody(SECRET, JSON.stringify(json)));
  });
});

test("unsigned request is rejected in live mode", async () => {
  await withServer({ hmacSecret: SECRET }, async (base) => {
    const { status, json } = await postAgent(base, gatekeeperEnvelope());
    assert.equal(status, 401);
    assert.equal(json.error, "invalid signature");
  });
});

test("tampered signature is rejected in live mode", async () => {
  await withServer({ hmacSecret: SECRET }, async (base) => {
    const raw = JSON.stringify(gatekeeperEnvelope());
    const res = await fetch(`${base}/agent`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-agent-games-signature": signBody("wrong-secret", raw),
      },
      body: raw,
    });
    assert.equal(res.status, 401);
  });
});

test("gatekeeper task returns APPROVE with a real proof (live mode)", async () => {
  await withServer({ hmacSecret: SECRET }, async (base) => {
    const { status, json, headers } = await postAgent(base, gatekeeperEnvelope(), SECRET);
    assert.equal(status, 200);
    assert.equal(json.decision, "APPROVE");
    assert.equal(json.reason_code, "VALID_CONDITION");
    assert.ok(json.proof, "response must include the Groth16 proof");
    assert.ok(Array.isArray(json.public_signals), "response must include public_signals");
    assert.equal(json.public_signals.length, 13);
    assert.equal(json.proof.protocol, "groth16");
    assert.equal(json.proof.curve, "bn128");
    assert.ok(headers.get("x-agent-games-signature"), "response must be signed");
  });
});

test("gatekeeper task is idempotent on retry (same task_id)", async () => {
  await withServer({ hmacSecret: SECRET }, async (base) => {
    const first = await postAgent(base, gatekeeperEnvelope("gk_retry"), SECRET);
    const second = await postAgent(base, gatekeeperEnvelope("gk_retry"), SECRET);
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.deepEqual(second.json, first.json);
  });
});

test("gatekeeper trap task returns REJECT with reason (demo mode)", async () => {
  await withServer({ hmacSecret: undefined }, async (base) => {
    const trap = gatekeeperEnvelope("gk_trap");
    trap.input.proof_vk =
      "0xa4c1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f";
    const { status, json } = await postAgent(base, trap);
    assert.equal(status, 200);
    assert.equal(json.decision, "REJECT");
    assert.equal(json.reason_code, "VK_SUBSTITUTION");
    assert.ok(json.proof, "rejects still carry a proof (except PROOF_REUSED)");
  });
});

test("vfy turn returns the decided action without a proof (blocked circuit)", async () => {
  await withServer({ hmacSecret: undefined }, async (base) => {
    const turn = {
      protocolVersion: "v1",
      eventId: "steal-the-vfy",
      mode: "competition",
      matchId: "9f4e1b2a-5c6d-7e8f-90a1-b2c3d4e5f6a7",
      turn: 3,
      issuedAt: new Date().toISOString(),
      deadlineAt: new Date(Date.now() + 300_000).toISOString(),
      state: {
        selfBalance: "95",
        opponentBalance: "105",
        selfFortifiedUntilTurn: null,
        opponentFortifiedUntilTurn: null,
      },
      strategyCommitment: { hash: "0x7d3a11aa22bb33cc44dd55ee66ff77889900aabbccddeeff0011223344556677" },
      resolverVersion: "v1",
      nonce: "3c2f1a",
    };
    const { status, json } = await postAgent(base, turn);
    assert.equal(status, 200);
    assert.equal(json.matchId, turn.matchId);
    assert.equal(json.turn, 3);
    assert.equal(json.action.type, "EXTRACT");
    assert.equal(json.action.amount, 5);
    assert.equal(json.policyProof.circuitVersion, "v1");
    assert.ok(json.policyProof.publicInputsHash, "audit hash must be present");
    assert.equal(json.policyProof.proof, undefined, "no proof while the official circuit is blocked");
    assert.equal(json.idempotencyKey, `${turn.matchId}-3`);
  });
});

test("unknown task type returns 400", async () => {
  await withServer({ hmacSecret: undefined }, async (base) => {
    const { status } = await postAgent(base, { type: "agent-games.nope.v1" });
    assert.equal(status, 400);
  });
});
