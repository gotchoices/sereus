/**
 * Shape validation for the tenant-supplied `pinnedOwnerKeys` of `POST /containers`
 * — the seed-trust anchors the created node is started with as `CADRE_OWNER_KEYS`.
 *
 * Its own module rather than part of `routes.ts`: the rule is a duplicate of
 * cadre-core's (see {@link validateOwnerKey}), so it is worth reading, testing and
 * changing on its own, without a routing file around it.
 */

import debug from 'debug';
import { fromString as uint8ArrayFromString } from 'uint8arrays';

const log = debug('cadre:provider:owner-keys');

/**
 * Longest rejected key echoed back in an error message — a real key is 43
 * base64url characters. Mirrors `REJECTED_VALUE_ECHO_LIMIT` in
 * `packages/cadre-core/src/ed25519-key.ts`.
 */
const REJECTED_OWNER_KEY_ECHO_LIMIT = 64;

/**
 * Render a rejected key for an error message, capped: `pinnedOwnerKeys` arrives
 * from a tenant over the network, so an unbounded echo would let one junk string
 * become a megabyte of log line.
 */
function describeRejectedOwnerKey(value: string): string {
  return value.length <= REJECTED_OWNER_KEY_ECHO_LIMIT
    ? value
    : `${value.slice(0, REJECTED_OWNER_KEY_ECHO_LIMIT)}… (${value.length} chars)`;
}

/**
 * Reject one `pinnedOwnerKeys` entry that is not shaped like a base64url-encoded
 * 32-byte Ed25519 public key. Returns the trimmed value, so the create request
 * carries exactly what was validated.
 *
 * **This deliberately restates `requireEd25519PublicKeyB64`
 * (`packages/cadre-core/src/ed25519-key.ts`) rather than importing it.**
 * cadre-provider declares no `workspace:` dependencies: depending on
 * `@serfab/cadre-core` would pull libp2p + quereus + optimystic into a thin
 * Docker-host service's install closure, and would invalidate the note in
 * `vitest.config.ts` that this package needs no stale-build guard. `uint8arrays`
 * — the base64url codec cadre-core itself uses — is dependency-light and is not a
 * workspace package, so the rule is restated over it instead. The rule itself is
 * fixed by Ed25519 (a public key is 32 bytes, always), not by our code.
 *
 * Keeping the two copies in step is **manual** — neither package can see the
 * other's rule, so no test can compare them. What the tests give instead is a
 * tripwire on each side: `__tests__/create-container-owner-keys.test.ts` and
 * `packages/cadre-core/test/ed25519-key.spec.ts` each pin their own copy to the
 * same accept/reject table, so changing either rule fails that package's own
 * suite — and the comment above the rule you just changed is what points at the
 * other copy.
 *
 * Curve membership is deliberately NOT checked, matching cadre-core: a
 * well-formed-but-off-curve key fails signature verification later exactly like
 * any other wrong key.
 */
function validateOwnerKey(value: string): { key: string } | { error: string } {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return { error: 'pinnedOwnerKeys entries must not be empty or whitespace-only' };
  }

  let decoded: Uint8Array;
  try {
    decoded = uint8ArrayFromString(trimmed, 'base64url');
  } catch (error) {
    log('rejecting pinnedOwnerKeys entry: %s', error instanceof Error ? error.message : String(error));
    return {
      error: `pinnedOwnerKeys entries must be base64url-encoded Ed25519 public keys (could not decode "${describeRejectedOwnerKey(trimmed)}" as base64url)`,
    };
  }

  if (decoded.length !== 32) {
    return {
      error: `pinnedOwnerKeys entries must be base64url-encoded 32-byte Ed25519 public keys ("${describeRejectedOwnerKey(trimmed)}" decoded to ${decoded.length} bytes)`,
    };
  }

  return { key: trimmed };
}

/**
 * Validate the optional `pinnedOwnerKeys` field of a create request: absent, or an
 * array of base64url-encoded 32-byte Ed25519 public keys (see
 * {@link validateOwnerKey}).
 *
 * Create is the last point at which the caller can still fix a typo, so the shape
 * is checked here: `cadre-cli start` rejects a malformed `CADRE_OWNER_KEYS` entry
 * outright, so without this check a typo'd pin is answered 201 and then produces a
 * container that dies at boot — the caller learning about it, if ever, from
 * container status rather than from a 400 naming the bad key.
 *
 * Every rejection names the offending entry: with several keys in one request the
 * message is the only thing that says WHICH one.
 *
 * @returns the trimmed keys, so the create request carries exactly what was validated.
 */
export function validatePinnedOwnerKeys(value: unknown): { keys?: string[] } | { error: string } {
  if (value === undefined) return {};
  if (!Array.isArray(value) || !value.every((key): key is string => typeof key === 'string')) {
    return { error: 'pinnedOwnerKeys must be an array of strings' };
  }

  const keys: string[] = [];
  for (const entry of value) {
    const checked = validateOwnerKey(entry);
    if ('error' in checked) return checked;
    keys.push(checked.key);
  }
  return { keys };
}
