description: On a party that has never revoked anyone, every membership lookup and every control-plane insert makes the machine ask the other machines whether its empty revocation list has changed, because the storage layer re-checks a table that has never been written on every single read. Once an owner machine is connected to another machine, have it write one permanent marker row into that list, so the list exists and gets re-checked on the storage layer's normal ten-second schedule, like every other table.
prereq: control-plane-consult-budget-gate
files:
  - packages/cadre-core/src/control-schema.ts:807-903 (`Revocation` — `RowIsGone` gains the marker branch; `TableName` column comment)
  - schemas/control.qsql (identical edit; `control-schema-drift.spec.ts` enforces it)
  - packages/cadre-core/src/control-database.ts:1035 (`queryRevocations` — skip the marker), new `openRevocationLedger`, debt NOTEs at :848-851, :1011-1013, :1909-1916
  - packages/cadre-core/src/seed-bootstrap.ts:609 (`reissueRevocations` — the signer-wrapper pattern to copy), :265 (`canAuthorize`)
  - packages/cadre-core/src/cadre-node.ts:2591 (`runReconcileControlCohort` — new step beside the connected-only reap at :2655), NOTE at :2601-2606, :3250 (`drainPendingRevocations` — consumes `queryRevocations`)
  - packages/cadre-core/src/control-authorization.ts:67 (`RevocableTable` — stays unchanged; the marker is not a revocable table)
  - packages/cadre-core/src/strand-membership-writer.ts:276 (`strandHasManagerRevocation` — tripwire NOTE only)
  - packages/cadre-core/test/control-revocation-reap.spec.ts, control-revocation-reissue.spec.ts (patterns for connected-gate and sweep tests)
  - packages/cadre-core/test/control-founding-consult-budget.spec.ts, cohort-consult-counter.ts (from the prereq)
  - docs/architecture.md:42 (the `Revocation` row of the control-table list)
difficulty: medium
----
# Write one marker row into `Revocation` so it is never a missing block

## The problem, measured

`CadreControl.Revocation` is read before almost every membership question: `queryCadrePeers` (`control-database.ts:872`) and `queryPeerRecord` (`:1069`) read the retired-stamp set before their own row read, `resolveDeviceToken` reads it again, and six guarded tables' `NotRevoked` insert checks plus the `RevocationRecorded` delete checks subquery it inside every control-plane write. On a party that has never revoked anything the table has never been written, so its blocks are missing on every node.

Upstream Optimystic consults a block's cohort (the machines responsible for it) on **every** read of a block missing locally, by design; the absence memo that briefly bounded that was removed on 2026-09-15 (upstream `drop-the-settled-absence-memo`, GitHub issue #20) because it served just-written blocks as never created. A **held** block is re-consulted at most once per `readRepairWindowMs` (10 s default).

Measured on a solo node on 2026-09-15; full table in `control-plane-consult-budget-gate`:

| read or write | `Revocation` empty (missing) | after one row exists (held) |
|---|---|---|
| `queryRevokedStamps('CadrePeer')` per call | 2 consults, every call | 0 (then 2 once per 10 s) |
| `queryCadrePeers()` per call, with a `CadrePeer` row | 2, every call | 0 |
| `authorizePeer` (a control-plane insert) | 5 | **0** |

What one consult costs depends on the deployment:

- **Solo:** a consult is one local `findCluster` call (0.009 ms, measured upstream) and no network work. The idle solo floor this ticket was filed about is therefore cheap in time.
- **Several machines:** each consult of a missing block is a round trip to every other cohort member (upstream's three-member spec pins 9 consults for 9 reads). Every membership lookup — per inbound connection, per wake or strand-address request, per backfill authorization, twice per 15 s reconcile pass — and every control-plane insert pays that. Latency on a real multi-machine party was **not** measured here.

## Why a marker row, and not a cache

Considered and rejected:

- **Cache the revoked-stamp set in `ControlDatabase`.** A cache cannot see a tombstone arriving by replication, so it adds staleness to an authorization input. The worst case is the first-ever revocation reaching a node that received the commit directly: instant today, up to the cache lifetime after. It would also do nothing for the six schema `NotRevoked` subqueries, which have no TypeScript call site.
- **Reorder or merge the reads** (check the row first; fold the exclusion into one statement). Every statement that touches `Revocation` still reads the same missing block, so the consult count does not move.
- **Serve per-request gates from the materialized `authorizedControlPeers` snapshot.** That removes the reads, but it changes new-member *authorization* latency from immediate to one reconcile interval as well, with liveness fallout in formation and join flows.
- **Upstream: `create table` writes an empty collection.** This is the class-level fix and would cover strand tables too, but it is cross-repo, reverses part of upstream's schema-apply write batching, and brings a creation race when several machines apply the schema cold. Out of scope here.

**The chosen fix changes where the data lives, not how fresh it is.** Once `Revocation` holds any row, every node holds its blocks after one read, and the storage layer's normal held-block window applies. That is the freshness contract every other populated control table, and every party that has already revoked someone, runs under today. No revocation becomes visible later than it does on such a party, and the schema subqueries are covered too, with no TypeScript cache and no change to any `NotRevoked` constraint.

## Design

### Schema: a singleton marker kind in `Revocation`

The marker row is `TableName = 'Revocation'`, `RowKey = 'ledger'`, `StampId = 'opened'`, `ReissuedAt = 0`.

- **`RowIsGone`** gains one branch: `or (new.TableName = 'Revocation' and new.RowKey = 'ledger' and new.StampId = 'opened')`. Nothing else is admitted under that `TableName`, so the marker is a singleton by the primary key `(TableName, StampId)`, and the append-only growth surface is unchanged.
- **`Authorized`** is unchanged: the marker is owner-signed like every other append, over `digest('CadreControl.Revocation', 'remove', 'Revocation', 'ledger', 'opened')`. This keeps the invariant the schema comment states, that every append is owner-signed. A captured marker signature can only re-file the identical row, which already exists. Say in a comment why the `'remove'` action tag appears on a marker (reusing the one append rule, instead of adding an unsigned or differently tagged branch).
- `FreshTombstone`, `ReissueOnly`, `NoDelete` and `AuthorizedReissue` are unchanged.
- Update the `TableName` column comment and the block comment above the table: the marker exists only so the table is never a missing block; it retires nothing.
- Make the identical edit in `schemas/control.qsql`.

Why the marker can never act as a retirement:

- every guarded table's `NotRevoked` and `RevocationRecorded` filter on their own `TableName`;
- the `committed.Revocation` reap branches filter on `TableName` too;
- `'Revocation'` is not a `RevocableTable`, so no TypeScript caller can ask for its stamps.

Stamps from `generateStampId` (`control-database.ts:33`) are 32 bytes encoded as 43 base64url characters, so the six-character literal `'opened'` can never collide with a real stamp, and the primary key includes `TableName` anyway.

### `ControlDatabase`

- `queryRevocations()` skips the marker row, filtered in TypeScript on `TableName`, keeping `RevocationRow.tableName: RevocableTable` honest. Its consumers — the reap sweep (`reapRevokedRows`) and the growth re-issue sweep (`CadreNode.drainPendingRevocations`) — therefore never see it: nothing reaps or re-signs the marker.
- `queryRevokedStamps(table)` needs no change, because the `where TableName = ?` binding is always a `RevocableTable`.
- New `openRevocationLedger(ownerKey, signMessage): Promise<'opened' | 'already-open'>`, shaped like `reissueRevocations`:
  - Mint the signature **outside** the locked body; a retried attempt re-presents the same signature.
  - Inside `lockedWithRetry`, run an insert-if-absent guard that **scans** `select StampId from CadreControl.Revocation where TableName = 'Revocation'` with `retry: false`, and compares in TypeScript. Do not seek the full composite primary key, which is served as a point lookup that can miss on a networked database (backlog `debt-composite-pk-point-lookup-unreliable-untracked`).
  - Insert with `with context OwnerKey = ?, Signature = ?`.
  - A uniqueness failure on `Revocation`'s primary key means another owner filed the marker first. Map it to `'already-open'` and log it.
- Rewrite the three debt NOTEs (`:848-851`, `:1011-1013`, `:1909-1916`) to state the real cost model, and point at the marker: the retired-set read costs a consult per call only while the table is a missing block.

### `SeedBootstrapService`

Add `openRevocationLedger()`: `requireOwnerPublicKey()`, then delegate with `message => this.signMessageBytes(message)`. This is the same shape as `reissueRevocations` at `seed-bootstrap.ts:609`.

### `CadreNode` — when to file

File the marker in `runReconcileControlCohort`, inside the **same connected-only gate as the reap** (`getControlConnectionCount() > 0`, `cadre-node.ts:2655`), and only when `seedBootstrapService?.canAuthorize()`.

- Keep a process-local flag, `revocationLedgerOpened`, set on `'opened'` or `'already-open'`. Once it is set, the step does nothing. The marker cannot be deleted (`NoDelete`), so the flag can never become wrong. It is a record of work done, not a cached authorization answer.
- On failure, log and leave the flag clear; the next pass retries. Best-effort like every other step in the pass: never abort the reconcile.
- **Why connected-only.** A write committed while alone is local-only and can fork the collection's history (`tickets/blocked/forked-control-collection-sync-livelocks.md`). That is exactly why the reap is gated the same way. A marker written alone by a disconnected owner, while another machine creates the same collection, is that fork.
- **The accepted cost of connected-only.** A solo founder never files the marker until its first sibling connects. On a solo node a consult costs a local lookup, so this is cheap. Record it as an accepted-tradeoff `NOTE:` at the new step: the solo founder keeps paying one local `findCluster` per missing-block read until first connection. Revisit if `findCluster` ever shows up as material in a device profile, or if a solo-founding marker can be made fork-safe (for example, filed inside the genesis transaction, when no other machine can hold the party's collections yet).
- Update the NOTE at `cadre-node.ts:2601-2606`: the two `CadrePeer` reads per pass no longer carry per-read `Revocation` consults once the marker exists.

### Docs

In `docs/architecture.md:42` (the `Revocation` row), add one sentence: an owner files a singleton `('Revocation', 'ledger', 'opened')` marker once connected, so the table is never a never-written block that the storage layer re-consults on every read; the marker retires nothing and is invisible to `queryRevocations`.

### Tripwire (strand side)

Add a `NOTE:` on `strandHasManagerRevocation` (`strand-membership-writer.ts:276`): `Strand.Revocation` has the same missing-block cost on a strand that has never revoked anyone (its `NotRevoked` insert checks and this scan consult per read). It is not measured and is cheap while strand membership writes are rare; if they become frequent, apply the same marker to the strand schema.

## Edge cases & interactions

- **Two owner machines file concurrently.** One commits; the other either sees the marker in its guard scan (`'already-open'`) or fails the primary-key uniqueness check (mapped to `'already-open'`). If Optimystic instead resolves a concurrent same-primary-key insert as last-writer-wins (`tickets/blocked/optimystic-concurrent-same-pk-insert-silent-lww.md`), both rows are byte-identical, so it is harmless. Test the uniqueness-to-`'already-open'` mapping directly.
- **Drones.** A node without an owner key never files. It picks the blocks up on its next read of `Revocation`: the block is missing locally, so it consults, sees the owner's claim, and acquires it. Test that a non-owner reconcile pass does not attempt the write.
- **Disconnect between the gate check and the commit.** The gate is sampled once per pass, the same residual the reap's NOTE already accepts; the write funnel's transient-failure classifier handles a cohort that vanishes mid-write. Do not add a second gate check inside the locked body.
- **Marker versus retirement semantics** — each needs a test:
  - a guarded insert whose `StampId` is `'opened'` passes `NotRevoked`;
  - `queryRevokedStamps(t)` never contains `'opened'` for any `RevocableTable`;
  - `queryRevocations()` excludes the marker;
  - `reapRevokedRows` returns 0 on a table holding only the marker;
  - `drainPendingRevocations`' first-growth sweep re-issues nothing when only the marker is held.
- **Schema refusals** — each needs a test:
  - an unsigned marker insert is refused (`Authorized`);
  - a marker signed by a non-owner is refused;
  - `TableName = 'Revocation'` with any other `RowKey` or `StampId` is refused (`RowIsGone`);
  - deleting the marker is refused (`NoDelete`).
- **Existing parties.** No backwards compatibility is needed, but this works for them anyway: the first connected reconcile pass of any owner node files the marker.
- **Counting specs that read raw `Revocation`.** `control-authorization-binding.spec.ts`'s `revocationCount()` and similar raw-SQL reads drive a bare `ControlDatabase`, which never runs the reconcile step, so they should be unaffected. If one turns out to go through a `CadreNode` reconcile, adjust its expectation rather than filtering the marker in SQL.
- **The cost effect, measured through the prereq's counter.** Drive `openRevocationLedger` directly on a solo node (bypassing the connected gate, which is tested separately), then assert:
  - `queryRevokedStamps` and `queryCadrePeers` cost 0 consults per call inside one window (they cost 2 every call before);
  - an `authorizePeer` costs 0 consults (it cost 5 before);
  - within one `reconcileControlCohort` pass, no control block is consulted more than once, which today fails for `Revocation`.
  - The solo founding budgets from `control-plane-consult-budget-gate` should **not** move, because the reconcile step never files alone. If they do, find out why before re-pinning.
- **Merge note.** Backlog `debt-strand-tombstone-reap` also plans edits to `REAPABLE_TABLES` and `reapRevokedRows`. That is a different concern, but expect a textual merge if both land close together.

## TODO

- Schema: add the `RowIsGone` marker branch and the comments in `control-schema.ts` and `schemas/control.qsql`; run `control-schema-drift.spec.ts`.
- `ControlDatabase`: skip the marker in `queryRevocations`; add `openRevocationLedger` (signature outside the lock, guard scan with `retry: false`, uniqueness failure → `'already-open'`); rewrite the three debt NOTEs.
- `SeedBootstrapService.openRevocationLedger()` wrapper.
- `CadreNode.runReconcileControlCohort`: the owner-only step inside the connected gate, with the process flag, the accepted-tradeoff NOTE, and the updated NOTE at `:2601`.
- Strand-side tripwire NOTE on `strandHasManagerRevocation`.
- Tests: schema accept/refuse cases; marker invisibility to `queryRevocations`, `queryRevokedStamps`, the reap and the re-issue sweep; the reconcile step filing only when connected and owner-capable, stopping once the flag is set, retrying after a failure; the cost effect through the prereq's counter.
- `docs/architecture.md:42` sentence.
- `yarn workspace @serfab/cadre-core test` (the revocation, reap, reissue, authorization-binding, schema-drift and consult-budget specs at minimum), `yarn typecheck`, `yarn lint`.
