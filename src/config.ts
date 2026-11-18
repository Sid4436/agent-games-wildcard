/**
 * Configuration: environment variables + protocol constants.
 *
 * All secrets come from the environment only. Nothing secret is hardcoded.
 * See .env.example for the full list.
 */
import "dotenv/config";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import path from "node:path";

/**
 * Find the repo root from a starting directory: the first ancestor that
 * contains both package.json and the circuits/ directory. Works whether the
 * code runs from src/ (tsx) or dist/src/ (compiled output).
 */
export function findRootDir(startDir: string): string {
  let dir = path.resolve(startDir);
  for (let i = 0; i < 8; i++) {
    if (
      existsSync(path.join(dir, "package.json")) &&
      existsSync(path.join(dir, "circuits"))
    ) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(startDir, "..");
}

export const BN128_FIELD_PRIME =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

/** Official Agent Games circuit verification-key hashes (mainnet). */
export const VK_HASH = {
  gatekeeper:
    "0x6b79c6012a6d8651f3e13bc4d2a20370280ab49700c90c5316d4168bfbad77b0",
  vfyPolicy:
    "0x6c56509f1c56fd1fd4e9737f906d2220f4b95f1d507f1adf6899085bd74be047",
} as const;

/** Official circuit artifact URLs (see circuits/CIRCUITS.md for hashes). */
export const CIRCUIT_URL = {
  gatekeeperWasm:
    "https://agentgames.zkverify.io/circuits/gatekeeper.wasm",
  gatekeeperZkey:
    "https://agentgames.zkverify.io/circuits/gatekeeper_final.zkey",
  vfyPolicyWasm:
    "https://agentgames.zkverify.io/circuits/vfy-policy.wasm",
  vfyPolicyZkey:
    "https://agentgames.zkverify.io/circuits/vfy-policy_final.zkey",
} as const;

export type SubmissionProviderName = "offline" | "kurier";

export interface AgentConfig {
  port: number;
  host: string;
  /** HMAC secret issued by the platform (Rotate Secret). Empty = demo mode. */
  hmacSecret: string | undefined;
  submissionProvider: SubmissionProviderName;
  kurierApiKey: string | undefined;
  kurierNetwork: "mainnet" | "testnet";
  dataDir: string;
  /** Private per-agent salt bound into every gatekeeper proof. */
  gatekeeperSalt: string;
  /** Absolute path to the repo root (for circuit artifacts). */
  rootDir: string;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

export function loadConfig(): AgentConfig {
  const rootDir = findRootDir(path.dirname(fileURLToPath(import.meta.url)));
  const providerRaw = (process.env.SUBMISSION_PROVIDER ?? "offline").toLowerCase();
  const submissionProvider: SubmissionProviderName =
    providerRaw === "kurier" ? "kurier" : "offline";
  const kurierNetwork =
    (process.env.KURIER_NETWORK ?? "testnet").toLowerCase() === "mainnet"
      ? "mainnet"
      : "testnet";
  return {
    port: envInt("PORT", 3000),
    host: process.env.HOST ?? "0.0.0.0",
    hmacSecret: process.env.AGENT_GAMES_HMAC_SECRET || undefined,
    submissionProvider,
    kurierApiKey: process.env.KURIER_API_KEY || undefined,
    kurierNetwork,
    dataDir: process.env.DATA_DIR ?? path.join(rootDir, "data"),
    gatekeeperSalt: process.env.GATEKEEPER_SALT ?? "0",
    rootDir,
  };
}

/** Kurier REST base URL for a network (docs: docs.zkverify.io/overview/getting-started/kurier). */
export function kurierApiUrl(network: "mainnet" | "testnet"): string {
  return network === "mainnet"
    ? "https://api.kurier.xyz/api/v1"
    : "https://api-testnet.kurier.xyz/api/v1";
}
