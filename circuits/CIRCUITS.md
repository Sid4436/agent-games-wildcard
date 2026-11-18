# Circuit artifacts — provenance and reverse-engineered interface

Both competitions use Groth16/BN128 circuits compiled with Circom 2.x
(source: https://agentgames.zkverify.io/build, section 02.5). The official
template repo linked from the site (`github.com/zkVerify/agent-games`)
returns 404, and the circuit sources are not published, so the input signal
interface below was **derived from the artifacts themselves** — see
"How the inputs were derived". Nothing here is guessed: every name was
confirmed against the circuit's own signal table, and the gatekeeper proof
flow was verified end-to-end against the exported verification key.

## Files

| File | Bytes | SHA-256 |
|---|---|---|
| `gatekeeper.wasm` | 1,755,820 | `be00aefe3c8ba910951a242f50e55937bf82a0375ad4b69c2ef10629ab92764f` |
| `gatekeeper_final.zkey` | 309,750 | `adfe95a439a7063a82a4967ef026d2dd6857a4d02c63b3caf63dac02e01af80d` |
| `vfy-policy.wasm` | 2,991,212 | `bc0998250d2baf75b89deef5306867ffa7085a08d4f7d2caf0dd63a060b134d2` |
| `vfy-policy_final.zkey` | 810,586 | `f9666a1655279ef27f7fee6d535ac8aa9e39286ac40ff6279fea87c21ab6ce41` |

Source URLs: `https://agentgames.zkverify.io/circuits/<file>` (also served via
`https://agentgames.zkverify.io/api/circuit-info`). Re-download + verify with
`npm run download-circuits`. The `*_vk.json` files are the verification keys
exported from the zkeys with `snarkjs zkey export verificationkey`, so proofs
can be verified locally with no network.

Registered verification-key hashes (zkVerify mainnet, from `/api/circuit-info`):

| Circuit | vkHash |
|---|---|
| gatekeeper | `0x6b79c6012a6d8651f3e13bc4d2a20370280ab49700c90c5316d4168bfbad77b0` |
| vfyPolicy | `0x6c56509f1c56fd1fd4e9737f906d2220f4b95f1d507f1adf6899085bd74be047` |

## Gatekeeper circuit — VERIFIED WORKING

- Protocol Groth16, curve BN128, 647 witness variables, 13 public signals.
- Public signals (snarkjs order: output first, then public inputs):
  `output[0]` (binding commitment, see below), then the 12 public inputs.
- One private input: `salt`.

| # | Signal | Size | Public? | Meaning |
|---|---|---|---|---|
| 1 | `registeredVkHash` | 1 | yes | keccak256 of the registered condition VK, mod field prime |
| 2 | `proofVkHash` | 1 | yes | keccak256 of the proof's VK, mod field prime |
| 3 | `minimum` | 1 | yes | condition minimum threshold |
| 4 | `publicBalance` | 1 | yes | balance disclosed in the proof |
| 5 | `expiryBlock` | 1 | yes | condition expiry block height |
| 6 | `currentBlock` | 1 | yes | current block height |
| 7 | `recipient` | 1 | yes | payment recipient (address as integer) |
| 8 | `conditionRecipient` | 1 | yes | address on the payment condition |
| 9 | `amount` | 1 | yes | requested transfer amount |
| 10 | `maxTransfer` | 1 | yes | single-transfer cap |
| 11 | `decision` | 1 | yes | `1` = APPROVE, `0` = REJECT |
| 12 | `taskId` | 1 | yes | keccak256 of the task id string, mod field prime |
| 13 | `salt` | 1 | **no** | per-agent private blinding value |

**Verified behaviour (2026-11-18, this machine, snarkjs 0.7.5):**

- Valid condition + `decision=1` + `salt=0` → proof generated in **~1.6 s**,
  verifies `OK` against the exported verification key.
- VK-substitution trap + `decision=0` → proof generated, verifies `OK`.
- Valid condition + `decision=0` (wrong decision) → witness generation
  **fails** (constraint unsatisfied). The circuit enforces the correct
  decision: a valid proof cannot launder a wrong decision.
- `publicSignals[0]` (the circuit's single output) is a binding commitment
  derived from (`taskId`, `salt`): it changes when either changes and does
  not depend on the decision or the VK hashes. Its exact hash construction
  (not keccak256 of the concatenation, not Poseidon of the pair) is
  undetermined; the agent forwards `public_signals` as returned by snarkjs,
  so the value is reproduced exactly and needs no formula.

Encoding note: the circuit only constrains *relations* between inputs
(hashes equal, balance >= minimum, recipient equal, ...), so the hash
function used for `registeredVkHash` / `proofVkHash` / `taskId` only has to
be applied consistently to both sides of an equality. keccak256 (mod the
field prime) is used because it is the Ethereum-native hash and the one the
platform's own tooling uses for `publicInputsHash`.

## vfy-policy circuit — inputs derived, proof generation BLOCKED

- Protocol Groth16, curve BN128, 1909 witness variables, 9 public signals.
- Public signals: `output[0]` (binding commitment) + 8 public inputs.
- Private inputs: `strategyParams[8]` + `salt`.

| # | Signal | Size | Public? | Meaning |
|---|---|---|---|---|
| 1 | `commitment` | 1 | yes | registered strategy commitment (field element) |
| 2 | `matchId` | 1 | yes | match UUID as integer (dashes removed) |
| 3 | `turnNumber` | 1 | yes | turn number |
| 4 | `selfBalance` | 1 | yes | own VFY balance |
| 5 | `opponentBalance` | 1 | yes | opponent VFY balance |
| 6 | `action` | 1 | yes | HOLD 0 / FORTIFY 1 / EXTRACT 2 |
| 7 | `amount` | 1 | yes | EXTRACT amount (0 for HOLD/FORTIFY) |
| 8 | `circuitVersion` | 1 | yes | `1` for "v1" |
| 9 | `strategyParams` | 8 | **no** | the 8 strategy knobs (see strategy/strategy.md) |
| 10 | `salt` | 1 | **no** | per-agent private blinding value |

### The blocker (documented, 2026-11-18)

Every proof attempt fails in witness generation with:

```
ERROR: Assert Failed. Error in template VfyPolicyProof_154 line: 72
```

~50 input combinations were tried and all fail at the **same** assert:
commitments as keccak256(strategy text), Poseidon(strategyParams),
Poseidon(strategyParams, salt), Poseidon(salt, strategyParams), keccak256 of
the params bytes, the circuit's own vkHash, 0, 1; strategyParams all-zero,
all-one, and plausible threshold sets; actions HOLD/FORTIFY/EXTRACT;
circuitVersion 0/1/2/3/154; salts 0/1/7; turns 0/1/3; balances 0/0,
95/105, 100/100; matchId 1 and UUID-derived. The assert does not depend on
any single input value tried, so it most likely checks a *relationship*
between inputs (e.g. commitment vs. strategyParams under a hash the platform
has not documented, or a parameter-validity rule) that cannot be derived
from the published material — the circuit source is not public and the
/build guide documents the *response* format, not the strategy semantics.

**Consequences, handled in code:**

- `src/prover.ts:proveVfyPolicy` throws `VfyPolicyBlockedError`.
- `src/server.ts` fails closed on Steal-the-VFY turns: it returns the
  decided action with the computable audit fields (`circuitVersion`,
  `publicInputsHash`) and no proof. The platform resolves a proof-less turn
  as HOLD (-2). This is the honest current state, logged loudly.
- The Wildcard entry's verified claim is therefore the **gatekeeper proof**
  (fully working, above), not the policy proof.
- `circuits-demo/` contains a locally compiled demo policy circuit with the
  *same interface* and a documented threshold strategy, so the policy-proof
  flow (decide → prove → verify → submit) is demonstrable end-to-end. It is
  clearly labeled DEMO and is never presented as the official circuit.
- The moment the strategy semantics are known (e.g. calibrated against
  practice mode, or published by the platform), only the `strategyParams`
  values change — no code change is needed in the proof path.

## How the inputs were derived

The official template repo is 404 and no signal list is published, so the
interface was recovered from the `.wasm` files themselves:

1. `snarkjs zkey export verificationkey` gave the public-signal counts
   (gatekeeper 13, vfy-policy 9) and confirmed Groth16/BN128.
2. Circom 2.x resolves input signal names by FNV-1a 64-bit hash; the wasm
   export `getInputSignalSize(hashMSB, hashLSB)` returns the signal size
   (>= 1) when the name exists and 0 otherwise. Candidate names taken from
   the official task envelopes (`/build` guide, event pages) were tested
   against this oracle. A definitely-unknown name returns 0, which was
   verified with a random control string.
3. The wasm data section contains the full (hash, witness-index, size)
   table. Dumping it (`scripts/derive-circuit-inputs.mjs`) enumerated every
   input signal and its size, confirming the candidate lists were complete
   except for one private signal per circuit — the shared hash
   `097f5318bf97c581`, found by dictionary brute-force to be `salt`.
4. Gatekeeper semantics were then confirmed empirically (valid/trap/wrong-
   decision cases above). The vfy-policy semantics could not be confirmed
   (see the blocker).

Re-run the derivation with `node scripts/derive-circuit-inputs.mjs`.
It needs no secrets and no network (it reads the local `circuits/*.wasm`).
