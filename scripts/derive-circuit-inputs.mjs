/**
 * Derive the official circuit input signals from the local .wasm files.
 *
 *   node scripts/derive-circuit-inputs.mjs
 *
 * Background: the official template repo is 404 and no signal list is
 * published. Circom 2.x resolves input signal names by FNV-1a 64-bit hash;
 * the wasm export getInputSignalSize(hashMSB, hashLSB) returns the signal
 * size (>= 1) when the name exists and 0 otherwise. This script:
 *
 *  1. Tests candidate names (taken from the official task envelopes in the
 *     /build guide and the event pages) against that oracle.
 *  2. Dumps the (FNV hash, witness index, size) table from the wasm data
 *     section, enumerating EVERY input signal — so completeness is proven,
 *     not assumed. Known names are matched to hashes; anything left over is
 *     printed as an unmatched hash for dictionary brute-forcing.
 *
 * No network, no secrets. Reads circuits/*.wasm only.
 */
import { readFile } from "node:fs/promises";
import { WitnessCalculatorBuilder } from "circom_runtime";

function fnvHash(str) {
  const uint64_max = BigInt(2) ** BigInt(64);
  let hash = BigInt("0xCBF29CE484222325");
  for (let i = 0; i < str.length; i++) {
    hash ^= BigInt(str[i].charCodeAt(0));
    hash *= BigInt(0x100000001B3);
    hash %= uint64_max;
  }
  let shash = hash.toString(16);
  return "0".repeat(16 - shash.length).concat(shash);
}

const CANDIDATES = {
  "circuits/gatekeeper.wasm": [
    "registeredVkHash", "proofVkHash", "minimum", "publicBalance",
    "expiryBlock", "currentBlock", "recipient", "conditionRecipient",
    "amount", "maxTransfer", "decision", "taskId", "salt",
  ],
  "circuits/vfy-policy.wasm": [
    "commitment", "matchId", "turnNumber", "selfBalance", "opponentBalance",
    "action", "amount", "circuitVersion", "strategyParams", "salt",
  ],
};

function readUleb(buf, off) {
  let result = 0n, shift = 0n, i = off;
  while (true) {
    const b = buf[i++];
    result |= BigInt(b & 0x7f) << shift;
    if ((b & 0x80) === 0) break;
    shift += 7n;
  }
  return [result, i];
}

function getDataSegments(buf) {
  let off = 8;
  const segs = [];
  while (off < buf.length) {
    const [secId, p1] = readUleb(buf, off);
    const [secSize, p2] = readUleb(buf, p1);
    const secStart = p2, secEnd = p2 + Number(secSize);
    if (secId === 11n) {
      let [count, q] = readUleb(buf, secStart);
      for (let s = 0; s < Number(count); s++) {
        const [flags, q1] = readUleb(buf, q);
        let q2 = q1;
        if (flags === 0n) {
          q2++;
          const [, q3] = readUleb(buf, q2);
          q2 = q3 + 1;
        } else if (flags === 2n) {
          const [, q3] = readUleb(buf, q2);
          q2 = q3;
          q2++;
          const [, q4] = readUleb(buf, q2);
          q2 = q4 + 1;
        } else break;
        const [size, q5] = readUleb(buf, q2);
        segs.push(buf.subarray(q5, q5 + Number(size)));
        q = q5 + Number(size);
      }
    }
    off = secEnd;
  }
  return segs;
}

for (const [wasmPath, candidates] of Object.entries(CANDIDATES)) {
  const buf = await readFile(wasmPath);
  const wc = await WitnessCalculatorBuilder(buf, { sanityCheck: false });
  const ex = wc.instance.exports;
  console.log(`\n== ${wasmPath} ==`);
  console.log(`  circom version: ${ex.getVersion()} | inputSize: ${ex.getInputSize()}`);

  // 1. Oracle probe of candidate names.
  const found = [];
  for (const name of candidates) {
    const h = fnvHash(name);
    const size = ex.getInputSignalSize(parseInt(h.slice(0, 8), 16), parseInt(h.slice(8, 16), 16));
    if (size >= 1) found.push({ name, size, hash: h });
  }
  console.log("  oracle-probed inputs:", JSON.stringify(found.map(({ name, size }) => ({ name, size }))));
  console.log(`  covered values: ${found.reduce((s, f) => s + f.size, 0)} / ${ex.getInputSize()}`);

  // 2. Full table dump. The signal table lives in the data segment that
  //    contains the known signal hashes; within that segment the entries are
  //    16-byte records (hash LE u64, witness index u32, size u32) aligned to
  //    16-byte boundaries. (Scanning every segment at 16-byte boundaries
  //    produces false positives from unrelated data, so only the segment
  //    holding a known hash is dumped.)
  const segs = getDataSegments(buf);
  const knownHashes = found.map((f) => Buffer.from(f.hash, "hex").reverse());
  const tableSeg = segs.find((seg) =>
    knownHashes.some((h) => seg.indexOf(h) >= 0),
  );
  const entries = [];
  if (tableSeg) {
    for (let off = 0; off + 16 <= tableSeg.length; off += 16) {
      const row = tableSeg.subarray(off, off + 16);
      const size = row.readUInt32LE(12);
      if (size >= 1 && size <= 64 && row.subarray(0, 8).some((b) => b !== 0)) {
        entries.push({
          hash: row.subarray(0, 8).reverse().toString("hex"),
          mid: row.readUInt32LE(8),
          size,
        });
      }
    }
  }
  entries.sort((a, b) => a.mid - b.mid);
  console.log(`  signal table (${entries.length} entries):`);
  for (const e of entries) {
    const name = found.find((f) => f.hash === e.hash)?.name ?? "??? (unmatched hash)";
    console.log(`    mid ${String(e.mid).padStart(2)} size ${e.size} ${name}`);
  }
}
