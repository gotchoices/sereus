description: When an outside approver signs off on someone joining a network, that approval is not tied to the specific person or the specific join, so a copy of it could be reused to let someone else in — bind each approval to one single join so it can only be spent once.
prereq:
files: schemas/control.qsql, packages/cadre-core/src/control-schema.ts, packages/cadre-core/src/control-database.ts, packages/cadre-core/src/control-formation-recorder.ts, packages/cadre-core/test/control-formation-invite.spec.ts, packages/integration-tests/src/harness/test-network.ts, docs/architecture.md
difficulty: medium
----

# Bind a formation approval to one redemption

## Background

A party may mint an invitation to one of its networks that requires an outside approver to
sign off before anyone redeems it: the invitation carries a `ValidationUrl`, and the party
enrolls the approver's public key in `CadreControl.ValidationKey`. Redeeming writes a
`CadreControl.FormationUsage` row, and its `Authorized` CHECK requires the sign-off to verify
against an enrolled approver key.

Today the approver signs a digest over exactly two values — the invitation token and the
joiner's disclosure text:

```sql
digest('CadreControl.FormationUsage', 'vouch', new.Token, new.Disclosure)
```

Both are attacker-repeatable. One approval therefore authorizes *any* redemption of that
invitation that repeats the same disclosure bytes: an invitation good for five joiners,
approver signs off on joiner A, anyone else holding the token copies A's disclosure and A's
signature into their own redemption and the gate opens. Nothing binds which use this is, which
network row is being formed, or who is joining.

Dormant today — nothing in the repo ever contacts a `ValidationUrl`, so no approvals exist to
capture (see `feat-formation-validation-webhook-unwired`). It goes live the moment that hook
is wired, which is why this lands first.

## The design

**One approval covers one redemption, identified by a nonce the redeeming node mints before it
asks the approver.**

Add a per-row single-use nonce column, `UsageStampId`, and make the joining peer a real column
rather than a write-time context value. The sign-off digest then covers all of it:

```sql
digest('CadreControl.FormationUsage', 'vouch',
       new.Token, new.UsageStampId, new.StrandId, new.PeerId, new.Disclosure)
```

Replay is closed twice over, by two independent mechanisms:

- Presenting the approval *verbatim* (same nonce) is refused by `UsageStampId`'s `unique`
  constraint — the row it covers already exists.
- Presenting it under any *other* redemption (different nonce, network, joiner, or disclosure)
  fails the `verify`, because those values are all inside the signed digest.

### Why a fresh nonce and not `UseNumber`

`UseNumber` would also make an approval single-use — the `(Token, UseNumber)` primary key
admits one row per number — but it is derived from the table's current state: the redeemer
reads `max(UseNumber)+1` just before inserting. Binding it would force the approver to be told
a value that a concurrent redemption can invalidate, so the loser of a race would have to go
back and get a *second* approval for the same joiner (for a manual review queue, a second human
review). A nonce chosen freely by the redeeming node has no such coupling: the loser retries
the insert with the same approval and a new use number, and the approval is still exactly
single-use because the nonce is unique.

This also matches how every other control table already does anti-replay (`OwnerKey`,
`ValidationKey`, `Strand`, `CadrePeer`, `DeviceToken` each carry a `StampId text not null
unique`), so there is one idiom rather than two.

Unlike those tables, `FormationUsage` is append-only (`InsertOnly check on update, delete
(false)`), so a `UsageStampId` is never freed by a delete and needs no `Revocation` tombstone —
uniqueness alone is permanent. Say so in the column comment, so a later reader does not go
looking for the missing `NotRevoked` / `RevocationRecorded` pair.

### Why `PeerId` becomes a column

It is currently a context value that no constraint reads. Two reasons to promote it:

- The digest should be built from `new.*` fields only, like every other authorization rule in
  the schema, so what an approval covers is exactly what the stored row says.
- `FormationUsage` is described as the audit log of invite consumption, and today it does not
  record who consumed. Persisting the joiner is what a later ticket needs in order to *verify*
  that joiner's signature (see "Deliberately out of scope").

`context.PeerSignature` stays in the context list, still unverified, still with its existing
"declared and not checked" note.

### Why `StrandStampId` is not in the digest

`StrandStampId` names the specific `Strand` **row** a consent record attaches to. Binding it
would mean minting the strand's stamp before contacting the approver, which the unbound
redemption path (`redeemInvitation`) currently does inside its own transaction. It buys
nothing that `UsageStampId` + `StrandId` do not already: the nonce makes the approval
single-use outright, and `StrandId` is what the approver actually cares about ("I approved
joining *this* network"). Row-incarnation pinning on top of a strictly single-use approval is
redundant. Note the reasoning in the constraint comment so it is not re-litigated.

## Schema shape

```sql
table FormationUsage (
    Token text,
    UseNumber int,
    UsageStampId text not null unique,  -- single-use nonce for THIS redemption; minted by the
                                        -- redeeming node before it asks the approver, and bound
                                        -- into the vouch digest, so one approval spends once.
                                        -- Append-only table => never freed, no Revocation pair.
    PeerId text not null,               -- the joining peer, bound into the vouch digest.
                                        -- Writer-asserted: context.PeerSignature is still
                                        -- unverified (see debt-formation-usage-peer-signature-unverified).
    Disclosure text,
    StrandId text,
    StrandStampId text not null,
    primary key (Token, UseNumber),
    ...
) with context (PeerSignature text, Now datetime, ValidationKey text null, ValidationSignature text null);
```

`PeerId` leaves the `with context (...)` list; `PeerSignature` stays.

## TS mirror and call sites

- `control-schema.ts` carries a byte-identical copy of the same table — both files change
  together, and `debt-embedded-schema-stale-dist-false-green` exists because they can drift.
- Export a message builder next to `buildAuthorizationMessage` in `control-database.ts` so the
  future webhook signer and the tests build the same bytes the SQL does, in the same field
  order:

  ```ts
  export function formationVouchMessage(fields: {
    token: string; usageStampId: string; strandId: string; peerId: string; disclosure: string;
  }): Uint8Array;
  ```

- `ControlDatabase.redeemInvitation` / `recordFormationUsage`: accept an optional
  `usageStampId` (defaulting to a fresh `generateStampId(localPeerId)`), and make `peerId`
  **required**. Dropping the `peerId ?? localPeerId` fallback is deliberate: with `PeerId`
  inside the signed digest, a caller that gets an approval for joiner X and then forgets to
  pass `peerId` would silently sign for X and insert the local node, failing as an opaque
  `CHECK constraint failed: Authorized`. Required-and-explicit removes that trap. Both methods
  should surface the `usageStampId` actually used (return it, or require the caller to supply
  it) so the caller that contacted the approver can prove the two match.
- `ControlFormationUsageRecorder.recordUsage` / `provisionAndRecord` already pass
  `initiatorKey`; keep that. They do not supply approvals yet — that is the webhook ticket.
- `packages/integration-tests/src/harness/test-network.ts:198` calls `recordFormationUsage` and
  will need the now-required `peerId`.

## Edge cases & interactions

Each of these is a test to write, not just a thing to keep in mind.

- **Cross-joiner replay on a multi-use bound invite** — the headline case. One host strand, one
  invitation with `TotalUses` > 1, an approval issued for joiner A; a second redemption reuses
  A's signature with a different `PeerId` (and its own fresh nonce). Must be rejected by
  `Authorized`.
- **Verbatim replay** — the identical approval re-presented with the *same* `UsageStampId`.
  Rejected, but by the `unique` constraint rather than by `Authorized`; assert the distinct
  rejector so a later refactor cannot collapse the two into one accidental pass.
- **Cross-strand replay** — same token, same joiner, same disclosure, approval filed against a
  different `StrandId`. Rejected.
- **Cross-token replay** — existing behavior (`Token` was already bound); keep a case so it
  does not regress out.
- **Disclosure tamper** — existing behavior; keep a case.
- **Happy path still lands** — an enrolled approver signing the full five-field digest is
  admitted, and the row stores the nonce and peer that were signed.
- **Non-validating invites unaffected** — an invitation with no `ValidationUrl` still redeems
  with no approval at all, now carrying the two new columns.
- **Race retry keeps the approval alive** — two redemptions of the same token collide on the
  `(Token, UseNumber)` primary key; the loser re-inserts with the *same* `usageStampId` and
  approval under a new use number and succeeds. This is the ergonomic property the nonce design
  is chosen for, so pin it. Then confirm the winner's already-committed nonce cannot be
  inserted a second time.
- **Both redemption paths** — `redeemInvitation` (unbound: `Strand` + `FormationUsage` inserted
  in one transaction, mutually-circular deferred CHECKs) and `recordFormationUsage`
  (record-only against a pre-existing host strand). Adding columns must not disturb the
  deferral: both CHECKs must still see both rows at commit.
- **`Monotonic` unaffected** — it reads `committed.FormationUsage`; confirm sequential use
  numbers still come out 1, 2, 3 with the new columns present.
- **Approver removal** — the existing "stops approving future redemptions, does not unwind past
  ones" case must still hold with the new digest.
- **Convergence caveat (comment, not a test)** — `unique` on `UsageStampId` is checked against
  locally visible rows, so two nodes that have not yet converged could each accept the same
  nonce, and both rows survive the merge. Identical in class to the existing `NotRevoked` /
  `StampId` notes on `OwnerKey` / `Strand` / `ValidationKey`; the digest binding still holds on
  both nodes, and the outcome is a duplicated audit row rather than an unapproved join. Record
  it as a `NOTE:` on the column, do not chase it here.

## Deliberately out of scope

- **Verifying `context.PeerSignature`.** `PeerId` is writer-asserted, so binding it stops an
  approval from being *re-filed under a different joiner's name* but does not yet prove the
  named joiner consented. Proving that needs the joiner's signature carried over the formation
  protocol and the joiner's key in a form `verify(...)` accepts, which is protocol plumbing
  belonging with the webhook wiring. Filed as
  `backlog/debt-formation-usage-peer-signature-unverified`.
- **Calling the `ValidationUrl`.** Still `feat-formation-validation-webhook-unwired`; that
  ticket now depends on this one, since the hook must be handed the nonce, strand, and joiner
  to sign over.

## TODO

- Add `UsageStampId text not null unique` and `PeerId text not null` to `FormationUsage` in
  `schemas/control.qsql`; drop `PeerId` from its `with context (...)` list, keep
  `PeerSignature`.
- Rewrite the `Authorized` CHECK's validation branch to verify over
  `digest('CadreControl.FormationUsage', 'vouch', new.Token, new.UsageStampId, new.StrandId, new.PeerId, new.Disclosure)`.
- Replace the `KNOWN GAP:` comment on that CHECK with a statement of what an approval is and is
  not transferable across, plus the `UseNumber`-vs-nonce and omitted-`StrandStampId` reasoning.
  The stale `tickets/backlog/debt-formation-approval-signature-replayable.md` path in that
  comment goes away with it.
- Mirror every schema edit into `packages/cadre-core/src/control-schema.ts` byte-for-byte.
- Export `formationVouchMessage` from `control-database.ts`, built on the existing
  `controlAuthorizationFields` / `buildAuthorizationMessage` pair so the field vector has one
  definition.
- Thread `usageStampId` (optional, defaulted to a fresh `generateStampId`) and required
  `peerId` through `redeemInvitation`, `recordFormationUsage`, and the shared
  `execFormationUsageInsert`; surface the nonce actually used back to the caller.
- Update `ControlFormationUsageRecorder` doc comments where they describe `PeerId` as
  "advisory" — it is now signed over.
- Update `packages/integration-tests/src/harness/test-network.ts:198` for the required
  `peerId`.
- Extend `packages/cadre-core/test/control-formation-invite.spec.ts`: update the `vouch` helper
  and `rawInsertFormationUsage` for the new field vector and columns, then add a case for every
  bullet in *Edge cases & interactions*.
- Update `docs/architecture.md`: the `ValidationKey` row (line ~35) still says "including the
  sign-off digest's known replay gap" — replace with what the approval now binds; the
  `FormationUsage` row (line ~40) should say the log records the joining peer and a per-
  redemption nonce.
- Run `yarn lint`, `yarn build`, and the `cadre-core` test suite in the foreground with `tee`.

## Discovery notes (interrupted run, 2026-07-30 — no code changed yet)

A prior run read the relevant files and hit its token budget before editing. **Nothing in the
working tree was modified**; the whole TODO above is still outstanding. What that run learned,
so the next one does not pay for it again:

### Exact edit sites

- `schemas/control.qsql` — `table FormationUsage` is lines 479–550. The `vouch` digest is
  line 530; the `KNOWN GAP:` comment to replace is lines 522–526; the `with context (...)`
  list carrying `PeerId` is line 550.
- `packages/cadre-core/src/control-schema.ts` — same table at lines 490–561 (digest line 541,
  `KNOWN GAP:` lines 533–537). **This file is one big TypeScript template literal**
  (`export const CONTROL_SCHEMA = \`-- This manages ...\``), so every backtick inside the SQL
  comments is written escaped (`` \` ``). Mirroring is byte-identical *after* accounting for
  that escaping — the new comments contain no backticks, so a straight copy works, but do not
  introduce any. The drift guard is
  `packages/cadre-core/test/control-schema-drift.spec.ts`.
- `packages/cadre-core/src/control-database.ts` — `buildAuthorizationMessage` at line 115
  (build `formationVouchMessage` next to it, over `controlAuthorizationFields`);
  `redeemInvitation` at 970; `recordFormationUsage` at 1034; the shared
  `execFormationUsageInsert` at 1068 (its `insert` statement, line 1090, is the one that gains
  the two columns and drops `PeerId` from the context list).
- `packages/cadre-core/src/control-formation-recorder.ts:89` — the doc comment that calls
  `PeerId` "advisory".
- `docs/architecture.md:35` (the `ValidationKey` row, phrase "including the sign-off digest's
  known replay gap") and `docs/architecture.md:40` (the `FormationUsage` row, currently just
  "Audit log of formation invite consumption").

### Call sites affected by making `peerId` required

`packages/integration-tests/src/harness/test-network.ts:198` **already passes**
`peerId: joiner.partyId` — contrary to the TODO above, it needs no change. Likewise
`ControlFormationUsageRecorder.recordUsage` / `provisionAndRecord` already pass `initiatorKey`.

The real cost is the specs, which call both methods with no `peerId` and will stop compiling:

- `packages/cadre-core/test/control-formation-invite.spec.ts` — `redeemInvitation` at 152,
  180, 198, 219, 237, 255, 452, 481, 519, 520; `recordFormationUsage` at 268, 269, 321, 505,
  637, 652, 663, 680, 701, 718, 729, 742, 949. (543/544 already pass `peerId`.)
- `packages/cadre-core/test/control-revocation-replay.spec.ts` — `redeemInvitation` at 702,
  732, 771, 780, 797, 809, 844; `recordFormationUsage` at 824, 860.

Mechanical, but it is most of the diff — budget for it.

### Test-harness details

- The `vouch` helper the validation-branch block signs with is
  `control-formation-invite.spec.ts:602–606`; the raw insert helper is
  `rawInsertFormationUsage` at lines 70–83 (it hardcodes `PeerId = 'peer-raw'` in the context
  list and inserts `(Token, UseNumber, Disclosure, StrandId, StrandStampId)`). Both need the
  new field vector / columns before any new case can be written.
- **`expectConstraintFailure` cannot express the verbatim-replay case.** It matches
  `/CHECK constraint failed: (<names>)\b/` (`test/control-constraint-helpers.ts:24`), and the
  verbatim replay is rejected by `UsageStampId`'s `unique` constraint, not by a named CHECK.
  Assert that one with a distinct matcher on the uniqueness error, and keep it distinct
  deliberately — the ticket's "assert the distinct rejector" bullet is exactly this. Confirm
  the engine's actual unique-violation message text before pinning a regex to it.
- Every case in the `FormationUsage.Authorized validation-key branch` block records against a
  pre-existing owner-signed strand via `recordFormationUsage` precisely so `Authorized` is the
  only constraint that can reject (single-rejector technique, documented at spec:584–596).
  New cross-joiner / cross-strand replay cases should keep that shape.
