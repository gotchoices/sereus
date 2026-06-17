description: A strand invitation's expiry date is recorded but never checked, so an expired invite can still be used to join — add the missing time check so expired invitations are rejected.
prereq:
files: schemas/strand.qsql, packages/quereus-plugin-sereus/src/strand-schema.ts, packages/cadre-core/src/strand-membership-writer.ts, packages/cadre-core/src/strand-member-registry.ts, packages/cadre-core/src/canonical-datetime.ts, packages/cadre-core/test/strand-membership-invite.spec.ts
difficulty: medium
----

# Implement: enforce `Strand.Invite.Expiration` at consume + in the join pre-flight

## Summary of the bug (reproduced / researched)

`Invite.Expiration` is canonicalised, folded into the issuance signature, and stored — but
**no code path ever compares it against the current time.** An invite whose `Expiration` is
in the past is fully consumable, indefinitely.

Confirmed by reading the consume path end-to-end:

- `schemas/strand.qsql` / `strand-schema.ts` → `ConsumedInvite` carries four checks
  (`InsertOnly`, `InviteExists`, `MemberExists`, `ValidUsage`, `MemberValid`) — **none**
  references `Invite.Expiration` or any "now". `ValidUsage` only checks the invite-key
  signature.
- `Invite.InviteValid` (issuance) folds `Expiration` into the signed payload only to bind it
  against tampering; it does **not** reject a past expiry at issue time.
- `StrandMemberVerifier.isAuthorizedToJoin` (`strand-member-registry.ts:82-93`) runs
  `select count(1) from Strand.Invite` with **no** expiry filter, so an expired invite still
  reads as "door is open".

There is no reproducing test today because there is no enforcement to assert against — the
existing expiry tests only prove the canonical datetime *round-trips*, not that an *expired*
invite is *rejected*. The TODO below adds those tests.

## The proven pattern to copy (control layer)

The control layer already does exactly what this ticket needs, with passing tests. Use it as
the template:

- `schemas/control.qsql` `FormationUsage.Authorized` (line ~172):
  `and (FI.ExpiresAt is null or FI.ExpiresAt > context.Now)`
  with `... with context (... Now datetime ...)` (line ~177).
- `ControlDatabase.execFormationUsageInsert` (`control-database.ts:790-811`) supplies `Now`
  as a string; `redeemInvitation` derives it from an optional `nowMs` param
  (`nowMs ?? Date.now()`), so tests can pin the comparison instant.
- The passing test `control-formation-invite.spec.ts:157` ("rejects redemption against an
  expired invite (nothing lands)") is the shape to mirror for the strand layer.

### One intentional improvement over the control precedent

The control writer passes `context.Now` as a JS **ISO** string (`new Date(ms).toISOString()`,
`control-database.ts:716`), e.g. `2031-03-04T12:34:56.000Z`. Quereus does **not** type-coerce
context params (only column values), so that ISO string is compared lexically against the
`datetime`-coerced (canonical, space-separated `YYYY-MM-DD HH:MM:SS`) `ExpiresAt`. Those two
formats differ at position 10 (`'T'` 0x54 vs `' '` 0x20) and in the `.000Z` suffix, so for
near-same-instant timestamps the lexical `>` can mis-order. The control tests only ever use
far-future / far-past expiries, so the latent skew never bites there.

For the strand layer, produce `context.Now` with the existing `canonicalDatetime(db, nowMs)`
helper (`canonical-datetime.ts`) — the **same** transform `issueInvite` already uses to store
`Invite.Expiration` (`strand-membership-writer.ts:294-295`). Then both sides of
`I.Expiration > context.Now` are byte-identical canonical strings and the lexical comparison
is chronologically correct at any granularity. Do **not** widen scope to "fix" the control
layer here — just note the divergence in code comments so the strand approach is not mistaken
for a copy-paste error.

## Design

### Schema (mirror BOTH copies byte-equivalently)

`schemas/strand.qsql` and the embedded `STRAND_SCHEMA` in
`packages/quereus-plugin-sereus/src/strand-schema.ts` MUST stay byte-equivalent (see the
drift-discipline headers in both files). Make the identical edit in both:

Add a deferred `NotExpired` check to `ConsumedInvite` and add `Now` to its context:

```sql
-- Invite [InviteKey] has been used to add [MemberKey] as a member
table ConsumedInvite (
    InviteKey text primary key,
    MemberKey text,
    constraint InsertOnly check on update, delete (false),
    constraint InviteExists check (exists (select 1 from Invite I where I.Key = new.InviteKey)),
    constraint MemberExists check (exists (select 1 from Member M where M.Key = new.MemberKey)),
    constraint ValidUsage check on insert (
        exists (select 1 from Invite I where I.Key = new.InviteKey and verify(digest(new.InviteKey || '|' || new.MemberKey, 'sha256', 'utf8'), context.InviteSignature, new.InviteKey, 'ed25519'))
    ),
    -- An invite with a non-null Expiration may only be consumed while it is still
    -- in the future. context.Now is the canonical-datetime "now" supplied by the
    -- consumeInvite writer (same canonicalDatetime() transform used to store
    -- Invite.Expiration), so both sides of the comparison are byte-identical
    -- canonical strings and the lexical `>` orders chronologically. A null
    -- Expiration never expires. Mirrors CadreControl.FormationUsage's
    -- `FI.ExpiresAt is null or FI.ExpiresAt > context.Now` gate.
    constraint NotExpired check on insert (
        exists (select 1 from Invite I where I.Key = new.InviteKey and (I.Expiration is null or I.Expiration > context.Now))
    ),
    constraint MemberValid check (exists (select 1 from Member M where M.Key = new.MemberKey))
) with context (InviteSignature text null, Now datetime null);
```

Notes:
- `NotExpired` has a subquery, so (like `ValidUsage`) it auto-defers to commit — consistent
  with the existing consume flow that already commits `Member` + `ConsumedInvite` together.
- `Now` is nullable to match the strand schema's nullable-context style. The null-`Now`
  fallback is safe: a null-expiry invite passes `I.Expiration is null` regardless of `Now`,
  and a set-expiry invite with a null `Now` evaluates `Expiration > null` → unknown → the
  `exists` fails → rejected (fail-closed). The writer always supplies `Now`, so this is only
  a defensive default.

### Writer: `consumeInvite` (`strand-membership-writer.ts:312-384`)

- Add an optional `nowMs?: number` to `ConsumeInviteParams` (default `Date.now()`), mirroring
  the control `redeemInvitation` convention, so tests can pin the instant.
- Before the transaction, compute `const nowCanonical = await canonicalDatetime(db, nowMs ?? Date.now());`
  (`canonicalDatetime` is already imported in this file). Note: plain runtime code — the
  tess `Date.now()` restriction applies only to Workflow scripts, not library code.
- Pass it on the `ConsumedInvite` insert context (the only place that inserts `ConsumedInvite`
  in the codebase — `strand-membership-writer.ts:365-369`):

```ts
await db.exec(
  `insert into Strand.ConsumedInvite (InviteKey, MemberKey)
     with context InviteSignature = ?, Now = ?
     values (?, ?)`,
  [inviteSignature, nowCanonical, inviteKey, memberKey],
);
```

The error/rollback handling already in `consumeInvite` covers a `NotExpired` rejection the
same way it covers the wrong-key (`ValidUsage`) rejection — both deferred checks fire at
commit and roll the whole txn back, so neither the `Member` nor the `ConsumedInvite` row
survives. No structural change to the try/catch is needed.

### Pre-flight parity: `isAuthorizedToJoin` (`strand-member-registry.ts:82-93`)

Filter expired invites out of the "door is open" count so the off-engine pre-flight matches
the on-engine `NotExpired` gate:

```ts
const nowCanonical = await canonicalDatetime(this.db, Date.now());
const invites = await scalarCount(
  this.db,
  'select count(1) as c from Strand.Invite where Expiration is null or Expiration > ?',
  [nowCanonical],
);
return invites > 0;
```

Import `canonicalDatetime` into `strand-member-registry.ts` (currently not imported there).
The `consumed > 0` short-circuit above it is unchanged — a member who already holds a
`ConsumedInvite` is in regardless of any invite's expiry.

## Test coverage to add (`packages/cadre-core/test/strand-membership-invite.spec.ts`)

Pin the comparison instant via `nowMs` rather than relying on wall-clock drift. Use a fixed
base (e.g. `const base = Date.UTC(2031, 2, 4, 12, 0, 0)`):

- **Past-expiry invite rejected + rolls back.** Issue with `expiration: base`, then
  `consumeInvite(db, { inviteKey, invitePrivateKey, memberKey, nowMs: base + 86_400_000 })`
  → `rejects.toThrow()`; assert `Member` count stays 1 and `ConsumedInvite` stays 0 (mirror
  the wrong-key atomic-rollback test at lines 220-234).
- **Future-expiry invite succeeds.** Issue with `expiration: base + 86_400_000`, consume with
  `nowMs: base` → resolves; `Member` = 2, `ConsumedInvite` = 1.
- **Boundary (optional but recommended).** `expiration: base`, `nowMs: base` → rejected
  (`>` is strict; expiry instant is exclusive, matching control's `>`).
- **Null-expiry still consumable (regression).** Issue with no `expiration`, consume → succeeds
  (the existing happy-path test at lines 206-218 already exercises this; an explicit assertion
  that the null-expiry path is unaffected by the new `Now` context is enough).
- **`isAuthorizedToJoin` returns false when the only invite is expired.** Issue an invite that
  is already expired relative to wall-clock now (e.g. `expiration: Date.UTC(2000, 0, 1)`), then
  `new StrandMemberVerifier(db).isAuthorizedToJoin(strandId, someMemberKey)` → `false`. Add a
  sibling positive case (a future-expiry invite → `true`) if not already covered.

## Validation

Run from `packages/cadre-core` (stream output — libp2p tests use 30s timeouts):

```
yarn workspace @serfab/cadre-core test 2>&1 | tee /tmp/cadre-core-test.log
yarn workspace @serfab/cadre-core typecheck 2>&1 | tee /tmp/cadre-core-tc.log
```

Also confirm the schema edit did not break the schema-application e2e (it inserts `Invite`
with null `Expiration` and goes through the writer for any `ConsumedInvite`, so it should be
unaffected, but verify):

```
yarn workspace @serfab/quereus-plugin-sereus test 2>&1 | tee /tmp/sereus-plugin-test.log
```

Run `yarn lint` for the SQL/style gate. Keep SQL reserved words lowercase.

## TODO

- [ ] Add `NotExpired` deferred check + `Now datetime null` context to `ConsumedInvite` in
      `schemas/strand.qsql`.
- [ ] Mirror the identical edit byte-for-byte into `STRAND_SCHEMA`
      (`packages/quereus-plugin-sereus/src/strand-schema.ts`).
- [ ] Add `nowMs?: number` to `ConsumeInviteParams`; compute `canonicalDatetime(db, nowMs ?? Date.now())`
      and pass `Now` on the `ConsumedInvite` insert context in `consumeInvite`.
- [ ] Update the `consumeInvite` doc comment to mention the expiry gate and the canonical-now
      approach (and why it diverges from the control layer's ISO `Now`).
- [ ] Filter expired invites in `StrandMemberVerifier.isAuthorizedToJoin`; import
      `canonicalDatetime` into `strand-member-registry.ts`.
- [ ] Add the consume past/future/boundary/null-expiry tests and the `isAuthorizedToJoin`
      expired test to `strand-membership-invite.spec.ts`.
- [ ] Run cadre-core tests + typecheck, the sereus-plugin e2e, and `yarn lint`; confirm green.

## Notes

Independent of the single-use platform gap (`optimystic-insert-pk-uniqueness-not-enforced`,
backlog) — that one is about duplicate-PK inserts silently overwriting; this is a missing time
comparison and applies even once PK uniqueness is enforced. The existing "KNOWN GAP" double-
consume test (lines 271-290) uses a null-expiry invite, so it is unaffected by this change.
