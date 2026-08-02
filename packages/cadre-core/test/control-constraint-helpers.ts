import { expect } from 'vitest';
import {
  generatePrivateKey,
  getPublicKey,
  sign as cryptoSign,
  randomBytes,
} from '@optimystic/quereus-plugin-crypto';
import { buildAuthorizationMessage } from '../src/control-database.js';

/**
 * Assert a control-plane write was rejected by one of the NAMED CHECK constraints, not by
 * an incidental SQL, binding, or transaction error.
 *
 * A bare `rejects.toThrow()` goes green on a mistyped statement, which would silently
 * retire the attack the test claims to pin — so every authorization rejection assertion in
 * the `CadreControl` suites routes through here. Shared by every `CadreControl` spec that
 * asserts a rejection (`control-revocation-replay`, `control-authorization-binding`,
 * `control-authorization-domain-separation`, `control-ownerkey-self-authorization`): they
 * are halves of the same rule set and must agree on what "rejected by the schema" looks like.
 *
 * Passing MORE THAN ONE constraint name widens the assertion, so callers should instead
 * arrange the write so exactly one constraint can fail (e.g. a delete-authorization test
 * files its `Revocation` tombstone in the same transaction, satisfying
 * `RevocationRecorded` and leaving only `AuthorizedDelete` able to reject).
 *
 * NOTE: that single-rejector technique leans on Quereus reporting ONE violated deferred
 * constraint per commit. If the engine ever reports a different one of several violated
 * deferred CHECKs, these name assertions become flaky — diagnose it as an engine
 * reporting change, do not widen the accepted-name list to make the suite green.
 */
export function expectConstraintFailure(write: Promise<unknown>, ...constraints: string[]) {
  return expect(write).rejects.toThrow(
    new RegExp(`CHECK constraint failed: (${constraints.join('|')})\\b`),
  );
}

/**
 * Assert a write was refused by a `unique` / primary-key collision on the named columns —
 * the OTHER way the control schema refuses a replay, for the anti-replay stamp columns whose
 * uniqueness is enforced on the insert itself rather than as a named deferred CHECK.
 *
 * Columns are given fully qualified and in the order the schema declares them, e.g.
 * `expectUniqueViolation(write, 'FormationUsage.UsageStampId')` or, for a composite key,
 * `expectUniqueViolation(write, 'FormationUsage.Token', 'FormationUsage.UseNumber')`.
 *
 * NOTE: unlike a named CHECK, this message is not something the schema promises — it is the
 * wording the optimystic vtab renders (`optimystic-module.ts` → `uniqueConstraintMessage`,
 * which qualifies by table name only, no schema prefix). It lives here rather than inline at
 * each call site so a reworded storage-layer error is one edit, and so a spec that greps green
 * cannot quietly be reading a DIFFERENT failure than the collision it means to pin.
 */
export function expectUniqueViolation(write: Promise<unknown>, ...columns: string[]) {
  const escaped = columns.map(column => column.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return expect(write).rejects.toThrow(
    new RegExp(`UNIQUE constraint failed: ${escaped.join(', ')}`, 'i'),
  );
}

// ── Shared signing fixtures for the CadreControl authorization suites ─────────
//
// Lifted from `control-revocation-replay.spec.ts` when the `Revocation` re-issue
// coverage split into its own spec (`control-revocation-reissue.spec.ts`) — both
// suites drive the same owner-signed write shapes and must agree on how a test
// owner signs.

export interface KeyPair {
  privateKey: string;
  publicKey: string;
}

export function freshKeyPair(): KeyPair {
  const privateKey = generatePrivateKey('ed25519', 'base64url') as string;
  return {
    privateKey,
    publicKey: getPublicKey(privateKey, 'ed25519', 'base64url', 'base64url') as string,
  };
}

/** A fresh one-off `StampId` nonce, sized like production's (generateStampId). */
export const freshStamp = (): string => randomBytes(256, 'base64url') as string;

/** ed25519-sign the raw canonical message bytes (no pre-hash), as the schema's verify expects. */
export function signAs(kp: KeyPair, message: Uint8Array): string {
  return cryptoSign(message, kp.privateKey, 'ed25519', 'bytes', 'base64url', 'base64url') as string;
}

/** ed25519-sign a base64url digest STRING (the peer-authorization helper encoding). */
export function signB64(kp: KeyPair, digestB64url: string): string {
  return cryptoSign(digestB64url, kp.privateKey, 'ed25519', 'base64url', 'base64url', 'base64url') as string;
}

/** `Revocation.Authorized` binds the whole tombstone row under its own domain tag. */
export const revocationMessage = (tableName: string, rowKey: string, stampId: string): Uint8Array =>
  buildAuthorizationMessage('CadreControl.Revocation', 'remove', [tableName, rowKey, stampId]);

/**
 * `Revocation.AuthorizedReissue` binds the identity triple PLUS the new counter under the
 * distinct 'reissue' action tag. `reissuedAt` rides as `String(reissuedAt)` because the
 * schema digests `cast(new.ReissuedAt as text)` — every digest field is TEXT on both
 * sides (see `buildAuthorizationMessage`), and the pairing is pinned end-to-end by the
 * happy-path test in `control-revocation-reissue.spec.ts`.
 */
export const reissueMessage = (
  tableName: string,
  rowKey: string,
  stampId: string,
  reissuedAt: number,
): Uint8Array =>
  buildAuthorizationMessage('CadreControl.Revocation', 'reissue', [tableName, rowKey, stampId, String(reissuedAt)]);
