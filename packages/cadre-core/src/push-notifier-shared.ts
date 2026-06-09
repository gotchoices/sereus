/**
 * push-notifier-shared.ts — internal helpers shared by the FCM and APNs
 * push-notifier implementations. Server-only (used only by modules that already
 * reach for `node:crypto` / `node:http2`); never re-exported from the package
 * entry. Centralized so the secret-redaction and payload-bounding rules have a
 * single, hardenable source rather than drifting between the two transports.
 */

/** Defensive cap on the free-form `reason` carried in a strand-wake payload. */
export const MAX_REASON_LEN = 256;

/** Base64url-encode the JSON form of an object (JWT header/claims segments). */
export function b64urlJson(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj)).toString('base64url');
}

/** A short, secret-free string for an unknown thrown value. */
export function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Redact a device token to a short, non-reversible prefix for debug lines — the
 * full FCM/APNs token is a secret and must never reach a log.
 */
export function redact(token: string): string {
  return token.length <= 8 ? '…' : `${token.slice(0, 6)}…`;
}
