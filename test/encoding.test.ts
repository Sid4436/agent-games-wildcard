/** Unit tests for field-element encoding + the publicInputsHash construction. */
import test from "node:test";
import assert from "node:assert/strict";
import { keccak256, encodePacked, toHex } from "viem";
import {
  addressToField,
  computePublicInputsHash,
  hashToField,
  intToField,
  stringToField,
} from "../src/encoding.js";
import { BN128_FIELD_PRIME } from "../src/config.js";

test("hashToField is deterministic and inside the field", () => {
  const a = hashToField("0x7d3a11aa");
  const b = hashToField("0x7d3a11aa");
  assert.equal(a, b);
  assert.ok(BigInt(a) >= 0n && BigInt(a) < BN128_FIELD_PRIME);
});

test("different inputs hash differently", () => {
  assert.notEqual(hashToField("0xaaaa"), hashToField("0xbbbb"));
});

test("stringToField matches keccak256 of the utf8 bytes mod p", () => {
  const expected = (BigInt(keccak256(new TextEncoder().encode("gk_24_9d1"))) % BN128_FIELD_PRIME).toString();
  assert.equal(stringToField("gk_24_9d1"), expected);
});

test("addressToField converts an address to its integer value", () => {
  assert.equal(
    addressToField("0xDe42000000000000000000000000000000009f01"),
    BigInt("0xDe42000000000000000000000000000000009f01").toString(),
  );
});

test("intToField rejects out-of-range values", () => {
  assert.throws(() => intToField("-1"), /outside the BN128 field/);
  assert.throws(() => intToField(BN128_FIELD_PRIME), /outside the BN128 field/);
  assert.equal(intToField("42"), "42");
});

test("computePublicInputsHash matches an independent ABI-packed computation", () => {
  // Independent reference: viem encodePacked + keccak256, per the /build guide.
  const input = {
    commitment: "0x7d3a11aa22bb33cc44dd55ee66ff77889900aabbccddeeff0011223344556677",
    matchId: "9f4e1b2a-5c6d-7e8f-90a1-b2c3d4e5f6a7",
    turn: 3,
    selfBalance: 95,
    opponentBalance: 105,
    action: "EXTRACT" as const,
    amount: 5,
  };
  const expected = keccak256(
    encodePacked(
      ["bytes32", "bytes32", "uint256", "uint256", "uint256", "uint256", "uint256", "uint256"],
      [
        input.commitment as `0x${string}`,
        // matchId is a 16-byte UUID; the guide pads it to 32 bytes big-endian.
        toHex(BigInt(`0x${input.matchId.replace(/-/g, "")}`), { size: 32 }),
        3n,
        95n,
        105n,
        2n, // EXTRACT
        5n,
        1n, // circuitVersion v1
      ],
    ),
  );
  assert.equal(computePublicInputsHash(input), expected);
});

test("publicInputsHash changes when any field changes", () => {
  const base = {
    commitment: "0x7d3a11aa22bb33cc44dd55ee66ff77889900aabbccddeeff0011223344556677",
    matchId: "9f4e1b2a-5c6d-7e8f-90a1-b2c3d4e5f6a7",
    turn: 3,
    selfBalance: 95,
    opponentBalance: 105,
    action: "HOLD" as const,
    amount: 0,
  };
  const h1 = computePublicInputsHash(base);
  assert.notEqual(computePublicInputsHash({ ...base, turn: 4 }), h1);
  assert.notEqual(computePublicInputsHash({ ...base, action: "EXTRACT", amount: 5 }), h1);
});
