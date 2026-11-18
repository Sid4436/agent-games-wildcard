/**
 * End-to-end prover tests with the REAL official circuits.
 *
 * - Gatekeeper: generates a real Groth16 proof with the downloaded
 *   artifacts and verifies it against the exported verification key
 *   (valid case + trap case), and asserts a wrong decision cannot be proven.
 * - vfy-policy: asserts the documented blocker — the official circuit's
 *   internal assert rejects the derived inputs (VfyPolicyBlockedError).
 *   This test documents the current state; it must be updated (to a
 *   successful proof) once the strategy semantics are known.
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
import {
  proveGatekeeper,
  proveVfyPolicy,
  verifyGatekeeperProof,
  VfyPolicyBlockedError,
} from "../src/prover.js";
import {
  demoPolicyCommitment,
  proveDemoPolicy,
  verifyDemoPolicyProof,
} from "../src/demo-policy.js";

const rootDir = findRootDir(path.dirname(fileURLToPath(import.meta.url)));

const VK_A =
  "0x7d3a11aa22bb33cc44dd55ee66ff77889900aabbccddeeff00112233445566778899";
const VK_B =
  "0xa4c1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f";
const ADDR = "0xDe42000000000000000000000000000000009f01";

function validInput(over: Partial<GatekeeperTaskInput> = {}): GatekeeperTaskInput {
  return {
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
    ...over,
  };
}

test("e2e: real gatekeeper proof for a valid condition verifies", async () => {
  const input = validInput();
  const verdict = decideGatekeeper(input, () => false);
  assert.equal(verdict.decision, "APPROVE");
  const circuitInput = gatekeeperCircuitInput("gk_24_9d1", input, verdict, "0");
  const { proof, publicSignals, proveMs } = await proveGatekeeper(rootDir, circuitInput);
  console.log(`    gatekeeper proof generated in ${proveMs}ms`);
  assert.equal(publicSignals.length, 13, "13 public signals (1 output + 12 inputs)");
  assert.equal(publicSignals[11], "1", "decision public signal is 1 (APPROVE)");
  const ok = await verifyGatekeeperProof(rootDir, publicSignals, proof);
  assert.equal(ok, true, "proof must verify against the official verification key");
});

test("e2e: real gatekeeper proof for a VK-substitution trap verifies", async () => {
  const input = validInput({ proof_vk: VK_B });
  const verdict = decideGatekeeper(input, () => false);
  assert.equal(verdict.decision, "REJECT");
  const circuitInput = gatekeeperCircuitInput("gk_trap_demo", input, verdict, "0");
  const { proof, publicSignals, proveMs } = await proveGatekeeper(rootDir, circuitInput);
  console.log(`    trap proof generated in ${proveMs}ms`);
  assert.equal(publicSignals[11], "0", "decision public signal is 0 (REJECT)");
  const ok = await verifyGatekeeperProof(rootDir, publicSignals, proof);
  assert.equal(ok, true);
});

test("e2e: a wrong decision cannot be proven (circuit is the referee)", async () => {
  const input = validInput();
  const verdict = decideGatekeeper(input, () => false);
  // Flip the decision: valid condition, but claim REJECT.
  const wrong = { ...verdict, decision: "REJECT" as const, decisionField: "0" as const };
  const circuitInput = gatekeeperCircuitInput("gk_wrong", input, wrong, "0");
  await assert.rejects(
    () => proveGatekeeper(rootDir, circuitInput),
    /Assert Failed/,
    "witness generation must fail for a wrong decision",
  );
});

test("e2e: vfy-policy proof is blocked with the documented error", async () => {
  await assert.rejects(
    () =>
      proveVfyPolicy(rootDir, {
        commitment: "0",
        matchId: "1",
        turnNumber: "3",
        selfBalance: "95",
        opponentBalance: "105",
        action: "0",
        amount: "0",
        circuitVersion: "1",
        strategyParams: ["0", "0", "0", "0", "0", "0", "0", "0"],
        salt: "0",
      }),
    (error: unknown) => error instanceof VfyPolicyBlockedError,
    "must throw the documented VfyPolicyBlockedError, not a generic error",
  );
});

test("e2e: demo policy circuit proves EXTRACT and verifies", async () => {
  const params = ["60", "40", "5", "17", "10", "2", "0", "0"];
  const commitment = await demoPolicyCommitment(params, 0);
  const { proof, publicSignals, proveMs } = await proveDemoPolicy(rootDir, {
    commitment,
    matchId: "1",
    turnNumber: "3",
    selfBalance: "95",
    opponentBalance: "105",
    action: "2",
    amount: "5",
    circuitVersion: "1",
    strategyParams: params,
    salt: "0",
  });
  console.log(`    demo policy proof generated in ${proveMs}ms`);
  assert.equal(publicSignals.length, 9, "9 public signals (1 output + 8 inputs)");
  assert.equal(publicSignals[6], "2", "action public signal is 2 (EXTRACT)");
  assert.equal(publicSignals[7], "5", "amount public signal is 5");
  const ok = await verifyDemoPolicyProof(rootDir, publicSignals, proof);
  assert.equal(ok, true, "demo proof must verify against the demo verification key");
});

test("e2e: demo policy circuit rejects a wrong action", async () => {
  const params = ["60", "40", "5", "17", "10", "2", "0", "0"];
  const commitment = await demoPolicyCommitment(params, 0);
  await assert.rejects(
    () =>
      proveDemoPolicy(rootDir, {
        commitment,
        matchId: "1",
        turnNumber: "3",
        selfBalance: "95",
        opponentBalance: "105",
        action: "0", // HOLD, but the strategy says EXTRACT
        amount: "0",
        circuitVersion: "1",
        strategyParams: params,
        salt: "0",
      }),
    /Assert Failed/,
    "witness generation must fail for a wrong action",
  );
});
