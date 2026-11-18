/**
 * Demo policy circuit (circuits-demo/) — the local stand-in for the official
 * vfy-policy circuit.
 *
 * The official circuit's strategy semantics are unpublished, so its proof
 * cannot be produced from public material (see circuits/CIRCUITS.md). This
 * module proves the SAME flow end-to-end with a locally compiled circuit
 * that has the same public interface and a DOCUMENTED threshold strategy:
 *
 *   commitment = Poseidon(strategyParams[0..7], salt)
 *   binding    = Poseidon(commitment, matchId, turnNumber, action, amount)
 *
 * The demo circuit is clearly labeled DEMO everywhere it appears. A
 * demo-circuit proof is never submitted as an official-circuit proof: the
 * verification keys differ, and the platform verifies against its own
 * registered key. Its purpose is to demonstrate the flow and to let the
 * strategy be calibrated before the official semantics are known.
 */
import * as snarkjs from "snarkjs";
import { buildPoseidon } from "circomlibjs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Groth16Proof, ProofResult } from "./prover.js";

/** Poseidon commitment for the demo circuit: Poseidon(params[0..7], salt). */
export async function demoPolicyCommitment(
  strategyParams: (number | bigint | string)[],
  salt: number | bigint | string,
): Promise<string> {
  const poseidon = await buildPoseidon();
  const inputs = [...strategyParams.map(BigInt), BigInt(salt)];
  return poseidon.F.toString(poseidon(inputs));
}

/** Generate a policy proof with the local demo circuit. */
export async function proveDemoPolicy(
  rootDir: string,
  input: Record<string, unknown>,
): Promise<ProofResult> {
  const started = Date.now();
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    input,
    path.join(rootDir, "circuits-demo", "demo-policy.wasm"),
    path.join(rootDir, "circuits-demo", "demo-policy_final.zkey"),
  );
  return {
    proof: proof as Groth16Proof,
    publicSignals: (publicSignals as unknown[]).map(String),
    proveMs: Date.now() - started,
  };
}

/** Verify a demo policy proof against the demo verification key. */
export async function verifyDemoPolicyProof(
  rootDir: string,
  publicSignals: string[],
  proof: Groth16Proof,
): Promise<boolean> {
  const vk = JSON.parse(
    await readFile(
      path.join(rootDir, "circuits-demo", "demo-policy_vk.json"),
      "utf8",
    ),
  );
  return snarkjs.groth16.verify(vk, publicSignals, proof);
}
