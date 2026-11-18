# Agent strategy — plain English, no secrets

This file is the agent's committed decision policy. Its keccak256 hash is the
**strategy commitment** registered with the Agent Games platform
(`npm run commit-strategy` computes it). The commitment is frozen when
matches are paired; the strategy text itself is published after the
tournament, so nothing secret may appear here.

## 1. Proof Gatekeeper — wallet transaction guard

Role: the agent is the gatekeeper for payments. Every incoming request is a
transfer that must be screened before it is approved. A proof can verify
on-chain and still back the wrong request, so verification alone is never
enough — every field is checked against the rule.

**APPROVE only when every check passes:**

1. **Key match** — the proof's verification key equals the registered
   condition key. A substituted key is a trap even if the proof verifies.
2. **Threshold** — the public balance disclosed in the proof is at least the
   condition's minimum.
3. **Single use** — the proof reference (`proof_tx`) has never been accepted
   before. A reused proof is rejected, however valid it looks.
4. **Not expired** — the current block is at or before the condition's
   expiry block.
5. **Right recipient** — the recipient committed in the proof equals the
   address on the payment condition.
6. **Within cap** — the amount does not exceed the single-transfer maximum.

**Otherwise REJECT**, naming the exact reason (`VK_SUBSTITUTION`,
`THRESHOLD_MISMATCH`, `PROOF_REUSED`, `EXPIRED_CONDITION`,
`RECIPIENT_MISMATCH`, `AMOUNT_OVERFLOW`).

**Fail closed.** On any timeout, error, or uncertainty the agent rejects —
never approves by default. The final call is deterministic code, never a
language model: the same task always yields the same decision, and the
Groth16 proof attests that the decision followed these rules (the circuit
re-checks them; a wrong decision cannot be proven).

## 2. Steal the VFY — threshold strategy

Each match is 20 turns, both agents start at 100 VFY. Actions: HOLD (free),
FORTIFY (costs 2, blocks up to 6 of incoming extraction this turn), EXTRACT N
(free, steals up to N, max 10, from the opponent's exposed balance).

The strategy is a threshold policy over the public game state, with 8
parameters (the `strategyParams` of the policy circuit):

| # | Parameter | Meaning | Default |
|---|-----------|---------|---------|
| 0 | extractThreshold | Extract when opponent balance exceeds this | 60 |
| 1 | fortifyThreshold | Fortify when own balance falls below this | 40 |
| 2 | extractAmount | How much to extract (1–10) | 5 |
| 3 | endgameTurn | From this turn on, extract whenever possible | 17 |
| 4 | minOpponentBalance | Never drive the opponent below this | 10 |
| 5 | fortifyCost | VFY a FORTIFY costs (protocol: 2) | 2 |
| 6 | reserved | Unused, must be 0 | 0 |
| 7 | reserved | Unused, must be 0 | 0 |

**Rules, in order:**

1. **Extract** when the opponent is rich (balance > extractThreshold, or the
   endgame has started), we are healthy (own balance >= fortifyThreshold),
   the opponent has exposed balance, and the take leaves them at or above
   minOpponentBalance. Take extractAmount, capped at 10 and at the exposed
   balance.
2. **Fortify** when we are low (own balance < fortifyThreshold) and the
   opponent is rich enough to come for us.
3. **Hold** otherwise. A hold is a safe pass; it gives the opponent a free
   extraction window, so it is only used when neither of the above applies.

**Rationale.** Extraction is free and the only way to grow; fortification is
cheap insurance when weak; holding avoids paying the fortify cost when there
is nothing to defend. The endgame rule accepts more risk late, when there
are no future turns to be punished in. The opponent floor avoids
retaliation spirals that cost both sides.

**Status note (2026-11-18).** The official vfy-policy circuit's exact
parameter semantics are not published, and its internal assert rejects every
parameter combination derived from public material so far (see
`circuits/CIRCUITS.md`). The threshold policy above is therefore the
*intended* strategy; the on-chain policy proof for this track is produced
best-effort and the agent fails closed to HOLD without a proof until the
strategy is calibrated against practice mode. The gatekeeper proof path is
fully working and is the entry's verified claim.
