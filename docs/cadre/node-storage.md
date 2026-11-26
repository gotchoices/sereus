# A node's storage

What a cadre node persists, how it asks the embedding program for it, and who owns the handles. The option itself is introduced in [The cadre node → Storage](node.md#storage); this document is the rest of it.

## Storage scope keys

cadre-core calls `storage.open` once per **scope** and passes a **scope key**:

| Scope | Key | Minted by |
|---|---|---|
| A strand | The strand id | The node that founded the strand, which may be another machine |
| The control database | `control-` followed by the lowercase hex of the party id's UTF-8 bytes | `controlStorageScope(partyId)` in `storage-scope.ts` |

**A scope key is opaque and already safe as a name.** Every key stays within `[a-z0-9._-]`, so it can be placed directly in a file path or a database name. The set has no uppercase letters because Windows and macOS file names ignore case. Do not parse a key; `controlStorageScope` and `isControlStorageScope` mint and recognise the control key.

**The control scope is per party.** Two parties on one device ask for two keys and must get two stores. A node started for one party over the other's store would read that party's owners and machines as its own.

A party id is arbitrary text, so the control key encodes it. A strand id arrives by replication from whichever node founded the strand, so it is checked instead: `assertStrandScopeKey` runs at every strand launch, before the scope is opened, and refuses an id that is not a safe name of at most 128 characters or that starts with `control-`. The refusal is `InvalidStrandIdError`, and the watcher does not retry that strand.

There is no form of `storage` that hands one `NodeStorage` to every scope: one value shared that way would put one party's control database in another's store. An embedder that wants sharing gets it from the platform factory, which counts its holders.

## When the scope is opened

`open` is called once per scope per runtime: for the control scope once per `CadreNode.start()`, and for a strand once per launch — a [client](node.md#a-node-that-holds-no-strand-blocks) included, since a client keeps its own blob records, pieces and clock high-water mark. cadre-core keeps what it opened while that runtime lives, so a wake from hibernation reuses it and its warm cache and never calls `open` again.

Two concurrent first uses of the control scope still open it once: cadre-core memoizes the call in flight as well as its result, which matters because LevelDB refuses a second open over one handle.

After `stopStrand`, or a `stop()` followed by `start()`, `open` is called again for that scope and must return storage over the same durable location, as the same object or a new one.

## Who closes what

**cadre-core closes nothing it is handed** — which is why `open` returns a `NodeStorage` rather than Optimystic's `OpenNodeStorage`: cadre-core cannot close what it cannot see a `close()` on. Keep the `OpenNodeStorage` the platform factory returned and close it once the node has stopped; `cadre-cli` does so at process exit, and the edge node in `EdgeNodeStorage.close()`.

The one thing cadre-core releases is its own read-cache lease: on `stop()` for the control scope, on `stopStrand` for a strand. A hibernated strand keeps both its storage handle and its lease, which is what makes the wake warm.

## The read cache

A cold start of a control database or a strand reads the same few blocks many times over, so cadre-core puts Optimystic's write-through read cache in front of every scope's `blocks` and holds the lease for that scope's runtime lifetime (`withReadCache`, through `node-storage-cache.ts`). In-memory blocks, and a block store that reports a read cache of its own, pass through unwrapped.

cadre-core wraps rather than leaving it to the node, because a node releases its lease when **it** stops while cadre-core rebuilds a strand's libp2p node over one store across runtimes — on a hibernation wake and on every rebuild — and Optimystic starts a cache cold once the last lease over a location has released. The node is handed a `blocks` that already reports a cache, so it passes that store through and takes no lease of its own.

The cache is correct only while every write to a location goes through it. Optimystic's helper makes that so within a process, deduplicating by store identity; what is left to the embedder is one process per location.

## Available storage implementations

Each storage package opens all three stores in one call, named for its backend so an embedder that imports two packages gets two distinct names:

| Package | Opener | Environment |
|---|---|---|
| `@optimystic/db-p2p` | `memoryNodeStorage()` | Any. Nothing persists; for tests, and for an embedder that means it |
| `@optimystic/db-p2p-storage-fs` | `fileNodeStorage(basePath)` | Node.js, over one directory |
| `@optimystic/db-p2p-storage-rn` | `levelDbNodeStorage(db)` | React Native, over one open `rn-leveldb` handle |
| `@optimystic/db-p2p-storage-ns` | `sqliteNodeStorage(db)` | NativeScript, over one open SQLite database |
| `@optimystic/db-p2p-storage-web` | `indexedDbNodeStorage(db)` | Browser, over one open IndexedDB handle |

Each asserts before returning that all three of its stores report one store identity, so everything the node keeps is inside the one location its block store measures. A layout that puts the key-value store or the piece store elsewhere fails at the first open instead of quietly leaving those bytes out of every figure the node reports about itself.

## The storage allotment

`storage.allotmentBytes` is how many bytes of this machine the operator gave each network this node serves. It reaches the control node and every strand node unchanged, not divided between them.

So with N strands running, a machine can hold up to (N+1) times that figure before any one node reports itself full: **the number bounds one network's share of the machine, not the machine.** On a Node host the file backend reports free space as well, which each node measures against too, so the disk cannot be filled past its own size. It is not divided because a node's allotment is fixed when the node is constructed while the strand count changes as it runs.

Two things read it. Each node's blob read-cache budget becomes the smallest of Optimystic's 256 MiB cap, an eighth of this figure, and what the node's other use leaves. And each node refuses writes above 0.95 of its effective total ([A write the cohort has no room for](../strands/writes.md#a-write-the-cohort-has-no-room-for)). Optimystic's ring move-in, move-out and released-block sweep stay inert here, because every Sereus node turns the rebalance reaction off wherever its peer-join catch-up is armed.

Left out, the figure is "as much as the backend reports free" — nothing at all on SQLite, LevelDB or memory, so such a node cannot tell how full it is and says so at start-up. Anything but an integer above 0 throws when the node is constructed; cadre-core validates nothing of it, so that refusal has one home.

## Limits and accepted tradeoffs

- **The allotment bounds one network, not the machine.** N strands plus the control network can hold up to (N+1) times `allotmentBytes` before any one node refuses a write; on a Node host the backend's own free-space figure is the only thing that keeps the disk from filling. Accepted because a node's allotment is fixed when it is constructed while the strand count changes as it runs. Revisit when Optimystic can take one account across several nodes of a machine, or when Sereus turns ring shedding on (ticket `5-ring-zulu-storage-rings`).
- **The pressure thresholds and the measurement cadence are not exposed.** Optimystic's `thresholds` (reclaim 0.40, shed 0.85, refuse 0.95) and `usedBytesCacheTtlMs` (60 s) stay at their defaults: nothing has measured a reason to move them, and one number is what an operator understands. Revisit if an operator reports a node refusing or shedding at the wrong point.
- **How full a machine is cannot be read as one figure.** Optimystic's `node.storageAccount` and `node.storagePressure` are per node, and nothing in Sereus surfaces either; answering the question would mean summing them across the control node and every strand node. Not built because no operator has asked.
