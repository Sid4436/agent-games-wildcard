# Agent Games — Wildcard entry: Proof-Bound Transaction Guard

A wallet transaction guard agent for **zkVerify Agent Games Season 01**
(Wildcard track). The agent screens payment requests against a rule set and
**proves each decision with a real Groth16 zero-knowledge proof** — generated
locally with snarkjs from the official Agent Games circuits, verifiable on
zkVerify via Kurier. The proof attests the decision followed the rules
without revealing how the agent decided.

> **Status (2026-11-18).** The gatekeeper proof path is **verified working
> end-to-end** with the official circuits (real proof, ~1.6 s, verifies
> against the official verification key). The Steal-the-VFY policy proof is
> **blocked** on unpublished strategy semantics — see
> [`circuits/CIRCUITS.md`](circuits/CIRCUITS.md). The agent fails closed
> there (HOLD without a proof). The Wildcard entry's verified claim is the
> gatekeeper proof.

## The problem it solves

A cryptographic proof can verify on-chain and still back the wrong request:
wrong key, wrong recipient, expired window, reused proof, amount over the
cap. This agent is the gatekeeper that checks every field before a payment
is approved — and writes its own zero-knowledge proof that the decision
followed the rules, so anyone can verify the decision without trusting the
agent. The same pattern guards any wallet or treasury: screen first, prove
the screening, then (and only then) sign.

## How it works

```
platform task (signed) ──> POST /agent ──> HMAC verify (raw body)
        │                                   │
        │                              decide (deterministic rules)
        │                                   │
        │                              Groth16 proof (snarkjs, official
        │                              gatekeeper circuit, ~1.6 s)
        │                                   │
        │                              submit proof (Kurier -> Finalized,
        │                              or offline local verification)
        │                                   │
        └──── signed response {decision, reason_code, proof, public_signals}
```

1. **Receive** — the platform POSTs a signed JSON task envelope to `/agent`.
   The HMAC signature is verified against the raw body before parsing.
2. **Decide** — deterministic rules (`src/decision.ts`): six checks, first
   failure wins the reason code. No model in the loop for the final call.
3. **Prove** — a Groth16 proof is generated locally with the official
   gatekeeper circuit. The circuit re-checks the rules, so a wrong decision
   cannot be proven (verified: a flipped decision fails witness generation).
4. **Submit** — Kurier REST to zkVerify, polled to `Finalized`; or offline
   local verification (default, demo).
5. **Respond** — one deterministic decision + proof evidence, signed with
   `x-agent-games-signature`. Preflight (`{ok: true, protocolVersion: "v1"}`)
   and `GET /health` (`{"status":"ok"}`) are supported.

## Quickstart

```bash
npm install
npm test        # build + full test suite (unit + e2e with real proofs)
npm run demo    # offline demo: decide -> real proof -> local verify, no keys
```

The demo needs nothing: no API key, no secret, no network. It prints the
decision, the proof generation time, and the local verification result.

## Run the server

```bash
cp .env.example .env   # fill in AGENT_GAMES_HMAC_SECRET (from the platform
                       # dashboard: Rotate Secret) and KURIER_API_KEY to go live
npm run build
npm start              # or: npm run dev (tsx)
```

`GET /health` must answer `{"status":"ok"}` in under 3 s. `POST /agent`
handles preflight, gatekeeper tasks, and Steal-the-VFY turns. Without
`AGENT_GAMES_HMAC_SECRET` the server runs in **demo mode** (HMAC skipped,
loud warning on every request) — local testing only, never deploy that.

## Configuration

| Variable | Required | Description |
|---|---|---|
| `PORT` / `HOST` | no (3000 / 0.0.0.0) | HTTP listen address (behind a reverse proxy; the public address must be HTTPS) |
| `AGENT_GAMES_HMAC_SECRET` | live only | 32-byte secret from Dashboard → Rotate Secret |
| `SUBMISSION_PROVIDER` | no (`offline`) | `offline` (local verification) or `kurier` |
| `KURIER_API_KEY` | for Kurier | Signup: https://kurier.xyz (mainnet) or https://testnet.kurier.xyz (testnet) |
| `KURIER_NETWORK` | no (`testnet`) | `mainnet` or `testnet` |
| `DATA_DIR` | no (`./data`) | Seen proof references + idempotency store |
| `GATEKEEPER_SALT` | no (`0`) | Private per-agent salt bound into each proof |

The Kurier docs page lists no price for the API key — check pricing on the
signup page before use. zkVerifyJS (direct chain interaction, needs a funded
Volta account) is the documented alternative: see
[`docs/zkverifyjs.md`](docs/zkverifyjs.md).

## The strategy

[`strategy/strategy.md`](strategy/strategy.md) is the committed decision
policy in plain English (gatekeeper rules + Steal-the-VFY threshold
strategy). Its keccak256 hash is the strategy commitment registered with the
platform:

```bash
npm run commit-strategy   # prints the 64-hex commitment + field element
```

The commitment is frozen when matches are paired; the strategy text is
published after the tournament, so it contains no secrets.

## Circuits — what was verified

Full provenance, hashes, derived input tables, and the vfy-policy blocker:
[`circuits/CIRCUITS.md`](circuits/CIRCUITS.md). Headlines:

- **Gatekeeper** (13 public signals, 1 private `salt`): valid + trap cases
  generate real proofs in ~1.6 s that verify against the official VK; a
  wrong decision fails witness generation. Input names were recovered from
  the circuit's own signal table (`scripts/derive-circuit-inputs.mjs`).
- **vfy-policy** (9 public signals, private `strategyParams[8]` + `salt`):
  all input names derived, but proof generation is blocked — the circuit's
  internal assert (template `VfyPolicyProof_154`, line 72) rejects every
  parameter combination derivable from public material (~50 tried). The
  strategy semantics are unpublished. The agent fails closed; the demo
  policy circuit in `circuits-demo/` proves the same flow end-to-end with a
  documented threshold strategy (clearly labeled DEMO, never the official
  circuit).

## Repo layout

```
src/            agent source (config, hmac, decision, prover, submission, server, demo)
test/           unit + e2e tests (node:test, run against the built output)
circuits/       official Agent Games artifacts (wasm/zkey/vk) + CIRCUITS.md
circuits-demo/  locally compiled demo policy circuit (circom) + README
strategy/       committed policy (strategy.md) + commitment.json
scripts/        commit-strategy, download-circuits, derive-circuit-inputs
demo/           sample gatekeeper task envelope
docs/           zkVerifyJS alternative
```

## Wildcard submission mapping

| Requirement (event page) | Where it is |
|---|---|
| Public repository | this repo |
| Public HTTPS endpoint | `GET /health` + `POST /agent` (deploy on any host; see Run the server) |
| Use case | Wallet/treasury transaction guard — screen payments, prove the screening |
| Build context | This README + `strategy/strategy.md` + `circuits/CIRCUITS.md` |
| zkVerify (optional plus) | The checkable claim: *"this decision followed the gatekeeper rules."* Proof: the Groth16 proof + public signals in every response; verify locally with `npm run demo` or `snarkjs groth16 verify` against `circuits/gatekeeper_vk.json`. |

## Reproduce the demo (for judges)

```bash
git clone <this repo> && cd agent-games-wildcard
npm install
npm run demo
```

Expected: `task gk_24_9d1: decision=APPROVE (VALID_CONDITION)`, a proof
generated in ~1–2 s, `local verification against the official VK: OK`, a
trap replay (`VK_SUBSTITUTION` → REJECT, proof verifies), the Steal-the-VFY
move with its `publicInputsHash`, and a demo-circuit policy proof that
verifies (the official policy proof is blocked — see
[`circuits/CIRCUITS.md`](circuits/CIRCUITS.md)). No keys, no network, no
wallet needed.

## Security notes

- Secrets come from the environment only (`.env`, git-ignored). No key, seed,
  or secret is committed — check with `git grep -iE "api[_-]?key|secret|seed|private"`.
- HMAC is verified on the raw body before parsing; responses are signed.
- Fail closed everywhere: timeout, error, or uncertainty → REJECT / HOLD.
- `task_id` / `(matchId, turn)` are idempotency keys; proof references are
  kept in a local seen-set (`DATA_DIR/seen-proofs.json`) for reuse detection.
- The platform never runs this code — you host it at a public HTTPS address
  and register that address. Use testnet first; rotate the secret after
  deploying.
