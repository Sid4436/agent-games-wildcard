/**
 * Deterministic decision logic.
 *
 * The final call is ALWAYS deterministic code — no language model, no
 * randomness, no heuristics that vary between runs. The same task envelope
 * always yields the same decision. This is what the Groth16 proof attests:
 * the circuit re-checks the same rules off-chain, so a wrong decision cannot
 * be laundered through a valid proof.
 *
 * --- Proof Gatekeeper (from the event page trap encyclopedia) ---
 * Checks, in order (first failure wins the reason code):
 *   1. VK_SUBSTITUTION      proof_vk != registered_vk
 *   2. THRESHOLD_MISMATCH   public_balance < minimum
 *   3. PROOF_REUSED         proof_tx already accepted before (local seen-set)
 *   4. EXPIRED_CONDITION    current_block > expiry_block
 *   5. RECIPIENT_MISMATCH   recipient != condition_recipient
 *   6. AMOUNT_OVERFLOW      amount > max_transfer
 * All pass -> APPROVE / VALID_CONDITION.
 * Score model (event page): correct decision +12, approve-a-trap -6,
 * reject-a-valid -3, timeout -2, missing/invalid proof -2.
 *
 * --- Steal the VFY (threshold strategy, see strategy/strategy.md) ---
 * The 8 strategyParams are the strategy's knobs. The INTENDED mapping is
 * documented here and in strategy.md; the official vfy-policy circuit's
 * exact parameter semantics are NOT published (see circuits/CIRCUITS.md),
 * so the on-chain policy proof for this track is best-effort until the
 * strategy is calibrated against practice mode.
 */
import { addressToField, hashToField, intToField, stringToField } from "./encoding.js";

export type GatekeeperDecision = "APPROVE" | "REJECT";

export type GatekeeperReasonCode =
  | "VALID_CONDITION"
  | "VK_SUBSTITUTION"
  | "THRESHOLD_MISMATCH"
  | "PROOF_REUSED"
  | "EXPIRED_CONDITION"
  | "RECIPIENT_MISMATCH"
  | "AMOUNT_OVERFLOW";

export interface GatekeeperTaskInput {
  registered_vk: string;
  proof_vk: string;
  minimum: string;
  public_balance: string;
  expiry_block: number | string;
  current_block: number | string;
  recipient: string;
  condition_recipient: string;
  amount: string;
  max_transfer: string;
  proof_tx: string;
}

export interface GatekeeperVerdict {
  decision: GatekeeperDecision;
  reason_code: GatekeeperReasonCode;
  /** "1" for APPROVE, "0" for REJECT — the gatekeeper circuit's `decision` input. */
  decisionField: "1" | "0";
  /** Which check failed (null when valid). */
  failedCheck: GatekeeperReasonCode | null;
}

/**
 * Pure decision function. `isProofSeen` is a lookup into the agent's local
 * seen-set of proof references (PROOF_REUSED detection). No I/O, no randomness.
 */
export function decideGatekeeper(
  input: GatekeeperTaskInput,
  isProofSeen: (proofTx: string) => boolean,
): GatekeeperVerdict {
  const reject = (code: GatekeeperReasonCode): GatekeeperVerdict => ({
    decision: "REJECT",
    reason_code: code,
    decisionField: "0",
    failedCheck: code,
  });

  // 1. Verification key must match the registered condition key. The proof
  //    may verify on-chain and still back the wrong condition.
  if (hashToField(input.proof_vk) !== hashToField(input.registered_vk)) {
    return reject("VK_SUBSTITUTION");
  }
  // 2. Public balance disclosed in the proof must meet the minimum.
  if (BigInt(input.public_balance) < BigInt(input.minimum)) {
    return reject("THRESHOLD_MISMATCH");
  }
  // 3. A proof reference is single-use. (Checked after VK/threshold so a
  //    reused trap is still classified by its most specific failure first
  //    when several apply — order matches the event page's checklist.)
  if (isProofSeen(input.proof_tx)) {
    return reject("PROOF_REUSED");
  }
  // 4. The condition's block-height expiry must not have passed.
  if (BigInt(input.current_block) > BigInt(input.expiry_block)) {
    return reject("EXPIRED_CONDITION");
  }
  // 5. The recipient committed in the proof must match the condition address.
  if (
    addressToField(input.recipient) !== addressToField(input.condition_recipient)
  ) {
    return reject("RECIPIENT_MISMATCH");
  }
  // 6. The amount must not exceed the single-transfer cap.
  if (BigInt(input.amount) > BigInt(input.max_transfer)) {
    return reject("AMOUNT_OVERFLOW");
  }
  return {
    decision: "APPROVE",
    reason_code: "VALID_CONDITION",
    decisionField: "1",
    failedCheck: null,
  };
}

/** Build the gatekeeper circuit inputs for a verdict (see circuits/CIRCUITS.md). */
export function gatekeeperCircuitInput(
  taskId: string,
  input: GatekeeperTaskInput,
  verdict: GatekeeperVerdict,
  salt: string,
): Record<string, string> {
  return {
    registeredVkHash: hashToField(input.registered_vk),
    proofVkHash: hashToField(input.proof_vk),
    minimum: intToField(input.minimum),
    publicBalance: intToField(input.public_balance),
    expiryBlock: intToField(input.expiry_block),
    currentBlock: intToField(input.current_block),
    recipient: addressToField(input.recipient),
    conditionRecipient: addressToField(input.condition_recipient),
    amount: intToField(input.amount),
    maxTransfer: intToField(input.max_transfer),
    decision: verdict.decisionField,
    taskId: stringToField(taskId),
    salt: intToField(salt),
  };
}

// ---------------------------------------------------------------------------
// Steal the VFY — threshold strategy (intended mapping; see strategy.md)
// ---------------------------------------------------------------------------

export type VfyAction = "HOLD" | "FORTIFY" | "EXTRACT";

export interface VfyState {
  selfBalance: number;
  opponentBalance: number;
  selfFortifiedUntilTurn: number | null;
  opponentFortifiedUntilTurn: number | null;
}

export interface VfyMove {
  action: VfyAction;
  /** 1..10 for EXTRACT; omitted for HOLD/FORTIFY. */
  amount?: number;
}

/**
 * The 8 strategyParams, as this agent defines them (see strategy/strategy.md):
 *   [0] extractThreshold   — extract when opponentBalance > this
 *   [1] fortifyThreshold   — fortify when selfBalance < this and threatened
 *   [2] extractAmount      — how much to extract (1..10)
 *   [3] endgameTurn        — from this turn on, extract whenever possible
 *   [4] minOpponentBalance — never drive the opponent below this (avoid
 *                            retaliation spirals)
 *   [5] fortifyCost        — VFY a FORTIFY costs (protocol: 2)
 *   [6] reserved (0)
 *   [7] reserved (0)
 *
 * Default strategy (committed in strategy/strategy.md):
 *   [60, 40, 5, 17, 10, 2, 0, 0]
 */
export const DEFAULT_STRATEGY_PARAMS = [60, 40, 5, 17, 10, 2, 0, 0];

export function decideVfyMove(
  state: VfyState,
  turn: number,
  strategyParams: number[],
): VfyMove {
  const [extractThreshold, fortifyThreshold, extractAmount, endgameTurn, minOpponentBalance] =
    strategyParams;
  const exposed = Math.max(
    0,
    state.opponentBalance -
      (state.opponentFortifiedUntilTurn !== null &&
      state.opponentFortifiedUntilTurn >= turn
        ? 6
        : 0),
  );
  const endgame = turn >= (endgameTurn ?? 17);

  // Extract when the opponent is rich enough to be worth it, we are not
  // about to be wiped out, and the take leaves them above the floor.
  if (
    (state.opponentBalance > (extractThreshold ?? 60) || endgame) &&
    state.selfBalance >= (fortifyThreshold ?? 40) &&
    exposed > 0 &&
    state.opponentBalance - (extractAmount ?? 5) >= (minOpponentBalance ?? 10)
  ) {
    return {
      action: "EXTRACT",
      amount: Math.min(10, Math.max(1, extractAmount ?? 5), exposed),
    };
  }
  // Fortify when we are low and the opponent is rich enough to come for us.
  if (
    state.selfBalance < (fortifyThreshold ?? 40) &&
    state.opponentBalance > (minOpponentBalance ?? 10)
  ) {
    return { action: "FORTIFY" };
  }
  return { action: "HOLD" };
}
