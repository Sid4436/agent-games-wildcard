/**
 * Groth16 proof generation + local verification with snarkjs.
 *
 * Uses the OFFICIAL Agent Games circuits (circuits/*.wasm + *.zkey, see
 * circuits/CIRCUITS.md). The verification keys are exported into
 * circuits/*_vk.json so proofs can be verified locally without any network.
 *
 * Gatekeeper circuit — VERIFIED WORKING end-to-end (see circuits/CIRCUITS.md
 * for the evidence): fullProve takes ~1.6s on this machine and the proof
 * verifies against the exported verification key. The circuit constrains
 * `decision` to the correct value: with all checks passing, decision MUST be
 * "1" (APPROVE); a wrong decision fails witness generation, so the agent
 * cannot launder a wrong decision through a valid proof.
 *
 * NOTE on snarkjs worker threads: snarkjs spawns a small worker-thread pool
 * on the first proof and never terminates it (its own CLI exits via
 * process.exit). The pool is REUSED across proofs (verified: still 4 worker
 * ports after 3 proofs), so a long-running server does not leak threads —
 * but short-lived processes (tests, the demo) must exit explicitly. That is
 * why the npm test scripts use `node --test --test-force-exit` and the demo
 * ends with process.exit(0).
 *
 * vfy-policy circuit — inputs fully derived (see circuits/CIRCUITS.md), but
 * proof generation is BLOCKED: every input combination tried so far fails
 * the circuit's internal assert (template VfyPolicyProof_154, line 72).
 * The strategy-parameter semantics are not published, so the correct
 * (strategyParams, salt, commitment) combination cannot be derived from
 * public material. `proveVfyPolicy` therefore throws a documented
 * VfyPolicyBlockedError; callers must fail closed (HOLD without a proof).
 * The demo policy circuit in circuits-demo/ (compiled locally, clearly
 * labeled) demonstrates the same flow end-to-end.
 */
import * as snarkjs from "snarkjs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { VK_HASH } from "./config.js";

export interface Groth16Proof {
  pi_a: [string, string, string];
  pi_b: [[string, string], [string, string], [string, string]];
  pi_c: [string, string, string];
  protocol: "groth16";
  curve: "bn128";
}

export interface ProofResult {
  proof: Groth16Proof;
  /** Public signals in snarkjs order: output first, then public inputs. */
  publicSignals: string[];
  /** Wall-clock proof generation time in milliseconds. */
  proveMs: number;
}

export class VfyPolicyBlockedError extends Error {
  constructor(detail: string) {
    super(
      `vfy-policy proof generation is blocked (official circuit, undocumented strategy semantics): ${detail}. ` +
        `See circuits/CIRCUITS.md. The agent fails closed to HOLD without a proof.`,
    );
    this.name = "VfyPolicyBlockedError";
  }
}

function circuitPaths(rootDir: string, name: "gatekeeper" | "vfy-policy") {
  return {
    wasm: path.join(rootDir, "circuits", `${name}.wasm`),
    zkey: path.join(rootDir, "circuits", `${name}_final.zkey`),
    vk: path.join(rootDir, "circuits", `${name}_vk.json`),
  };
}

async function fullProve(
  wasm: string,
  zkey: string,
  input: Record<string, unknown>,
): Promise<{ proof: Groth16Proof; publicSignals: string[]; proveMs: number }> {
  const started = Date.now();
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    input,
    wasm,
    zkey,
  );
  return {
    proof: proof as Groth16Proof,
    publicSignals: (publicSignals as unknown[]).map(String),
    proveMs: Date.now() - started,
  };
}

/** Verify a proof against an exported verification key file. */
export async function verifyProof(
  vkPath: string,
  publicSignals: string[],
  proof: Groth16Proof,
): Promise<boolean> {
  const vk = JSON.parse(await readFile(vkPath, "utf8"));
  return snarkjs.groth16.verify(vk, publicSignals, proof);
}

/** Generate a gatekeeper decision proof with the official circuit. */
export async function proveGatekeeper(
  rootDir: string,
  input: Record<string, string>,
): Promise<ProofResult> {
  const { wasm, zkey } = circuitPaths(rootDir, "gatekeeper");
  return fullProve(wasm, zkey, input);
}

/** Verify a gatekeeper proof against the official verification key. */
export async function verifyGatekeeperProof(
  rootDir: string,
  publicSignals: string[],
  proof: Groth16Proof,
): Promise<boolean> {
  return verifyProof(circuitPaths(rootDir, "gatekeeper").vk, publicSignals, proof);
}

/** The registered vk hash for a circuit (for Kurier submission). */
export function registeredVkHash(name: "gatekeeper" | "vfy-policy"): string {
  return name === "gatekeeper" ? VK_HASH.gatekeeper : VK_HASH.vfyPolicy;
}

/**
 * Generate a Steal-the-VFY policy proof with the official circuit.
 *
 * CURRENTLY BLOCKED — see the module docstring. This function attempts the
 * proof and, on the known assert failure, throws VfyPolicyBlockedError
 * (callers fail closed). It is kept wired so the path works the moment the
 * strategy semantics are known (e.g. after calibrating against practice
 * mode): no code change is needed beyond supplying correct strategyParams.
 */
export async function proveVfyPolicy(
  rootDir: string,
  input: Record<string, unknown>,
): Promise<ProofResult> {
  const { wasm, zkey } = circuitPaths(rootDir, "vfy-policy");
  try {
    return await fullProve(wasm, zkey, input);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/Assert Failed|VfyPolicyProof_154/.test(message)) {
      throw new VfyPolicyBlockedError(
        `witness generation failed at template VfyPolicyProof_154 line 72 for the supplied strategy parameters`,
      );
    }
    throw error;
  }
}

/** Verify a vfy-policy proof against the official verification key. */
export async function verifyVfyPolicyProof(
  rootDir: string,
  publicSignals: string[],
  proof: Groth16Proof,
): Promise<boolean> {
  return verifyProof(circuitPaths(rootDir, "vfy-policy").vk, publicSignals, proof);
}
