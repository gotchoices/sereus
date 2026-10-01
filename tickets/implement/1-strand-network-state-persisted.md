description: When a machine restarts, it should remember which machines it was sharing each workspace with and how to reach them, using the ring library's own saved routing table instead of Sereus's separate address book. Save that table for every workspace node, then prove that the "two relay-only machines restart" test passes without the address book.
prereq:
architecture: docs/architecture.md#strand-address-resolution
files: packages/cadre-core/src/strand-network-state.ts (new), packages/cadre-core/src/strand-network-state-file.ts (new), packages/cadre-core/src/strand-instance-manager.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/types.ts, packages/cadre-core/src/index.ts, packages/cadre-core/src/node-local-snapshot.ts, packages/cadre-core/package.json, packages/cadre-core/test/strand-network-state.spec.ts (new), packages/cadre-cli/src/commands/start.ts, packages/reference-app-rn/src/cadre-phone.ts, packages/reference-app-rn/src/node-local-slots.ts, packages/reference-app-rn/src/phone-node-config.ts, packages/reference-app-web/src/lib/cadre-web.ts, packages/reference-app-web/src/lib/node-local-slots.ts, packages/reference-app-ns/src/cadre-phone.ts, packages/reference-app-ns/src/node-local-slots.ts, packages/integration-tests/src/harness/node-fixtures.ts, packages/integration-tests/src/harness/fixtures/strand-restart-party.mjs, packages/integration-tests/src/scenarios/strand-relay-only-restart-reconverges.integration.ts, every packages/*/package.json that names @optimystic/*, yarn.lock, docs/architecture.md, docs/strands.md, docs/testing.md, .release-notes.pending.md
difficulty: hard
----
# Persist each strand node's network state (FRET table with address records)

## Why

Sereus's strand peer book (`strand-peer-book*.ts`, gotchoices/sereus#18) lets a restarted strand node dial the other parties' strand nodes. FRET 1.0.0 now does this job itself: neighbour snapshots carry signed libp2p peer records, and the exported routing table carries each peer's record, which `importTable` hands back to the peerStore (read `../Fret/tickets/complete/10-address-hints-live-exchange.md` and `10.5-address-hints-persisted-table.md`, and `../Fret/docs/fret.md` → *Routing table persistence*). `@optimystic/*` 1.8.1 requires `p2p-fret ^1.0.0`. The table only survives a restart if db-p2p is given `NodeOptions.persistence`, which no Sereus node passes today.

This ticket adds that persistence for strand nodes and then runs the #18 restart scenario with the book reduced to its in-memory default. Passing is what licenses `remove-strand-peer-book` (the next ticket) to delete the book. The book stays in place in this ticket.

## The db-p2p contract (read-only, `../optimystic/packages/db-p2p/src/libp2p-key-network.ts`)

```ts
interface NetworkStatePersistence {
	load(): Promise<PersistedNetworkState | undefined>;
	save(state: PersistedNetworkState): Promise<void>;
}
// PersistedNetworkState: { version: 2, networkHighWaterMark, lastConnectedTimestamp,
//   consecutiveIsolatedSessions, fretTable?: SerializedTable, servingPeers?: string[] }
```

Both types and `PERSISTED_STATE_VERSION` are exported from `@optimystic/db-p2p`. `createLibp2pNode` calls `load()` once, after the node starts, and imports the table (a wrong `version` is discarded and a structurally corrupt table is refused, both logged, never thrown). It calls `save()` fire-and-forget on every `connection:open` and on the microtask after a serving verdict changes. It never saves on stop. Sereus must not validate the payload beyond "a plain object with a numeric `version`": db-p2p owns the version fence and FRET owns table validation.

## Design

**Store** (`strand-network-state.ts`, cross-platform, default entry). One node-local, never-replicated record per party, keyed by strand id. It uses the same `NodeLocalSnapshot` machinery and `DurableSlot` seam as the bootstrap-peer store and the strand peer book:

```ts
export interface StrandNetworkStateStore {
	readonly partyId: string;
	/** The last state saved for `strandId`, or undefined. Synchronous: served from the in-memory half of the snapshot. */
	load(strandId: string): PersistedNetworkState | undefined;
	/** Replace the strand's state; visible to load() at once, then persisted. */
	save(strandId: string, state: PersistedNetworkState): Promise<void>;
	/** Drop the strand's state; a no-op when nothing is held. */
	forget(strandId: string): Promise<void>;
}
export class MemoryStrandNetworkStateStore implements StrandNetworkStateStore { … }
export class PersistentStrandNetworkStateStore implements StrandNetworkStateStore { static open(slot: DurableSlot, partyId: string): Promise<…> }
/** Adapts one strand's slice of the store to db-p2p's `NodeOptions.persistence`. */
export function strandNetworkStatePersistence(store: StrandNetworkStateStore, strandId: string): NetworkStatePersistence;
```

Envelope: `{ version, partyId, strands: { [strandId]: PersistedNetworkState } }`. Per-entry validation drops an entry that is not a plain object with a numeric `version` (the `drop-entry` policy). The load policy is `NodeLocalSnapshot.open`'s: an absent, corrupt or wrong-party slot is a cold start, and a present-but-unreadable slot throws.

**File backend** (`strand-network-state-file.ts`, Node-only): `FileStrandNetworkStateStore.open(dir, partyId)` over `FileDurableSlot(dir, 'strand-network', partyId)`, exported at the new subpath `@serfab/cadre-core/strand-network-state-file`. It follows the same pattern as `strand-peer-book-file.ts`.

**Config.** `CadreNodeConfig.strandNetworkState?: { store?: StrandNetworkStateStore }`. The default is the memory store. A party mismatch fails closed at `start()`. The store is adopted during `start()` and kept across `stop()`→`start()`. This mirrors `strandPeers` and `initializeStrandPeerBookStore` exactly; copy that code's shape and doc comments. `getStrandNetworkStateStore()` goes beside `getStrandPeerBookStore()`.

**Wiring.** `StartStrandConfig.networkState?: StrandNetworkStateStore`, which `CadreNode.launchStrand` passes. `buildStrandRuntime` passes `persistence: strandNetworkStatePersistence(store, strandId)` to `createLibp2pNode` when it is present. Because the value is retained with the launch config, a hibernation resume rebuilds the node over the same state and re-imports the table. Forget the strand's state everywhere the book forgets it: `unpublishStrand`, `forgetJoinedStrand` and self-revocation. `stopStrand` and a hibernation quiesce keep it. Search for the book's `forget(strandId)` call sites and mirror each one.

**Control node.** Out of scope. Its cross-machine re-mesh is the bootstrap-peer store's job, and nothing here reports it broken.

**Embedders** (add beside the book; do not remove the book here):
- `cadre-cli start`: `FileStrandNetworkStateStore.open(nodeStateDir, partyId)`, next to the `FileStrandPeerBookStore` it opens. cadre-host needs no code because its children run `cadre-cli start`. Update the comment in `cadre-host/src/orchestrator/node-identity.ts` if it lists the files kept in the state directory.
- React Native, web and NativeScript reference apps: `PersistentStrandNetworkStateStore.open(slot, partyId)` over the same slot kind as their strand peer book, under a new key `strand-network.<party>`. Add the key constant beside the `strand-peers.<party>` one in each `node-local-slots.ts`.
- Integration harness: `controlNodeConfig` gains `strandNetworkStateStore` (a pass-through to `strandNetworkState.store`, the same shape as `strandPeerBook`).

**Dependency floor.** Raise every `@optimystic/*` range to `^1.8.1` (`yarn upgrade:optimystic` or by hand, then `yarn check:dep-ranges`). The workspace resolves `@optimystic/*` through `link:` resolutions to `../optimystic`, which is at 1.8.1. Do **not** build or install into `../optimystic` or `../Fret` (see the sibling-repos rule). If the stale-build guard reports either `dist` stale, stop and record that the ticket is blocked on the sibling's build.

## The gate: the #18 scenario without the book

Change `strand-relay-only-restart-reconverges.integration.ts` and its child fixture so that **what makes the arms pass is the network-state store, not the book**:

- **Default arm (in-process):** the book stays at the in-memory default (drop `bookSlot`/`PersistentStrandPeerBookStore`). A `PersistentStrandNetworkStateStore` over an in-memory `DurableSlot` is held outside the node and reopened per incarnation, the same way the book slot was.
- **`RESTART_NEGATIVE_CONTROL=1`:** both the book and the network state are in-memory defaults. It must still fail to converge, exactly as today. That proves the default arm depends on the saved table.
- **`RESTART_TWO_PROCESS=1`:** the child (`strand-restart-party.mjs`) drops `FileStrandPeerBookStore` and opens `FileStrandNetworkStateStore` in the same `node/` directory.
- **A pre-restart gate replaces the book-specific one** (the check "both strand peer books hold the other side's signed entry before the restart"): before anyone stops, each side's saved network state (`store.load(strandId)`) holds a `fretTable` entry for the other side's strand peer id **with an `addressRecord`**. Use a `waitUntil` with a bounded budget. If this gate times out, the problem is the timing of db-p2p's saves (see *Edge cases*), not FRET, and the failure message should say so.
- **The post-restart book assertion** ("each book holds the other side's entry signed after the restart") still holds with an in-memory book, because the swap re-runs between the rebuilt nodes. Keep it in this ticket. `remove-strand-peer-book` removes it together with the book.
- Update the file's header comment, which currently credits the book, and the `[RESTART book|no-book]` log prefix.

Run all three arms in the foreground. Record the timings (reconnect, phase-2 read) beside the book-era numbers in `tickets/complete/4-scenario-relay-only-restart-reconverges.md` (reconnect 1.25–1.39 s, B reads at 1.41–2.46 s, two-process about 12 s).

**If the default or two-process arm does not converge without the book:** stop. Put the scenario back to its book-backed arms, but keep the persistence wiring, which is worth having on its own because db-p2p also restores the high-water mark and serving verdicts. Write a `blocked/` ticket naming what is missing, with the run output, the pre-restart gate's verdict, and whether the saved table held the record. Then add that blocked ticket's slug to the `prereq:` line of `tickets/implement/2-remove-strand-peer-book.md`, so that the removal does not run on a partial replacement.

## Edge cases & interactions

- **db-p2p saves at `connection:open`, before FRET has learned the new peer's record.** The record arrives afterwards, through identify (`peer:update` → FRET adopts it) or a neighbour snapshot, and nothing triggers another save until the next connection opens or a serving verdict changes. So the saved table can lag the live one. The pre-restart gate is what catches this in the scenario. If it only passes because of an unrelated later connection, say so in the handoff. The fix belongs upstream (db-p2p saving when FRET's table changes), so it goes in a blocked ticket, not a Sereus workaround. Verified by the gate.
- **Address rotation during a long connection** (a relay reservation moving): the saved record stays stale until the next save. This matters only for a restart that follows. Park a `NOTE:` at the adapter; no test.
- **Write amplification:** every save rewrites the party's whole snapshot, meaning all strands' tables, and saves fire on every `connection:open`. That is fine for a handful of strands. Add a `NOTE:` at `PersistentStrandNetworkStateStore.save`: if slot writes show up in profiles, move to one slot per strand or coalesce saves. `NodeLocalSnapshot` already serialises the writes, so concurrent saves from several strands cannot interleave. Verified by inspection.
- **Save after forget:** a strand being torn down can still have a save in flight (fire-and-forget from db-p2p) that lands after `forget(strandId)` and resurrects the entry. Guard it: the adapter drops a save for a strand that was forgotten after the adapter was created (for example with a per-strand generation counter held by the store), or state why the ordering makes this impossible. Verified by inspection. Add a store-level assertion only if the guard has real branching.
- **Hibernation resume** must hand the same store to the rebuilt node, so the table the quiesced node last saved is imported. Verified by inspection of `resumeStrand`, which uses the retained launch config.
- **Self entry:** FRET's `importTable` drops a snapshot's record for self, so nothing is needed here.
- **Party mismatch** on an injected store fails `start()` closed, as the book does. By inspection; the pattern is already tested for the book.
- **Wrong or foreign `version`** in a stored entry is db-p2p's to discard. The store must not rewrite or drop it on its own beyond the structural check.

## Tests

- `strand-network-state.spec.ts`: one test for the persistent round trip. Save two strands, reopen over the same slot, get both back, forget one, reopen again, and only the other is left. Also check that a non-object entry is dropped on load. The envelope and load policy are already pinned by `NodeLocalSnapshot`'s own tests, so do not repeat them.
- The scenario changes above are the behavioural proof. No unit test for the wiring.

## TODO

- Raise the `@optimystic/*` floors to `^1.8.1`; `yarn install`; `yarn check:dep-ranges`.
- Add `strand-network-state.ts` (store interface, memory and persistent backends, adapter) and `strand-network-state-file.ts` with its `package.json` subpath export; export from `index.ts`; mention the store in `node-local-snapshot.ts`'s module comment.
- Add `CadreNodeConfig.strandNetworkState`, the adoption at `start()`, `getStrandNetworkStateStore()`, `StartStrandConfig.networkState`, the `persistence` option in `buildStrandRuntime`, and forget at the book's forget sites.
- Wire the embedders: cadre-cli, RN, web, NS, and the integration harness `controlNodeConfig`.
- Change the #18 scenario and its child fixture as described in *The gate*; run all three arms and record the timings.
- Add the store spec.
- Docs: `docs/architecture.md` → Strand-Address Resolution (a restarted strand node re-imports its saved FRET table, which carries signed address records) and the node-local snapshot paragraph (list the new record); `docs/strands.md` → "How a restarted machine re-finds its strand's peers"; `docs/testing.md` topology line for the restart shape (what each arm now uses); `.release-notes.pending.md`: embedders should inject `strandNetworkState.store` (cadre-cli does this itself).
- `yarn lint`, `yarn typecheck`, `yarn workspace @serfab/cadre-core test`, and the embedder unit suites you touched.
