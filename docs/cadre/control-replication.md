# Control database replication

This document describes how a cadre's control database is stored and replicated across the party's nodes: which Optimystic network carries it, how many nodes hold each block and why, how a node that joins late receives blocks written before it arrived, and how a node serializes and retries its own control reads and writes. It is for maintainers changing `ControlDatabase`, the cluster policies or the retry classifiers.

Related: [the control schema](control-schema.md) · [how a party's machines converge](control-convergence.md) · [deadlines and the link budget](../network/deadlines.md) · [the unbuilt consistency design](../design/control-consistency.md)

## Control tables are network-backed

`ControlDatabase.initialize()` makes `optimystic` the database's default virtual-table module, with the network transactor and the party's control network as its arguments, and loads the catalog from stored schemas before it applies the control schema. The `declare schema CadreControl` tables name no storage of their own, so each one is an Optimystic collection, and every control write is a transaction committed by the control network's cluster. `connectToStrand` sets a strand's tables up the same way.

Durability comes from Optimystic's cluster replication alone. There is no sync or CRDT layer underneath; [the consistency design](../design/control-consistency.md) describes one that is not built.

The schema relies on two behaviours of the Optimystic virtual table. A deferred `check` that reads `committed.<Table>` sees the snapshot from before the transaction, which the use cap on `FormationUsage` depends on. And the table enforces secondary `unique` constraints, which is what makes a stamp usable only once.

The control tables declare the query planner's cost profile `localDisk`, because every member answers a control read from its own replica. Optimystic's default for the network transactor is `distributed`, which would add eager prefetches to joins whose reads never leave the machine. Strands keep the default, because a strand holds each block on a subset of its machines.

### Every control table has a collection from genesis

A table nobody has written has no Optimystic collection, and Optimystic keeps no record of an absence. Every read of such a table asks the block's cluster to prove it absent: a round trip to the other machines, and an error or a wait while they are offline.

So `ControlDatabase.ensureOwnerKey`, the one entry point for founding a party, first commits an empty collection for every `CadreControl` table, index tree and unique-enforcement tree, then inserts the founding `OwnerKey` row. Strand founding runs the same step.

A collection committed by a machine that is alone forks only if another machine creates the same collection independently. Before genesis the party has no owner, so no other machine can have been admitted, and the step cannot fork. A founder that restarts finds the `OwnerKey` row and commits nothing. Joining machines receive the collections from the cluster like any other block.

## Network scoping

Cadre creates its libp2p and Optimystic nodes with `@optimystic/db-p2p`, which namespaces every Optimystic protocol by network name. The protocol prefix is `/optimystic/<networkName>`, and the control network's name is `control-<partyId>`. A node therefore speaks the control protocols only with peers that serve the same party's control network.

Sereus's own protocols are separate and live under `/sereus/`: `/sereus/seed/1.0.0` (seed delivery), `/sereus/cadre-invite/1.0.0`, `/sereus/owner-grant/1.0.0`, `/sereus/formation/1.0.0`, `/sereus/strand-wake/1.0.0` (waking a hibernated strand over the control network) and `/sereus/strand-addr/1.0.0` (asking another machine of the party for its strand-network addresses).

### One key network per node

The component that answers which peers hold a key (`findCluster`) and which peer coordinates a write (`findCoordinator`) is built once per node by `createLibp2pNode`, with the node's cluster size and protocol prefix, and attached as `node.keyNetwork`. The node's consensus path and the SQL transactor both use that instance, because the Optimystic plugin's collection factory prefers the attached instance to building one from defaults. Two instances would derive different clusters and different coordinators for the same key.

For a node that a host built without `createLibp2pNode`, the factory builds a key network and passes the protocol prefix through, so discovery stays scoped to the network.

## Replication cluster size

Optimystic replicates each block to a group of nodes, the block's **cluster**, and the embedder says how many nodes that group should have: the cluster size, also called the replication breadth. Some Optimystic identifiers call the same group a cohort (`cohortQueryTimeoutMs`, `cohort-unreachable`). In these documents a cohort is all the nodes that serve a network, and the per-block group is always the cluster. Cadre gives a different answer for the control network and for strand networks, because the two are read differently. The constants and both networks' cluster policies live in `packages/quereus-plugin-sereus/src/cluster-size.ts`, re-exported by `@serfab/cadre-core`, so that the SQL plugin, cadre-core and the test harness use one definition. That file's comments hold the per-field reasoning; this section holds the decisions.

### The control network replicates to the whole party

`CONTROL_REPLICATION_BREADTH` is 16 and is not configurable. Every control node reads the whole control database (membership, peer addresses, the strand list), so a member left out of a block's cluster is a member that may never learn the fact. Optimystic caps a cluster at the peers that serve the network and shrinks one it cannot fill, so any value at or above the party's machine count makes every control cluster the whole party. 16 is about twice the largest party the project expects.

It is a constant and not the live `CadrePeer` count for two reasons. Optimystic fixes the value when the libp2p node is created, which is before the `ControlDatabase` holding those rows exists. And membership is eventually consistent, so two nodes deriving the number would briefly disagree, and a cluster member rejects a coordinator whose declared cluster is smaller than the member's own view allows.

Whole-party breadth covers blocks written while the members were serving the network. A member that was offline at write time is not in the cluster at all, and catches up one of three ways:

- by read repair, on its next read of the block ([Read repair and the corroboration floor](#read-repair-and-the-corroboration-floor));
- by the block catch-up that runs when it connects ([Catching up a new machine](#catching-up-a-new-machine));
- when the writer itself could reach no other member, by the writer re-issuing the row ([Writes made while alone](control-convergence.md#writes-made-while-alone)).

### Why a strand's default cluster size is 4 and its minimum 2

Strand data is application data that no single node needs in full, so its breadth is a tradeoff between storage and availability. `DEFAULT_STRAND_CLUSTER_SIZE` is 4. A host overrides it with `CadreNodeConfig.strandClusterSize`, or with `StrandConnectionOptions.clusterSize` when it calls the SQL plugin directly. Every strand node is created through `resolveStrandClusterSize`, which applies the default and rejects a non-integer or a value below `MIN_CLUSTER_SIZE`. Leaving the value unset would not be neutral: Optimystic's own fallback is 10.

The minimum is 2 because that is Optimystic's own minimum and the smallest size at which a cluster forms at all. A node on its own writes to local storage.

The default is 4 for two reasons:

- **Availability.** A write commits when a super-majority of the cluster approves, and the bar is 0.75. The approvals needed are `ceil(size × 0.75)`: 2 of 2, 3 of 3, 3 of 4. Four is the smallest size at which a write commits while one holder is offline. Five and six still tolerate only one absence.
- **Repair.** With two machines, a member that missed a write has one peer to ask, and cannot detect that the peer missed it too ([Read repair and the corroboration floor](#read-repair-and-the-corroboration-floor)).

The value is a constant and is not derived from the strand's member list. The `Member` rows live in the strand database, which runs on the node whose cluster size is already fixed. Open strands have no member list. A node that restarted after a join would derive a wider cluster than one that did not, and the wider view is the one that rejects the other's writes. And a member is a party, while cluster size counts machines.

### Read repair and the corroboration floor

**Read repair** is how a member that missed a write catches up: on reading a block whose local copy may be stale, it asks the block's cluster for the newest revision. Optimystic trusts an answer only when enough other peers agree on it. That number is the **corroboration floor**, normally two.

When the cluster cannot hold a second peer besides the reader, Optimystic lowers the floor to one and accepts a single peer's answer. If that peer also missed the write it reports the older revision, the reader concludes it is current, and the two never converge. This is the second reason the control database replicates to every member, and the reason a strand does not default to 2.

What raises the floor from one to two is a third machine, or a declaration that there are three. A wider replication target does nothing: Optimystic computes the floor from the larger of the peers it can see and a declared size (`corroboratorCapacity` in db-p2p's `cluster/quorum-restore.ts`). A declaration that is too high is worse than none. A floor of two on a cluster that can only ever supply one peer makes repair impossible, and a joining node's `create table` then fails with `Missing block`.

The visible peer count comes from unauthenticated routing. A partition, a hibernating party or an attacker with influence over routing can shrink it, and the floor with it. So breadth is not what protects repair. The declared size is, and Cadre declares one where it has an exact number.

### Two declared sizes

Optimystic's cluster policy carries two size declarations with different jobs.

`assumedClusterSize` is read by the membership admission gate, the check a cluster member runs before it accepts a coordinator's declared peer set. Both Cadre policies set it to 2, and it must stay there. Raising it to N makes the gate demand `ceil(0.75 × N)` declared peers, and a party of phones and laptops cannot promise that three quarters of its machines are awake.

`repairCorroborationClusterSize` is read only by block repair. Cadre declares it for the control network as `max(MIN_CLUSTER_SIZE, min(enrolled machines, CONTROL_REPLICATION_BREADTH))` (`resolveRepairYardstick`, through `controlClusterPolicy`). A declared size of 3 or more fixes the floor at two corroborators whatever the node can currently see. Declaring 1 or 2 changes nothing. The upper bound exists because a block never lives on more machines than the cluster is wide. The lower bound exists because a node that authorizes nobody may be a founder alone, a newly seeded node or a node with an empty anchor, and cannot tell which.

**Where the count comes from.** It is the number of authorized members (the `CadrePeer` rows whose owner voucher or invitation chain verifies) plus this node. It comes from authenticated application state, not from what the network shows, and it is exact because every enrolled machine runs the control node. Two members briefly holding different counts is harmless, because the value governs only each node's own reads.

**When it applies.** The control libp2p node is built before the control database exists, so a node cannot read the count when it needs it. The node writes the count to a node-local record on every membership refresh (`enrolled-machine-store.ts`; see [Node-local state](node.md#node-local-state)) and reads it back at start, so it declares what it knew at its last run. A node with no record, or an unreadable one, declares nothing.

**What it costs.** The same number feeds Optimystic's commit freshness rule: a local commit lets later reads of the block skip the cluster consult only when its approvals exceed half of `max(observed cluster, declared size)`. On a party of three or more with fewer than half its machines awake, a commit does not qualify, and the next read of each such block costs one cluster consult per read-repair window.

**A strand declares nothing.** A strand runs only on machines whose app registered it, plus storage-profile machines that host it as a replica. The party's machine count overstates that, and overstating makes repair impossible. No authenticated count of the machines serving one strand exists, so every strand runs the base policy.

### The cluster policy

Each network has one shared policy object, `CONTROL_CLUSTER_POLICY` and `STRAND_CLUSTER_POLICY`. Production code, the integration harness and the plugin's tests pass these constants. A hand-copied literal with a different threshold would let a commit pass in tests that fails in a real party. The two objects have the same shape for unrelated reasons and are kept separate.

- `allowDownsize` and `sizeTolerance` let a 16-wide or 4-wide target shrink to the machines that exist.
- Neither policy names `superMajorityThreshold`, which selects Optimystic's default of 0.75 for both the coordinator and the cluster member.
- `cohortQueryTimeoutMs` is how long one peer gets to answer one read-path request. Both policies use the same value because it is a property of the link, and a phone's control node and its strand nodes share one link. [Deadlines over Optimystic's reads and commits](../network/deadlines.md#deadlines-over-optimystics-reads-and-commits) owns the value and its derivation. A host changes it through `NetworkConfig.linkRoundTripMs` or `NetworkConfig.cohortQueryTimeoutMs`.

Every node on one network must use the same cluster size, because a member configured with a larger size can reject a coordinator's smaller declared cluster. Optimystic fixes the size and the policy when the libp2p node is created, so changing a strand's cluster size means restarting every node on that strand.

### Unanimity at three machines

Because every member is in every control cluster, a three-machine party needs `ceil(3 × 0.75) = 3` approvals, which is every member. A member that is connected but slow or silent therefore counts against the bar. A slow member's delay is paid on each cluster request the write makes. A silent member fails the write once Optimystic's cluster request deadlines run out ([Deadlines over Optimystic's reads and commits](../network/deadlines.md#deadlines-over-optimystics-reads-and-commits)).

The failed write rolls back, is not queued, and the next write commits normally. The cost is latency and availability, not consistency.

No approval threshold relaxes this. For three machines to commit on two approvals, the threshold T must satisfy `ceil(3 × T) ≤ 2`, so `T ≤ 2/3`. Optimystic's partition-safety condition requires that the two sides of a network split cannot both recruit an admission quorum from one cluster: `2 × membershipAdmissionFraction × T > 1`, which at the admission fraction of 0.75 means `T > 2/3`. The two ranges do not overlap.

A higher admission fraction would make such a threshold possible, but Optimystic does not expose that option to embedders. A lower threshold would also not help at four machines (`ceil(4 × 0.7) = 3`) or at two.

So Cadre accepts unanimity at three machines, and uses a [bounded retry](#control-write-retry) for the transient part of its cost: a cluster that failed to answer, as opposed to one that refused.

## Catching up a new machine

Optimystic has no catch-up for a peer that joins a cluster after blocks were committed. A block committed while its writer was alone has one holder. The collection-header blocks are the clearest case: the founder writes them once, at genesis, and their revision never moves, so no later commit carries them to anyone, and re-issuing a row leaves them untouched. Without a catch-up, a member that read those tables over the network and then restarted offline would read them as empty.

`peer-join-backfill.ts` in cadre-core fills the gap for the control network and for strand networks. When a connected peer's libp2p identify result names the network's block-transfer protocol, the node pushes every block in its own raw store that the peer is not known to hold. Relays and bootstrap nodes do not name the protocol and are never pushed to. The receiver saves through Optimystic's `saveReplicatedBlock`, which never replaces a newer revision, so pushes crossing from both ends are safe.

The node pushes each block once per peer, and reports each accepted block to Optimystic (`reportBlockHeld`), so Optimystic's own record of under-replicated blocks stops owing it. A node that runs the catch-up builds its Optimystic node with the rebalance reaction off, because that reaction would push the same blocks one request at a time. The module's header comment holds the scheduling and retry rules.

On the control network the push is gated on the node's set of authorized members, checked when the push is made. The [connection gate](control-security.md#the-connection-gate) admits non-members in several states (a node taking its seed, an open invitation window, bootstrap and relay peers), and pushing the control store to one of them would hand a stranger the party's membership, addresses and strand list. A denied peer is retried at its next identify and on every committed membership change, because the normal join order is connect, then authorize. The one non-member pushed to is a device whose cadre invitation this member has just verified ([Cadre invitations](membership.md#cadre-invitations)).

Strand networks apply no gate. Any peer that speaks a strand's block-transfer protocol already receives the cluster's new commits, so older blocks expose nothing more.

`CadreNodeConfig.controlBackfill` and `CadreNodeConfig.strandBackfill` tune the catch-up or switch it off. A joining machine's first-sync gate waits for this push instead of fetching the same blocks one read at a time ([Joining: no writes before the first sync](../strands/formation.md#joining-no-writes-before-the-first-sync)).

## Local write serialization

A node's control database is one Quereus `Database` handle, and Quereus tracks transaction state per handle. A write statement's implicit transaction stays open across the awaits inside `exec`. Two components of one node writing at once would therefore either join one another's transaction, and commit or roll back together, or trip the commit-boundary assertion that guards the `CadrePeer` writers.

`ControlDatabase` prevents this with a process-local write queue: every public write method runs its statements through `withWriteLock`. The lock is not re-entrant, so code that already holds it uses the database handle directly. Every `CadrePeer` write statement lives on `ControlDatabase` itself, and a lint rule fails the build on a literal `CadrePeer` insert, update or delete anywhere else, so a new writer cannot skip the membership refresh those methods trigger.

Reads take no lock. They open no transaction of their own, and locking them would deadlock the membership listener, which reads while a write is notifying it. The queue orders writes inside one node only; agreement between nodes is the cluster's job.

## Read retry

Every control read goes through `ControlDatabase.readRows`, which adds two behaviours.

**Reads answer during a stalled write.** A read normally queues behind whatever statement holds the database, and a write waiting on an unresponsive member can hold it for a long time. While a write is in flight, `ControlDatabase` asks Quereus for a committed read (`readConcurrency: 'committed'`), which answers from the last committed local state without waiting. It asks only then, because a committed read does not refresh from the network, and asking every time would stop a node from seeing other machines' writes.

**A read the cluster could not answer is retried.** `control-read-retry.ts` presents a failed read up to three times, with jittered backoff of 100 ms and then 400 ms, inside a 1.5 s elapsed budget. The budget is sized to fit inside the connection gate's 2 s decision timeout (`ADMISSION_DECISION_TIMEOUT_MS`). That gate reads the control database and admits the peer when the decision times out, so a read that outlived it would spend its retries after the gate had already answered.

Two failures are retried, both meaning that the cluster could not be asked: the transactor's read-phase "some peers did not complete" error, and a `BlockUnavailableError` whose reason is `peers-unreachable` or `cohort-unreachable`. Nothing else is; a `claimed-elsewhere` failure, for one, returns the same error on every retry. An attempt slow enough to have waited out a silent peer exceeds the budget and is not retried.

A read issued from inside a locked write body passes `retry: false`. Its backoff would sleep while holding the write lock, and the write retry runs the body's reads again anyway.

## Control-write retry

Every local control write passes through `ControlDatabase.lockedWithRetry`, backed by `control-write-retry.ts`. The retry exists because of [unanimity at three machines](#unanimity-at-three-machines): one member that fails to answer fails the write, and the usual cause is a stream still forming just after a connection opens. That file's comments hold the classifier's per-case reasoning; this section states the policy.

### What is retried

A write gets three attempts, with jittered backoff of 250 ms and then 1 s, inside a 10 s budget measured from the start of the first attempt and checked after a failed attempt before sleeping. The budget is below what a silent member costs one attempt, so that failure surfaces after the first attempt and the retry adds no delay to the case it cannot help.

A failed control write rolls back whole, and the loop runs the write body again including its reads. A retried write is therefore a new transaction over the rows as they now stand.

The default policy retries:

- the transactor's "some peers did not complete" error from the read and promise phases, and a super-majority shortfall that counts no rejection: the cluster did not answer and nothing committed;
- a block read the cluster could not answer (`BlockUnavailableError` with `peers-unreachable` or `cohort-unreachable`), through the predicate the read retry also uses;
- a torn write that Optimystic marks final, meaning it was not saved and cannot land.

**Lost updates, for writers that decide inside the lock.** A machine's `CadrePeer` row has two writers that can fire together while a cadre starts: the owner re-issuing the row, and the machine publishing its own signed address record. The second to commit is refused as a lost update (`ConcurrentModificationError`), with nothing stored. `LOST_UPDATE_RETRY_POLICY` runs it again. A writer may opt in only if its read of the row, its decision and its signature all happen inside the locked body, so that the second run decides over the row the other writer left. The `CadrePeer` self-publish, owner re-issue and removal methods opt in.

### What is never retried, and why

- **A rejection.** No matcher claims a constraint or authorization failure, or a shortfall that counts a rejection. Presenting it again would present a spent signature to a cluster that already refused it.
- **An indeterminate commit.** The "some peers did not complete" error is also raised from the commit phase, where the write may have committed with only the reply lost. Running the body again would turn a success into a constraint failure. The classifier tells the phases apart by the error's text, so a rewording upstream disables the retry and never makes it unsafe.
- **A write that may be partly stored.** A spent sync retry budget (which is also how contention on a block ends), a torn write not marked final and a partial commit are declined by type.
- **A lost update, by default.** A body that signs over a row it read outside the lock would present a record the other writer has already superseded.

### When the retry gives up

When the classifier declines a failure, or the attempts or budget run out, the loop notifies an observer once, and the node emits the `control:write-abandoned` event with the operation label, the attempts made, the elapsed time and the error. `cadre start` prints each one as a warning. The event matters because background control writes have no caller: the node's republish of its own address record and its re-replication drains run unawaited, and their failures are otherwise visible only in debug logs.

The node escalates one case to `console.warn`: its own address record has gone unpublished for longer than `DEFAULT_PEER_RECORD_MAX_AGE_MS` (15 minutes). By then every other machine is discarding the record, and the node cannot be reached by any machine not already connected to it. The warning is printed once and re-armed by the next successful publish.

### Schema initialization uses a wider policy

`ControlDatabase.applyControlSchema` opts into `SCHEMA_INIT_RETRY_POLICY`: the default classifier plus one more failure, over five attempts inside the same 10 s budget. The extra failure is Optimystic refusing to let a node elect itself coordinator while its last connection dropped less than 30 s ago (`Self-coordination blocked: grace-period-not-elapsed`). Without the retry, a newly provisioned node whose connection drops during schema setup fails to start. The refusal clears as soon as the node holds one connection again.

Presenting that refusal again is safe here and not for writes in general. `apply schema` is a diff, and a failed run is undone whole, so the second run diffs against a catalog that matches storage. For an ordinary write the same refusal can come from the commit phase after a block has landed. The full argument is at the `applyControlSchema` call site in `control-database.ts`.

## Limits and accepted tradeoffs

- **A party of more than 16 machines replicates its control database partially.** Above `CONTROL_REPLICATION_BREADTH`, a machine outside a block's cluster learns of a change only when it next reads the block. Such a party needs the constant raised in the source.
- **A three-machine party needs every machine's approval for a control write.** One connected but silent member fails control writes until it recovers or disconnects. The threshold cannot be lowered without an Optimystic change that exposes the admission fraction.
- **A two-machine party, and every strand, can accept one peer's stale answer during read repair.** A two-machine party has no third machine to corroborate. A strand has no authenticated count of the machines that serve it, so it declares no repair size (ticket `feat-strand-yardstick-from-serving-machines`) and is exposed whenever a node sees a single peer.
- **On a strand, four machines are not four parties.** Optimystic selects a cluster by hash proximity without regard to which party owns a peer, and a strand's mesh is seeded from one party's own machines unless a formation added the other party's addresses. Four copies can be four machines of one party (tickets `feat-strand-party-diverse-placement`, `feat-strand-member-allowlist-admission`).
- **Replication on a strand with more machines than its cluster size is not verified.** A machine outside a block's cluster reads it over the network, and nothing checks that the intended number of copies exists (ticket `debt-replication-proof-above-cohort-size`).
- **A declared repair size of 3 can block repair in one case.** In a party of three where two members were offline for a write, the returning members see one peer with the new revision, which is below a floor of two. The writer's re-issue of rows written while alone is what recovers that case, not read repair.
- **The repair size lags membership by one launch,** so a party that grew keeps the old declaration on each node until the node restarts. Its cost in extra read consults on a mostly-asleep party ([Two declared sizes](#two-declared-sizes)) has not been measured under load.
- **A control table added by a later schema version has no genesis collection.** The start-time schema apply runs on every machine, possibly alone, where committing an empty collection could fork. Reads of such a table ask the cluster until some machine writes it, and fail while the others are offline (ticket `feat-strand-tables-added-by-a-later-schema-get-their-collection`).
- **Two reads still wait behind a write.** Quereus refuses a committed read while an explicit transaction is open, so a read that overlaps such a body's commit waits for it. And a writer that bypasses `withWriteLock` is not counted as a write in flight.
- **Some writes that cannot commit are presented three times.** The 10 s budget only stops retries of slow attempts, so a shortfall that fails quickly is retried. And a rejection wrapped in the promise-phase error is retried, because the classifier matches the wrapper. Nothing has committed at that phase, and one such rejection, a stale revision, is fixed by the second run's reads; excluding wrapped rejections would lose that case.
- **The shared key network shares its coordinator cache.** A wrong cache entry misroutes both the consensus path and the SQL transactor. That is accepted because the two must agree on a key's coordinator.
