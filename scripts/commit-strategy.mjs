/**
 * Commit the strategy: hash strategy/strategy.md into the 64-hex strategy
 * commitment registered with the Agent Games platform.
 *
 *   npm run commit-strategy
 *
 * The commitment is keccak256 of the strategy file (32 bytes = 64 hex
 * characters). The platform freezes it when matches are paired; the strategy
 * text itself is published after the tournament. This script also writes
 * strategy/commitment.json with the file hash, the commitment, and the same
 * value as a BN128 field element (for the policy circuit's `commitment`
 * input).
 *
 * Nothing secret is involved: the strategy file must never contain secrets.
 */
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { keccak256 } from "viem";

const FIELD_PRIME =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const strategyPath = path.join(rootDir, "strategy", "strategy.md");

const content = await readFile(strategyPath);
const sha256 = createHash("sha256").update(content).digest("hex");
const commitment = keccak256(`0x${content.toString("hex")}`);
const fieldElement = (BigInt(commitment) % FIELD_PRIME).toString();

const record = {
  strategyFile: "strategy/strategy.md",
  sha256,
  commitment,
  commitmentFieldElement: fieldElement,
  note: "keccak256 of the strategy file. Register this commitment on the Agent Games dashboard (My Agents -> Edit agent -> Steal the VFY section) before Swiss Round 1 opens.",
  generatedAt: new Date().toISOString(),
};
await writeFile(
  path.join(rootDir, "strategy", "commitment.json"),
  JSON.stringify(record, null, 2) + "\n",
);

console.log("strategy file :", record.strategyFile);
console.log("sha256        :", sha256);
console.log("commitment    :", commitment);
console.log("as field elem :", fieldElement);
console.log("written       : strategy/commitment.json");
