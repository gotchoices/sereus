# Writing to a strand: durability and offline mode

A commit on a strand can succeed while only the writing machine holds it. This doc says how an app learns who holds each commit, and how offline mode lets a commit resolve as soon as it is saved on this machine and reach the other members later. It is written for app developers first; the mechanism sections at the end are for embedders and maintainers.

Neighbouring docs: [Strands: model and lifecycle](lifecycle.md) · [Inviting and joining](formation.md) · [App schemas](app-schema.md) · [Strand hibernation and wake](hibernation.md) · [cadre-core API guide](../api.md)

## What an app sets, calls and handles

Every name here is exported from `@serfab/cadre-core` unless the row says otherwise. The option types are in `packages/cadre-core/src/types.ts` and `packages/cadre-core/src/strand-offline.ts`.

Options and calls:

| Name | What it does |
| --- | --- |
| `StrandDatabase.commitDurability(tx)` | Returns the durability record of a recent commit, or `undefined`. |
| `EdgeNodeOptions.strandOfflineMode` | Start option of an edge node: the mode every strand starts in, `'online'` (default) or `'offline'`. |
| `EdgeNode.setStrandOfflineMode(mode)` | Changes the mode of every strand without a restart, and saves it for later starts. Throws a plain `Error` while no node runs and on a platform with no journal. |
| `CadreNodeConfig.strandOffline` | `{ journal, initialMode? }`. Offers offline mode on a `CadreNode`'s strands. |
| `CadreNode.setStrandOfflineMode(strandId, mode)`, `getStrandOfflineMode(strandId)` | Sets or reads one strand's mode. |
| `StrandDatabase.offline` | The strand's queue (`StrandOfflineQueue`): `status`, `entries`, `queueState`, `outcomes`, `acknowledge`, `discard`, `whenDrained`, `onStatus`, `onQueueState`. `undefined` without offline mode. |
| `CadreNode.getUnreachedStrandMachines(strandId)` | Names the party's own machines a queued transaction may be waiting for. |
| `StrandLeaveOptions.discardQueued` | Passed to `forgetJoinedStrand` or `unpublishStrand`: withdraw unsent transactions, then leave. |

Events on `CadreNode` (and on the edge node, which forwards them):

| Event | Payload | Emitted |
| --- | --- | --- |
| `strand:commit-durability` | `StrandCommitDurability` | For every commit on the strand database that wrote something, synchronously inside the commit. |
| `strand:commit-held` | `{ strandId, transactionId }` | Once, when a followed commit becomes held by every machine assigned the blocks it wrote. |
| `strand:offline-status` | `{ strandId, status }` | For every status the queue delivers for a queued transaction. |
| `strand:queue-state` | `{ strandId, state }` | On every change of the queue's state or mode, and once each time the strand's database is published. |

Errors:

| Error | Thrown by | Meaning |
| --- | --- | --- |
| `StrandOfflineUnavailableError` | `CadreNode.setStrandOfflineMode` only | The node was configured without `strandOffline`. |
| `StrandQueueNotEmptyError` (`transactionIds`) | `forgetJoinedStrand`, `unpublishStrand` | The queue holds unsent transactions and `discardQueued` was not given. Nothing was left or removed. |
| `StrandOfflineQueueBusyError` (`transactionIds`) | every closed-strand membership writer | The queue holds transactions. Nothing was written; await `offline.whenDrained()` and retry. |
| `EntryNotDiscardableError`, `UnknownEntryError` | `StrandDatabase.offline.discard` | The transaction was sent or is being sent; or the queue does not hold it. |

## A commit's durability

A commit made while no other member is connected succeeds on this machine alone ([Joining: no writes before the first sync](formation.md#joining-no-writes-before-the-first-sync) explains why a writable strand is not necessarily a connected one). Such a commit is lost if the machine then stops for good. cadre-core reports, per commit, whether another machine holds it, so the app can show a change as not yet delivered.

### Reading it

Write with one statement that returns the commit's id, then read the record with that id. `strand` is a `StrandInstance` whose database has been published. The example is adapted from `packages/reference-app-web/src/lib/chat-dml.ts` and `send-marks.ts`:

```ts
const stored = await strand.database.getDatabase().get(
	'insert into App.Message (Id, ParticipantId, Content, Timestamp) values (?, ?, ?, ?) returning StampId() as Tx',
	[id, participantId, content, timestamp],
);
const tx = stored?.Tx as string;
const durability = strand.database.commitDurability(tx);
if (durability && !durability.heldElsewhere) {
	// Show the message as not yet delivered; clear the mark on `strand:commit-held`.
}
```

The single statement matters. One statement holds Quereus's execution lock for its whole run, so no other writer's commit is mixed in. cadre-core's membership writer and reconciler write to the same database, so "the reports that arrived while my `exec` ran" can include a commit that is not the app's.

The record is `StrandCommitDurability` (`packages/cadre-core/src/strand-commit-durability.ts`). cadre-core builds it from the commit report of Optimystic's Quereus plugin, which `@serfab/quereus-plugin-sereus` passes through as `onCommitDurability` and `onCommitFullyHeld`.

### The fields

- **`heldElsewhere` answers "does this survive my machine stopping".** Optimystic assigns each block to a cluster of the strand's machines ([Replication cluster size](../cadre/control-replication.md#replication-cluster-size)); its own reports call that group a cohort. The field is true when the commit's overall answer is `majority` or `full` and no block it wrote was abandoned (`torn`). A strict majority of a cluster of at least two is at least two machines, and an abandoned block is held by nobody. Read this field instead of comparing Optimystic's quorum classes.
- **`followed` says whether anything will report the commit reaching the others.** When it is true and `heldElsewhere` is false, `CadreNode` emits `strand:commit-held` once every machine in those clusters holds the commit, and `commitDurability(tx)` returns `heldElsewhere: true` from then on.
- **`followed: false` with `heldElsewhere: false` means nothing will say so this session.** The app can only keep showing the commit as pending. The causes: its holders are unknown, a block it wrote was abandoned, or no record on this machine tracks its missing copies (a fault in that record, a write whose destination never resolved, a commit coordinated by another machine).
- **`awaitedMachines` names the party's own machines known to hold the strand that do not hold this commit yet** ([Waiting for the party's own machines](#waiting-for-the-partys-own-machines)). It distinguishes a commit waiting for a machine this node has not reached from one made by a cadre of one. It is empty once `heldElsewhere` is true, and absent on a node that offers no offline mode, because such a node does not track those machines.
- **`report` is the plugin's own report**, for per-table detail. Its `unconfirmed` list names only peers this strand node has met, which is why `awaitedMachines` exists.

A lone founder's commits are all reported not held elsewhere and followed, until a member joins and takes the copies. That is correct: nobody else has them.

### When there is no record

`commitDurability(tx)` returns `undefined` for a commit that wrote nothing (an `insert or ignore` that ignored, an update that matched no rows), one made before this database was built, and one more than 256 commits back. An app treats each of these as "nothing new to mark".

In offline mode it is also `undefined` for a transaction that is still queued, and that case is different: the transaction has not reached anyone yet. An app in offline mode reads `strand.database.offline.status(tx)` first. When the queue later sends the transaction and it commits, the record takes the plugin's durability report, and `strand:commit-durability` and later `strand:commit-held` fire as for an online commit.

### The events

`strand:commit-durability` carries the same record as each commit happens. It runs synchronously inside the commit, so a handler must be short. It covers every commit on the strand database, cadre-core's own membership writes included, so an app filters by the ids it holds. A handler that throws is logged and the commit is unaffected.

`strand:commit-held` is the signal to clear a "not yet delivered" mark. Typical uses:

- A chat marks a message sent while alone as not yet delivered and clears the mark on `strand:commit-held`, as the reference apps do ([Messages not yet delivered](../platforms/reference-apps.md#messages-not-yet-delivered)).
- A two-party app that needs the other party to receive a move keeps the phone awake, or warns before leaving, until `heldElsewhere` is true.

## Offline mode

In offline mode a strand commit resolves as soon as the transaction is saved on this machine. The strand's members get it later, in order, once they can be reached. Outside offline mode a commit resolves once the cluster members it can reach take it, which is this machine alone when no member is connected.

The queue belongs to Optimystic's Quereus plugin (its README, "Offline mode"; design in Optimystic's `docs/offline-sync.md`). Sereus composes it into [the strand connection](#the-strand-connection) and [the cadre node](#on-a-cadre-node), and [the edge node](#on-the-edge-node) supplies the journal on the phone and in the browser.

### What a local acknowledgement promises

- **The transaction survives this machine stopping.** It is in the strand's journal before its commit resolves (its `queued` status says `persisted: true`), and the next database build restores it ([Where queued transactions are saved](#where-queued-transactions-are-saved)).
- **It is sent in order, and this machine does not commit it alone while it knows of members it cannot reach.** Sereus leaves Optimystic's `allowSoloCommit` at `false`, so a queued transaction waits until its cluster takes it. The members this machine knows include those its saved network state restores after a restart, and [the party's own machines that hold the strand](#waiting-for-the-partys-own-machines).
- **A send interrupted by a restart or a hibernation lands once.** The transaction was journaled before it went out, and the restore re-sends it under the same action id or reports it `committed` (the Optimystic plugin README, "Restarting"). Sereus adds nothing to the send path.
- **It does not promise that the members will accept it.** A queued transaction can fail when sent, for instance on a constraint another member's write broke first, and its rows then leave this machine's view. The queue judges each queued transaction's `outlook` as `assured` or `exposed`: whether anything another writer does could make it fail. A key column the app fills with a fresh value is tagged `"optimystic.fresh" = true`, so an insert under it is judged `assured` (the reference chat's `Message.Id`).
- **Once committed, who holds it is the online question.** The commit's durability record arrives when the queue sends it ([A commit's durability](#a-commits-durability)).

### Turning it on

- **An edge app** (the phone kit, the web reference app) sets the start option `EdgeNodeOptions.strandOfflineMode` and changes it at runtime with `EdgeNode.setStrandOfflineMode(mode)`, which applies to every strand ([On the edge node](#on-the-edge-node)). The reference apps' offline switch calls it.
- **Any `CadreNode`** is offered the mode by `CadreNodeConfig.strandOffline`, `{ journal, initialMode }`, and sets it per strand with `CadreNode.setStrandOfflineMode(strandId, mode)` ([On a cadre node](#on-a-cadre-node)).
- **An app that turns the mode on should leave it on.** After it is turned off, each later commit is acknowledged by the network and waits behind the transactions still queued.

Where it is not offered:

- **The always-on programs** (cadre-host, cadre-provider, cadre-cli) configure no `strandOffline`, because a node that is always connected gains nothing from a local acknowledgement.
- **NativeScript** has no journal, so the edge node configures no `strandOffline` there. `EdgeNode.setStrandOfflineMode` throws a plain `Error` naming the missing journal, and `CadreNode.setStrandOfflineMode` throws `StrandOfflineUnavailableError`.
- **The control database** registers Optimystic without `offline`. Its writes are owner-signed membership and authorization facts, and the retry and veto rules of `control-write-retry.ts` assume a network answer.
- **A strand loaded through the SQL plugin config** (`parse-config.ts`). A journal is an object, and that config carries only SQL values and refuses keys it does not know.

### Where queued transactions are saved

A journal is an Optimystic `IKVStore`. Each queued transaction is saved in it before its commit resolves. On the next connect, the queue's `hydrate` step puts the saved transactions back before the `Strand` and `App` schemas are applied, so the first statement any caller runs sees their rows. Without a journal the queue lives in memory and is lost with the process, which is why a cadre node never builds a queue without one.

- **Phone:** a `LevelDBKVStore` over the strand's own rn-leveldb database (`sereus-<strandId>`), beside the blocks its transactions refer to.
- **Browser:** an `IndexedDBKVStore` over the strand's own IndexedDB database (`sereus-strand-<strandId>`, its `kv` object store). The plugin's browser connect (`connectToStrandBrowser`) journals there too when it defaulted the storage there and the caller gave no `journal`.
- **Node embedder:** its own store, for example a `FileKVStore` (`@optimystic/db-p2p-storage-fs`) in the strand's directory. The plugin's Node connect passes on only what it is given.

Both edge stores keep their key-value keys apart from blocks, so the journal's records (under `optimystic-offline/`) cannot collide with them. The records are keyed by a label derived from the strand id (`strandJournalLabel` in `compose-strand.ts`). No two strand ids share a label, so an embedder that passes one store to several strands keeps their records apart. Every store Sereus itself opens is per strand.

### Membership tables are always acknowledged by the network

Every `Strand` table is tagged `"optimystic.offline" = 'network'` in `schemas/strand.qsql`, so offline mode never acknowledges a write to one locally. These rows are authorization facts: a membership change, an invitation redemption or a revocation must never be acknowledged on this machine and refused by the others later. Consequences for an app:

- A transaction that writes any `Strand` table is acknowledged by the network as a whole, its `App` writes included.
- A live read of a `Strand` table is not answered from this machine's own view while the members cannot be reached. It fails as it does outside offline mode.
- A network-acknowledged commit made while transactions are queued waits behind them, holding Quereus's execution lock, for up to the plugin's `networkCommitTimeoutMs` (five minutes, the plugin's default). On a cadre node Sereus's own membership writers stay out of that wait ([Membership writes are refused while transactions are queued](#membership-writes-are-refused-while-transactions-are-queued)).

A tag change is not refused while transactions are queued, so a store whose tables predate the tag gets it on its next connect, as one `alter table … set tags` per table.

#### Membership writes are refused while transactions are queued

Every membership writer (`strand-membership-writer.ts`) refuses with `StrandOfflineQueueBusyError` while the strand's queue lists any transaction, and writes nothing. Its `transactionIds` name the queued transactions, including journaled ones a restore has not put back yet. An app that calls a membership writer awaits `strand.database.offline.whenDrained()` and retries.

The refusal exists because a `Strand` write is network-acknowledged: its commit would wait behind the queue inside `db.exec`, holding the execution lock, and every other statement on the strand database, the app's included, would wait with it.

- **Every writer is refused, inside an app transaction or not.** A writer that joined a transaction the app opened would make that transaction network-acknowledged, and the app's own commit would take the same wait.
- **The background writers retry.** The membership reconciler treats the refusal as it treats an open app transaction and retries until the queue drains. A party key replacement is left `pending` and runs again when the queue empties. The cleanup in `unpublishStrand` that deletes this machine's membership binding logs the refusal and leaves the binding, as it does for any failed write.

### What the app reads

- **One transaction:** write with one statement that returns its id (`… returning StampId() as Tx`), then read `strand.database.offline.status(Tx)`. It returns the transaction's live status while queued, and its retained outcome afterwards.
- **The queue:** `strand.database.offline` is a `StrandOfflineQueue`, the connection's controller without the mode switch. Listeners taken on it end when the database closes, as `watchTables` subscriptions do, and a strand's database is closed and rebuilt on hibernation and wake.
- **Events that survive rebuilds:** `strand:offline-status` carries every status the queue delivers. `strand:queue-state` carries every change of the queue's state or mode, plus one at each publication of the database with the current `queueState()`.
- **Restored transactions are announced only by that publication event.** Their `queued` statuses are delivered during `hydrate`, before cadre-core subscribes. An app reads `offline.entries()` when the publication's `strand:queue-state` arrives.
- **An entry names its transaction and tables, not its rows.** An app that marks its own items by transaction keeps that mapping itself, as the reference apps' queued-message record does.
- **Nothing arrives from a closing connection.** `StrandDatabase.close` unsubscribes the queue's listeners first, as it does the commit listeners.
- **Table watches fire on queued commits and on refusals.** A queued commit is a local commit, and Optimystic announces a refused transaction's removal with `Database.notifyExternalChange` ([Change notifications](app-schema.md#change-notifications)).

The status type is Optimystic's `QueuedTransactionStatus`, re-exported from `@serfab/quereus-plugin-sereus`. Its kinds are `queued`, `outlook-changed`, `submitting`, `partially-committed`, `committed` and `failed`.

### Waiting for the party's own machines

A queued transaction stays `queued` with `waitingFor: 'cohort'` while this machine is alone in a block's cluster and the party has another machine that holds the strand. `CadreNode.getUnreachedStrandMachines(strandId)` names those machines by control peer id (what `listMachines` and `removeMachine` use) and by strand peer id. Nothing releases the wait on its own, because the transaction is safe in the journal.

The reason: a machine that has never connected to another machine of its party does not know it as a member of the strand's network, so Optimystic's own gate would let it commit a queued transaction alone. cadre-core composes that gate with what the control database knows (`strand-party-machines.ts`) and registers the result with the strand connection as `StrandConnectionOptions.cohortReachability`. The queue and the offline live-read path both ask it.

- **Which machines count.** A machine with a `CadreControl.StrandPeer` row for the strand ([Binding the party's machines](membership.md#binding-the-partys-machines)) and a live `CadrePeer` row this node trusts. A machine writes its `StrandPeer` row when it runs the strand, so one whose strand filter or app keeps it off the strand never counts.
- **Alone in the cluster, not merely unconnected to one machine.** With one of the party's machines connected and another blocked, the block's cluster has two members, the commit runs, and nothing waits. The same holds when another party's member is connected. A cluster that names nobody but this machine, or whose lookup fails, waits.
- **The machines are redialed.** The strand node's redial (`strand-peer-redial.ts`) dials these machines at the addresses the strand-address protocol put in its address book ([How a strand's nodes find each other](../network/strand-addressing.md)), so a blocked port that opens is reached even if no connection was ever made to it.
- **A long wait blocks other writes.** Membership writes are refused while the queue holds transactions, and an `App` schema apply may wait for the queue.
- **Removing the machine releases the wait.** `CadreNode.removeMachine` takes its strand peer id out of the machines waited for, and the strand node refuses that id as a member. If the machine is in the running node's launch seed, the strand's runtime is rebuilt once, as on a hibernation wake. On a closed strand the [key replacement](keys.md#replacing-the-partys-key) that the removal starts is refused while the queue holds transactions, and runs once it empties.
- **Outside offline mode nothing waits.** The commit runs alone, and its durability record names these machines in `awaitedMachines`.

### An app schema upgrade waits for the queue

An `App` schema apply that queued transactions refuse does not fail the connect. The strand comes up on the schema it had, and the apply is retried as the queue drains. [An app schema upgrade waits for the queue or the cohort](app-schema.md#an-app-schema-upgrade-waits-for-the-queue-or-the-cohort) describes the mechanism and what the app reads.

### Leaving a strand with unsent transactions

`CadreNode.forgetJoinedStrand(strandId, options?)` and `CadreNode.unpublishStrand(strandId, options?)` check the strand's queue on this machine before they change anything. The options type is `StrandLeaveOptions`.

- **A queue holding transactions refuses the leave** with `StrandQueueNotEmptyError` (`transactionIds`), and nothing is left or removed. The app told its user each of those transactions was saved, so it shows the unsent changes and asks.
- **`discardQueued: true` withdraws them, then leaves.** Optimystic refuses to withdraw a transaction that was sent or is being sent (`EntryNotDiscardableError`), because the members may already hold it. Those stay in the journal, named in one `console.warn`, and settle if this machine attaches the strand again. The leave goes on, because otherwise a cohort that never returns would block it forever.
- **A hibernating strand is checked without waking it,** from what its queue listed when its database last closed. Discarding wakes it first, because the queue is back only once a build restores it. A wake that builds no database (no seed peer has answered) discards nothing, and the leave goes on with a warning naming the transactions.
- **The discard runs before the control database write.** A leave refused after the discard (this machine cannot sign the removal) leaves the discarded transactions discarded.
- **A strand this process has built no database for is not checked.** Its journal may hold transactions from an earlier run, and they come back if the strand is attached again.

The other ways a strand goes away do not consult the queue:

- **`stopStrand`** leaves the journal, and the next build restores the queue.
- **A strand moved to another cadre** keeps its storage scope, which is its strand id, so its journal goes with it unchanged.
- **A party removed from a closed strand** keeps the strand running for the session (`strand:revoked`). Its queued transactions cannot land, because the remaining members refuse a removed party's writes.

### The strand connection

`@serfab/quereus-plugin-sereus` turns the queue on per connection. An app on cadre-core does not call this layer; an embedder calling `connectToStrand` directly does.

- **`StrandConnectionOptions.offline` turns it on.** Its keys are the Optimystic plugin's `offline` block without `journalLabel` (`StrandOfflineOptions`). When it is absent, nothing reaches the plugin and the connection has no queue.
- **The result's `offline` is the handle on the queue** (`StrandOfflineController`), present only when `offline` was given. It adds `enter`, `exit` and `isEntered` to what `StrandOfflineQueue` exposes. Sereus's own writers, which are handed a bare `Database`, find it with `offlineControllerOf(db)`.
- **The queue is released before the transaction bridge** on shutdown and on a failed connect, so its drain stops before the component it reports commits through goes away.

### On a cadre node

`CadreNodeConfig.strandOffline` offers the mode on a node's strands: `{ journal: (scope) => IKVStore | Promise<IKVStore>, initialMode?: 'online' | 'offline' }`.

- **A journal is required.** cadre-core never builds a memory-only queue, because an acknowledgement that a process exit loses breaks the promise a local commit makes. `journal` is called once per database build with the strand id (its storage scope key). A throw or rejection fails the build, as a storage provider's does.
- **The embedder owns the store.** Every rebuild calls `journal` again, and nothing in cadre-core or Optimystic closes the store. Return the same store for the same scope and close it after the node stops.
- **When `strandOffline` is absent, no strand database gets a queue,** and `setStrandOfflineMode` throws `StrandOfflineUnavailableError`.

#### The mode belongs to the strand

`CadreNode.setStrandOfflineMode(strandId, mode)` records the mode against the strand id, and `getStrandOfflineMode(strandId)` reads it: the mode last set, else `initialMode`, else `'online'`. Both throw for a strand this node does not run.

- **A live database takes the mode at once,** whether it is published or still behind the first-sync gate. Optimystic fixes a transaction's acknowledgement when the transaction begins, so a transaction already open keeps its own.
- **A hibernating strand takes the mode at its next build.** A strand's `Database` is closed and rebuilt on hibernation, wake and every other runtime rebuild, and Optimystic's mode lives on one database's plugin. `StrandInstanceManager` therefore keeps the mode per strand id and each build applies it.
- **The mode lasts as long as the process.** After a restart every strand starts in `initialMode` again. An app that wants something else sets it again at startup, or uses the edge node, which saves it.

Each build applies the mode at the end of `StrandDatabase.initialize`: after the connect has restored the queue and after the founder bootstrap (whose `Strand` writes are network-acknowledged in either mode), and before the first-sync probe and publication.

#### First sync in offline mode

The first-sync gate ([Joining: no writes before the first sync](formation.md#joining-no-writes-before-the-first-sync)) is unchanged. Applying the mode before the gate's probe is what lets a machine pass it offline: in offline mode a read the cluster cannot answer is served from this machine's copy, so a machine that holds every collection passes the probe with its peers unreachable. A machine that never held a table still fails it (`BlockUnavailableError`).

A restored non-empty queue does not skip the gate. Its transactions may cover only some tables, and the gate's rule concerns what the local store holds.

#### Sending is activity

On a node whose hibernation timers are on, each `submitting`, `committed`, `partially-committed` or `failed` status counts as activity on the strand ([What counts as activity](hibernation.md#what-counts-as-activity)). The idle timer then does not cut a drain short, and a check-in window that finds the cohort reachable stays up while the queue drains. cadre-core records it with `HibernationManager.recordActivity`, not `CadreNode.recordStrandActivity`, whose push fan-out would wake other phones.

- **It has no effect on the edge node.** The edge node runs with the timers off, and recorded activity is ignored there ([When hibernation applies](hibernation.md#when-hibernation-applies)). A `serviceWake` window on a phone ends on schedule even while the queue is sending, and the drain continues at the next wake.
- **Waiting is not activity.** A queue waiting for its cohort (`queued`) records nothing, or an offline phone would never hibernate.
- **Not while quiescing.** Activity on a strand being quiesced would wake it again once the quiesce ends, which would undo a `hibernateAll` made as the app went to the background.
- **A hibernation that closes the database mid-send is safe,** because an interrupted send lands once ([What a local acknowledgement promises](#what-a-local-acknowledgement-promises)).

### On the edge node

The edge node (`@serfab/cadre-core/edge-node`, which `@serfab/cadre-rn/phone-node` and the web reference app run) passes `strandOffline` when its platform's storage implements `EdgeNodeStorage.offlineJournal(scope)`, and none otherwise.

- **`EdgeNodeOptions.strandOfflineMode` is the app's default** (`'online'` or `'offline'`, default `'online'`). It becomes `strandOffline.initialMode` and is saved with the start options, so a background restart or a push wake starts every strand in it again.
- **The saved mode follows the app, not the party.** It carries into a joined cadre and back to the founded one after a removal. A start whose options name no mode takes the saved start's, so a start from a form, or from options held since before a change, keeps the app's choice.
- **`EdgeNode.setStrandOfflineMode(mode)` changes that default without a restart.** Every strand the running node runs takes the mode at once, each strand it starts later takes it too, and the saved start keeps it. It throws a plain `Error` while no node runs and on a platform with no journal. It overrides a mode set on one strand with `CadreNode.setStrandOfflineMode`.
- **The journal is in the strand's own database** ([Where queued transactions are saved](#where-queued-transactions-are-saved)).
- **One store per scope until the storage closes.** A store serves its unflushed writes from memory, so a second store over the same handle would not see them. The edge node's stop stops the node, its strands included, before `EdgeNodeStorage.close` flushes and closes the journals. `destroyScope` closes the scope's journal before deleting the database.

## Limits and accepted tradeoffs

- **Followed commits are held in memory.** Closing the database, hibernation and a restart forget them, and `strand:commit-held` never fires for a forgotten commit, though its rows still reach the others when this machine next connects. Optimystic offers no way to ask afterwards whether an earlier commit is held.
- **The durability record keeps the 256 most recent commits.** An app that needs the answer for an older commit must read it sooner or keep the event. The limit is `RECENT_COMMIT_LIMIT` in `strand-commit-durability.ts`.
- **An empty `awaitedMachines` on a commit not held elsewhere does not prove a cadre of one.** The list is built from what this node knows at that moment. A machine whose `StrandPeer` row has not arrived, has not been read yet or could not be read is not listed, and a torn commit whose other blocks their clusters took lists nobody either. The list can also over-report; `heldElsewhere` remains the survival answer.
- **A save made just after a node is added can commit alone.** A machine in the cadre with no `StrandPeer` row yet is not waited for, so a save made between adding a node and its first row reaching this machine commits alone and reaches the node later, when the strand node connects to it and pushes it the blocks it lacks (ticket `feat-offline-hold-starts-when-a-node-is-claimed`).
- **A machine that stops running the strand but stays in the cadre keeps being waited for** until it is removed from the cadre, because its `StrandPeer` row is permanent. A peer that never returns keeps counting in Optimystic's own gate the same way. The `NOTE:` on `StrandPartyMachines` names the revisit condition.
- **The membership-write check is not atomic with the write.** An app commit queued between the check and the membership `exec` makes that membership commit wait behind it, for up to `networkCommitTimeoutMs`. A reconciler write that times out (`OfflineCommitTimeoutError`) is retried by the next pass, which reads the state first, so a write that landed anyway is found, not written twice.
- **A held queue delays a removed machine's removal from a closed strand.** The key replacement that follows `removeMachine` waits for the queue to empty. A queue still waiting for a second unreachable machine therefore keeps the removed machine a member of the closed strand until it drains, unless another owner machine carries out the replacement. Letting those writes past the refusal would bring back the bounded wait the refusal avoids.
- **The network-commit wait is the plugin's five-minute default.** Nothing has been measured that would justify another value.
- **Offline mode is unavailable on NativeScript** (ticket `feat-strand-offline-mode-nativescript`). The other places it is not offered are deliberate ([Turning it on](#turning-it-on)).
- **Deleting the journal's records on a leave without asking was rejected.** Dropping transactions the user was told were saved must be the user's explicit choice, which is also why the default is to refuse.
- **The queue is not held for a current app schema version.** A member offline on an older schema keeps queuing, and its queue can drain before it learns of a newer version ([A running member stops](app-schema.md#a-running-member-stops)).
