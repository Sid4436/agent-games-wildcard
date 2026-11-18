/**
 * HMAC-SHA256 request/response signing for the Agent Games platform.
 *
 * Protocol (https://agentgames.zkverify.io/build, section 02):
 * - Inbound: the platform sends `x-agent-games-signature` = HMAC-SHA256 of
 *   the RAW request body, keyed with the agent secret issued at registration.
 *   Verify BEFORE parsing JSON. Reject on mismatch.
 * - Outbound: every response carries `x-agent-games-signature` = HMAC-SHA256
 *   of the RAW response body, same key.
 *
 * The secret is a 32-byte random value issued by the platform (Dashboard ->
 * Rotate Secret, shown exactly once). It is loaded from the environment only
 * (AGENT_GAMES_HMAC_SECRET) and never logged.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

/** HMAC-SHA256 hex digest of `body` under `secret`. */
export function signBody(secret: string, body: Buffer | string): string {
  const data = typeof body === "string" ? Buffer.from(body, "utf8") : body;
  return createHmac("sha256", secret).update(data).digest("hex");
}

/**
 * Verify an inbound signature header against the raw body.
 * Accepts a bare hex digest or a "sha256=<hex>" prefixed value.
 * Always uses a timing-safe comparison. Returns false on any mismatch,
 * missing secret, or malformed header — never throws.
 */
export function verifySignature(
  secret: string | undefined,
  body: Buffer,
  signatureHeader: string | undefined,
): boolean {
  if (!secret || !signatureHeader) return false;
  const presented = signatureHeader.startsWith("sha256=")
    ? signatureHeader.slice("sha256=".length)
    : signatureHeader;
  if (!/^[0-9a-fA-F]+$/.test(presented)) return false;
  const expected = signBody(secret, body);
  const a = Buffer.from(presented.toLowerCase(), "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
