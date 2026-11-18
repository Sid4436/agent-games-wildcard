/** Unit tests for HMAC request/response signing. */
import test from "node:test";
import assert from "node:assert/strict";
import { signBody, verifySignature } from "../src/hmac.js";

const SECRET = "test-secret-32-bytes-long-value!!";
const BODY = Buffer.from(JSON.stringify({ type: "agent-games.preflight.v1" }), "utf8");

test("sign then verify succeeds", () => {
  const sig = signBody(SECRET, BODY);
  assert.equal(verifySignature(SECRET, BODY, sig), true);
});

test("tampered body fails verification", () => {
  const sig = signBody(SECRET, BODY);
  const tampered = Buffer.from(JSON.stringify({ type: "tampered" }), "utf8");
  assert.equal(verifySignature(SECRET, tampered, sig), false);
});

test("wrong secret fails verification", () => {
  const sig = signBody(SECRET, BODY);
  assert.equal(verifySignature("different-secret", BODY, sig), false);
});

test("missing secret or header fails verification", () => {
  const sig = signBody(SECRET, BODY);
  assert.equal(verifySignature(undefined, BODY, sig), false);
  assert.equal(verifySignature(SECRET, BODY, undefined), false);
  assert.equal(verifySignature(SECRET, BODY, ""), false);
});

test("sha256= prefixed header is accepted", () => {
  const sig = `sha256=${signBody(SECRET, BODY)}`;
  assert.equal(verifySignature(SECRET, BODY, sig), true);
});

test("non-hex header fails verification (no throw)", () => {
  assert.equal(verifySignature(SECRET, BODY, "not-a-hex-signature!!"), false);
});

test("signing is deterministic", () => {
  assert.equal(signBody(SECRET, BODY), signBody(SECRET, BODY));
});

test("different bodies give different signatures", () => {
  const other = Buffer.from("{}", "utf8");
  assert.notEqual(signBody(SECRET, BODY), signBody(SECRET, other));
});
