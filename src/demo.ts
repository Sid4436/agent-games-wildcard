/**
 * Offline demo: the whole agent loop with NO keys, NO network, NO secrets.
 *
 *   npm run demo
 *
 * 1. Loads the sample gatekeeper task (demo/sample-task.json — the valid
 *    condition from the event page).
 * 2. Decides APPROVE with the deterministic rule set.
 * 3. Generates a REAL Groth16 proof with the official gatekeeper circuit
 *    (circuits/gatekeeper.wasm + .zkey) and verifies it locally against the
 *    official verification key.
 * 4. Replays a VK-substitution trap and shows the REJECT + proof.
 * 5. Shows the Steal-the-VFY move + publicInputsHash, and the documented
 *    vfy-policy blocker (official circuit proof cannot be produced yet).
 *
 * Expected output: two verified proofs and the timings. Exit code 0 means
 * the loop works; anything else is a failure.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findRootDir } from "./config.js";
import {
  decideGatekeeper,
  decideVfyMove,
  gatekeeperCircuitInput,
  DEFAULT_STRATEGY_PARAMS,
  type GatekeeperTaskInput,
} from "./decision.js";
import { computePublicInputsHash } from "./encoding.js";
import {
  proveGatekeeper,
  proveVfyPolicy,
  verifyGatekeeperProof,
  VfyPolicyBlockedError,
} from "./prover.js";
import { OfflineSubmissionProvider } from "./submission.js";
import { registeredVkHash } from "./prover.js";
import {
  demoPolicyCommitment,
  proveDemoPolicy,
  verifyDemoPolicyProof,
} from "./demo-policy.js";

const rootDir = findRootDir(path.dirname(fileURLToPath(import.meta.url)));

async function main(): Promise<void> {
  console.log("=== Agent Games Wildcard — offline demo ===\n");

  // --- 1. Valid gatekeeper task -----------------------------------------
  const sample = JSON.parse(
    await readFile(path.join(rootDir, "demo", "sample-task.json"), "utf8"),
  ) as { task_id: string; input: GatekeeperTaskInput };
  const verdict = decideGatekeeper(sample.input, () => false);
  console.log(`task ${sample.task_id}: decision=${verdict.decision} (${verdict.reason_code})`);
  if (verdict.decision !== "APPROVE") {
    throw new Error("demo failed: the valid sample task must APPROVE");
  }

  // --- 2. Real proof with the official gatekeeper circuit ----------------
  const circuitInput = gatekeeperCircuitInput(
    sample.task_id,
    sample.input,
    verdict,
    "0",
  );
  const { proof, publicSignals, proveMs } = await proveGatekeeper(rootDir, circuitInput);
  console.log(`proof generated in ${proveMs}ms (Groth16/BN128, official circuit)`);
  const verified = await verifyGatekeeperProof(rootDir, publicSignals, proof);
  console.log(`local verification against the official VK: ${verified ? "OK" : "FAILED"}`);
  if (!verified) throw new Error("demo failed: proof did not verify");

  // --- 3. Offline submission (local verification, nothing leaves the box) -
  const provider = new OfflineSubmissionProvider(rootDir);
  const receipt = await provider.submit(
    "gatekeeper",
    proof,
    publicSignals,
    registeredVkHash("gatekeeper"),
  );
  console.log(`submission [${provider.name}]: ${receipt.status} — ${receipt.detail}`);
  console.log(`public signals[0] (binding output): ${publicSignals[0].slice(0, 24)}...`);
  console.log(`vk hash used: ${registeredVkHash("gatekeeper")}\n`);

  // --- 4. Trap replay: VK substitution -> REJECT + proof -----------------
  const trapInput: GatekeeperTaskInput = {
    ...sample.input,
    proof_vk:
      "0xa4c1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f",
  };
  const trapVerdict = decideGatekeeper(trapInput, () => false);
  console.log(`trap (VK_SUBSTITUTION): decision=${trapVerdict.decision} (${trapVerdict.reason_code})`);
  const trapProof = await proveGatekeeper(
    rootDir,
    gatekeeperCircuitInput("gk_trap_demo", trapInput, trapVerdict, "0"),
  );
  const trapVerified = await verifyGatekeeperProof(
    rootDir,
    trapProof.publicSignals,
    trapProof.proof,
  );
  console.log(`trap proof generated in ${trapProof.proveMs}ms, verifies: ${trapVerified}\n`);

  // --- 5. Steal-the-VFY move (decision + audit hash, proof blocked) ------
  const move = decideVfyMove(
    {
      selfBalance: 95,
      opponentBalance: 105,
      selfFortifiedUntilTurn: null,
      opponentFortifiedUntilTurn: null,
    },
    3,
    DEFAULT_STRATEGY_PARAMS,
  );
  console.log(`vfy turn 3 (95 vs 105): move=${move.action}${move.amount ? ` ${move.amount}` : ""}`);
  const commitment =
    "0x7d3a11aa22bb33cc44dd55ee66ff77889900aabbccddeeff0011223344556677";
  console.log(
    `publicInputsHash: ${computePublicInputsHash({
      commitment,
      matchId: "9f4e1b2a-5c6d-7e8f-90a1-b2c3d4e5f6a7",
      turn: 3,
      selfBalance: 95,
      opponentBalance: 105,
      action: move.action,
      amount: move.amount ?? 0,
    })}`,
  );
  try {
    await proveVfyPolicy(rootDir, {
      commitment,
      matchId: String(BigInt("0x9f4e1b2a5c6d7e8f90a1b2c3d4e5f6a7")),
      turnNumber: "3",
      selfBalance: "95",
      opponentBalance: "105",
      action: move.action === "EXTRACT" ? "2" : move.action === "FORTIFY" ? "1" : "0",
      amount: String(move.amount ?? 0),
      circuitVersion: "1",
      strategyParams: DEFAULT_STRATEGY_PARAMS.map(String),
      salt: "0",
    });
    console.log("vfy policy proof: GENERATED (unexpected — see circuits/CIRCUITS.md)");
  } catch (error) {
    if (error instanceof VfyPolicyBlockedError) {
      console.log("vfy policy proof: BLOCKED (documented) — official circuit's strategy");
      console.log("  semantics are unpublished; the agent fails closed to HOLD without");
      console.log("  a proof. See circuits/CIRCUITS.md.");
    } else {
      throw error;
    }
  }

  // --- 6. Demo policy circuit: the same flow, end-to-end, locally --------
  console.log("\n--- demo policy circuit (local, same interface as official) ---");
  const demoCommitment = await demoPolicyCommitment(DEFAULT_STRATEGY_PARAMS, 0);
  console.log(`demo commitment (Poseidon of params+salt): ${demoCommitment.slice(0, 24)}...`);
  const demoResult = await proveDemoPolicy(rootDir, {
    commitment: demoCommitment,
    matchId: "1",
    turnNumber: "3",
    selfBalance: "95",
    opponentBalance: "105",
    action: move.action === "EXTRACT" ? "2" : move.action === "FORTIFY" ? "1" : "0",
    amount: String(move.amount ?? 0),
    circuitVersion: "1",
    strategyParams: DEFAULT_STRATEGY_PARAMS.map(String),
    salt: "0",
  });
  const demoVerified = await verifyDemoPolicyProof(
    rootDir,
    demoResult.publicSignals,
    demoResult.proof,
  );
  console.log(
    `demo policy proof generated in ${demoResult.proveMs}ms, verifies: ${demoVerified}`,
  );
  if (!demoVerified) throw new Error("demo failed: demo policy proof did not verify");

  console.log("\n=== demo OK ===");
  // snarkjs leaves its worker-thread pool alive after proving (its CLI exits
  // via process.exit for the same reason); exit explicitly so the demo ends.
  process.exit(0);
}

main().catch((error) => {
  console.error("demo FAILED:", error);
  process.exit(1);
});
