description: A phone in offline mode sends a queued save as soon as it sees no other machine, even when one of its own always-on nodes runs that workspace and simply cannot be reached yet. Make the queue wait for any of the party's machines that have stated they run the workspace, and let the app ask which machines it is waiting for.
architecture: docs/strands.md#offline-mode
files: packages/cadre-core/src/strand-party-peers.ts, packages/cadre-core/src/strand-party-machines.ts (new), packages/cadre-core/src/strand-instance-manager.ts (`buildStrandRuntime` ~1000, `buildStrandDatabase` ~1148, `notifyPartyPeersChanged` ~1569, `releaseRuntime` ~1379), packages/cadre-core/src/cadre-node.ts (`partyPeers` ~7518, strand-party-peers watch ~1590, `readSiblingPeerIds` ~1239), packages/cadre-core/src/strand-database.ts (`StrandDatabaseOffline`, connect options ~170), packages/cadre-core/src/strand-peer-redial.ts, packages/cadre-core/src/strand-membership-reconciler.ts (~856), packages/quereus-plugin-sereus/src/compose-strand.ts (~354), packages/quereus-plugin-sereus/src/types.ts, packages/cadre-core/test/strand-party-peers.spec.ts, packages/cadre-core/test/strand-membership-reconciler.spec.ts, packages/cadre-core/test/strand-peer-redial.spec.ts, packages/integration-tests/src/scenarios/strand-offline-waits-for-party-machine.integration.ts (new), docs/strands.md, docs/testing.md, ../optimystic/packages/db-p2p/src/network/cohort-reachability.ts (read only), ../optimystic/packages/quereus-plugin-optimystic/src/optimystic-adapter/collection-factory.ts (`registerCohortReachability`, read only)
difficulty: hard
----
# The offline queue waits for the party's machines that hold the strand (gotchoices/sereus#56)

## The gap

`docs/strands.md` → Offline mode promises a queued transaction is "not committed by this machine alone while it knows of members it cannot reach". Optimystic's reachability gate (`KeyNetworkCohortReachability`) knows only the peers this strand node has itself identified as serving the network (`rememberedServing`). A sibling it has never met does not count, so `whyNotAlone` answers "genuinely alone" and the queue commits at `quorum: 'local'` with `knownAbsent: 0`.

The reporter saw a whole phone session of this with a node whose control port was reachable and whose strand port was not. The strand address answer arrives, the dial fails, and nothing ever enters `rememberedServing`.

## Decisions

**Which machines count: a live, trusted machine with a `CadreControl.StrandPeer` row for this strand.** That row is the machine's own signed statement of its peer id in the strand, written when it launches or resumes the strand, and it already exists (`strand-party-peers.ts`, `ControlDatabase.queryStrandPeers`). It settles both open questions in the plan ticket:

- *Evidence the machine holds the strand.* A machine writes the row only when it runs the strand, so a machine whose `strandFilter` excludes the strand, or a phone whose app never claimed it, has no row and is never waited for. This avoids the "too high" trap a `CadrePeer` count would fall into (`docs/architecture.md` → Replication cluster size).
- *A name for the machine.* The plan ticket's belief that "a control row cannot name it" predates this table. The row carries the strand peer id and verifies against the machine's `CadrePeer.PublicKey`.

**Open strands write the row too.** Today only closed strands do ("nothing to bind into"), and the reporter's strand is open. Publishing on every strand costs one immutable control row per (strand, machine). The reconciler stays closed-only: `armMembershipReconciler` checks the type itself.

**The hold is a composed reachability gate, built in cadre-core and registered through the plugin.** No Optimystic change is needed. `CollectionFactory.registerCohortReachability` is the seam it documents "for tests and hosts", a gate registered first wins over the node's own, and the queue and the offline live-read path both ask it. Rejected: adding to `rememberedServing` or adopting Optimystic's backlog `feat-declared-membership-feeds-cohort-assembly`. Both need upstream work, and the second also changes cohort assembly and quorum, which is more than this question asks.

**A machine with no row is not waited for, whatever its profile.** The window between adding a node and its first row reaching the phone stays open, and such a save commits alone and reaches the node through the peer-join backfill. Closing it needs a separate signal; `backlog/feat-offline-hold-starts-when-a-node-is-claimed` holds that.

**How the app is told.** The queue already reports `waitingFor: 'cohort'` on each entry and on `queueState()`. `CadreNode.getUnreachedStrandMachines(strandId)` names the machines, so the app can say what it is waiting for and offer removal. Nothing times out or releases a hold on its own: the transaction is safe in the journal, and removing the machine is the user's decision. The follow-on ticket `removing-a-machine-releases-an-offline-queue-waiting-for-it` finishes that path.

## Interfaces

```ts
// strand-party-peers.ts — `live` carries the control peer id so an app can name the machine.
export interface PartyStrandPeer {
  /** The machine's control peer id (`CadrePeer.PeerId`, what `listMachines` and `removeMachine` use). */
  readonly peerId: string;
  /** Its peer id in this strand's network. */
  readonly strandPeerId: string;
}
export interface PartyStrandPeers {
  live: readonly PartyStrandPeer[];
  removed: readonly string[];
}

// strand-party-machines.ts (new)
/** The party's other machines known to hold one strand, from the last good read of the control database. */
export class StrandPartyMachines {
  constructor(deps: { label: string; source: Pick<PartyStrandPeerSource, 'read'> });
  /** Read again now: coalesced, one read in flight. A failed read logs and keeps the last answer. */
  refresh(): void;
  /** Settles once the first read has finished, either way. */
  settled(): Promise<void>;
  /** The last good read's live machines; empty before one. */
  machines(): readonly PartyStrandPeer[];
  /** Called only when the set of machines changes. Returns an idempotent unsubscribe. */
  onChange(listener: () => void): () => void;
  stop(): void;
}

/** `inner` (the node's gate), closed also while this node is alone in a block's cohort and the party has machines holding the strand. */
export function cohortGateWaitingForMachines(
  inner: ICohortReachability,
  keyNetwork: Pick<IKeyNetwork, 'findCluster'>,
  selfId: string,
  machines: Pick<StrandPartyMachines, 'settled' | 'machines' | 'refresh' | 'onChange'>
): ICohortReachability;

// quereus-plugin-sereus types.ts
export interface StrandConnectionOptions {
  /**
   * The gate this connection's offline queue and offline live reads ask, in place of the node's
   * `cohortReachability`. Registered with the collection factory before any table opens.
   */
  cohortReachability?: ICohortReachability;
}

// CadreNode
/** The party's other machines known to hold this strand with no open connection from its strand node. Empty on a strand not running here, or on a node offering no offline mode. */
getUnreachedStrandMachines(strandId: string): readonly PartyStrandPeer[];
```

Gate logic, in order:

1. `inner.reachable(blockIds)` false → false. Nothing further is read.
2. Await `machines.settled()`. A last read that failed asks `refresh()` again, so a retry rides the queue's own re-check timer and needs no timer of its own.
3. `machines()` empty → true.
4. For each distinct block id, `Object.keys(await keyNetwork.findCluster(routingKeyForBlock(id)))`. A cohort naming nobody but `selfId` → false. A lookup that throws → logged, false, as the upstream gate's `lookup-failed` answers.
5. Otherwise true.

The test is "alone in the cohort", not "this machine is unconnected". With node A connected and node B firewalled the cohort is `{self, A}`, the commit runs on it, and the hold does not apply. The same goes for another party's member being connected.

`onChange` forwards both `inner.onChange` and `machines.onChange`.

## Wiring

- `strand-party-peers.ts`: `partitionPartyStrandPeers` builds `live` as `PartyStrandPeer[]`; `removed` stays strand peer ids. The header comment stops saying "closed". Callers: `strand-membership-reconciler.ts:856`, `cadre-node.ts:1239` (`readSiblingPeerIds`) and the two specs map to `strandPeerId`. `removed` must still never hold an id that is also live.
- `cadre-node.ts` ~7518: pass `partyPeers` for every strand. `strand-instance-manager.ts` ~1000: drop the `Type === 'c'` check on `publishOwn`.
- `strand-instance-manager.ts`: a `partyMachines: Map<strandId, StrandPartyMachines>`, built in `buildStrandRuntime` **before `createLibp2pNode`** when `config.offline` and `config.partyPeers` are both present (the next ticket's predicate needs it there), first `refresh()` at once, stopped in `releaseRuntime`. Only a node offering offline mode pays for this, which leaves out the always-on programs.
- `notifyPartyPeersChanged` also refreshes every tracker. That method's loop today covers only `membershipReconcilers`, and the watch's first-touch NOTE (`cadre-node.ts` ~1580) still holds: the tracker's first read touches `StrandPeer` on the launch path.
- `buildStrandDatabase` builds the gate from `node.cohortReachability`, `node.keyNetwork` and the tracker, and hands it through `StrandDatabaseOffline` to `connectToStrand`. A node carrying no `cohortReachability` builds no gate, with a log line.
- `compose-strand.ts`, right after `registerLibp2pNode`: `collectionFactory.registerCohortReachability(`${resolvedTransactor}:libp2p`, options.cohortReachability)` when given. The key is the factory's `${transactor}:${keyNetwork}`, and the vtab args a few lines below set those two values.
- `strand-peer-redial.ts`: without this a blocked port that opens is never redialed. `knownMembers` reads only FRET records and the seed, and the module's header says cadre-core's address passes only fill the address book. Add `StrandRedialDeps.partyMachines?: () => readonly string[]`. `knownMembers` adds each eligible id with its peerStore addresses and skips one with none. `memberConnected` counts these ids, so a connected machine stops the dialing. (The connection the reporter saw about 1 s after an answer was not traced to its dialer, and this ticket does not depend on it.)

## Proposed `docs/strands.md` text

In "What a local acknowledgement promises", the second bullet ends: "...the members it knows include those its saved network state restores after a restart, and [the party's own machines that hold the strand](#waiting-for-the-partys-own-machines)."

New section under Offline mode, after "What the app reads":

> ### Waiting for the party's own machines
>
> A machine that has never connected to a sibling does not know it as a member of the network, so on its own it would commit a queued transaction alone. Cadre-core closes the queue's gate while this machine is alone in a block's cohort and the party has another machine holding the strand.
>
> - **Which machines count.** A machine with a `CadreControl.StrandPeer` row for the strand ([Binding the party's machines](#binding-the-partys-machines)) and a live `CadrePeer` row this node trusts. It writes that row when it runs the strand, so a machine its filter or its app keeps off the strand never counts. A machine in the cadre with no row is not waited for, so a save made between adding a node and its first row reaching this machine commits alone and reaches the node later through the peer-join backfill.
> - **What the app sees.** The transaction stays `queued` with `waitingFor: 'cohort'`, and `CadreNode.getUnreachedStrandMachines(strandId)` names the machines. Nothing releases a hold on its own, since the transaction is safe in the journal.
> - **What a long wait blocks.** Membership writes are refused while the queue holds transactions ([below](#membership-writes-are-refused-while-transactions-are-queued)), and an `App` schema apply may wait for the queue.
> - **Outside offline mode nothing is held.** The commit runs alone as before ([Writable does not mean connected](#joining-no-writes-before-the-first-sync)).

In "Binding the party's machines", the first bullet: "At every launch and resume, once the strand's node exists..." and remove "and an open strand gets no row (nothing to bind into)". State instead that an open strand's row is used only by this wait, since it has nothing to bind into.

In "Writable does not mean connected", the *In offline mode* paragraph: add the party's machines beside "those its saved network state restores".

Add the scenario to `docs/testing.md` in the offline-mode list.

## Edge cases & interactions

- **A machine that stops running the strand but stays in the cadre** (its filter changed, its app was removed, `stopStrand`). Its row is permanent, so it keeps counting until it is removed from the cadre. This matches what `rememberedServing` already does for a peer that never returns. Leave a `NOTE:` at `StrandPartyMachines` naming the revisit condition: if operators hit this, add a strand-address reply saying the filter excludes the strand. By inspection.
- **Control read fails** (a migrated store whose `StrandPeer` table has no collection fails while the others are offline, per the `NOTE:` on `queryStrandPeers`). A failed first read counts as no machines, which is today's behaviour: rows this machine cannot read are rows it does not hold as evidence. A failed later read keeps the last answer and never empties the set. Unit test.
- **Gate asked before the first read.** It awaits `settled()`, so a queue restored at launch cannot send ahead of the rows. The control read is the local one `connectedSiblingTargets`' NOTE measured in milliseconds; carry that condition in a `NOTE:` here, since a stalled read would also stall offline live reads. By inspection.
- **Machine removed.** `queryMachineRowsFresh` drops it, the set shrinks, `onChange` wakes the queue. A removed peer this node once met or seeded is the next ticket.
- **A sibling connects mid-wait.** Inner `onChange` fires on identify, FRET admits it, the cohort names it and the gate opens. Covered by the scenario's unblock arm.
- **Race between gate and send.** A row arriving after the gate opened and before the commit: that commit runs alone. Harmless as above, and the same class as upstream's own gate being a heuristic. Optimystic's `refuseSolo` cannot help, since it reads only `absentCohortMembers`. By inspection.
- **Rebuilds.** `deferUnreachableJoin` builds a second database on the same node; the tracker outlives it and each build registers its own gate with its own factory. Hibernation releases the runtime, so a resume reads afresh. By inspection.
- **Membership tables.** `Strand` tables are tagged `network`, and the plugin asks the gate only for `queue`-policy tables (`offline-mode.ts`), so membership reads and the first-sync probe of those tables are unaffected. By inspection.
- **Online mode with entries left in the queue.** They still wait, and a network-acknowledged commit waits behind them up to `networkCommitTimeoutMs`, as it does for a known-absent peer. By inspection.
- **A live trusted sibling states a false strand peer id** in its row. Only this party's machines read it, and it costs a wait that removing that machine ends. No new authority. By inspection.
- **A machine with no signing identity** (ephemeral) writes no row and is not waited for. By inspection.
- **Reads on a phone whose gate is closed** are served from its own copy and `readsServedLocally` turns true, where before a self-only refresh ran. Same answer in practice, since the cohort was itself. Check the reference apps' status line does not show this as an error. By inspection.

## Tests

- `strand-party-machines.spec.ts`, the gate's branching:

| `inner` | machines | cohort | answer |
|---|---|---|---|
| closed | any | not read | false |
| open | none | self | true |
| open | one | self | false |
| open | one | self + other | true |
| open | one | `findCluster` throws | false |

- Same spec, the tracker: a failed first read gives no machines and a later ask retries; a failed later read keeps the set; `onChange` fires only on a change.
- `strand-peer-redial.spec.ts`: one case. No member connected, a machine named only by `partyMachines`: dialed when the peerStore holds addresses, not when it holds none.
- `strand-offline-waits-for-party-machine.integration.ts`, on loopback with an open strand. A phone-shaped owner in offline mode and a storage-profile node, each with a test-supplied `network.connectionGater`, which reaches both control and strand nodes (`denyDirectPortGate` in the harness is the existing example; `control-cohort-cold-start-retry.integration.ts` shows the same config). While blocked, the phone refuses every dial except the node's control port, and both refuse `/p2p-circuit`, or the strand would tunnel through a relay on that port. Wait until `getUnreachedStrandMachines` names the node, then:
  - insert `returning StampId()`: `offline.status(tx)` stays `queued` with `waitingFor: 'cohort'`, and `commitDurability(tx)` is `undefined`;
  - open the gater: within a bound the status is `committed`, `heldElsewhere` is true, and the node's store holds the row. This also pins the redial.

## How to confirm by hand

The issue's script with `DEBUG='optimystic:db-p2p:coordinator-repo*'`: once the node's row has reached the phone, no strand `commit:solo-cohort` line should follow while it is unconnected. The `+0 s` write can still commit alone, by the decision above.

## TODO

- Change `PartyStrandPeers.live` to `PartyStrandPeer[]` and update its callers and specs
- Publish `StrandPeer` rows on open strands
- Add `strand-party-machines.ts`: the tracker and `cohortGateWaitingForMachines`, with their spec
- Add `StrandConnectionOptions.cohortReachability` and register it in `compose-strand.ts`
- Build the tracker before the strand node, the gate in `buildStrandDatabase`, and refresh from `notifyPartyPeersChanged`
- Add `CadreNode.getUnreachedStrandMachines`
- Feed the machines to the redial loop, with its spec case
- Add the integration scenario
- Update `docs/strands.md` and `docs/testing.md`
- Run `yarn typecheck`, `yarn lint`, the `@serfab/cadre-core` and `@serfab/quereus-plugin-sereus` suites, the new scenario, `strand-offline-queue-survives-restart` and `machine-removal`. If the stale-build guard reports a sibling `dist` is stale, stop and record it per `tickets/rules/sibling-repos.md`
