----
description: When someone's access is revoked, the revocation record can get stuck on the machine that made it and never reach the others. This first step makes that record re-sendable, and makes every membership lookup treat a revoked entry as gone.
prereq:
files: schemas/control.qsql (Revocation table, ~line 632-699), packages/cadre-core/src/control-schema.ts (same table, kept byte-identical by control-schema-drift.spec.ts), packages/cadre-core/src/control-database.ts (deleteGuardedRow ~1265, queryCadrePeers ~655, queryPeerRecord ~771, queryRevokedStamps ~752, inTransaction ~1326), packages/cadre-core/src/control-authorization.ts (buildAuthorizationMessage), packages/cadre-core/test/control-revocation-replay.spec.ts, packages/cadre-core/test/control-schema-drift.spec.ts, packages/cadre-core/test/control-database-solo.spec.ts
difficulty: hard
----

## Why

A guarded delete (`ControlDatabase.deleteGuardedRow`, behind `deleteCadrePeer` /
`deleteDeviceToken` / `deleteStrand` / `deleteValidationKey`) removes the row **and**
appends an owner-signed `CadreControl.Revocation` tombstone naming the retired
`StampId`, in one transaction. When that transaction commits while the node is alone,
Optimystic commits it local-only: neither half is broadcast, and other nodes keep
treating the removed peer as a member.

Inserts and updates made while alone are rescued by re-issuing the **same row** later
(`control-write-ensure-replicated`). A delete cannot be replayed — the row is gone
locally, so the statement matches nothing. Measured, not assumed: the scratch scenario
`packages/integration-tests/src/scenarios/zz-scratch-delete-alone.integration.ts`
manufactured a genuinely local-only `removePeer` (node A restarted on its own storage
while sibling B was down, so A's FRET table did not know B at all) and reported
`droppedOnReconnect=false` **and** `droppedAfterBroadcast=false` — a later broadcasting
`CadrePeer` write on A does **not** drag the earlier local-only delete along.

The `Revocation` row, though, *is* re-issuable in principle: readers already honour it
(`CadreNode.listAuthorizedMembers` drops any `CadrePeer` row whose stamp is retired;
`resolveDeviceToken` does the same). It is stored in its own Optimystic collection
(`default/Revocation`), separate from `default/CadrePeer`, so it can converge even while
the `CadrePeer` collection stays forked. Two things block re-issuing it today:

- the row already exists locally, and its primary key `(TableName, StampId)` cannot vary,
  so a re-INSERT collides; and
- `constraint Immutable check on update, delete (false)` forbids any in-place re-touch.

**This ticket removes both blocks and fixes the read paths. It does not wire the
re-issue to cohort growth** — that is `control-revocation-drain-on-growth`, which
depends on this.

### Design decision (settled here — do not re-open in implementation)

**Chosen: a monotonic `ReissuedAt` counter on `Revocation`, bumped by an owner-signed
UPDATE.** The tombstone identity columns stay immutable; only a meaningless counter
moves, and moving it re-writes the row, which is what makes Optimystic broadcast it.

**Rejected: a `Removed`/`RemovedAt` soft-delete column on `CadrePeer`.** It would
duplicate a tombstone the schema already has, and it would touch every membership read
path, the re-authorization story (is a re-add an un-tombstone or a fresh row?), a new
monotonicity constraint on a table that already has one, and eventual tombstone GC —
for no behaviour the `Revocation` row does not already provide. It would also cover only
`CadrePeer`, whereas `Revocation` covers all four guarded tables at once.

The schema already anticipates this: `Revocation.Authorized`'s comment says RowKey is
deliberately not cross-checked against the retired row precisely so a tombstone
**re-issued in a later transaction** stays valid.

## Schema change

`Revocation` gains one column and its `Immutable` constraint splits in three. Make the
identical edit in `schemas/control.qsql` and `packages/cadre-core/src/control-schema.ts`
— `control-schema-drift.spec.ts` compares them and will fail otherwise.

```sql
table Revocation (
    TableName text,
    RowKey text not null,
    StampId text,
    -- Bumped by an owner-signed re-issue so a tombstone written while the node was
    -- alone (committed local-only, never broadcast) can be re-written and therefore
    -- re-broadcast on cohort growth. Carries NO semantics: nothing reads it, and
    -- retirement is decided by the row's existence, not by this value.
    ReissuedAt integer not null default 0,
    primary key (TableName, StampId),
    -- Retirement is permanent: a tombstone may never be withdrawn.
    constraint NoDelete check on delete (false),
    -- Pinned at 0 on insert so an owner cannot seat a tombstone at a saturated
    -- counter and thereby freeze its own later re-issues (Monotonic below).
    -- Deliberately NOT folded into the Authorized digest: the value is fixed by this
    -- rule, so signing over it would only widen the signed surface for no gain, and
    -- would invalidate every existing insert-side digest.
    constraint FreshTombstone check on insert (new.ReissuedAt = 0),
    -- A re-issue may move NOTHING but the counter, and only upward. Without the
    -- identity clause an "update" would be a way to re-point a tombstone at a
    -- different row, restoring exactly the replay the table exists to stop.
    constraint ReissueOnly check on update (
        new.TableName = old.TableName and new.RowKey = old.RowKey
            and new.StampId = old.StampId and new.ReissuedAt > old.ReissuedAt
    ),
    constraint RowIsGone check on insert ( ... unchanged ... ),
    constraint Authorized check on insert ( ... unchanged ... ),
    -- A re-issue is an OWNER action, like the original append. Distinct 'reissue'
    -- action tag, so an append approval can never be replayed as a re-issue and vice
    -- versa. Reads LIVE OwnerKey, matching Authorized above.
    constraint AuthorizedReissue check on update (
        exists (select 1 from OwnerKey A where A.Key = context.OwnerKey
            and verify(digest('CadreControl.Revocation', 'reissue',
                              new.TableName, new.RowKey, new.StampId, new.ReissuedAt),
                       context.Signature, A.Key, 'ed25519'))
    )
) with context (OwnerKey text, Signature text);
```

Keep the existing block comment above the table; extend it with one sentence naming the
re-issue path so a reader meets the reason at the site.

## Statement hazard — do NOT write the obvious `where`

`Revocation`'s primary key is composite, `(TableName, StampId)`. An equality on **every**
primary-key column makes the optimystic vtab claim the predicate and serve the read as a
single point lookup with no engine-side re-check — and that descent has been observed
returning **zero rows for a row that provably exists** on a networked table
(`tickets/backlog/debt-composite-pk-point-lookup-unreliable-untracked`). A re-issue that
silently matches nothing would report success and replicate nothing, which is the exact
failure this ticket exists to remove.

So the re-issue UPDATE must key on **`StampId` alone** — a non-leading subset of the
primary key, which the module declines, so it is served by a scan the engine filters:

```sql
update CadreControl.Revocation
    with context OwnerKey = ?, Signature = ?
    set ReissuedAt = ?
    where StampId = ?
```

A `StampId` is 128 bits of CSPRNG output minted per row incarnation
(`generateStampId`), so it identifies one row across all `TableName` values. Put this
reasoning in a comment at the statement — the next reader's instinct will be to "fix"
the `where` by adding `TableName`.

## API surface

Add to `ControlDatabase`:

- `queryRevocations(): Promise<RevocationRow[]>` — every locally-held tombstone, as
  `{ tableName: RevocableTable; rowKey: string; stampId: string; reissuedAt: number }`.
  Plain scan (no `where`), so the point-lookup hazard does not arise. Consumed by the
  first-growth sweep in the follow-up ticket.
- `reissueRevocations(rows, reissuedAt, ownerKey, signMessage): Promise<number>` — bump
  a batch of tombstones in **one** `inTransaction`, one owner signature per row over the
  `'reissue'` digest, returning how many statements ran. One transaction, not one per
  row: a sweep may cover every tombstone in the table and each separate commit is a
  separate round of network work. Callers pass a `reissuedAt` strictly above every
  affected row's current value (`Math.max(Date.now(), max(existing) + 1)`, mirroring
  `reissuePeerAuthorize`'s monotonic bump).
- Have `deleteGuardedRow`'s tombstone insert name `ReissuedAt` explicitly with `0`
  rather than leaning on the column default.

## Read paths

`ControlDatabase.queryCadrePeers()` currently returns raw rows; `CadreNode.listMembers`
/ `isMember` / `resolveCohortSeed` / `reconstructAuthoredMembership` all consume it
unfiltered, so a peer whose stamp is retired still counts as addressable membership and
still gets RPC'd as a cohort-seed source. Only `listAuthorizedMembers` filters.

- `queryCadrePeers()` excludes rows whose `StampId` appears in
  `queryRevokedStamps('CadrePeer')`. Every consumer inherits it; drop the now-redundant
  `revokedStamps` filter from `listAuthorizedMembers` and rewrite its doc bullet 5 to
  say the exclusion now happens in the query.
- `queryPeerRecord(peerId)` returns `null` when that row's stamp is retired, so
  `resolvePeerAddrs` stops handing out a revoked peer's addresses.
- **Single-row writer-side reads stay RAW** — `queryStampId` and its wrappers
  (`queryCadrePeerStampId` etc.). `deleteGuardedRow` and the insert-if-absent guard in
  the `CadrePeer` upsert both need to see a physically present row; filtering them would
  make an insert-if-absent guard read "absent" for a row that exists and collide on the
  primary key. State this in a comment on `queryStampId`.

Add a `NOTE:` at `queryCadrePeers` — it now runs a second query per call and is on the
membership-gate refresh path; if control tables ever grow, fold the exclusion into one
statement or cache the retired-stamp set.

## Edge cases & interactions

- **Non-owner node.** Only an owner key can sign a `'reissue'` digest.
  `reissueRevocations` must surface the constraint failure rather than swallow it; the
  caller (next ticket) gates on `canAuthorize()`.
- **Counter saturation / two processes re-issuing.** `ReissueOnly` requires strictly
  increasing. Two owner devices bumping the same tombstone concurrently: one commit wins,
  the other fails its CHECK — must not corrupt anything, and the loser retries with a
  fresh value on the next sweep. `FreshTombstone` prevents seating a tombstone at a value
  a later bump cannot exceed.
- **A tombstone whose guarded row was never present locally.** `RowIsGone` passes (no
  live row holds the stamp) and a re-issue never files a delete, so
  `RevocationRecorded` on the guarded table is not involved. Re-issuing such a row must
  work — it is the normal case on a node that converged on the tombstone but never had
  the row.
- **Re-authorization after a tombstone.** `authorizePeer(X)` after `removePeer(X)` mints
  a **fresh** `StampId`, so `CadrePeer.NotRevoked` passes and the new row is not filtered
  by the retired-stamp set. The old tombstone stays forever and must not affect the new
  row. Cover this explicitly — it is the case most likely to break when the filter moves
  into `queryCadrePeers`.
- **A node that converged on the re-add before the tombstone.** It holds a live row at
  stamp2 and later receives the stamp1 tombstone; `RowIsGone` is keyed on the stamp only
  (not RowKey) precisely so that tombstone is still accepted. Do not tighten it.
- **Removal racing a re-authorization.** `deleteGuardedRow` reads the stamp outside the
  transaction (existing, documented). Unchanged here, but the re-issue path must not
  make it worse: a re-issue never reads a live row.
- **`DeviceToken` / `Strand` / `ValidationKey`.** All four guarded tables share
  `deleteGuardedRow`, so all four get a re-issuable tombstone from this change. Only
  `CadrePeer` and `DeviceToken` have read-side revocation filters; `Strand` and
  `ValidationKey` deliberately do not (schema comments say why). Do not add them here.
- **`control-revocation-replay.spec.ts` drives `Revocation` with hand-rolled SQL**
  including the `OwnerKey` branch. Its inserts must keep passing unchanged (the insert
  digest is not touched); its assertions about immutability need re-pointing from
  `Immutable` to `NoDelete` / `ReissueOnly`.

## Tests (unit, `packages/cadre-core/test/`)

Extend `control-revocation-replay.spec.ts` (or add
`control-revocation-reissue.spec.ts` if that file is already dense):

- an owner-signed `'reissue'` update bumps `ReissuedAt` and leaves TableName / RowKey /
  StampId untouched;
- an update that changes `RowKey` (or `StampId`, or `TableName`) is refused even with a
  valid signature over the new values — `ReissueOnly`;
- a non-increasing (equal or lower) `ReissuedAt` is refused;
- an update signed with the **insert** (`'remove'`) digest is refused, and an update
  signed by a non-owner key is refused;
- `delete from Revocation` is still refused (`NoDelete`);
- an insert with `ReissuedAt` non-zero is refused (`FreshTombstone`);
- `reissueRevocations` over a batch of three tombstones runs in one transaction and all
  three land; one bad row in the batch rolls the whole batch back.

Read-path specs (`control-database-solo.spec.ts` or a new
`control-revocation-read-paths.spec.ts`):

- after `deleteCadrePeer(X)`, `queryCadrePeers()` omits X and `queryPeerRecord(X)`
  returns `null`, while `queryCadrePeerStampId` still reports raw presence semantics;
- a peer re-authorized after removal reappears in `queryCadrePeers()` with a new stamp;
- a `CadrePeer` row planted at a retired stamp (the replay case) is absent from
  `queryCadrePeers()`.

`control-schema-drift.spec.ts` must pass with both schema files edited.

## TODO

Phase 1 — schema
- Add `ReissuedAt` and replace `Immutable` with `NoDelete` / `FreshTombstone` /
  `ReissueOnly` / `AuthorizedReissue` in `schemas/control.qsql`.
- Mirror the identical text into `packages/cadre-core/src/control-schema.ts`; run
  `control-schema-drift.spec.ts`.
- Extend the table's block comment with the re-issue rationale.

Phase 2 — database layer
- Add the `'reissue'` action tag wherever `control-authorization.ts` enumerates action
  tags, if it enumerates them.
- `deleteGuardedRow`: name `ReissuedAt` as `0` in the tombstone insert.
- Add `queryRevocations()` and `reissueRevocations()`; single transaction, per-row
  signature, `where StampId = ?` with the point-lookup comment.
- Export the `RevocationRow` type from wherever `CadrePeerRow` is exported.

Phase 3 — read paths
- Filter retired stamps out of `queryCadrePeers()` and `queryPeerRecord()`; add the
  raw-read comment on `queryStampId`; add the per-call cost `NOTE:`.
- Drop the redundant filter in `CadreNode.listAuthorizedMembers` and update its doc.

Phase 4 — tests
- The unit specs listed above.
- `cd packages/cadre-core && yarn test 2>&1 | tee /tmp/cadre-core.log`, plus `yarn lint`
  and the package type check. Do not run the integration suite here — it belongs to the
  follow-up ticket, and several of its scenarios are already failing upstream
  (`tickets/.pre-existing-known.md`).
