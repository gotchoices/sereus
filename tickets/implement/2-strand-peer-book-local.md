description: A machine that restarts forgets the addresses of the other people's machines in a shared workspace, so it comes back up alone and stops replicating. Keep a small per-workspace address book in the machine's own storage and dial it first on every start.
prereq: strand-catch-up-skips-non-speaking-peers
architecture: docs/architecture.md#strand-address-resolution
files: packages/cadre-core/src/strand-peer-book.ts, packages/cadre-core/src/strand-peer-book-file.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/strand-instance-manager.ts, packages/cadre-core/src/types.ts, packages/cadre-core/src/index.ts, packages/cadre-core/package.json, packages/cadre-core/test/cadre-node-strand-seed.spec.ts, packages/cadre-core/test/cadre-node-strand-addr-refresh.spec.ts, packages/cadre-cli/src/commands/start.ts, packages/cadre-host/src/orchestrator/node-identity.ts, packages/reference-app-rn/src/cadre-phone.ts, packages/reference-app-rn/src/node-local-slots.ts, packages/reference-app-web/src/lib/cadre-web.ts, docs/strands.md, docs/architecture.md
difficulty: hard
----

## Why

gotchoices/sereus#18. A cross-party strand learns the other party's strand addresses once, at formation (`CadreNode.crossPartyStrandAddrs`, in memory), and the strand-addr RPC answers own-party siblings only. After a restart neither relay-only party has any address for the other: the FRET ring and the Optimystic cohort each contain only self, the strand reports `active`, local writes succeed, nothing replicates. Maintainer decision (2026-09-27), item 1: a local address book per machine, per strand, in the machine's own storage (not in the strand database), holding the strand peers it has connected to with their last-known addresses and a last-seen time; dialed before anything else on attach; entries aged out, because a failed relayed dial costs up to 14 s at the declared link. Item 2 (swapping books between members, signed) is the next ticket; this one lays the store and the local write/read paths so that ticket only adds a protocol.

## Design

### Entry and store

```ts
/** One strand peer this node knows an address for. `sig` is set only on an entry the peer signed itself (next ticket). */
export interface StrandPeerEntry {
	/** The peer's STRAND transport peer id (never a control peer id). */
	peerId: string;
	/** Multiaddr strings, each bound to `peerId` (trailing /p2p/<peerId>), signaling-first, at most MAX_STRAND_ADDRS. */
	addrs: string[];
	/** Signer's clock, ms: when the peer itself issued these addresses. 0 for an entry this node observed or was handed unsigned. */
	issuedAt: number;
	/** Base64 Ed25519 signature by the peer's strand transport key (next ticket); absent = local-only, never forwarded. */
	sig?: string;
	/** This node's clock, ms: when it last held a connection to the peer, or 0 for an entry it has never connected to. Local, never on the wire. */
	lastSeenAt: number;
}

export interface StrandPeerBookStore {
	readonly partyId: string;
	/** Snapshot of one strand's entries, freshest first (max(issuedAt, lastSeenAt) descending). Empty for an unknown strand. */
	entries(strandId: string): StrandPeerEntry[];
	/** Insert or replace by (strandId, peerId) under the merge rule below. Reflected synchronously; the promise tracks durability only. */
	merge(strandId: string, entry: StrandPeerEntry): Promise<void>;
	/** Drop one peer, or the whole strand when peerId is omitted. */
	forget(strandId: string, peerId?: string): Promise<void>;
}
```

Merge rule, implemented once in the store and unit-tested (both this ticket's unsigned case and the next ticket's signed case go through it):

- A signed entry never yields to an unsigned one for the same peer; between two signed entries the greater `issuedAt` wins; between two unsigned entries the greater `lastSeenAt` wins. `lastSeenAt` is always the `max` of old and new whichever entry wins, because it is this node's own observation.
- Per strand at most `MAX_STRAND_PEERS` (16) peers; when full, the entry with the smallest `max(issuedAt, lastSeenAt)` is evicted. Per entry at most `MAX_STRAND_ADDRS` (exists, 16) addrs, and every addr must attribute to `peerId` under `groupAddrsByPeerId`'s rule (trailing `/p2p/<peerId>`, a relay hop only with a destination behind it); others are dropped at merge.
- Aging: an entry whose `max(issuedAt, lastSeenAt)` is older than `STRAND_PEER_MAX_AGE_MS` (default 14 days; `network.controlCohort.strandPeerMaxAgeMs` overrides) is dropped at load and on every `merge`/`entries` call. The node's own entry is exempt (the next ticket writes it).

Three implementations mirroring `bootstrap-peer-store.ts` exactly, sharing `node-local-snapshot.ts` with the `drop-entry` policy: `MemoryStrandPeerBookStore(partyId)`, `PersistentStrandPeerBookStore.open(slot, partyId)`, and Node-only `FileStrandPeerBookStore` behind a new subpath `@serfab/cadre-core/strand-peer-book-file` (add it to `package.json` exports and to whatever typecheck or dependency-check lists the other `*-store-file` subpaths are in; `yarn check` will tell you which). Envelope: `{ version, partyId, strands: { [strandId]: { [peerId]: StrandPeerEntry } } }`. Config: `CadreNodeConfig.strandPeers?: { store?: StrandPeerBookStore }` with the same party-mismatch fail-closed check as `bootstrapPeers`, memory default, retained across `stop()`→`start()`, not cleared by `cleanup()`.

Why per node rather than one store per strand: the existing snapshot machinery writes one slot whole; a node runs a handful of strands with at most 16 peers each, a few KB. The embedder therefore wires one slot, like the other node-local stores. Why a node-local store and not the strand database: the maintainer ruled the in-strand registry out for now (offline members are the only case that would need it); record that as a `NOTE:` in the store's module comment.

### Writers

1. **Formation.** `CadreNode.formStrand` → today `recordCrossPartyStrandAddrs(strandId, addrs)`. Replace the in-memory `crossPartyStrandAddrs` map with the book: group the carried addrs by peer id (`groupAddrsByPeerId`) and `merge` each as an unsigned entry with `issuedAt: 0, lastSeenAt: now` (the responder disclosed them live a moment ago). Delete the map and `recordCrossPartyStrandAddrs`; keep the refresh-throttle clear so a re-formation reaches a running strand on the next tick. Keep `MAX_STRAND_ADDRS` and `sanitizeStrandAddrs` at the formation seam.
2. **Observation.** Every strand libp2p node: on `peer:identify` (the same event `PeerJoinBackfill` now schedules on) where `speaksBlockTransfer(protocols, protocolPrefix)` is true, merge an unsigned entry `{ peerId, addrs, issuedAt: 0, lastSeenAt: now }` whose addrs are the peer's dialable addresses from the identify result (`listenAddrs`, plus the open connection's `remoteAddr` when it carries a `/p2p-circuit`, all bound with `withTrailingPeerId`, signaling-first). The relay never matches, by the prereq's filter. Throttle: at most one write per (strand, peer) per 10 minutes unless the address set changed, so a flapping relayed connection does not rewrite the slot every 14 s. Wire it in `StrandInstanceManager.buildStrandRuntime` beside the backfill (add `StartStrandConfig.onStrandPeerIdentified?(strandId, entry)` or hand the store in; pick the one that keeps the manager free of the store type), and remove the listener in `releaseRuntime` so a hibernation wake re-arms it on the rebuilt node.
3. **Nothing else writes.** Sibling RPC answers are re-resolvable every 10 minutes and stay out of the book.

### Readers

- `resolveCohortSeed(strandId)`: `unionAddrs(siblingAnswers, bookAddrs)` where `bookAddrs` is the flattened, freshest-first address list of `store.entries(strandId)` minus self. Same position the map had. Also used by `resumeStrandRuntime`.
- `refreshOneStrandPeerAddrs`: `contactAddrs` comes from the book instead of the map. The "no sibling and no contact" early return keeps its meaning.
- Diagnostics: add `CadreNode.getStrandPeerBookStore()` beside `getBootstrapPeerStore()`.

"Dial those before anything else" is satisfied by the existing seed path: `bootstrapNodes` reaches `@libp2p/bootstrap`, which dials at start, and `mergeStrandPeerAddrs` files them under the peer id for every later bare-peer-id dial. Confirm on the relayed restart that the dial goes out before the first-sync probe; the scenario ticket measures it.

### Aging versus a failed dial

The book cannot see dial outcomes (dials happen inside libp2p and Optimystic). Aging is therefore time-based, and the 14 s cost is bounded by the 16-peer cap and by a live peer refreshing its entry on every connection. If a case shows a dead entry re-dialed every tick for two weeks, the lever is `connection:close`/dial-failure observation; leave a `NOTE:` at the merge site.

### Embedders

Wire a durable backend everywhere `bootstrapPeers.store` is wired today, with the same slot kind: `cadre-cli/src/commands/start.ts` and `cadre-host/src/orchestrator/node-identity.ts` (`FileStrandPeerBookStore.open` in the state directory), `reference-app-rn/src/cadre-phone.ts` + `node-local-slots.ts` (app-private LevelDB key; dial hints are not trust-bearing, same argument as the bootstrap peers), `reference-app-web/src/lib/cadre-web.ts` (the same IndexedDB slot kind its bootstrap-peer store uses). The book is not trust-bearing: an address grants no authority and the dialed peer authenticates by peer id at the handshake, the same statement `bootstrap-peer-store.ts` makes.

## Edge cases & interactions

- **Restart with a book but no sibling and no formation** (the #18 shape): seed = book entries. Proven by the scenario ticket; at unit level, extend `cadre-node-strand-seed.spec.ts` with "a pre-populated book seeds a strand with no connected sibling".
- **Hibernation wake**: `resumeStrandRuntime` re-reads the book; the identify listener is re-armed on the rebuilt node. Inspection of `releaseRuntime`/`buildStrandRuntime` symmetry.
- **Self in the book**: `mergeStrandPeerAddrs` already skips self; the seed flattening must skip self too, and the observation writer never sees self (identify is about remotes). Assertion at the seed flattening.
- **Two strands on one node**: entries keyed by strand. One machine in two strands has two different transport ids, so the same peer id under two strands is only a test-fixture artefact; keyed per strand regardless. Inspection.
- **A junk address from a responder or a peer's identify**: dropped at merge if it does not attribute to the peer id; otherwise it costs one failed dial per launch until it ages out or the peer's next connection replaces the entry. Same posture as the existing `mergeStrandPeerAddrs` `NOTE:`; update that note, which currently says the cross-party list "never ages out" and is re-merged for the node's lifetime, which is no longer true.
- **`unpublishStrand`, `stopStrand`, `forgetJoinedStrand`, self-revocation**: `unpublishStrand` and `forgetJoinedStrand` (from the sibling ticket, if landed; otherwise leave a `NOTE:`) call `forget(strandId)`; `stopStrand` keeps the book (the strand is rediscovered on restart); self-revocation forgets. This resolves the "evict on `unpublishStrand`" tripwire the map carried.
- **Store slot unreadable at start**: `drop-entry` policy loads what parses; a slot that throws at `load()` should behave as `PersistentBootstrapPeerStore.open` does on a throwing slot; read it and match it.
- **Concurrent merges from several strands' identify handlers**: check whether `node-local-snapshot.ts` serialises writes; verify, do not assume.
- **Refresh test fallout**: `cadre-node-strand-addr-refresh.spec.ts` and `cadre-node-strand-seed.spec.ts` currently reach into `crossPartyStrandAddrs`; move them onto the store.

## Tests

- `strand-peer-book.spec.ts`: the merge rule (signed-over-unsigned, freshness, per-strand cap eviction, aging, addr attribution) in one table-driven test, and the persistent round trip with a junk entry dropped. This is the contract every later ticket leans on.
- `cadre-node-strand-seed.spec.ts`: a pre-populated book seeds a strand with no connected sibling; and a formation result populates the book (replacing the existing map-based assertion).
- No new test for the identify writer beyond what the scenario proves; an assertion in the handoff that `strand-formation-cross-party-seed` leaves both nodes' books non-empty is enough.

## Docs

- `docs/architecture.md` → "Strand-Address Resolution": rewrite the "Cross-party: carried by formation" bullet. The formation seed now lands in the per-node strand peer book, which also records every strand peer the node connects to, is read on launch, resume and refresh, and ages out after 14 days; the map is gone.
- `docs/strands.md` → the "Two limits are real" list: the in-memory limit is closed; the never-refreshed limit closes in the next ticket. Add how a restarted machine re-finds its strand's peers.
- `types.ts` config doc for `strandPeers`; `.release-notes.pending.md` bullet.

## TODO

- Store module, file subpath, config field, exports, party-mismatch check, diagnostics getter.
- Replace `crossPartyStrandAddrs` with the book at formation, seed, resume and refresh; delete the map and update the two `NOTE:` comments named above.
- Identify-driven observation writer in `StrandInstanceManager`, armed and released with the runtime, throttled.
- Forget on `unpublishStrand` and self-revocation.
- Embedder wiring in CLI, host, RN, web.
- Tests; `yarn workspace @serfab/cadre-core test`, `yarn lint`, `yarn typecheck`, `yarn check` for the new subpath, and integration scenarios `strand-formation-cross-party-seed`, `strand-addr-seed-convergence`, `strand-circuit-same-party-e2e`, `blind-relay-phone-to-phone-e2e` in the foreground.
- Docs and release note.
