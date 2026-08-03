----
description: When a second machine joins a shared strand it only receives data written from that point on; anything written earlier never gets copied to it. Copy the earlier data across when the machines first connect, so each machine holds a full copy instead of depending on the original machine staying online.
prereq:
files: packages/cadre-core/src/strand-backfill.ts (new), packages/cadre-core/src/strand-instance-manager.ts, packages/cadre-core/src/types.ts, packages/cadre-core/src/index.ts, packages/cadre-core/src/cadre-node.ts (~line 3500-3520, buildStrandLaunchConfig), packages/integration-tests/src/scenarios/strand-membership-closed-strand-e2e.integration.ts, packages/integration-tests/src/harness/block-store-probe.ts, docs/cadre-consistency.md, docs/architecture.md
difficulty: hard
----

## The gap, restated in one paragraph

On a two-node strand, every block the founder commits *after* the second node dials in is
physically in that node's own block store about a millisecond later — the push is part of the
commit. Blocks committed *before* the dial are never copied. Nothing pushes them and nothing
pulls them. The joiner can still read those rows, because a read picks one coordinator peer per
block and that coordinator is the founder answering from its own storage — so the gap is
invisible until the founder goes offline, at which point the joiner holds no copy of the strand's
founding membership rows. Measured in
`packages/integration-tests/src/scenarios/strand-membership-closed-strand-e2e.integration.ts`:
9 of the founder's 27 blocks never reached the joiner, all 9 committed before the dial.

## The decision this ticket settles (the plan stage's open questions, resolved)

**1. Is "one node holds it" actually a defect?** Yes.
[`docs/architecture.md` → Replication cluster size](../../docs/architecture.md#replication-cluster-size)
sets the strand replication target at 4 (`DEFAULT_STRAND_CLUSTER_SIZE`) precisely so a commit
survives one holder being offline, and Optimystic shrinks a cohort to the peers that actually
serve the network — so on a two-machine strand the intended holder count is *both* machines. A
block sitting on exactly one machine while a second machine serves the same strand is below the
declared target, not a design choice. No further durability-model decision is needed to justify
the fix.

**2. Optimystic's cohort layer, or cadre-core's strand path?** cadre-core.
`../optimystic` is a **read-only** sibling for this repo — that is already the recorded rule in
[`tickets/blocked/offline-node-cannot-serve-its-own-data.md`](../blocked/offline-node-cannot-serve-its-own-data.md)
("the one code site that must change is … in a repository this one may read but not edit"). The
upstream primitives this needs are already exported and usable from here, so no upstream change
is required:

- `BlockTransferClient.pushBlocks(...)` (from `@optimystic/db-p2p`) sends blocks to a peer over
  `/optimystic/strand-<strandId>/db-p2p/block-transfer/1.0.0`.
- The receiver's `BlockTransferService.handlePush` persists each block through
  `StorageRepo.saveReplicatedBlock`, which is monotonic and idempotent — a block the receiver
  already holds at an equal-or-newer revision is a durable no-op, and the response's `missing`
  array names anything it could not parse or persist.
- The service is registered on **every** node the factory builds (`libp2p-node-base.ts` →
  `services.blockTransfer`), including strand nodes, so nothing needs enabling on the receiving
  side.

**3. Push or pull?** Push. A joiner cannot enumerate what it does not have — there is no
"list the block ids you hold" request in the block-transfer protocol, and adding one would be an
upstream change. The holder knows its own ids (`IRawStorage.listBlockIds`, implemented by all four
production backends — fs, ns/sqlite, rn/leveldb, web/indexeddb — and by `MemoryRawStorage`).

**4. Why not mirror the control database's row-level re-issue queue** (`CadreNode.drainPendingControlReplication`)?
Because it would only cover rows cadre-core itself knows how to re-author. Re-touching a row
under the strand RBAC schema requires the right signing key (only a manager may touch `Header` /
`Manager`), covers no application (`App.*`) data written while alone, and rewrites only the tree
path the update touches — a unique-index block whose indexed value did not change is not
rewritten, so it would stay uncopied. A block-level copy has none of those holes.

## What to build

A new cadre-core module, `packages/cadre-core/src/strand-backfill.ts`, plus its wiring into
`StrandInstanceManager`. Behaviour: **when a strand's libp2p node opens a connection to a peer
this runtime has not yet caught up, copy every block in this strand's own raw store to that
peer.** Both sides run it, so the catch-up is symmetric without any coordination.

### Interface (write it close to this; adjust names only for good reason)

```ts
/** Tuning for the per-peer strand catch-up. Every field optional; defaults in DEFAULT_STRAND_BACKFILL. */
export interface StrandBackfillConfig {
  /** Default true. False disables the catch-up entirely (the pre-existing behaviour). */
  enabled?: boolean;
  /** Settle time after a connection opens before catching that peer up, ms. Default 1000. */
  debounceMs?: number;
  /** Ceiling on blocks copied in one catch-up. Default 10_000. Reaching it is LOGGED, never silent. */
  maxBlocks?: number;
  /** Soft byte budget per push message. Default 1 MiB. Protocol hard cap is MAX_BLOCK_MESSAGE_BYTES (8 MiB). */
  maxChunkBytes?: number;
  /** Max blocks per push message. Default 64. */
  maxChunkBlocks?: number;
  /** Per-push dial deadline, ms. Default 3000 (matches SpreadOnChurnMonitor). */
  dialTimeoutMs?: number;
  /** Per-push response deadline, ms. Default 10_000 (matches SpreadOnChurnMonitor). */
  responseTimeoutMs?: number;
}

export interface StrandBackfillDeps {
  strandId: string;
  /** The STRAND's libp2p node (not the control node) — source of connection events and peer ids. */
  libp2p: Libp2p;
  /** `node.keyNetwork`, the IPeerNetwork BlockTransferClient dials through. */
  peerNetwork: IPeerNetwork;
  /** This strand's own raw block store — the same instance handed to the libp2p node. */
  storage: IRawStorage;
  /** Must equal the prefix the receiver registered its handler under: `/optimystic/strand-<strandId>`. */
  protocolPrefix: string;
}

/** What one peer's catch-up actually did. Returned for tests and logged at the end of each run. */
export interface StrandBackfillResult {
  /** Blocks offered: had a committed `latest` AND materialized content locally. */
  offered: number;
  /** Blocks the remote reported it persisted. */
  accepted: number;
  /** Block ids the remote reported in `missing` (parse or persist failure on its side). */
  rejected: string[];
  /** Skipped: metadata has no `latest` (pending-only — not yet a durability claim here). */
  uncommitted: number;
  /** Skipped: `latest` exists but no materialized block is stored for that actionId. */
  unmaterialized: number;
  /** Not attempted because `maxBlocks` was reached. */
  capped: number;
}

export class StrandBackfill {
  constructor(deps: StrandBackfillDeps, config?: StrandBackfillConfig);
  /** Subscribe to connection:open AND schedule a catch-up for peers already connected. */
  start(): void;
  /** Unsubscribe, clear timers; in-flight runs observe the stopped flag and bail. */
  stop(): void;
  /** Run one peer's catch-up now, bypassing the debounce. The unit tests' entry point. */
  catchUpPeer(peerId: PeerId): Promise<StrandBackfillResult>;
}
```

### Behaviour rules

- **Trigger.** `libp2p.addEventListener('connection:open', …)`, taking `evt.detail.remotePeer`.
  `start()` also walks `libp2p.getConnections()` once, so a runtime rebuilt (`resumeStrand`) over
  live connections still catches up.
- **Debounce per peer**, `debounceMs`, so bring-up connection churn produces one run per peer.
- **One-shot per peer per runtime, on SUCCESS only.** Keep a `Set<string>` of peer ids fully
  caught up and a `Set<string>` of in-flight ones. A run that threw, or whose remote reported
  anything in `missing`, does **not** mark the peer done — the next `connection:open` from that
  peer retries. A `StrandBackfill` is per strand runtime, so `stopStrand`/`quiesceStrand` resets
  the memo naturally.
- **Reading a block locally**: `storage.getMetadata(blockId)` → skip when `metadata.latest` is
  absent (count `uncommitted`); otherwise `storage.getMaterializedBlock(blockId, latest.actionId)`
  → skip when absent (count `unmaterialized`). Send `blockMeta[blockId] = { rev, actionId }` from
  `latest` so the receiver replicates at the source's revision instead of fabricating rev 1.
- **Chunking.** Encode each block once (`JSON.stringify` → `TextEncoder`) and accumulate into a
  chunk until either `maxChunkBlocks` or `maxChunkBytes` would be exceeded; flush with
  `pushBlocks(ids, buffers, 'replication', blockMeta, { dialTimeoutMs, responseTimeoutMs })`. A
  single block larger than `maxChunkBytes` still goes in a chunk of its own (never dropped),
  unless it alone exceeds `MAX_BLOCK_MESSAGE_BYTES` — then skip it and log the id and size.
- **Best-effort throughout.** A failed chunk is logged and the run continues to the next chunk;
  nothing here may throw into a libp2p event handler or into `buildStrandRuntime`.
- **No silent caps.** Reaching `maxBlocks`, skipping an oversized block, and any non-empty
  `rejected` list each produce a log line naming the counts. The end-of-run log line reports the
  whole `StrandBackfillResult`.
- **Stop is prompt.** Check the stopped flag between chunks and abandon the run.

### Wiring

- `packages/cadre-core/src/types.ts`
  - `Libp2pNodeWithRepo` gains `keyNetwork?: IPeerNetwork` (from `@optimystic/db-core`). Optional
    deliberately: the base factory always assigns it (`libp2p-node-base.ts:1280`) but it is not in
    the upstream node type, so declaring it required would be a claim this repo cannot enforce.
    Backfill logs once and stays inert when it is absent.
  - `CadreNodeConfig` gains `strandBackfill?: StrandBackfillConfig`, documented next to
    `strandClusterSize`.
- `packages/cadre-core/src/strand-instance-manager.ts`
  - `StartStrandConfig` gains `backfill?: StrandBackfillConfig`.
  - `buildStrandRuntime`: after `strandDb.initialize()` succeeds, construct + `start()` a
    `StrandBackfill` when **all** of: `mode === 'networked'`, `strandStorage` is present,
    `node.keyNetwork` is present, `config.backfill?.enabled !== false`. Track it in a private
    `Map<string, StrandBackfill>` on the manager (not on the public `StrandInstance` type).
  - `releaseRuntime`: `stop()` and delete the entry **before** closing the database and stopping
    the node, so no push is issued against a torn-down transport.
- `packages/cadre-core/src/cadre-node.ts` (~3500-3520, where `clusterSize:
  this.config.strandClusterSize` is passed): pass `backfill: this.config.strandBackfill`.
- `packages/cadre-core/src/index.ts`: export the module's public types.

### Tripwires to leave in the code (comments, not tickets)

- At the top of `strand-backfill.ts`: `NOTE:` this copies the **whole** local store to every newly
  connected strand peer, which is right while a strand mesh is one party's handful of machines
  (see `docs/architecture.md` → Replication cluster size, "On a strand, the machine count is not a
  party count"). If strand meshes ever get large, filter the pushed set by FRET cohort
  responsibility for each block id instead of pushing everything.
- Same file: `NOTE:` this lives in cadre-core only because `../optimystic` is read-only from this
  repo. If Optimystic ever grows a cohort-join catch-up of its own, delete this module rather than
  running two.

## Test plan

### Unit — `packages/cadre-core/test/strand-backfill.spec.ts` (new)

Drive `catchUpPeer` against a fake `IRawStorage` and a fake push transport (inject the client
factory, or a seam that lets the test capture `pushBlocks` calls — do not dial libp2p here).

- copies every committed+materialized block, with `blockMeta` carrying the source `(rev, actionId)`
- skips a block whose metadata has no `latest` → counted `uncommitted`, never pushed
- skips a block with `latest` but no materialized content → counted `unmaterialized`, logged
- chunks by block count and by byte budget; a chunk never exceeds either
- a single block over `maxChunkBytes` still ships alone; one over `MAX_BLOCK_MESSAGE_BYTES` is
  skipped and named in the log
- `maxBlocks` reached → `capped > 0` and the remaining blocks are not pushed
- remote reports `missing` → those ids land in `rejected` and the peer is **not** marked done, so a
  second `catchUpPeer` retries them
- a throwing push → the run resolves (never rejects), the peer is not marked done
- a successful run marks the peer done: a second `connection:open` from the same peer pushes nothing
- `stop()` mid-run: no further chunks are pushed
- storage without `listBlockIds` → one log line, zero pushes, no throw

### Integration — extend the existing physical test

`packages/integration-tests/src/scenarios/strand-membership-closed-strand-e2e.integration.ts`,
the test `"replicates the founder's blocks PHYSICALLY into the joiner's own block store"`:

- **Keep** the existing `authoredSinceDial`-narrowed gate exactly as it is — it is the
  ongoing-replication claim and it is still true.
- **Add** a second gate after it: `compareBlockCoverage(founderStore, joinerStore)` with **no**
  `include` narrowing, polled to completeness. This is the whole point of the ticket: the founder's
  pre-dial bootstrap blocks must now be physically present on the joiner.
- **Rewrite** the `WHAT IS AND IS NOT CLAIMED` comment block (currently lines ~860-888). It
  presently instructs the reader *not* to widen the comparison and points at
  `backlog/debt-strand-no-backfill-of-pre-membership-blocks`; both statements stop being true here.
  Record the new measurement (block counts before and after) in its place.
- The `⚠ THE JOINER'S DATABASE IS OFF LIMITS` rule still holds and still matters — the new gate is
  also a raw-store poll. Do not read `joinerDb` at or after the founder-only writes.
- One claim in the source plan ticket is **wrong and must not be carried forward**: it says the two
  collection root blocks "are not a gap at all" because each node mints its own random root id.
  Each node minting a different id is true, but it means the joiner holds a *useless local* root
  and lacks the founder's *real* one — the block through which the founder's collection is
  traversed. A push copies the founder's root under the founder's id, so the joiner ends up
  holding it and `founder ⊆ joiner` coverage becomes reachable. If a measured residue remains
  anyway, narrow the new gate with an **explicit, measured** exclusion listing exactly which ids
  and why — never restore a blanket narrowing.

## Edge cases & interactions

- **Both ends push at once.** Founder and joiner each run a catch-up over the same connection.
  `saveReplicatedBlock` is monotonic, so the crossing pushes cannot regress a revision; assert the
  symmetry does not deadlock (the unit suite covers the single-peer path; the integration run is
  the real evidence).
- **Push racing a live commit.** A block being committed while its older revision is pushed:
  `saveReplicatedBlock` no-ops when an equal-or-newer revision is already stored, and takes the
  same per-block commit latch as `StorageRepo.commit`, so ordering is upstream's problem, not
  ours. Do not add locking here; do not push a block read outside that latch as if it were
  authoritative — always send the `(rev, actionId)` the metadata reported.
- **Receiver lacks the base revision.** Not this path's problem — a push carries the whole
  materialized block, not a transform, so there is no base to be missing. (Contrast the commit
  path, which refuses with `missing-base-revision` and heals via `reconcileDivergentCommit`.)
- **Reconnect churn.** A flapping peer must not re-copy the store on every reconnect: the
  success memo plus the debounce is what prevents it. Cover the flap in the unit suite.
- **`quiesceStrand` → `resumeStrand`.** The runtime is rebuilt, so the memo resets and one
  catch-up runs again per peer. That is intended (a resumed node may have missed writes) but it
  means a hibernation-thrashing node re-copies; the cost is bounded by `maxBlocks` and logged.
- **`bootstrap` mode.** No mesh, no backfill. Assert the constructor is not even reached.
- **Storage backends without `listBlockIds`.** Inert, one log line, no throw.
- **Non-member peers.** Anything connected on the strand's own libp2p network already receives
  cohort replicas of new commits, so pushing older blocks to it exposes nothing new. Say this out
  loud in the module comment rather than adding a membership gate that would diverge from what
  ordinary replication already does.
- **Control network is out of scope.** It has its own row-level re-issue queue
  (`drainPendingControlReplication`); do not wire `StrandBackfill` into the control node.

## Known-red neighbourhood — read before you run

All four tests in `strand-membership-closed-strand-e2e.integration.ts` are currently listed in
[`tickets/.pre-existing-known.md`](../.pre-existing-known.md) against the blocked ticket
`strand-unique-index-sync-stale-revision`. If the file is red for that tracked fingerprint, note
it in the handoff and move on — do not chase it, and do not skip, disable, or loosen any test.
Failures your own change causes are of course yours.

## TODO

Phase 1 — mechanism
- Write `packages/cadre-core/src/strand-backfill.ts` to the interface above
- Extend `Libp2pNodeWithRepo` with optional `keyNetwork`; add `CadreNodeConfig.strandBackfill`
- Wire construction/teardown into `StrandInstanceManager` (`buildStrandRuntime`, `releaseRuntime`)
- Thread `backfill` through `cadre-node.ts`'s strand launch config
- Export public types from `packages/cadre-core/src/index.ts`

Phase 2 — unit coverage
- `packages/cadre-core/test/strand-backfill.spec.ts` covering every bullet under *Unit* above
- `yarn workspace @serfab/cadre-core test`, `yarn typecheck`, `yarn lint` — all green

Phase 3 — integration evidence
- Add the whole-store coverage gate to the physical test; rewrite its
  `WHAT IS AND IS NOT CLAIMED` block with the new measured numbers
- Run `npx vitest run strand-membership-closed-strand-e2e` from `packages/integration-tests`,
  streaming output (`… 2>&1 | tee`), and record the measured block counts in the handoff

Phase 4 — docs
- `docs/cadre-consistency.md` → *What Ships Today*: the paragraph beginning "**Measured on the
  strand side, and the gap it exposes.**" currently states that nothing backfills a joiner and
  cites the backlog slug. Replace it with what now happens, keeping the measurement history
- `docs/architecture.md` → *Replication cluster size*: the bullet listing how a member that was
  offline at write time catches up currently names read repair and the control re-replication
  queue; add the strand peer-join catch-up as the third path, strand-only
