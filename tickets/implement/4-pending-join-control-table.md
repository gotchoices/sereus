description: Add a table to a party's own control database that remembers a join request it could not finish yet, with its outcome once known, so every machine of the party can see it and carry it on.
architecture: docs/strands.md#what-a-joiners-node-remembers
files: schemas/control.qsql (JoinedStrand ~370 as the template, Revocation ~877-940), packages/cadre-core/src/control-schema.ts (mirror of control.qsql), packages/cadre-core/src/control-authorization.ts (ControlTable ~42, RevocableTable ~68), packages/cadre-core/src/control-database.ts (insertJoinedStrand ~1675, deleteJoinedStrand ~1705, deleteGuardedRow, reapRevokedRows, queryRevocations), packages/cadre-core/src/types.ts, packages/cadre-core/test/control-joined-strand.spec.ts (template), packages/cadre-core/test/control-revocation-reap.spec.ts, packages/cadre-core/test/control-revocation-replay.spec.ts, packages/cadre-core/test/control-schema-apply-unwind.spec.ts, packages/cadre-core/test/control-start-storage-op-budget.spec.ts, packages/cadre-core/test/control-revocation-ledger-marker.spec.ts, packages/integration-tests/src/scenarios/control-cross-machine-unique-column.integration.ts, docs/architecture.md (control table list ~40-45)
----
# `CadreControl.PendingJoin`: a party-wide record of a join still in progress

Part of gotchoices/sereus#25 (split from the plan ticket `durable-pending-join`). This ticket adds the table and the `ControlDatabase` methods only. `pending-join-retry-loop` adds the `CadreNode` API and the loop that uses them. Commit `b32bad70` (`joined-strand-control-table`) added a table of the same shape and is the template: follow its file list.

## Why a control row

The issue asks for the attempt to survive the device, and the maintainer asked that the whole party, not one device, be "trying". The control database is the one store every machine of the party reads, and `JoinedStrand` already established the pattern for a party-private secret (the joined strand's read key) replicated to every machine under the accepted risk in `docs/strands.md` → "Closed-Strand Member Key Handling". The invitation is a bearer credential of the same class.

## Schema

```sql
-- A join THIS party asked for and has not finished, or finished and not yet dismissed.
table PendingJoin (
    Id text primary key,           -- base64url sha256 of the invitation token: one row per invitation,
                                   -- and the append-only Revocation ledger never holds the token itself
    Invitation text not null,      -- CadreNode.encodeInvitation(invitation): token, sAppId, expiration, bootstrap
    Disclosure text not null,      -- canonicalJson of the disclosure the requester gave (formation overrides partyId per attempt)
    RequestedAt integer not null,  -- epoch ms
    ExpiresAt integer not null,    -- epoch ms; no attempt starts at or after it
    Outcome text null,             -- null while pending | 'joined' | 'failed'
    OutcomeAt integer null,
    StrandId text null,            -- 'joined': the strand the formation returned
    MembershipInvite text null,    -- 'joined', closed strand: JSON {inviteKey, invitePrivateKey} the formation delivered
    FailureCode text null,         -- 'failed': a FormationRejectionCode, 'expired', or 'local'
    FailureReason text null,       -- 'failed': human-readable text
    StampId text not null unique,
    ...
) with context (OwnerKey text, Signature text);
```

Constraints, each mirroring the `JoinedStrand` constraint of the same name unless stated:

- `NotRevoked`, `RevocationRecorded` (tombstone `RowKey` = `Id`), `NoUpdate`.
- `KnownOutcome`: `Outcome` is null, `'joined'` or `'failed'`.
- `OutcomeShape`: pending means `OutcomeAt`, `StrandId`, `MembershipInvite`, `FailureCode` and `FailureReason` are all null. `'joined'` means `OutcomeAt` and `StrandId` are not null and the failure columns are null. `'failed'` means `OutcomeAt` and `FailureCode` are not null and `StrandId` and `MembershipInvite` are null.
- `AuthorizedInsert`: owner-signed `digest('CadreControl.PendingJoin', 'add', Id, Invitation, Disclosure, RequestedAt, ExpiresAt, Outcome, OutcomeAt, StrandId, MembershipInvite, FailureCode, FailureReason, StampId)`. Nullable columns sign as `''` via `coalesce`, and integers as their text (`cast(... as text)`, the `CadrePeer` publish digest's form). Owner-signed only. Who else might write here is the open decision in `blocked/decide-non-owner-machine-completes-a-pending-join`. Do not add a non-owner branch.
- `AuthorizedDelete`: owner-signed `'remove'` digest over (`Id`, `StampId`), **or** the reap branch (a committed tombstone for this exact `Id` and `StampId`). Reap is allowed, as on `JoinedStrand`, because nothing here is stored only here: the inviter's party holds the `FormationInvite` row, the user holds the shared link, and the membership invitation is a copy of what the inviter issued.

Then:

- `Revocation`: add `'PendingJoin'` to the `TableName` and `RowKey` comments and a `RowIsGone` branch. Check whether `Revocation`'s `Authorized` rule enumerates tables, and if so add it there too.
- `control-authorization.ts`: add `'PendingJoin'` to `ControlTable` and `RevocableTable`.

**The membership invitation in a control row.** `StrandMembershipInvite`'s doc says it is "never written to either side's control DB". That rule was written when only the formation's own process ever needed it. A join completed in the background may be finished on one machine and launched first on another (`pending-join-retry-loop` covers this), so the joining party's copy moves into this owner-signed, party-private row, beside `JoinedStrand.MemberPrivateKey` and `StrandPartyKey.PrivateKey`, which are stronger secrets than a single-use, 7-day invitation. Update that doc comment to say so. The inviter's side is unchanged.

## `ControlDatabase` methods

Typed row `PendingJoinRow` in `types.ts`, with columns as above and `Outcome` typed `null | 'joined' | 'failed'`.

- `queryPendingJoins(): Promise<PendingJoinRow[]>` and `queryPendingJoin(id)`. Retired stamps are filtered out the way `queryJoinedStrands` filters them.
- `insertPendingJoin(row without StampId, ownerKey, signMessage)`. Fails with a primary-key violation when the id exists. Expose an `isPendingJoinConflict(error)` (or reuse `isStrandIdConflict`'s pattern) so the caller can adopt the existing row.
- `replacePendingJoin(expectedStampId, next, ownerKey, signMessage)`: in **one** locked transaction, check the live row's `StampId` equals `expectedStampId` (otherwise throw `PendingJoinChangedError` and write nothing), delete it with its tombstone, and insert `next` under a fresh stamp. This is the only way an outcome is written. One transaction keeps every reader from seeing the row missing in between. Across machines, two concurrent replacements of the same incarnation cannot both commit: the second fails on the primary key or the stale stamp, and the caller re-reads.
- `deletePendingJoin(id, ownerKey, signMessage)`: remove with tombstone; a no-op returning `false` when absent, like `deleteJoinedStrand`.
- The reap sweep (`reapRevokedRows`) and the re-issue sweep pick the table up through `RevocableTable`. Confirm by reading both.

Which transitions are allowed (pending→joined, pending→failed, failed→joined, terminal→pending on a re-request, any→removed) is `CadreNode` policy in `pending-join-retry-loop`, not a schema rule: every writer is an owner.

## Edge cases & interactions

- **Schema mirror.** `control-schema.ts` must match `schemas/control.qsql`. `control-schema-drift.spec.ts` enforces this; run it.
- **Start-up storage budget.** A new table adds collection reads at start. `control-start-storage-op-budget.spec.ts` counts them. Update its numbers with the measured value, and say so in the handoff.
- **Schema apply on an existing database.** `control-schema-apply-unwind.spec.ts` lists the tables. Add the new one. A party already running gets the table on its next start through the normal schema apply; there is no migration (no backwards compatibility yet).
- **The token never reaches the Revocation ledger.** `Id` is a hash. Verify by inspection that no log line prints `Invitation` or `MembershipInvite` (ids and outcome only).
- **Cross-machine unique column.** `control-cross-machine-unique-column.integration.ts` enumerates the tables with a `unique` StampId. Add this one where the `JoinedStrand` commit did.
- **Row size.** `Invitation` is a few kilobytes at most (`invitation-names-every-party-machine` caps the addresses). No new limit is needed. Note it in the column comment.

## Tests

Model on `control-joined-strand.spec.ts`, keeping only what pins a rule a type cannot:

- an owner-signed insert lands, and an insert signed by an enrolled non-owner peer key is refused (the authorization rule);
- `OutcomeShape` refuses a `'joined'` row with no `StrandId` and a pending row carrying a `FailureCode` (one test, two cases);
- `replacePendingJoin` moves pending → joined in one transaction (the old stamp is retired and the new row is live), and a call with a stale `expectedStampId` throws `PendingJoinChangedError` and writes nothing;
- the reap branch deletes a row whose tombstone is committed. Add a case to `control-revocation-reap.spec.ts` rather than a new file.

## TODO

- Add the table to `schemas/control.qsql` and `control-schema.ts`; update `Revocation`'s comments and `RowIsGone`.
- Add `'PendingJoin'` to the authorization table types.
- `PendingJoinRow`, the query, insert, replace and delete methods, and `PendingJoinChangedError`.
- Update `StrandMembershipInvite`'s doc comment (`types.ts`) on where the joiner's copy may be stored.
- Update the existing specs that enumerate control tables; add the tests above.
- Docs: a `PendingJoin` row in the control-table list in `docs/architecture.md`, and add `PendingJoin` to the `Revocation` row's table list. The behaviour belongs to the next ticket's docs; this one documents the table only.
- `yarn lint`, `yarn typecheck`, `yarn workspace @serfab/cadre-core test`.
