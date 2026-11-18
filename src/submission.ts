/**
 * Proof submission providers.
 *
 * Two providers, one interface. The agent never talks to the chain directly
 * in the default configuration.
 *
 * - OfflineSubmissionProvider (default): verifies the proof locally against
 *   the exported verification key and stores the evidence on disk. Nothing
 *   leaves the machine. Use for the demo, practice, and judging.
 * - KurierSubmissionProvider: submits the proof to zkVerify via Kurier REST
 *   (docs: https://docs.zkverify.io/overview/getting-started/kurier) and
 *   polls `GET /job-status/{apiKey}/{jobId}` every 5s until the job reaches
 *   "Finalized". Requires a Kurier API key (signup: https://kurier.xyz for
 *   mainnet, https://testnet.kurier.xyz for testnet). The Kurier docs page
 *   lists no price; check pricing on the signup page before use.
 *
 * zkVerifyJS (direct chain interaction) is the documented alternative:
 * it needs a funded Volta session/account, so it is NOT wired in by default.
 * See zkverifyjs.md for how to swap it in.
 */
import { kurierApiUrl } from "./config.js";
import type { Groth16Proof } from "./prover.js";
import { verifyGatekeeperProof, verifyVfyPolicyProof } from "./prover.js";

export type SubmissionStatus =
  | "Finalized"
  | "IncludedInBlock"
  | "Submitted"
  | "VerifiedLocally"
  | "Failed";

export interface SubmissionReceipt {
  status: SubmissionStatus;
  /** Kurier job id, when submitted via Kurier. */
  jobId?: string;
  /** On-chain / Kurier reference, when available. */
  proofReference?: string;
  /** Human-readable detail (status text, error, or local note). */
  detail: string;
}

export interface SubmissionProvider {
  readonly name: string;
  submit(
    circuit: "gatekeeper" | "vfy-policy",
    proof: Groth16Proof,
    publicSignals: string[],
    vkHash: string,
  ): Promise<SubmissionReceipt>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Default provider: local verification only, evidence stored on disk. */
export class OfflineSubmissionProvider implements SubmissionProvider {
  readonly name = "offline";
  constructor(private readonly rootDir: string) {}

  async submit(
    circuit: "gatekeeper" | "vfy-policy",
    proof: Groth16Proof,
    publicSignals: string[],
    _vkHash: string,
  ): Promise<SubmissionReceipt> {
    const ok =
      circuit === "gatekeeper"
        ? await verifyGatekeeperProof(this.rootDir, publicSignals, proof)
        : await verifyVfyPolicyProof(this.rootDir, publicSignals, proof);
    return {
      status: ok ? "VerifiedLocally" : "Failed",
      detail: ok
        ? `proof verified locally against the official ${circuit} verification key (offline mode — nothing submitted on-chain)`
        : `LOCAL VERIFICATION FAILED for ${circuit} proof — not submitted`,
    };
  }
}

/** Kurier REST provider (docs.zkverify.io/overview/getting-started/kurier). */
export class KurierSubmissionProvider implements SubmissionProvider {
  readonly name = "kurier";
  constructor(
    private readonly apiKey: string,
    private readonly network: "mainnet" | "testnet",
    private readonly pollIntervalMs = 5000,
    private readonly pollTimeoutMs = 120_000,
  ) {}

  private get baseUrl(): string {
    return kurierApiUrl(this.network);
  }

  async submit(
    circuit: "gatekeeper" | "vfy-policy",
    proof: Groth16Proof,
    publicSignals: string[],
    vkHash: string,
  ): Promise<SubmissionReceipt> {
    const submitRes = await fetch(
      `${this.baseUrl}/submit-proof/${this.apiKey}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          proofType: "groth16",
          vkRegistered: true,
          proofOptions: { library: "snarkjs", curve: "bn128" },
          proofData: { proof, publicSignals, vk: vkHash },
        }),
      },
    );
    if (!submitRes.ok) {
      const text = await submitRes.text().catch(() => "");
      return {
        status: "Failed",
        detail: `Kurier submit failed: HTTP ${submitRes.status} ${text.slice(0, 200)}`,
      };
    }
    const submitted = (await submitRes.json()) as {
      jobId?: string;
      optimisticVerify?: string;
    };
    const jobId = submitted.jobId;
    if (!jobId) {
      return {
        status: "Failed",
        detail: `Kurier accepted the proof but returned no jobId: ${JSON.stringify(submitted).slice(0, 200)}`,
      };
    }
    if (submitted.optimisticVerify && submitted.optimisticVerify !== "success") {
      return {
        status: "Failed",
        jobId,
        detail: `Kurier optimistic verification failed: ${submitted.optimisticVerify}`,
      };
    }
    // Poll job-status until Finalized (docs: GET /job-status/{apiKey}/{jobId}).
    const deadline = Date.now() + this.pollTimeoutMs;
    for (;;) {
      const statusRes = await fetch(
        `${this.baseUrl}/job-status/${this.apiKey}/${jobId}`,
      );
      if (!statusRes.ok) {
        return {
          status: "Failed",
          jobId,
          detail: `Kurier job-status failed: HTTP ${statusRes.status}`,
        };
      }
      const statusBody = (await statusRes.json()) as {
        status?: string;
        aggregationId?: string;
        txHash?: string;
      };
      const status = statusBody.status ?? "";
      if (status === "Finalized") {
        return {
          status: "Finalized",
          jobId,
          proofReference: statusBody.txHash ?? statusBody.aggregationId,
          detail: `proof finalized on zkVerify (job ${jobId})`,
        };
      }
      if (status === "Failed" || status === "Rejected") {
        return {
          status: "Failed",
          jobId,
          detail: `Kurier job ${jobId} ended with status ${status}`,
        };
      }
      if (Date.now() > deadline) {
        return {
          status: "IncludedInBlock",
          jobId,
          detail: `poll timed out after ${this.pollTimeoutMs}ms; last status was ${status || "unknown"} (job ${jobId})`,
        };
      }
      await sleep(this.pollIntervalMs);
    }
  }
}
