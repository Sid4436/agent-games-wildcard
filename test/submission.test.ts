/**
 * Submission provider tests.
 * - Offline: verifies a real gatekeeper proof locally (no network).
 * - Kurier: exercises the submit + poll-to-Finalized flow against a stubbed
 *   fetch (no real network, no real API key).
 */
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findRootDir } from "../src/config.js";
import {
  decideGatekeeper,
  gatekeeperCircuitInput,
  type GatekeeperTaskInput,
} from "../src/decision.js";
import { proveGatekeeper, registeredVkHash } from "../src/prover.js";
import {
  KurierSubmissionProvider,
  OfflineSubmissionProvider,
} from "../src/submission.js";

const rootDir = findRootDir(path.dirname(fileURLToPath(import.meta.url)));

const VK_A =
  "0x7d3a11aa22bb33cc44dd55ee66ff77889900aabbccddeeff00112233445566778899";
const ADDR = "0xDe42000000000000000000000000000000009f01";

async function makeProof() {
  const input: GatekeeperTaskInput = {
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
    proof_tx: "0xproof1",
  };
  const verdict = decideGatekeeper(input, () => false);
  const { proof, publicSignals } = await proveGatekeeper(
    rootDir,
    gatekeeperCircuitInput("gk_24_9d1", input, verdict, "0"),
  );
  return { proof, publicSignals };
}

test("offline provider verifies a real proof locally", async () => {
  const { proof, publicSignals } = await makeProof();
  const provider = new OfflineSubmissionProvider(rootDir);
  const receipt = await provider.submit(
    "gatekeeper",
    proof,
    publicSignals,
    registeredVkHash("gatekeeper"),
  );
  assert.equal(receipt.status, "VerifiedLocally");
});

test("offline provider rejects a tampered proof", async () => {
  const { proof, publicSignals } = await makeProof();
  const tampered = { ...proof, pi_a: ["1", "2", "3"] as [string, string, string] };
  const provider = new OfflineSubmissionProvider(rootDir);
  const receipt = await provider.submit(
    "gatekeeper",
    tampered,
    publicSignals,
    registeredVkHash("gatekeeper"),
  );
  assert.equal(receipt.status, "Failed");
});

test("kurier provider polls job-status until Finalized (stubbed fetch)", async () => {
  const { proof, publicSignals } = await makeProof();
  const calls: string[] = [];
  const realFetch = globalThis.fetch;
  let polls = 0;
  globalThis.fetch = (async (url: unknown) => {
    const u = String(url);
    calls.push(u);
    if (u.includes("/submit-proof/")) {
      return new Response(JSON.stringify({ jobId: "job-123", optimisticVerify: "success" }), { status: 200 });
    }
    polls += 1;
    const status = polls >= 2 ? "Finalized" : "IncludedInBlock";
    return new Response(
      JSON.stringify({ status, jobId: "job-123", txHash: "0xdeadbeef" }),
      { status: 200 },
    );
  }) as typeof fetch;
  try {
    const provider = new KurierSubmissionProvider("test-key", "testnet", 10, 5000);
    const receipt = await provider.submit(
      "gatekeeper",
      proof,
      publicSignals,
      registeredVkHash("gatekeeper"),
    );
    assert.equal(receipt.status, "Finalized");
    assert.equal(receipt.jobId, "job-123");
    assert.equal(receipt.proofReference, "0xdeadbeef");
    assert.ok(calls.some((c) => c.includes("/submit-proof/test-key")));
    assert.ok(calls.some((c) => c.includes("/job-status/test-key/job-123")));
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("kurier provider reports a failed submit cleanly (stubbed fetch)", async () => {
  const { proof, publicSignals } = await makeProof();
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response("unauthorized", { status: 401 })) as typeof fetch;
  try {
    const provider = new KurierSubmissionProvider("bad-key", "testnet", 10, 1000);
    const receipt = await provider.submit(
      "gatekeeper",
      proof,
      publicSignals,
      registeredVkHash("gatekeeper"),
    );
    assert.equal(receipt.status, "Failed");
    assert.match(receipt.detail, /401/);
  } finally {
    globalThis.fetch = realFetch;
  }
});
