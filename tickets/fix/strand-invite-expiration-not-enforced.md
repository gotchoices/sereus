description: A strand invitation can carry an expiry date, but nothing actually stops an expired invitation from being used to join — the expiry is recorded but never checked.
files: schemas/strand.qsql, packages/quereus-plugin-sereus/src/strand-schema.ts, packages/cadre-core/src/strand-membership-writer.ts, packages/cadre-core/src/strand-member-registry.ts, packages/cadre-core/test/strand-membership-invite.spec.ts
difficulty: medium
----

# Fix: strand `Invite.Expiration` is signed and stored but never enforced

## Problem

The invite → join handshake (`2-strand-membership-invite-join`, now complete) lets an
authority issue an invite with an optional expiry:

```ts
issueInvite(db, { authorityKeyPair, expiration /* epoch-ms */ })
```

The expiry is canonicalised, bound into the issuance signature, and stored in
`Strand.Invite.Expiration`. **But no code path or constraint ever compares that
expiry against the current time.** Concretely:

- `schemas/strand.qsql` / `strand-schema.ts` → `ConsumedInvite.ValidUsage` only checks
  the invite-key signature; there is **no** `NotExpired` constraint. An invite with an
  `Expiration` in the past is fully consumable.
- `Invite.InviteValid` (issuance) folds `Expiration` into the signed payload only to
  prevent tampering — it does not reject a past expiry at issue time either.
- `StrandMemberVerifier.isAuthorizedToJoin` (`strand-member-registry.ts`) counts
  `select count(1) from Strand.Invite` with **no** expiry filter, so an expired invite
  still reads as "door is open".

Net effect: `Expiration` is currently decorative. An invite that was meant to lapse can
still be redeemed indefinitely. The implement-stage tests cover issuing a set-expiry
invite and that the canonical datetime round-trips, which gives a false impression that
expiry "works" — there is no test (because there is no enforcement) that an *expired*
invite is rejected at consume.

## Expected behavior

An invite whose `Expiration` is non-null and in the past must NOT be consumable, and an
expired invite should not count toward `isAuthorizedToJoin`'s "door is open" pre-flight.
A null `Expiration` continues to mean "never expires".

## Things to research / decide

- **Where to enforce.** The natural home is a deferred CHECK on `ConsumedInvite` (e.g. a
  `NotExpired` constraint: the matching `Invite.Expiration` is null or `> <now>`). Confirm
  both schema copies stay byte-equivalent (`schemas/strand.qsql` and the runtime
  `STRAND_SCHEMA` in `packages/quereus-plugin-sereus/src/strand-schema.ts`).
- **Determinism of "now" inside a constraint.** A deferred CHECK referencing
  `datetime('now')` must evaluate consistently and be testable. Investigate whether
  Quereus exposes a deterministic/injectable current-time inside a constraint, or whether
  the comparison value must be supplied as a `with context` parameter (the writer passing a
  canonicalised "now") so tests can pin it. The existing `canonicalDatetime` helper is the
  tool for producing the comparison string either way.
- **Pre-flight parity.** `isAuthorizedToJoin` should filter out expired invites so the
  off-engine pre-flight matches the on-engine gate.

## Test coverage to add

- Consume of an invite whose `Expiration` is in the past is rejected (and rolls back, like
  the wrong-key case).
- Consume of an invite whose `Expiration` is in the future succeeds.
- Null-expiry invite still consumable (regression).
- `isAuthorizedToJoin` returns false when the only invite is expired.

## Notes

This is independent of the single-use platform gap
(`optimystic-insert-pk-uniqueness-not-enforced`, backlog) — that one is about duplicate-PK
inserts silently overwriting; this one is about a missing time comparison and would apply
even once PK uniqueness is enforced.
