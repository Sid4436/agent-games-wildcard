# Demo policy circuit — DEMO ONLY

A locally compiled Groth16/BN128 circuit (`demo-policy.circom`) with the
**same public interface** as the official vfy-policy circuit, built to
demonstrate the policy-proof flow end-to-end while the official circuit's
strategy semantics are unpublished (see `../circuits/CIRCUITS.md`).

**Never present a demo-circuit proof as an official-circuit proof.** The
verification keys differ, and the platform verifies against its own
registered key. The demo circuit exists to (a) prove the flow works,
(b) let the threshold strategy be calibrated, and (c) give reviewers
something real to verify locally.

## What it proves

Same interface as the official circuit — public inputs `commitment`,
`matchId`, `turnNumber`, `selfBalance`, `opponentBalance`, `action`,
`amount`, `circuitVersion`; private inputs `strategyParams[8]`, `salt`;
one public output `binding`. It constrains:

- `commitment = Poseidon(strategyParams[0..7], salt)` (documented
  construction — the official construction is unknown).
- `circuitVersion = 1` ("v1"), `action` in 0..2, `amount` in 0..10.
- The action follows the threshold strategy in
  `../strategy/strategy.md`:
  `canExtract = (opponentBalance > p0 || turnNumber >= p3) && selfBalance >= p1 && opponentBalance - p2 >= p4`,
  `canFortify = selfBalance < p1 && opponentBalance > p4`,
  `action = canExtract ? 2 : (canFortify ? 1 : 0)`,
  `amount = canExtract ? p2 : 0`.
- `binding = Poseidon(commitment, matchId, turnNumber, action, amount)`.

Verified 2026-11-18: EXTRACT and HOLD cases generate proofs that verify
against `demo-policy_vk.json`; a wrong action fails witness generation
(the circuit enforces the correct action, like the official one does).

## Files

| File | Description |
|---|---|
| `demo-policy.circom` | Circuit source (Circom 2.0) |
| `demo-policy.wasm` | Compiled witness generator (3.3 MB) |
| `demo-policy_final.zkey` | Proving key (1.2 MB) |
| `demo-policy_vk.json` | Verification key (exported from the zkey) |
| `build/` | Ceremony intermediates (r1cs, sym, ptau, 0000 zkey) — git-ignored, reproducible |

## Rebuild

Requires circom 2.2.x and snarkjs (both used here; circom binary from
https://github.com/iden3/circom/releases, snarkjs via npm). From the repo
root:

```bash
# 1. Compile
circom circuits-demo/demo-policy.circom --r1cs --wasm --sym -l node_modules -o circuits-demo/build
# 2. Powers of Tau (2^12 > 2554 constraints)
snarkjs powersoftau new bn128 12 circuits-demo/build/ptau_0000.ptau
snarkjs powersoftau prepare phase2 circuits-demo/build/ptau_0000.ptau circuits-demo/build/ptau_final.ptau
# 3. Setup + ONE contribution (demo ceremony — a production key needs a
#    real multi-party ceremony; this key is for demonstration only)
snarkjs groth16 setup circuits-demo/build/demo-policy.r1cs circuits-demo/build/ptau_final.ptau circuits-demo/build/demo-policy_0000.zkey
snarkjs zkey contribute circuits-demo/build/demo-policy_0000.zkey circuits-demo/build/demo-policy_final.zkey --name="demo-contributor-1" -e="agent-games-wildcard-demo-entropy"
# 4. Export + place artifacts
snarkjs zkey export verificationkey circuits-demo/build/demo-policy_final.zkey circuits-demo/build/demo-policy_vk.json
cp circuits-demo/build/demo-policy_js/demo-policy.wasm circuits-demo/demo-policy.wasm
cp circuits-demo/build/demo-policy_final.zkey circuits-demo/demo-policy_final.zkey
cp circuits-demo/build/demo-policy_vk.json circuits-demo/demo-policy_vk.json
```

## Prove with it

```ts
import { proveDemoPolicy, verifyDemoPolicyProof, demoPolicyCommitment } from "./src/demo-policy.js";
const commitment = await demoPolicyCommitment([60, 40, 5, 17, 10, 2, 0, 0], 0);
const { proof, publicSignals } = await proveDemoPolicy(rootDir, {
  commitment, matchId: "1", turnNumber: "3", selfBalance: "95",
  opponentBalance: "105", action: "2", amount: "5", circuitVersion: "1",
  strategyParams: ["60", "40", "5", "17", "10", "2", "0", "0"], salt: "0",
});
await verifyDemoPolicyProof(rootDir, publicSignals, proof); // true
```

Or just run `npm run demo` — it runs the demo-circuit proof after the
official-circuit section.
