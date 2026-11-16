# How a party's machines converge

Once a seed or an invitation has given a node a peer to dial, the party's control nodes must come to hold the same control data. This document describes the mechanisms in `CadreNode` that achieve that: nodes dial each other without being told to; a node whose first connection failed keeps retrying from a record that survives a restart; writes and deletes committed while a node could reach no other member are sent again when it can; and a node learns of table changes through one subscription mechanism, which also governs its in-memory copy of the membership rows. It is for maintainers of cadre-core.

Related: [control database replication](control-replication.md) · [adding and removing machines](membership.md) · [who a node trusts and admits](control-security.md) · [the cadre node](node.md) · [deadlines and the link budget](../network/deadlines.md)

In this document a **sibling** is another member machine of the same party.

## Cohort auto-connect

Control blocks replicate only between connected nodes, and nothing in Optimystic makes the control cohort, the party's own nodes, connect to each other. Each node therefore runs `CadreNode.reconcileControlCohort`, a pass that dials the node's siblings from their replicated `CadrePeer` rows and re-dials connections that dropped. Only one pass runs at a time.

In order, a pass:

1. refreshes the node's in-memory set of authorized members;
2. publishes the node's own address record if it has not published one yet;
3. refreshes relay delegate grants and each running strand's peer addresses ([How a strand's nodes find each other](../network/strand-addressing.md));
4. while a sibling is reachable, deletes rows that tombstones have retired ([The reap sweep](#the-reap-sweep)) and, on an owner node, publishes the joined strands this machine has recorded and not yet published;
5. lists the siblings, and with none takes the [cold-start](#cold-start-retry) branch;
6. selects which siblings to dial, copies every sibling's verified addresses into the libp2p address book, and dials the selected siblings that are not connected.

### What starts a pass

A pass runs when something it acts on changes, and otherwise at a backstop:

- once after start;
- when the node's own addresses change (libp2p's `self:peer:update`);
- when any of the seven membership tables changes, by local commit or by replication (the membership gate watch under [Consumers](#consumers));
- when an authorized sibling becomes reachable ([Why identify, not a connection](#why-identify-not-a-connection)) or one of its connections closes;
- on the wakes a pass arms for itself ([Retries a pass arms](#retries-a-pass-arms));
- at the backstop, `network.controlCohort.reconcileMs` after the last pass settled (default `DEFAULT_CONTROL_COHORT_RECONCILE_MS`, 2 minutes).

A connection to a relay, a bootstrap node or another party's machine starts no pass. A scheduled run waits for a pass in flight and then starts its own, because that pass may have read its rows before the change that woke the run.

The backstop bounds how long a node can miss a change that reaches it with no storage event. That happens to a machine outside the block's cluster in a party larger than `CONTROL_REPLICATION_BREADTH`, and to a cluster member the writer could not reach when it committed. The backstop pass reads after the [membership rows view](#membership-rows-view) has expired, so its reads go to storage and start the cluster consult that brings the change in.

### Retries a pass arms

At the end of every pass, `nextReconcileWakeMs` in `control-cohort.ts` picks the earlier of two wakes.

- **Redial.** When a dial to a selected sibling or a cold-start bootstrap peer failed, the next pass runs after `CONTROL_COHORT_REDIAL_MS` (15 s), doubled for each consecutive such pass and capped at the backstop: 15 s, 30 s, 60 s, then every backstop. A sibling with no dialable address earns no redial, because a retry would dial nothing; its record arriving, or its own connection, starts a pass.
- **Strand address.** The earliest time a sibling is due to be asked again for its strand addresses, when that falls before the backstop ([Strand-address resolution](../network/strand-addressing.md#strand-address-resolution)).

An offline sibling therefore costs one dial per backstop once the redial delay reaches the cap. One retry runs outside the pass: an owner that has just claimed a node redials it every second for the first 15 s, while the node restarts into the party.

### Which siblings are dialed

The pass lists its siblings with `listMembers` and selects among them with `selectControlCohortDials`:

- every member whose `CadrePeer.Profile` is `storage`. These always-on machines are the **backbone**: they stay reachable while phones sleep or change networks.
- the rest (phones, and machines that have not published a profile) in peer-id order, up to `network.controlCohort.targetDegree` (default 6).

Replication needs a connected graph, not a full mesh. For a small party the selection is a full mesh; for a large one it bounds each node's dials. A profile is self-declared and is only a dial preference, so a machine that misdeclares one costs extra dials and gains no access.

For each selected sibling that is not connected, the pass takes addresses from three sources in order: the sibling's signed address record in `CadrePeer` (`resolvePeerAddrs`), the libp2p address book, and the node-local bootstrap-peer store ([Cold-start retry](#cold-start-retry)).

### Dial limits, and why addresses are dialed one at a time

Each dial is bounded per address and per sibling by `dialPeerAddrs` in `peer-dial.ts`. The limits are `network.controlCohort.perAddressDialTimeoutMs` and `dialTimeoutMs`, and both defaults derive from the declared link round trip ([Dial budgets are counted in round trips, not milliseconds](../network/deadlines.md#dial-budgets-are-counted-in-round-trips-not-milliseconds)). The per-address limit covers a relayed dial on a mobile link. The per-sibling limit is four per-address limits, so three dead addresses ahead of a working one still leave it a full attempt; a sibling with more dead addresses than that ahead of its working one is not reached. A pass costs at most the number of dialed siblings times the per-sibling limit.

A sibling's addresses are not handed to one `libp2p.dial()`. libp2p tries the addresses of a multi-address dial one after another under a single deadline. One or two addresses that silently drop the connection attempt (a firewall, a subnet the dialer cannot route to, a virtual adapter) use most of the deadline before the working address is tried, on every pass. A phone claiming a home machine is the common case: the machine lists its public addresses first, and a home router that does not loop back to its own public address drops those dials. So each address is its own dial under the per-address limit, direct addresses before relayed ones, stopping at the first connection.

Each address is also dialed outside libp2p's dial queue (`dialAddr`). The queue joins any new dial of a peer to a queued dial of the same peer, whatever address the new dial names, so while FRET or Optimystic is dialing that peer an attempt through the queue would never try its own address. Every address is bound to the expected peer id, so the handshake verifies which peer answered.

The helper drops every address that relays through the dialing node itself, which a phone holding a relay reservation on that node publishes. When no other address is left it throws `SelfRelayOnlyError` without dialing, because only the phone can reconnect.

The same helper bounds the seed dials in `SeedBootstrapService.applySeed`, the dial of a claimed node, and the redial of a strand's member machines.

### Verified addresses go into the libp2p address book

Each pass copies every sibling's verified addresses into the control node's libp2p address book (`peer-addr-book.ts`). Everything below cadre-core, including Optimystic's cluster and repo clients and FRET, dials by bare peer id and has no addresses of its own. Without the copy, those layers could not dial a sibling whose connection had dropped until a pass re-dialed it, and replication would stall on NAT'd and mobile networks.

The copy covers every sibling, including connected ones and those the degree cap left undialed, and writes only addresses that `resolvePeerAddrs` verified. A sibling whose record is revoked, stale or untrusted is not written, and its existing entry ages out.

### What the pass does not do

The pass does not make the first connection of a node that has no rows. The seed, the configured bootstrap nodes or a relay does that, with the cold-start retry when it fails. The pass also does not move a relayed connection onto a direct path; that belongs to the transport ([Relays](../network/relay.md)).

## Cold-start retry

`SeedBootstrapService.applySeed` dials the seed's preferred peers, which are the machine that created the seed and the party's always-on machines, once. When that dial fails, the joining node has no connection and an empty `CadrePeer` table, so the pass has no siblings to dial. A pass that finds no siblings therefore takes a cold-start branch: it re-dials the preferred peers of every seed the node has applied. A one-machine party has none, and the branch does nothing there.

### The bootstrap-peer store

`CadreNode` keeps those peers in a node-local bootstrap-peer store (`bootstrap-peer-store.ts`, peer id to addresses). Its entries are the dial targets that [adding and removing machines](membership.md) refers to. It does not read them from the libp2p address book, so the retry set is exactly what an owner-signed seed named, and the entries are never copied into that address book, which takes only verified addresses. [Node-local state](node.md#node-local-state) says where the store is kept on each platform.

The store also holds the addresses of every node this node added with `CadreNode.addDrone`, and the steady-state pass uses a sibling's entry as its last source of addresses. That is how an owner that cannot listen, such as a phone, reaches a node it added. The added node's `CadrePeer` row carries no signed record until the node publishes one, which needs a connection only the phone can open. And a phone relaunched after the record's 15-minute freshness window has nothing else durable to dial.

Each pass replaces an existing entry with the addresses the sibling's signed record resolves to, when they differ. It never creates an entry, so the store does not become a copy of every sibling. A local `removePeer` or `removeMachine` forgets the entry.

Before dialing, every stored address is bound to the peer id it was stored under, so a retry authenticates the peer it aims at. The node excludes itself, because a seed lists every member.

### Retry policy

Retries are unbounded, on the redial delays every pass arms. The branch runs only while the node has no siblings, so it stops as soon as the node is in the party, and a stranded node must keep trying.

`ApplySeedResult` reports `preferredDialsAttempted` and `preferredDialsFailed`, so a caller can tell "seeded and connected" from "seeded and stranded". Its `success` field means only that the seed was accepted.

### Overlap with FRET's probes

The branch is not the only thing that reconnects a stranded joiner. While the libp2p address book still holds the seed's addresses, FRET's stabilization probes dial the peer by id and usually reconnect it within seconds. The branch is needed for what the probes cannot cover: address-book entries that have aged out, and a process restart, since the libp2p address book is held in memory. A regression that disables the branch can therefore go unnoticed in ordinary use.

## Writes made while alone

This section covers inserts and updates. Deletes are under [Deletes made while alone](#deletes-made-while-alone).

Optimystic commits a write without broadcasting it when the block's cluster is the writing node alone. Such a control write exists only in the writer's store. A sibling that connects later does not learn of it by reading, because a read asks the block's cluster, and the cluster never received the write.

`CadreNode` counts itself **alone** while no sibling is reachable (`CadreNode.hasReachableControlSibling`). A sibling is reachable when it is connected, its libp2p identify result lists the control network's `repo` or `cluster` protocol, and it passes the control node's cluster-member check: it is an authorized member, or a device whose admission this node is writing. A sibling that identified before this node authorized it becomes reachable on the membership refresh that authorizes it. cadre-cli's admin channel reports the same predicate as `alone`. `CadreNode.getControlConnectionCount` remains the raw connection count.

The node queues a write that commits while it is alone and re-issues it when a sibling becomes reachable. One drain runs at a time, and a drain runs each time the node goes from alone to not alone.

### Why identify, not a connection

Optimystic builds a block's cluster from the peers whose protocol lists show that they serve the network, and a peer's protocol list is filled in only when its identify completes, shortly after the connection opens. A write made in that gap, or with only a relay or a bootstrap node connected, commits on a cluster of one.

If the sibling advanced the same block to the same revision in the meantime, the two copies are a fork that no later read and no block catch-up detects, because both compare revision numbers only. The fork lasts until this node's next write to that block conflicts. So such a write is queued like one made with no connection. Every reaction to a sibling connecting waits for the sibling's identify: this drain, the reconcile pass and its first publish of the node's own record, the reap sweep, and the membership view drops.

The predicate is a proxy for the block's own cluster. In a party larger than `CONTROL_REPLICATION_BREADTH`, a reachable sibling can be outside that cluster, and the write is then left to read repair.

### How a queued write is re-issued

- **The node's own rows.** The node republishes its `CadrePeer` record and its `DeviceToken` through the idempotent `registerSelf` and device-token refresh. The first drain after start does this whether or not the process queued them, which covers a write a previous process made alone. That first drain skips a `CadrePeer` row that already holds a current record this process signed.
- **Membership rows an owner wrote for other machines.** The owner re-issues the row as an owner-signed bump of `UpdatedAt` (`ControlDatabase.reauthorizeCadrePeer`). On the first drain after start, an owner also re-issues every other machine's row that the machine has not yet signed, since any of them may be a row a previous process wrote alone. A row the machine has signed is that machine's to republish.

Applying a re-issue more often than needed is safe: `UpdatedAt` only increases, and the schema rejects a replayed older record.

### Background writes wait for a sibling; awaited writes commit alone

A re-issue repairs a write that only one side made. When two members are alone at the same time and each writes the same collection, each takes it to the same next revision with different content. Two machines restarted together, each publishing its address record before it reaches the other, is the ordinary case. No re-issue heals that fork. Each member judges the other's re-issue against its own copy and refuses it, and refuses every later write to that collection the same way.

So a write that no caller waits on does not commit while no sibling is reachable and the party has other authorized members (`CadreNode.controlWriteCouldFork`). It is left to the drain, or to a reconcile pass made while a sibling is reachable. These writes are:

- the node's publish of its own address record at start, on its heartbeat and on an address change;
- the pending-join runner's background attempts and its bookkeeping writes ([Joining while the inviter is offline](../strands/formation.md#joining-while-the-inviter-is-offline));
- the publish that `cadre start --owner` makes.

A write that a caller awaits commits alone and is queued for re-issue: `registerSelf`, `registerDeviceToken`, a membership write, `requestJoin`. So is the recorded outcome of a join attempt already made, which exists only in memory until it is written. A party with no other members cannot fork, so a founder on its own writes at once.

### Owner-key changes are refused while alone

An `OwnerKey` insert has no re-issue path, because the table permits no update and so leaves no row to re-issue. `CadreNode.addOwner` therefore refuses before any write, with `OwnerKeyAddRefusedError` and code `alone`, when no sibling is reachable and the party has other authorized members. The owner retries once a sibling is reachable.

`CadreNode.removeOwner` refuses, with `OwnerKeyRemovalRefusedError` and code `alone`, a call that re-vouches any row. Re-vouching an owner key re-adds its row, and re-vouching a machine can fork `CadrePeer` ([Removing an owner key](owner-keys.md#removing-an-owner-key)).

## Deletes made while alone

A delete that commits while the node is alone removes the row locally, so it cannot be re-issued the way an insert or update can: a second `delete … where PeerId = X` matches nothing. The tombstone that every guarded delete files in the same transaction carries the removal to the other machines instead. [Stamps and tombstones](control-schema.md#stamps-and-tombstones) explains stamps, tombstones and which tables are guarded. This section covers how a tombstone written alone reaches the party, and when a machine deletes the stale row.

### The tombstone

Every guarded delete runs one signed statement pair, `ControlDatabase.execGuardedRemoval`, so no removal can omit its tombstone.

A machine that receives the tombstone without the delete still holds the removed row, and reads it as absent from then on. The filter is in `ControlDatabase.queryCadrePeers` and `queryPeerRecord`, so the member list, the connection and stream gates, address resolution and the seed bundle all inherit it. Delivering the tombstone is therefore enough for a removal to take effect.

### Re-issuing the tombstone

A tombstone can be re-issued. An owner-signed increase of its `ReissuedAt` column changes no meaning, since retirement is decided by the row's existence, but it rewrites the row and so broadcasts it. `CadreNode` queues a tombstone whose delete committed while the node was alone, and re-issues the queue when a sibling becomes reachable (`drainPendingRevocations`). On the first drain after a process start it re-issues every tombstone it holds, which covers deletes a previous process committed alone.

A node without an owner key drops its queued entries. Nothing is lost, because every guarded delete is owner-signed, so a re-issue is always an owner's to make.

### The tombstone authorizes a local reap

A machine that holds both a removed row and the tombstone for it may delete the row without an owner signature (`ControlDatabase.reapRevokedRow`). [Reaping](control-schema.md#reaping) states the rule and the tables it applies to.

### The reap sweep

The reconcile pass calls `ControlDatabase.reapRevokedRows`, which walks the tombstones the node holds and reaps the row each one retires.

- **It runs before the pass lists siblings.** A cadre whose only sibling row is the tombstoned one lists no siblings and returns early, so a later reap would never run in the smallest case.
- **It runs only while a sibling is reachable.** A reap is a write, and a write committed alone is local only and can fork the collection. Nothing is urgent, because the stale row already reads as absent.

### What is not reaped

The sweep skips the node's own `CadrePeer` and `DeviceToken` rows, and every table outside `REAPABLE_TABLES`. [Reaping](control-schema.md#reaping) and [How rows leave each table](control-schema.md#how-rows-leave-each-table) give the reason for each.

The retired-stamp read filters therefore remain necessary: between a tombstone's arrival and the node's next reconcile pass with a sibling reachable, and permanently for the rows that are never reaped.

## Table change subscriptions

`table-change-watch.ts` is the one way cadre-core learns that a control or strand table changed, so that a loop waits for a change instead of re-reading on a timer. `ControlDatabase.watchTables` and `StrandDatabase.watchTables` subscribe a consumer's `onChange` to a list of qualified table names, such as `'CadreControl.Strand'` or `'Strand.Member'`. Each database's `close()` disposes its subscriptions before anything it awaits.

### What it hears and does not hear

The mechanism is built on Quereus's `Database.watch`. That fires after every commit made on the `Database`, and whenever the Optimystic plugin reports that this node's storage moved a table's collection forward: a consensus commit made on another machine in which this node took part as a cluster member, a block catch-up push, or a read repair landing. Events name a table and carry no row keys. A consensus commit that spans several collections raises its events once all of them have landed on this node, or after Optimystic's 10 s hold, so a consumer woken by a replicated row reads that table's indexes current.

It does not hear:

- a change that never reaches this node's storage. That is the case for a machine outside the block's cluster (a cadre larger than `CONTROL_REPLICATION_BREADTH`, a strand with more machines than its cluster size) until it next reads the block.
- a replicated change to a table this `Database` has not yet read. The plugin starts reporting storage changes for a table on the table's first full initialization. A consumer's first run reads its tables, and that is what turns the reporting on.

### Scheduling

The watch handler runs inside the committing call, possibly with the control write lock held, so it only sets flags and arms a timer. Consumer work never runs inside a commit.

- Changes within the coalescing window (`TABLE_CHANGE_COALESCE_MS`, 50 ms) share one run. The window also merges the two events that one local commit raises.
- At most one run is in flight, and any number of changes during a run produce exactly one further run.
- A consumer's own `trigger(delayMs)` and its backstop go through the same rule.
- An optional synchronous `onInvalidate` hook hears each changed table inline, for clearing a cache.

`scheduleRuns` gives the same schedule with no table subscription. Because of what a subscription does not hear, each consumer sets a `backstopMs`: the consumer runs that long after its last run settled, whether or not a change arrived.

`ControlDatabase.setMembershipChangeListener` is a separate, awaited hook inside the write. It makes the set of authorized members current before a local `authorizePeer` or `removePeer` returns, where a coalesced subscriber would refresh the set up to one window later.

### Consumers

| Consumer | Tables | Backstop | What a run does |
|---|---|---|---|
| Membership rows view | the seven membership tables | none; a maximum age instead | Drops cached rows, through `onInvalidate` only. |
| Membership gate watch | the seven membership tables | none | Rebuilds the set of authorized members, closes this node's connections to removed peers, then triggers the reconcile schedule. |
| Reconcile schedule | none; triggered by the gate watch, connection events and its own wakes | `network.controlCohort.reconcileMs`, 2 minutes by default | Runs `reconcileControlCohort`. |
| `StrandWatcher` | `Strand`, `JoinedStrand` | 5 minutes | Starts and stops strands ([Reactive strand management](../strands/lifecycle.md#reactive-strand-management)). |
| Pending-join runner | `JoinRequest`, `JoinSuccess`, `JoinFailure`, `OwnerKey`, `Revocation` | 10 minutes | Picks up joins that other machines changed; attempts run on their own timers. |
| First-sync gate | the strand node's storage-wide change feed, not a table watch | 2 s | Probes whether a joining machine has its first copy of the strand. |
| Revoked-peer enforcer | `Strand.Member`, `Strand.MemberPeer` | 5 minutes | Disconnects machines removed from a closed strand ([Removing members](../strands/membership.md#removing-members)). |
| Party-machine watch | `StrandPeer`, `CadrePeer`, `Revocation` | none | Re-runs each closed strand's binding of the party's machines ([Binding the party's machines](../strands/membership.md#binding-the-partys-machines)). |
| Party key watch | `StrandPartyKey`, `PendingStrandPartyKey` | the reconcile backstop | Switches a running closed strand to the party's current key and continues a pending key rotation. |

The gate watch is separate from the reconcile pass so that a replicated removal takes effect without waiting behind a pass that is spending its dial time on an unreachable sibling. [The connection gate](control-security.md#the-connection-gate) describes the set it rebuilds.

## Membership rows view

`ControlDatabase` keeps the rows of seven control tables in memory (`membership-view.ts`, read through `ControlDatabase.readMembershipRows`), because every flow reads them several times. On a party of several machines, a read of a block this node does not hold is a request to the other machines, and a read of a held block after Optimystic's 10 s read-repair window starts a background consult with them. Only these tables are cached, because each is bounded by the party's machines, its owner keys and the invitations and grants issued to admit them.

- `Revocation`, `CadrePeer` and `OwnerKey`: every membership, owner-key and peer-record read starts from them.
- `CadreInvite`, `CadreInviteUsage`, `OwnerGrant` and `OwnerGrantUsage`: every membership refresh verifies invitation-admitted machines and grant-seated owner keys through them. All four are append-only, so a stale copy can only lack rows. A missing row refuses an admission until the copy reloads; it never authorizes what a fresh read would refuse.

### What is kept, and when it is dropped

The view holds one unfiltered full scan per table, and concurrent readers share one load. One table change subscription on the seven tables drops a table's rows from its `onInvalidate` hook. Quereus fires that hook inside the committing call, so a write that has returned is always visible to the next read. A load that was in flight when the hook fired answers its own callers and keeps nothing.

Three reads do not go through kept rows:

- A caller that holds the write lock with an explicit transaction open reads SQL directly. Its read must see the transaction's uncommitted rows, and a rollback raises no change event.
- A load answered by a committed read, because a write was in flight, is returned to its callers and not kept. A committed read can initialize a table without turning on storage-change reporting for it, so no event would ever drop those rows.
- A failed load keeps nothing, so the next call asks again.

The schema's `check` constraints, the point reads of a stamp (which must see retired rows) and the redemption path's reads of the invitation or grant being redeemed also stay plain SQL.

### Maximum age

Kept rows are served for at most `MEMBERSHIP_VIEW_MAX_AGE_MS` (15 s), and the next read after that reloads them. The reload is the only path for a change that reaches this node with no storage event.

The age is longer than Optimystic's 10 s read-repair window, so the reload's storage read starts the cluster consult that brings such a change in. It is shorter than the reconcile backstop, so the backstop pass, which is the only reader on an idle party, always reloads. On an idle party the bound on such a change is therefore the backstop.

### After a sibling connects

A machine that was offline when a sibling committed is covered sooner than the maximum age. `CadreNode` drops every view when an authorized sibling becomes reachable, and drops them again `MEMBERSHIP_VIEW_RECONNECT_RELOAD_MS` (11 s) later. Each drop starts a reconcile pass whose reads reload the views.

The second drop is the one that brings the sibling's commits in. The node's reads before the sibling arrived started the read-repair window on the control blocks, so the reload at the identify is answered from the local copy without asking the sibling. The reload after the window starts the consults, and a consult that lands a newer revision raises a table change.

## Limits and accepted tradeoffs

- **A fork between two members who each wrote the same collection while alone does not heal.** Awaited writes still commit alone, so two owners who each make a membership write while unable to reach each other can fork `CadrePeer`. A delete made alone can fork it too: the tombstone and the reap make nodes agree on content, not on storage revisions. Each side then refuses the other's writes to that collection. Healing needs upstream work (ticket `forked-control-collection-sync-livelocks`).
- **A re-issue is not confirmed as broadcast.** The node clears a queue entry when the re-issue commits. If the sibling that became reachable is outside the block's cluster, the write stays local until a later process's first drain (ticket `control-rereplication-broadcast-confirmation`).
- **An owner-key add can still commit alone.** The refusal is checked before the owner approves, and the last connection can drop during the approval. The node logs the case and does not re-issue the row.
- **The reap sweep and the first-drain re-issue each scan every tombstone the party has ever written,** because tombstones are never removed. That is acceptable for a party-sized table; a large one would need a node-local record of how far each scan has got. The rows and tables that are never reaped are listed in [the control schema's limits](control-schema.md#limits-and-accepted-tradeoffs).
- **The reap sweep is covered by unit tests only.** No integration scenario runs it across a real network.
- **A change that raises no storage event is seen at the reconcile backstop,** 2 minutes by default. A party that needs a tighter bound lowers `network.controlCohort.reconcileMs`.
- **A deferred consult delays the reload after a reconnect.** Optimystic defers a consult when 16 are already in flight, and the view then keeps its rows until the first read past its maximum age, which on an idle node is the backstop.
- **Machine removal can miss an invitation.** `CadreNode.planMachineRemoval` reads `CadreInvite` and `CadreInviteUsage` through the view, and there a missing row means an invitation the machine could return through is not withdrawn. The exposure is the view's maximum age, for a row that reached the node with no storage event.
- **A removal replicated from another owner does not clear the bootstrap-peer store.** The steady-state pass ignores entries for peers that are no longer siblings, but the cold-start branch would still dial a removed peer's entry.
