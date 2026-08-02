----
description: Finish the revocation re-issue work by updating the tests that pinned the old "tombstones are immutable" rule and adding coverage for the new re-issue path and revocation-filtered membership reads. The production code is already written and type-checks.
prereq:
files: packages/cadre-core/test/control-revocation-replay.spec.ts, packages/cadre-core/test/cadre-node-authorized-surface.spec.ts, packages/cadre-core/test/control-constraint-helpers.ts, packages/cadre-core/test/device-token-registry.spec.ts (pattern reference ~284-310), packages/cadre-core/src/control-database.ts (queryRevocations ~770, reissueRevocations ~1395, deleteGuardedRow ~1300), packages/cadre-core/src/control-schema.ts (Revocation table ~643), schemas/control.qsql, packages/cadre-core/src/cadre-node.ts (listAuthorizedMembers ~3842)
difficulty: hard
----

## State — production code is DONE, tests are NOT

Continuation of `control-revocation-reissuable-tombstone` (this run implemented all of
Phases 1–3, then hit the token budget before Phase 4). Everything below is in the tree
and `yarn typecheck` passes in `packages/cadre-core`. **`yarn test` has NOT been run**
— at least two existing specs are known-broken by design (listed below) and the new
spec does not exist yet.

What landed (do not redo, do not re-verify beyond running the suite):

- **Schema** (`schemas/control.qsql` + identical text in
  `packages/cadre-core/src/control-schema.ts`; `control-schema-drift.spec.ts` passes):
  `Revocation` gained `ReissuedAt integer not null default 0`, and the old `Immutable`
  constraint is REPLACED by four: `NoDelete` (delete always refused), `FreshTombstone`
  (insert must have `ReissuedAt = 0`), `ReissueOnly` (update may change nothing but
  `ReissuedAt`, strictly upward), `AuthorizedReissue` (update requires an owner
  signature over `digest('CadreControl.Revocation', 'reissue', new.TableName,
  new.RowKey, new.StampId, cast(new.ReissuedAt as text))`). Note the `cast(... as
  text)` — the TS signer passes `String(reissuedAt)`, matching the repo's
  integer-in-digest convention.
- **`control-authorization.ts`**: `'reissue'` added to the `ControlAction` union + doc.
- **`types.ts`**: `RevocationRow` interface exported
  (`{ tableName; rowKey; stampId; reissuedAt }`) next to `CadrePeerRow`.
- **`control-database.ts`**:
  - `deleteGuardedRow`'s tombstone INSERT now names `ReissuedAt` with literal `0`;
  - `queryRevocations()` — plain unlocked scan returning `RevocationRow[]`;
  - `reissueRevocations(rows, reissuedAt, ownerKey, signMessage)` — signatures minted
    BEFORE the locked body, `executed` counter reset inside it, one `inTransaction`
    over per-row `update ... set ReissuedAt = ? where StampId = ?` (StampId ALONE —
    the composite-PK point-lookup hazard comment is at the statement; do not add
    TableName), returns statement count;
  - `queryCadrePeers()` now drops rows whose stamp is in
    `queryRevokedStamps('CadrePeer')` (read through that method, deliberately, so
    tests can interpose on it);
  - `queryPeerRecord()` selects `StampId`, returns `null` for a retired row, return
    shape unchanged;
  - `queryStampId` doc states it stays RAW (insert-if-absent guards need physical
    presence).
- **`cadre-node.ts`**: `listAuthorizedMembers` no longer does its own revoked-stamp
  filtering (inherited from `queryCadrePeers`); its doc bullet 5, plus the
  `listMembers`/`isMember` docs, updated — **revocation now removes a peer from the
  ADDRESSABLE surface too**, by design.

## TODO (all of it is Phase 4 of the original ticket)

Fix the two knowingly-broken specs:

- `control-revocation-replay.spec.ts`:
  - The test "a tombstone is permanent — delete and update are both refused
    (Immutable)" at ~1040–1065 pins the now-deleted `Immutable` name. Restructure into
    single-rejector probes (helper `expectConstraintFailure` forbids widening to
    multiple names): unsigned DELETE → `NoDelete`; owner-signed UPDATE changing
    `StampId` (signature valid over the NEW values) → `ReissueOnly`; unsigned
    counter-only bump → `AuthorizedReissue`. Note the existing test's unsigned
    UPDATE could now trip either of two constraints — split it, don't guess.
  - Header comment (~line 45) and the section comment above the `Authorized` tests
    (~1069) name `Immutable` — reword to the new constraint names.
  - Existing raw tombstone INSERTs omit `ReissuedAt` → default 0 → keep passing;
    no edits needed there.
- `cadre-node-authorized-surface.spec.ts`: fake `controlDatabase` (injected ~71–82)
  returns raw rows from `queryCadrePeers`, and the test at ~218–241 ("drops a fully
  valid, anchored voucher whose StampId is retired…") relies on the node doing the
  filtering — it now FAILS. Make the fake's `queryCadrePeers` model the new DB
  contract (pre-filter revoked rows), and note its final `isMember(A) === true`
  assertion ("Still ADDRESSABLE…") INVERTS by design — revoked peers are no longer
  addressable. Update that assertion, its comment, and the spec's header (~8–19)
  describing the two surfaces. The stubs in `membership-gate-helpers.ts` (~87, 111)
  and `cadre-node-control-cohort.spec.ts` (~77) keep working (stub goes unused on
  this path; still used by `resolveDeviceToken`).

New spec `control-revocation-reissue.spec.ts` (replay spec's header says split rather
than grow; copy the minimal fixture — per-test `CadreNode` boot as in replay spec
beforeEach ~453–469, `freshKeyPair`/`signAs`/`signB64`/`freshStamp`/`rawTombstone`/
`tombstoneStamp` helpers; lifting shared ones into `control-constraint-helpers.ts` is
blessed):

- owner-signed `'reissue'` update bumps `ReissuedAt`, leaves TableName/RowKey/StampId
  untouched (also proves TS `String(reissuedAt)` matches SQL
  `cast(new.ReissuedAt as text)`);
- update changing RowKey / StampId / TableName refused even with a valid signature
  over the new values → `ReissueOnly`;
- equal-or-lower `ReissuedAt` refused → `ReissueOnly`;
- update signed with the `'remove'` digest refused, and non-owner signer refused →
  `AuthorizedReissue`;
- `delete from Revocation` refused → `NoDelete`;
- insert with explicit non-zero `ReissuedAt` refused → `FreshTombstone`;
- `db.reissueRevocations` over three tombstones lands all three in one transaction;
  one bad row (e.g. stale counter) rolls back the whole batch and the error surfaces;
- re-issuing a tombstone whose guarded row was never present locally works (the
  normal converged-tombstone-only case — `tombstoneStamp` against an orphan stamp);
- read paths: after `deleteCadrePeer(X)` via production APIs
  (`node.initializeSeedBootstrap(founder.privateKey)`, `node.authorizePeer`,
  `node.removePeer` — precedent replay spec ~1317–1329), `queryCadrePeers()` omits X,
  `queryPeerRecord(X)` is null, `queryCadrePeerStampId(X)` still reports raw
  presence; a peer re-authorized after removal reappears with a fresh stamp; a
  CadrePeer row "planted at a retired stamp" is absent from `queryCadrePeers()` —
  NOT constructible with real writes (both constraint orders forbid it), use the
  wrap pattern from `device-token-registry.spec.ts` ~284–310: temporarily replace
  `db.queryRevokedStamps` with a wrapper reporting an extra stamp, restore in
  `finally` (works because the filters read through that method).

Validation (from `packages/cadre-core`):
`yarn test 2>&1 | tee /tmp/cadre-core.log`, `yarn lint`, `yarn typecheck`. Do NOT run
the integration suite (belongs to the follow-up `control-revocation-drain-on-growth`
work; several scenarios already failing upstream — see
`tickets/.pre-existing-known.md`). Other specs beyond the two named above may also
touch the changed read paths — triage whatever the run surfaces; failures caused by
this change are yours to fix, not pre-existing.

Handoff: on completion write the review/ ticket for the WHOLE feature (schema +
database + read paths + tests), noting that the review stage should treat the original
ticket `control-revocation-reissuable-tombstone` (now deleted; see git history at this
commit) as the spec.
