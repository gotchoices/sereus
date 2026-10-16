description: When a strand is founded, create an empty storage collection for every table it declares, so that reading a table nobody has written yet is answered from the machine's own store instead of asking the other member, and works while the other member is offline (GitHub #47).
architecture: docs/strands.md#joining-no-writes-before-the-first-sync
files: packages/quereus-plugin-sereus/src/compose-strand.ts (`OptimysticPluginResult` shim ~62-80, `composeStrand` result ~380-395), packages/quereus-plugin-sereus/src/types.ts (`SereusPluginResult` ~78-113), packages/cadre-core/src/strand-database.ts (`initialize` ~94-150, `bootstrapFounder` ~173), packages/cadre-core/src/strand-membership-writer.ts (`FounderBootstrapParams`, `bootstrapFounderMembership` ~532-561, `strandHasManagerRevocation` NOTE ~350-372), packages/cadre-core/src/strand-first-sync-gate.ts (~245, how App tables are enumerated), packages/integration-tests/src/scenarios/strand-read-cost-over-relay.integration.ts (new), docs/strands.md (~244, first residual under "Joining"), docs/architecture.md (§ Strand Membership Bootstrap ~1374)
----

# The founder commits every declared table's collection before its Header

## The defect

Optimystic stores each table in its own collection, and a collection comes into existence only when something is first written to it. A table nobody has written has no collection, so "this table is empty" is not something any one machine holds: every read has to ask the block's cohort (the machines responsible for it) to prove the collection absent. Optimystic keeps no memory of that answer between reads (the memo was removed upstream; re-adding it is optimystic `backlog/feat-a-cohort-member-remembers-a-settled-absence`), and a read flagged as uncertain is retried once, so every read of such a table costs about two round trips to the other member. With the other member offline the read throws `BlockUnavailableError` (`cohort-unreachable`).

Measured by the reporter (gotchoices/sereus#47, on two relay-only parties sharing a closed strand): 217 ms per read on a 100 ms link, up to 31.7 s on a phone-shaped link with one failed read, and 3 of 3 reads failing with the joiner stopped. Every table that holds a row reads in about 1 ms. When the founder writes and deletes one row in the unwritten table at founding, every read in every arm is local and none fails.

Today the founder writes only `Strand.Header`, `Strand.Member` and `Strand.Manager` (`bootstrapFounderMembership`). Every `App` table, and the strand schema's `Revocation`, `CancelledInvite`, `ConsumedInvite`, `Invite` and `MemberPeer`, start with no collection. A joiner's first writes read `ConsumedInvite`, `CancelledInvite`, `Revocation` through its seat CHECKs, each answered `no-quorum` (`holders: 0, absent: 1`), each asked twice (reporter's second comment on #47).

## The design

**Rule: on a founding run that finds no `Strand.Header`, the founder commits an empty collection for every table declared in the `Strand` and `App` schemas — each table's main tree and every index tree the table maintains — and only then writes the Header.** Peer-join backfill (`peer-join-backfill.ts`) pushes the founder's whole store to each joiner, so every joiner receives those collections, and no read of a declared table ever needs the cohort to prove absence. This also removes the "two machines invent one table" residual for every table that exists at founding: no joiner can create a collection that already exists.

### Why not a marker row

The control database solved this for its `Revocation` table with a marker row (`complete/revocation-ledger-marker`), but that does not generalise. The strand schema's `Revocation` and `CancelledInvite` are `Immutable` and `ConsumedInvite`/`Invite` are `InsertOnly` (`check on update, delete (false)`), each with signature or existence CHECKs on insert, so an insert-then-delete is refused and a lasting marker row would need schema exemptions in four tables. App tables carry arbitrary CHECKs and foreign keys, so sereus cannot synthesise a row that satisfies them, and `applyAppSchema` already refuses `seed` items.

### Mechanism: commit the collections the vtabs themselves opened

Nothing in Optimystic's public SQL surface commits an empty collection. The Optimystic Quereus plugin opens a table lazily, on the first statement that touches it: `OptimysticVirtualTable.doInitialize` calls `CollectionFactory.createOrGetCollection`, which, when no header has been committed, stages a fresh empty collection in the local tracker without writing anything (`Collection.createOrOpen`, the "invented" branch), and registers it — main tree, index trees and unique-enforcement trees — with the transaction bridge (`registerCollections` → `TransactionBridge.registerCollection`). A legacy-mode commit then syncs only the trees DML marked dirty, so an invented tree nobody wrote stays unwritten. The plugin's registration result already exposes `txnBridge` and `collectionFactory` "for testing and advanced usage", and `@serfab/quereus-plugin-sereus` already uses both.

So the new step, owned by the composition in `@serfab/quereus-plugin-sereus`:

1. Open every table: for each non-view table in the `Strand` and `App` schemas (`db.schemaManager.getSchema(name).getAllTables()`, as `strand-first-sync-gate.ts` ~245 does for `App`), run a cheap read such as `select 1 from Strand."Revocation" limit 1`. This initialises the vtab and registers its collections.
2. Assert at the seam: every declared table's main collection id (`defaultCollectionUri(schema, table)` from `@optimystic/quereus-plugin-optimystic` with the `tree://` scheme stripped, the rule `CollectionFactory.parseCollectionId` applies) must now be in `txnBridge.getCollectionRegistry()`. A missing one means the plugin's open or registration path changed; throw naming the table rather than founding a strand that silently skips it. Check the exact casing of the schema segment against a real registry (docs/strands.md says `tree://default/strand/Member`).
3. For every collection in the registry with `committedRevision() === undefined && hasUnsyncedChanges()` (the invented state, which `committedRevision`'s doc comment says is safe to branch on), call `collection.sync()`. Return the count committed.

Expose it on `SereusPluginResult` as `createEmptyCollections(): Promise<number>` (widen the local `OptimysticPluginResult.txnBridge` shim with `getCollectionRegistry(): Map<CollectionId, Collection<unknown>>`, typed from `@optimystic/db-core`). Document on it that it must run only while no other writer can reach the `Database`: `sync()` on a registered collection commits whatever is staged in it, outside any SQL transaction.

Wiring in cadre-core:

- `StrandDatabase` keeps the `connectToStrand` result's `createEmptyCollections` and passes it into `bootstrapFounderMembership` as a new `FounderBootstrapParams` field.
- `bootstrapFounderMembership` calls it after the existing validation and the pre-split check, and before `insertHeaderIfAbsent`, **only when `Strand.Header` holds no row**. Log the count and elapsed time.

Why Header-absent and before the Header:

- A joiner cannot write before it holds the Header (`strand-first-sync-gate.ts`), so while the Header is absent no other machine can have created any of these collections, and creating them cannot fork one.
- A founder restart (the bootstrap re-runs on every founder launch and is meant to be a no-op) finds the Header and skips the step. Running it there would be wrong: a table a joiner wrote while the founder was away would be invented locally on the founder and committed as a second, empty history.
- A crash between the collections and the Header leaves the Header absent, so the next founding run repeats the step; collections already committed are not invented on reopen, so it commits only the rest.

### Tables added by a later app schema version

Decided: **not** created eagerly. Every member applies the app schema itself at connect (`applyAppSchema` runs on every node at every bring-up), and none is privileged to create. A member that upgrades while it cannot reach the others would commit an empty collection of its own beside one another member already created and wrote, which forks the table on reconnect and can lose the other member's rows — strictly worse than today, where that member only forks the table if it writes. Such a table keeps the residual behaviour (reads consult the cohort until its first write; offline reads fail). Parked as `backlog/feat-strand-tables-added-by-a-later-schema-get-their-collection`, which belongs with the strand schema-versioning design the `Header` table's `-- TODO: revisit for versioning` points at.

### Cost

Each collection is a separate `sync()` (header, root and log-tail blocks), sequential, made while the founder is alone, so every one is a local commit. Measure `foundStrand` wall time with and without the step on in-memory storage and on the file-system store, for the scenario's nine-table schema and for the reference chat schema, and put the numbers (and how measured) in a `NOTE:` at the call site. If the added time is material (the founder waits on it before the strand is usable), the tripwire is to commit the collections as one batch through a coordinator, the way the bridge's `commitBatchLegacy` does; do not build that unless the measurement asks for it.

## Edge cases & interactions

- **Founder restart / re-`addStrand` with `founder: true`.** Header present → step skipped, nothing invented is committed. Verify by inspection of the guard; the idempotence spec below covers the "nothing left to commit" half.
- **Crash after some collections, before the Header.** Next founding run commits only the remainder (committed ones open as non-invented). Inspection.
- **Open strand (`'o'`).** `Member`, `Manager`, `Invite` are `OnlyClosed`, but an empty collection holds no row, so no constraint runs. Their collections are still created; inspection.
- **Storage replica.** Never founds (`founderSApp` throws first); no change.
- **`foundStrand` against a still-gated joiner-shaped instance.** Same bootstrap path, same Header-absent guard; the database is still withheld, so no other writer reaches it. Inspection.
- **Concurrency with app and reconciler writes.** The step runs inside `StrandDatabase.initialize` before the database is published, so nothing else stages into those collections. The doc comment on `createEmptyCollections` states the precondition.
- **Commit durability reports.** These syncs bypass the bridge, so `onCommitDurability` reports nothing for them and `StrandCommitRecord` never sees them. Correct: they wrote no row an app would ask about. Inspection.
- **Index and unique-enforcement trees.** Registered by the vtab's init (`reconcileMaintainedIndexes`), so the registry sweep covers them; the scenario's `PartyKey` composite key and any declared index exercise this. The assertion in step 2 checks only main trees.
- **The schema catalog collection (`optimystic/schema`).** Already committed by `apply schema`, so it is never in the invented state; skipped by the predicate.
- **A failure mid-sweep.** `sync()` throws → `bootstrapFounderMembership` throws → `initialize` throws → the caller closes the half-built database (existing path). Header was not written, so the retry repeats the step.
- **Joiner side.** Unchanged: it never calls the step. Its first-sync probe now finds every `App` collection on the founder; `Strand.*` collections arrive through peer-join backfill, and a read before backfill lands fetches the header from the founder once and holds it.
- **Upgrade-added tables.** Not covered by design (above); the docs residual says so.

## Tests

- **The reproduction:** commit the reporter's scenario from the issue body (`gh issue view 47 --repo gotchoices/sereus --json body -q .body`; the diff is in the first comment) as `packages/integration-tests/src/scenarios/strand-read-cost-over-relay.integration.ts`, with the reporter's later diff applied (the offline arm runs on the 100 ms pipelined link, because on loopback whether a lone founder answers "absent" or "unknown" depends on timing). Run it once before the fix to see the two arms fail, then make them plain `it`. Delete the `touchUnwritten` control arm and its option: with the fix it repeats the main arms. Keep the opt-in phone arm.
- **Acceptance for the strand tables:** extend the scenario's read pass with the `Strand` tables (`Header`, `Member`, `Manager`, `MemberPeer`, `Invite`, `ConsumedInvite`, `CancelledInvite`, `Revocation`, read as `Strand."<T>"`), so the same "no read slower than `LOCAL_READ_MS`, connected" and "no failures, other member stopped" assertions cover them. `Revocation` and `CancelledInvite` are the ones nothing in the journey writes.
- **One spec at the plugin layer** (`packages/quereus-plugin-sereus/test/`): compose a strand on the `test` transactor with a small `App` schema holding a table with an index, call `createEmptyCollections()`, and assert that it returns a non-zero count, that afterwards opening each declared table's main collection with `Collection.open`/`Tree.open` on the same transactor resolves defined, and that a second call returns 0. This pins the invented-vs-committed branch without the relay harness. No cadre-core unit test for the Header guard: it is one `if` on a count, verified by inspection and by the scenario's founding.

## TODO

- Add the scenario file from the issue (with the 100 ms offline-arm diff and the `Strand` tables in the read pass); run it and confirm the two arms fail at HEAD.
- Widen the `OptimysticPluginResult` shim's `txnBridge` with `getCollectionRegistry`; implement `createEmptyCollections` in `compose-strand.ts` (open every `Strand`/`App` table, assert main collections registered, sync invented ones); add it to `SereusPluginResult` in `types.ts` with its precondition documented.
- Add the plugin-layer spec described above.
- Thread it through `StrandDatabase` into `FounderBootstrapParams`; call it in `bootstrapFounderMembership` before `insertHeaderIfAbsent`, guarded by an empty `Strand.Header`; update that function's doc comment.
- Measure founding cost (in-memory and file-system store; nine-table and reference chat schemas) and record it in a `NOTE:` at the call site, with the batch-commit tripwire.
- Rewrite the `strandHasManagerRevocation` NOTE in `strand-membership-writer.ts` (~364): `Strand.Revocation` is now committed at founding, so the "consults the cohort on every read" half no longer holds; keep the table-growth NOTE.
- Make the scenario's failing arms plain `it`; run `yarn workspace @serfab/integration-tests exec vitest run strand-read-cost-over-relay`, the plugin-sereus and cadre-core suites, `yarn lint` and the type checks.
- `docs/strands.md` ~244: replace the open-question sentence of the first residual with the rule (founder commits every declared table's collection before its Header, so absence never needs the cohort), and narrow the residual to tables added by a later schema version, linking the backlog ticket. `docs/architecture.md` § Strand Membership Bootstrap: one item saying the founder creates every declared table's collection before the Header, and why.
