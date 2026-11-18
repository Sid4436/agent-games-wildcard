/**
 * Minimal type declarations for snarkjs 0.7.5 (it ships no types).
 * Only the API surface used by src/prover.ts is declared.
 */
declare module "snarkjs" {
  export namespace groth16 {
    function fullProve(
      input: Record<string, unknown>,
      wasmFile: string,
      zkeyFile: string,
    ): Promise<{ proof: unknown; publicSignals: unknown[] }>;
    function verify(
      verificationKey: unknown,
      publicSignals: string[],
      proof: unknown,
    ): Promise<boolean>;
  }
}

/**
 * Minimal type declarations for circomlibjs (it ships no types).
 * Only buildPoseidon, as used by src/demo-policy.ts, is declared.
 */
declare module "circomlibjs" {
  export interface PoseidonField {
    toString(x: unknown): string;
  }
  export interface Poseidon {
    (inputs: bigint[]): unknown;
    F: PoseidonField;
  }
  export function buildPoseidon(): Promise<Poseidon>;
}
