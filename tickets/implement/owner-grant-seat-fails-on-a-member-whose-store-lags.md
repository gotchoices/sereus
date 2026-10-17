description: A machine that is already in the cadre, but was offline when an owner grant was made, cannot redeem that grant right after it comes back: copying the grant into its own records fails with a duplicate-key error, because the rest of the cadre already holds that record and this machine has not caught up yet. The copy should count as already done, and a machine that still cannot read the record should get a named "try again" refusal.
architecture: docs/architecture.md#owner-grants
files: packages/cadre-core/src/control-database.ts (seatIssuedRow ~4399, idConflictPattern ~613, redeemOwnerGrant ~4997, redeemCadreInvite ~4740), packages/cadre-core/src/cadre-node.ts (redeemOwnerGrantLocally ~9726), packages/cadre-core/src/owner-grant-protocol.ts (OwnerGrantHandler.redeemAdmitted ~421), packages/cadre-core/src/cadre-invite-protocol.ts (CadreInviteHandler.redeemAdmitted ~530), packages/cadre-core/src/member-redemption.ts (writeFailureRefusal), packages/cadre-core/test/control-owner-grant.spec.ts, packages/cadre-cli/src/commands/start-invitation.ts (describeRedemptionFailure), docs/architecture.md (Owner grants)
repro: verified
----

# Seating an issued row from its bundle fails on a member whose store lags the cohort

## The defect

`ControlDatabase.seatIssuedRow` (the body of `seatOwnerGrant` and `seatCadreInvite`) is an insert-if-absent: under the write lock it reads the row's stamp locally (`queryStampId(table, key, false)`) and inserts only when the read finds nothing. On a member whose store has not caught up, the read finds nothing, but the insert's commit is checked by a cohort member that already holds the row; that member re-runs the insert, refuses it, and the error comes back as `UNIQUE constraint failed: OwnerGrant.Key`. The write funnel declines to retry it (correctly: it is a rejection), and the raw message reaches the caller with no code. On `CadreNode.redeemOwnerGrant`'s local path, cadre-cli (`describeRedemptionFailure`) and the apps therefore report the redemption as final.

Observed with real cadre-cli nodes (the ticket's original report):

```
⚠ Control write abandoned [owner-grant-seat] after 1/3 attempt(s) (declined): UNIQUE constraint failed: OwnerGrant.Key
✗ Failed to redeem the owner grant: UNIQUE constraint failed: OwnerGrant.Key
```

Steps: owner node A (`cadre start --owner --admin-port …`); node C joins by invitation and A lists it; stop C; mint an owner grant on A (`POST /admin/owner-grants`); start C with `CADRE_OWNER_GRANT=<grant>`. cadre-cli runs one control-cohort dial pass (`reconcileControlCohort`) and then `redeemOwnerGrant`, which fails as above. The same run with the grant minted while C was up, and C restarted only once it listed the grant, succeeds.

## What the fix stage measured in-process

A throwaway integration scenario (A owner, C a storage-profile member admitted by `addDrone`, C stopped, grant minted on A after C left A's cohort, C restarted on its own key, address and storage; deleted afterwards) did NOT reproduce the refusal. It found the two outcomes on either side of it, which locate the race:

- Restarted C waited until its control cohort (`readCohort`) included A, then redeemed: 6 of 6 runs, the guard read pulled the row from A (`OwnerGrant … already seated; seat skipped`) and the redemption succeeded.
- Restarted C ran one dial pass only, as cadre-cli does, then redeemed: 7 of 7 runs, C held one connection to A but its cohort was C alone, so the guard read missed, and the seat and redemption committed with C alone (`seated from its bundle`). A held the seated `OwnerKey` row shortly after (checked once). This is the write-while-alone territory of `blocked/optimystic-write-made-alone-owes-no-one` and `blocked/forked-control-collection-sync-livelocks`, not this ticket.
- Slowing C's raw storage after the restart (30 ms and 100 ms per operation) only made the dial pass slower; the cohort had filled by the read both times.

So the refusal needs C's cohort to be C alone when the guard read runs, and to include A by the time the insert commits. cadre-cli's file storage and process start make that window wide enough to hit; in-process it closes in under a second. A deterministic end-to-end test would need control over when FRET adds a peer, which the harness does not have. The regression test below pins the classifier against the live engine error instead.

## The fix

**Arm 1 — the seat treats a cohort refusal on the row's key as "already seated".** In `seatIssuedRow`, after the locked write throws, test the error chain for `UNIQUE constraint failed: <Table>.Key` (text-matched, failing closed, as `idConflictPattern` / `isStrandIdConflict` do; `docs/schema-guide.md` says to match on that text, not the error type). Generalize `idConflictPattern` to take the key column rather than adding a second near-copy. Match the primary key only, never `StampId`: the bundle copy is verbatim, so a key conflict means the cohort holds the row under that key, and the row's columns are all under the issuer's signature.

On a key conflict, re-read the stamp with an UNLOCKED, refreshing read (`queryStampId(table, key)` with the default `retry`; the lock is released by then). If the row is visible now, log and return `false`, exactly as the local "already seated" branch does. If it is still not visible, throw a new named error (proposed `IssuedRowNotHereYetError`, with `table`, `key`, and the original error as `cause`), meaning "the cadre holds this row and this machine has not caught up; try again shortly".

Re-reading inside the seat, rather than letting the redemption discover the missing row, keeps `redeemOwnerGrantLocally`'s rule that every refusal comes before the signer's approval, so a prompting signer never asks for a redemption this node then refuses.

**Arm 2 — the redemption's "no row seated" check throws the same named error.** `ControlDatabase.redeemOwnerGrant` and `redeemCadreInvite` currently throw a plain `Error("… no OwnerGrant row is seated on this node (seatOwnerGrant first)")`. Throw `IssuedRowNotHereYetError` there too, so a row that disappears from the local view between the seat and the locked read gets the same retryable name.

**Arm 3 — callers map the named error to a retryable refusal.**
- `CadreNode.redeemOwnerGrantLocally`: catch `IssuedRowNotHereYetError` from the seat and from the redemption and throw `OwnerGrantRejectedError('conflict', …)` (retryable in `OWNER_GRANT_REJECTION_RETRYABLE`). The local path already refuses with `OwnerGrantRejectedError('grant-spent')` ("the member is this node"), so cadre-cli's `describeRedemptionFailure` and the apps (`edge-node/owner-grant.ts`) classify it with no change.
- `OwnerGrantHandler.redeemAdmitted` and `CadreInviteHandler.redeemAdmitted`: answer `rejection('conflict', …)` for it in both catch blocks. Today the handlers fall through to `writeFailureRefusal`, which answers `internal` (also retryable, so the holder already tries the next address); the change gives it the accurate code. With arm 1 the seat no longer throws the raw UNIQUE error at all.

## Tests

One case in `packages/cadre-core/test/control-owner-grant.spec.ts`: insert an `OwnerGrant` row the store already holds through the raw database (the spec has `rawDb`), and assert the live engine error matches the classifier arm 1 uses (export it, or a small `isIssuedRowKeyConflict(error, table)` predicate, as `isStrandIdConflict` is exported). This pins the cross-repo message text the fix depends on, the way `publish-strand.spec.ts`'s repeat-publish cases pin `isStrandIdConflict`; an upstream reword reddens there.

No end-to-end test: see "What the fix stage measured" for why the window cannot be forced. Do not mock the control database to stage the refusal.

Run the existing owner-grant and invitation suites (`control-owner-grant.spec.ts`, `control-cadre-invite.spec.ts`, `cadre-node-owner-grant.spec.ts`, `cadre-invite-protocol.spec.ts`) plus `yarn lint` and the cadre-core typecheck. The integration scenarios `owner-grant-without-machine` and `cadre-invite-row-unreplicated` exercise the handler seat on a member without the row; run them once after the change.

## Docs

`docs/architecture.md` → Owner grants: one sentence where the seat is described, saying a seat the cohort refuses because it already holds the row counts as seated, and a member that still cannot read the row refuses `conflict` (retryable). Same for the invitation seat if its section describes the seat.

## TODO

- Generalize `idConflictPattern` to take the key column; add the issued-row key-conflict predicate.
- Add `IssuedRowNotHereYetError` (exported from `control-database.ts` and the package index, next to `OwnerGrantIssuerUnknownError`).
- `seatIssuedRow`: on a key conflict, re-read unlocked; return `false` when visible, else throw the named error.
- `redeemOwnerGrant` / `redeemCadreInvite`: throw the named error for the missing row.
- `CadreNode.redeemOwnerGrantLocally`: map the named error to `OwnerGrantRejectedError('conflict', …)`.
- `OwnerGrantHandler` / `CadreInviteHandler`: map it to `rejection('conflict', …)` in both catch blocks.
- Spec case pinning the live duplicate-insert error against the predicate.
- Update the seat docs (`seatIssuedRow`, `seatOwnerGrant`, `seatCadreInvite`, `redeemOwnerGrant` @throws) and `docs/architecture.md` → Owner grants.
- Build cadre-core, run the suites listed under Tests, lint, typecheck.
