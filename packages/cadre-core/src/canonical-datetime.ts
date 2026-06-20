import type { Database } from '@quereus/quereus';

/**
 * Canonicalise an epoch-ms timestamp to the exact `datetime` string Quereus stores,
 * by round-tripping through the engine's own `datetime(?)` scalar — the same parse
 * the `datetime` column coercion uses.
 *
 * **Stored form:** a `datetime` column always stores and reads back values as
 * `YYYY-MM-DDTHH:MM:SS[.frac]` (T-separated, no trailing Z). Any valid input —
 * space-form (`YYYY-MM-DD HH:MM:SS`), T-form, or ISO-Z (`...T...000Z`) — is
 * coerced to this form on read; ordering over a `datetime` column is therefore
 * chronologically correct regardless of which input form was inserted.
 *
 * **Raw bound-parameter comparisons:** Quereus only coerces operands that carry
 * `datetime` semantics (typed columns or explicit `cast(... as datetime)`). A raw,
 * un-coerced bound parameter is compared lexically. To avoid mis-ordering, anything
 * compared against a `datetime` column value via a raw `> ?` should be produced by
 * this helper (or `datetime()` / an explicit cast), so both sides are T-form.
 *
 * This avoids a hand-rolled ISO formatter whose fractional-second handling could
 * diverge from Temporal. Any signed payload segment that must byte-match a
 * `datetime`-typed column value AFTER coercion (e.g. the control-layer
 * `FormationInvite.ExpiresAt` or the strand-layer `Invite.Expiration`) must be
 * produced this way, so the signer and the deferred CHECK verifier agree exactly.
 *
 * Pure scalar eval (no network) — safe to call on any composed Quereus database.
 *
 * @param db - The Quereus database to evaluate against.
 * @param epochMs - The timestamp in epoch milliseconds.
 * @returns The engine-canonical `datetime` string for that instant (T-separated ISO,
 *   no trailing Z).
 * @throws If the `datetime()` eval returns no row.
 */
export async function canonicalDatetime(db: Database, epochMs: number): Promise<string> {
  for await (const row of db.eval('select datetime(?) as Canonical', [epochMs])) {
    return row.Canonical as string;
  }
  throw new Error('datetime() canonicalisation returned no row');
}
