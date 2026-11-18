/**
 * Field-element encoding helpers.
 *
 * The official Agent Games circuits take field elements (BN128 scalar field).
 * Off-chain values must be mapped into the field in a documented, deterministic
 * way:
 *
 * - Ethereum addresses ("0x...") -> the integer value of the address
 *   (160 bits, always below the field prime).
 * - Hex hashes / arbitrary strings -> keccak256, reduced mod the field prime.
 * - Decimal strings / numbers -> BigInt, range-checked against the prime.
 *
 * The gatekeeper circuit only constrains RELATIONS between its inputs
 * (vk hashes equal, balance >= minimum, recipient equal, ...), so the exact
 * hash function used for `registeredVkHash` / `proofVkHash` / `taskId` does
 * not change whether a proof verifies — it only has to be applied
 * consistently to both sides of an equality. keccak256 is used because it is
 * the Ethereum-native hash and the one the platform's own tooling uses
 * (see the publicInputsHash construction in the /build guide, which is
 * keccak256 over ABI-packed fields).
 */
import { keccak256, toHex } from "viem";
import { BN128_FIELD_PRIME } from "./config.js";

/** keccak256 of a hex string, reduced mod the BN128 field prime. */
export function hashToField(hex: string): string {
  const digest = keccak256(hex as `0x${string}`);
  return (BigInt(digest) % BN128_FIELD_PRIME).toString();
}

/** keccak256 of a UTF-8 string, reduced mod the field prime. */
export function stringToField(text: string): string {
  const bytes = new TextEncoder().encode(text);
  const hex = `0x${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}` as `0x${string}`;
  return hashToField(hex);
}

/** Ethereum address (0x...) -> decimal string of its integer value. */
export function addressToField(address: string): string {
  const value = BigInt(address);
  if (value >= BN128_FIELD_PRIME) {
    throw new Error(`address ${address} is outside the BN128 field`);
  }
  return value.toString();
}

/** Decimal string / number / bigint -> decimal string, range-checked. */
export function intToField(value: string | number | bigint): string {
  const n = BigInt(value);
  if (n < 0n || n >= BN128_FIELD_PRIME) {
    throw new Error(`value ${value} is outside the BN128 field`);
  }
  return n.toString();
}

/** Encode a task id string ("gk_24_9d1") as a field element. */
export function taskIdToField(taskId: string): string {
  return stringToField(taskId);
}

/**
 * Steal-the-VFY publicInputsHash, exactly as specified in the Agent Games
 * /build guide: keccak256 of the ABI-packed fields, each padded to 32 bytes
 * big-endian: commitment, matchId (UUID dashes removed), turn, selfBalance,
 * opponentBalance, action code (HOLD 0 / FORTIFY 1 / EXTRACT 2), amount,
 * circuitVersion ("v1" -> 1).
 */
export function computePublicInputsHash(input: {
  commitment: string;
  matchId: string;
  turn: number | bigint;
  selfBalance: number | bigint;
  opponentBalance: number | bigint;
  action: "HOLD" | "FORTIFY" | "EXTRACT";
  amount: number | bigint;
  circuitVersion?: number | bigint;
}): string {
  const actionCode = { HOLD: 0n, FORTIFY: 1n, EXTRACT: 2n }[input.action];
  const packed = [
    toHex(BigInt(input.commitment), { size: 32 }),
    toHex(BigInt(`0x${input.matchId.replace(/-/g, "")}`), { size: 32 }),
    toHex(BigInt(input.turn), { size: 32 }),
    toHex(BigInt(input.selfBalance), { size: 32 }),
    toHex(BigInt(input.opponentBalance), { size: 32 }),
    toHex(actionCode, { size: 32 }),
    toHex(BigInt(input.amount), { size: 32 }),
    toHex(BigInt(input.circuitVersion ?? 1n), { size: 32 }),
  ]
    .map((h) => h.slice(2))
    .join("");
  return keccak256(`0x${packed}` as `0x${string}`);
}
