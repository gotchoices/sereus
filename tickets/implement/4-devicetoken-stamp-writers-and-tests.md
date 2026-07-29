description: The database rules for a phone's push-token row were just tightened to make each approval single-use, but the code that writes and reads those rows has not caught up yet, so token registration is currently broken and must be finished.
files:
  - packages/cadre-core/src/control-schema.ts (DeviceToken + Revocation — DONE, do not re-edit)
  - schemas/control.qsql (byte-identical twin — DONE, do not re-edit)
  - packages/cadre-core/src/peer-authorization.ts (deviceTokenAddDigest / deviceTokenRemoveDigest)
  - packages/cadre-core/src/control-authorization.ts (RevocableTable, ControlAction docs)
  - packages/cadre-core/src/control-database.ts (queryDeviceToken, queryStampId helpers, GuardedKeyColumn)
  - packages/cadre-core/src/seed-bootstrap.ts (insertSelfDeviceToken, deleteDeviceToken; copy removePeer at :465)
  - packages/cadre-core/src/cadre-node.ts (resolveDeviceToken at :2157)
  - packages/cadre-core/test/control-authorization-domain-separation.spec.ts (DeviceToken case at :299, tombstoneStamp at :99)
  - packages/cadre-core/test/control-revocation-replay.spec.ts (test at :940 uses 'DeviceToken' as an OUT-OF-SET TableName — now wrong)
  - packages/cadre-core/test/control-cadrepeer-voucher-constraint.spec.ts (pattern for the new crypto-free spec)
  - packages/cadre-core/test/device-token-registry.spec.ts
difficulty: medium
---

# DeviceToken StampId: finish the writers, readers and tests

Continuation of `bug-devicetoken-authority-antireplay` / `devicetoken-authority-antireplay`.
That ticket's Phase 1 (schema) is **complete and verified mirrored**; the prior run stopped
on a token-budget warning before Phase 2. Read the original ticket in
`tickets/complete/` or git history (`ef54585`) for the full attack write-up — it is not
repeated here.

## Current tree state — IMPORTANT

The working tree is **mid-change and cadre-core tests will fail** until this ticket lands.
That is expected, not a pre-existing failure: the schema now demands a `StampId` column on
`CadreControl.DeviceToken` and binds the whole row into the insert approval, but no
TypeScript writer supplies either yet.

What already landed (both `packages/cadre-core/src/control-schema.ts` and
`schemas/control.qsql`, textually mirrored — verified by diffing the `DeviceToken` and
`Revocation.RowIsGone` blocks; the only difference is the deliberate `` \` `` escaping the
TypeScript template literal needs):

- `DeviceToken.StampId text not null unique` (after `Sig`).
- `DeviceToken.NotRevoked` (on insert) and `RevocationRecorded` (on delete), same shape as
  `CadrePeer`'s pair.
- `AuthorizedInsert` now binds the whole row:
  `digest('CadreControl.DeviceToken', 'add', new.PeerId, new.Platform, new.Token, coalesce(cast(new.UpdatedAt as text), ''), coalesce(new.Sig, ''), new.StampId)`.
- `AuthorizedDelete` now binds `(old.PeerId, old.StampId)`.
- `AuthorizedUpdate`: the owner re-touch branch was **removed** (the recommendation in the
  original ticket). One branch remains — the peer self-update — and it now also requires
  `new.StampId = old.StampId`. Note the surviving branch is no longer wrapped in its own
  parentheses (there is nothing left to `or` against).
- `Revocation.RowIsGone` gained the `DeviceToken` arm; the `TableName` column comment lists
  `'DeviceToken'`.

## Remaining work

### Phase 2 — TypeScript writers and readers

- `peer-authorization.ts`: widen `deviceTokenAddDigest` to the full field vector
  `(peerId, platform, token, updatedAt-or-'', sig-or-'', stampId)` and
  `deviceTokenRemoveDigest` to `(peerId, stampId)`. Keep the "SQL mirror:" doc-comment
  convention accurate — it is the only thing keeping the two sides from drifting silently.
  Consider taking the record shape (`Omit<DeviceTokenRecord, never>` + stampId) rather than
  six positional strings, so a caller cannot transpose `platform` and `token`.
- `control-authorization.ts`: add `'DeviceToken'` to the `RevocableTable` `Extract<...>`
  union; drop the "the `DeviceToken` owner re-touch" mention from the `ControlAction`
  `'vouch'` doc comment (that branch no longer exists).
- `control-database.ts`: add `queryDeviceTokenStampId(peerId)` alongside
  `queryCadrePeerStampId` (:467) — the private `queryStampId` helper already takes a
  `RevocableTable` + `GuardedKeyColumn`, and `'PeerId'` is already in that union, so this is
  a two-line addition. Also return `StampId` from `queryDeviceToken` (:563) so the delete
  path and any future reader can see it. `DeviceTokenRecord` (`types.ts:813`) does not carry
  a stamp field today — decide whether to widen it or return the stamp separately; the
  narrower change is a separate accessor, since `DeviceTokenRecord` is also the signed-record
  shape that `deviceTokenSignedPayload` consumes and it must NOT grow a field the self-sig
  does not cover.
- `seed-bootstrap.ts`:
  - `insertSelfDeviceToken` (:377) — mint `generateStampId(record.peerId)`, sign the
    whole-row digest, insert the extra column.
  - `deleteDeviceToken` (:399) — read the row's `StampId` first and early-return when the
    row is absent (as `removePeer` does at :476), then delete **and** insert the
    `Revocation` tombstone in one transaction, each with its own owner signature. Copy the
    transaction/rollback shape from `removePeer` (:465–512) verbatim, including the
    `requireOwnerPrivateKey()` fail-fast before the DB read.
- `cadre-node.ts`: `resolveDeviceToken` (:2157) must drop a row whose `StampId` is retired,
  via `queryRevokedStamps('DeviceToken')` — the same read-side mitigation
  `listAuthorizedMembers` applies for `CadrePeer` (:3171). Without it a node that has not
  converged on the tombstone still honours a resurrected row. Add the `NOTE:` comment
  recording that the freshness ceiling defaults to infinite **by design** (a suspended phone
  must stay push-reachable long after publish), so stamp retirement — not staleness — is
  what retires a cleared token.

### Phase 3 — tests

- New `packages/cadre-core/test/control-devicetoken-stamp-constraint.spec.ts`, crypto-free,
  built exactly like `control-cadrepeer-voucher-constraint.spec.ts`: a minimal `Probe`
  schema carrying only the non-crypto predicates (unique `StampId`, `NotRevoked`,
  `RevocationRecorded`, `new.StampId = old.StampId` on update) with a direct truth table.
- Extend `control-authorization-domain-separation.spec.ts` with the three reproduced
  attacks, each asserted through `expectConstraintFailure` **by constraint name**:
  - **A** — capture the insert approval, delete the row, replay the approval with a
    different `Platform`/`Token`/`UpdatedAt` → rejected (`AuthorizedInsert`, since the
    digest no longer matches).
  - **B** — insert → delete → replay the *exact* approved row → rejected (`NotRevoked`).
  - **C** — an owner-signed update is rejected outright now that the owner branch is gone
    (`AuthorizedUpdate`).
  - Its existing DeviceToken case (:299) needs the `StampId` column and the new digests;
    its `tombstoneStamp` helper (:99) needs `'DeviceToken'` in the table-name union, and its
    DeviceToken delete now needs a tombstone in the same transaction (use the existing
    `inTransaction` helper) or `RevocationRecorded` will be the rejector instead of the
    constraint under test.
- `control-revocation-replay.spec.ts:940` — the test *"a TableName outside the guarded set
  is refused"* uses `'DeviceToken'` as its out-of-set example, which is now wrong. Swap it
  for a control table that is genuinely not revocable (`'FormationInvite'` reads well). The
  live-row `RowIsGone` test at :921 could also gain a `DeviceToken` arm.
- `device-token-registry.spec.ts` drives everything through the `CadreNode` API, so it needs
  no SQL edits — but it is the end-to-end proof that register → resolve → clear → re-register
  all still work, and that a re-register after a clear succeeds (fresh stamp) rather than
  tripping `NotRevoked`. **Make sure that last case is covered** — it is the one way this
  change could break a legitimate flow.

### Validation

`yarn workspace @serfab/cadre-core test 2>&1 | tee /tmp/cadre-core-test.log` (stream it),
plus `yarn workspace @serfab/cadre-core typecheck` and `yarn lint`.

## Trade-off to leave alone

`Revocation` is append-only and grows by one row per explicit token clear (rotation goes
through the self-update path and files nothing). Same bargain `CadrePeer` already makes. Do
**not** add pruning as part of this ticket.
