/**
 * Unit tests for the deterministic gatekeeper + vfy decision logic.
 * Every trap variety from the event page is covered, plus the valid case.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  decideGatekeeper,
  decideVfyMove,
  type GatekeeperTaskInput,
} from "../src/decision.js";

const VK_A =
  "0x7d3a11aa22bb33cc44dd55ee66ff77889900aabbccddeeff00112233445566778899";
const VK_B =
  "0xa4c1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f";
const ADDR = "0xDe42000000000000000000000000000000009f01";
const OTHER = "0x1111111111111111111111111111111111111111";

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

const neverSeen = () => false;

test("valid condition approves", () => {
  const v = decideGatekeeper(validInput(), neverSeen);
  assert.equal(v.decision, "APPROVE");
  assert.equal(v.reason_code, "VALID_CONDITION");
  assert.equal(v.decisionField, "1");
});

test("VK substitution rejects", () => {
  const v = decideGatekeeper(validInput({ proof_vk: VK_B }), neverSeen);
  assert.equal(v.decision, "REJECT");
  assert.equal(v.reason_code, "VK_SUBSTITUTION");
  assert.equal(v.decisionField, "0");
});

test("threshold mismatch rejects (balance below minimum)", () => {
  const v = decideGatekeeper(validInput({ public_balance: "999" }), neverSeen);
  assert.equal(v.reason_code, "THRESHOLD_MISMATCH");
});

test("threshold boundary: balance exactly at minimum approves", () => {
  const v = decideGatekeeper(validInput({ public_balance: "1000" }), neverSeen);
  assert.equal(v.decision, "APPROVE");
});

test("reused proof rejects", () => {
  const v = decideGatekeeper(validInput(), (tx) => tx === "0xproof1");
  assert.equal(v.reason_code, "PROOF_REUSED");
});

test("expired condition rejects (current block past expiry)", () => {
  const v = decideGatekeeper(validInput({ current_block: 19842202 }), neverSeen);
  assert.equal(v.reason_code, "EXPIRED_CONDITION");
});

test("expiry boundary: current block exactly at expiry approves", () => {
  const v = decideGatekeeper(validInput({ current_block: 19842201 }), neverSeen);
  assert.equal(v.decision, "APPROVE");
});

test("recipient mismatch rejects", () => {
  const v = decideGatekeeper(validInput({ recipient: OTHER }), neverSeen);
  assert.equal(v.reason_code, "RECIPIENT_MISMATCH");
});

test("amount overflow rejects (amount above cap)", () => {
  const v = decideGatekeeper(validInput({ amount: "1001" }), neverSeen);
  assert.equal(v.reason_code, "AMOUNT_OVERFLOW");
});

test("amount boundary: amount exactly at cap approves", () => {
  const v = decideGatekeeper(validInput({ amount: "1000" }), neverSeen);
  assert.equal(v.decision, "APPROVE");
});

test("first failing check wins when several apply", () => {
  // VK mismatch AND expired AND wrong recipient -> VK_SUBSTITUTION (check 1).
  const v = decideGatekeeper(
    validInput({ proof_vk: VK_B, current_block: 99999999, recipient: OTHER }),
    neverSeen,
  );
  assert.equal(v.reason_code, "VK_SUBSTITUTION");
});

test("decision is deterministic (same input, same output)", () => {
  const a = decideGatekeeper(validInput(), neverSeen);
  const b = decideGatekeeper(validInput(), neverSeen);
  assert.deepEqual(a, b);
});

// --- Steal the VFY threshold strategy ------------------------------------

test("vfy: extracts when opponent is rich and we are healthy", () => {
  const move = decideVfyMove(
    { selfBalance: 95, opponentBalance: 105, selfFortifiedUntilTurn: null, opponentFortifiedUntilTurn: null },
    3,
    [60, 40, 5, 17, 10, 2, 0, 0],
  );
  assert.equal(move.action, "EXTRACT");
  assert.equal(move.amount, 5);
});

test("vfy: fortifies when we are low and opponent is rich", () => {
  const move = decideVfyMove(
    { selfBalance: 30, opponentBalance: 105, selfFortifiedUntilTurn: null, opponentFortifiedUntilTurn: null },
    3,
    [60, 40, 5, 17, 10, 2, 0, 0],
  );
  assert.equal(move.action, "FORTIFY");
});

test("vfy: holds when nothing applies", () => {
  const move = decideVfyMove(
    { selfBalance: 50, opponentBalance: 50, selfFortifiedUntilTurn: null, opponentFortifiedUntilTurn: null },
    3,
    [60, 40, 5, 17, 10, 2, 0, 0],
  );
  assert.equal(move.action, "HOLD");
});

test("vfy: extract amount is capped at the exposed balance", () => {
  // Opponent balance 20, extract amount 8 -> 20 - 8 = 12 >= floor 10, so
  // EXTRACT 8. (With a fortified opponent the exposed balance shrinks by 6.)
  const move = decideVfyMove(
    { selfBalance: 95, opponentBalance: 20, selfFortifiedUntilTurn: null, opponentFortifiedUntilTurn: null },
    3,
    [5, 40, 8, 17, 10, 2, 0, 0],
  );
  assert.equal(move.action, "EXTRACT");
  assert.equal(move.amount, 8);
  const fortified = decideVfyMove(
    { selfBalance: 95, opponentBalance: 20, selfFortifiedUntilTurn: null, opponentFortifiedUntilTurn: 5 },
    3,
    [5, 40, 8, 17, 10, 2, 0, 0],
  );
  // Exposed is 20 - 6 = 14, still enough for 8.
  assert.equal(fortified.action, "EXTRACT");
  assert.equal(fortified.amount, 8);
});

test("vfy: does not extract below the opponent floor", () => {
  const move = decideVfyMove(
    { selfBalance: 95, opponentBalance: 14, selfFortifiedUntilTurn: null, opponentFortifiedUntilTurn: null },
    3,
    [5, 40, 5, 17, 10, 2, 0, 0],
  );
  // 14 - 5 = 9 < floor 10 -> no extract; not low either -> HOLD.
  assert.equal(move.action, "HOLD");
});
