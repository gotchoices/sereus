description: A machine can now take part in a shared workspace without storing or signing any of its data, reading and writing through the machines that do. This is what lets a workspace with tens of thousands of phones work, because a sleeping phone then never sits on the path of someone else's save.
prereq: strand-plugin-takes-a-node-that-serves-no-blocks
architecture: docs/cadre/node.md#node-classes
files: packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/strand-instance-manager.ts, packages/cadre-core/src/types.ts, packages/cadre-core/src/node-roles.ts, packages/cadre-core/src/strand-database.ts, packages/cadre-core/test/cadre-node.spec.ts, packages/cadre-core/test/cadre-node-control-node-options.spec.ts, packages/integration-tests/src/scenarios/strand-client-node-holds-no-blocks.integration.ts, docs/cadre/node.md, docs/strands/lifecycle.md, docs/strands/writes.md, docs/strands/formation.md, docs/contributing/topology-coverage.md, packages/cadre-core/README.md, packages/cadre-cli/README.md, .release-notes.pending.md
difficulty: hard
----

# A strand node that holds no blocks

`NodeRoles.strandCohortMember` is the fourth node role: whether this node holds and signs the blocks of the strands it runs. It defaults to `true` under both node classes and is **refused** at `CadreNode` construction today, because until Optimystic 1.28.0 there was no node that could run a network while serving none of its blocks. There is now: `NodeOptions.servesBlocks: false` builds a **client node**, which registers none of the four storage protocol services (`repo`, `cluster`, `sync`, `block-transfer`), so every other machine classifies it from its identify list as not serving and leaves it out of every cohort — including its own view of itself. `../optimystic/docs/internals.md` → "Client nodes" is the reference for what such a node builds, what it ignores and what it costs.

This ticket makes `strandCohortMember: false` a working setting: the node runs the strand — reads, writes, membership, change notifications — and its reads and writes go to the strand's serving machines. The control network is untouched: it always replicates to every party member, because a machine must be able to read its own party's state with nothing reachable.

## The one seam

`StrandInstanceManager.buildStrandRuntime` is the only place a strand's libp2p node is built. `StartStrandConfig.roles.strandCohortMember` already arrives there (it is retained with the launch config, so a hibernation wake rebuilds with the same roles) and is read by nothing — a `NOTE:` on the field says this is the site that has to read it. One binding at the top of the build decides everything below:

```ts
const servesBlocks = config.roles.strandCohortMember;
```

and `createLibp2pNode({ …, servesBlocks })`.

Everything else in this ticket follows from that one flag. Where the existing code already branches on "is there a store?", a client falls into the right arm for free; where it does not, it needs one.

### What the node options must and must not carry

- **`servesBlocks`** — the new option, from the role.
- **`storage` must not be passed.** Optimystic ignores it on a client, but Sereus resolving it has a side effect: `resolveStrandStorage(config.storage?.provider, strandId)` in `startStrand` asks the embedder's provider for a per-strand store, which on a phone creates a per-strand LevelDB database and on a node a per-strand directory. A client must never ask. So the decision has to reach `startStrand`, not just `buildStrandRuntime`: skip the resolution entirely on a client, record nothing in `strandStorages`, and the three downstream readers (`backfillArms`, `storageRepo`, `strandStoreEmpty`) and `disposeStrandStorage` all already handle the absent case.
- **`arachnode` must not be passed.** A client builds no Arachnode at all, and `arachnode` is on Optimystic's ignored-serving-options list, so passing it buys one `node-wiring` log line per strand and nothing else.
- **`rebalance: { enabled: false }`** is already behind `backfillArms`, which is false with no store. Leave it that way; do not pass it on a client (also on the ignored list).
- **Everything else stays.** `clusterSize` and `clusterPolicy` (a client reads the cluster size and the deadlines), `isNetworkMember`, `authorizeInboundStream` and the connection gater, `cohortTopic`, the transports, listen addresses, relay settings, `connectionMonitor`, `linkRoundTripMs`, the dial limits and `persistence`.

### What must not be armed

- **The peer-join block catch-up** (`PeerJoinBackfill`) pushes this machine's own blocks to a newly connected peer. A client has none. It is already gated on `strandStorage !== undefined`, so skipping the storage resolution disarms it; make the reason explicit in the comment rather than leaving it to follow from a `undefined` check three hundred lines away.
- **The first-sync write gate.** See below — it is the one piece whose answer is not "skip it because there is no store".
- **This machine's `StrandPeer` row.** See below.

## The first-sync gate does not apply to a client

The gate exists to stop a JOINING machine inventing a collection: with no strand peer connected, Optimystic's cohort for every block is the machine itself, so the first write to a table finds no collection locally and creates one, and two histories then live under one collection id. A client cannot do that. It is in no cohort, including its own, so a write with no serving machine reachable resolves no coordinator and fails (`FindCoordinatorError`) instead of committing locally. There is no fork to prevent.

Keeping the gate on a client would be actively wrong, not merely redundant:

- Its probe reads would be **remote** reads repeated on the 2-second backstop (a client has no storage change feed to wake it) for up to the 360-second budget — a poll on a metered phone link, which is exactly the machine this role exists for.
- While it withholds the database the app cannot write **or queue**, so a client phone in offline mode could not record a vote on a train. That is the use case.

So: a client's database is published as soon as `StrandDatabase.initialize()` returns. The smallest correct change is in `buildStrandDatabase`, where a founder is already treated as synced — extend that one condition to a client, and leave the `StrandFirstSyncGate` object itself in place as the cleanup handle `releaseRuntime` closes the database through. `firstJoin` is already false on a client (no `storageRepo`), so nothing listens and nothing probes.

A consequence to state in the docs rather than paper over: on a client, `addStrand` resolving no longer means "a member has been reached". It means the database is open; the first read or write still fails, retryably, until a serving machine is reachable. `isAwaitingFirstSync` keeps its meaning for the case that matters — a launch whose database could not be built at all leaves `instance.database` unset, so `addStrand` still waits and still rejects with the retryable `StrandAwaitingFirstSyncError`. (Making that case **retry** rather than fail the launch is the next ticket, `client-strand-waits-for-a-serving-machine`.)

## A client publishes no `StrandPeer` row

`CadreControl.StrandPeer` is this machine's statement of its peer id in a strand, and `strand-party-machines.ts` states what the row set means: "the machines a queued transaction must not be committed without are the live, trusted machines with such a row". A client is not one of them. If a client published a row anyway, a **serving** sibling's offline queue would wait for it forever: that sibling's own gate answers "genuinely alone" (the client is not an absent cohort member, because it is in no cohort), and then the composed party-machine gate closes because the party has machines "holding" the strand that it is alone in a cohort without. The queue would never drain. That is a defect this feature would introduce, so it has to be closed here.

So the `publishOwn` call in `buildStrandRuntime` is skipped on a client, and the row set keeps meaning exactly "the machines that serve this strand".

Two costs, both to be written into the docs as accepted limits rather than worked around:

- **A sibling cannot look up a client's strand addresses.** `mergeStrandPeerAddrs` and `refreshStrandPeerAddrs` read siblings' rows, so no party machine learns a client's strand node address. The client dials out and keeps its connection, and its change-notification registration is answered over that connection, so nothing in the current design needs the inbound direction. Revisit condition: if a sibling ever has to dial a client's strand node, the row needs a field saying whether the machine serves — which means a new `CadreControl` column, not a third `CadrePeer.Profile` value (`node-class.ts` records why that column cannot grow one).
- **A party key rotation does not pre-bind a client's peer id.** `StrandPartyKeyRotation.bindMachines` binds every sibling peer id it reads from `StrandPeer` under the new key. A client is not in that list, so its `Strand.MemberPeer` binding under the new key is written by its own membership reconciler on its next pass instead of by the rotating machine. Correct, one pass later.

## Membership is unchanged

A closed strand's `Strand.MemberPeer` bindings and the revoked-peer gate are about who may take part, not who serves. A client seats its own binding through the membership reconciler like any other machine, and the revocation enforcer stays armed: its per-stream gate (`authorizeInboundStream`) has no storage protocols to gate on a client, but it still gates the `blob` protocol, which a client does register. The enforcer's `Revocation` reads are remote on a client — a periodic remote read per closed strand, where a serving machine reads its own store.

## Refusing the contradiction

`hostUnclaimedStrands` makes a node run every admitted strand as a **storage replica**, whose whole job is to store and serve. A client that stored nothing would be a replica that replicates nothing.

- Its **default** must come out `false` on a client regardless of `alwaysOn`. It defaults from `roles.alwaysOn` today, so an always-on `server` with `strandCohortMember: false` — a read-mostly dashboard node, a plausible deployment — would otherwise default straight into the contradiction and be refused for a setting it never made.
- An **explicit** `hostUnclaimedStrands: true` with `strandCohortMember: false` is refused at construction, naming both settings: the embedder asked for two things that cannot both be true.

The existing blanket refusal of `strandCohortMember: false` in the `CadreNode` constructor goes.

## Edge cases & interactions

- **The control node must never become a client.** `servesBlocks` is passed only in `buildStrandRuntime`; `buildControlNodeOptions` must not carry it, and the control node keeps its `coordinatedRepo` (`createControlNode` throws without one). A client control node could not read its own party's state offline, which is the promise the control network exists to keep. *Verified by a test — see Tests.*
- **`Libp2pNodeWithRepo.coordinatedRepo` is declared required** in `packages/cadre-core/src/types.ts` and a client has none. Widen it to optional with the reasoning the sibling fields already carry, and give the type a `servesBlocks?: boolean`. Then `buildStrandDatabase` passes `coordinatedRepo` through to `StrandDatabase` only when the node has one, and `StrandDatabaseConfig.coordinatedRepo` becomes optional too. The control-node read (`createControlNode`'s own `coordinatedRepo not available` throw) stays as it is. *Carried by the types.*
- **A commit on a client is never followed to full replication.** Upstream: the under-replication ledger entry lives on the server that coordinated the write, whose full-replication event the client never hears, and `CollectionFactory.getBlockDurabilityNotifier` answers `undefined` on a client. So `strand:commit-held` never fires on a client and `StrandCommitRecord.heldElsewhere` is never answered for its own commits; the durability record's `recordedBy` names the coordinating machine. *Verify that the plugin's `onCommitFullyHeld` subscribe is a no-op rather than a throw when the notifier is absent, then state the behaviour in `docs/strands/writes.md` → "A commit's durability".*
- **Change notifications on a client** receive but never originate: with `cohortTopic.enabled` a client runs the subscriber registry, the forwarder host and the watch service but no commit-certificate store, origination manager or change bridge, because it applies no commits. The `reactivity` role still picks the host profile as it does on a serving node. A watch's wake can lag by one cohort gossip round until its registration reaches the machine that announces a commit. *By inspection against upstream's subsystem table; stated in the docs.*
- **Hibernation and wake** rebuild the runtime from the retained launch config, so a woken strand is a client again. Quiescing closes the node and the database; there is no store to keep. *By inspection.*
- **An app claiming a running storage replica** (`attachSApp`) cannot arise on a client, which runs no replicas. *By inspection (the refusal above makes it unreachable).*
- **A strand whose members are all clients has no cohort anywhere**, so nothing commits and nothing can be read. FRET is unchanged upstream, so clients still take places in the ring and a ring that is mostly clients leaves cohorts short — upstream's blocked `clients-in-the-ring-crowd-out-serving-peers` owns that, and until it lands this role serves a strand with a MINORITY of clients, not a network of tens of thousands of phones. *A stated limit, not a guard: Sereus cannot tell from one node how many of a strand's machines are clients.*
- **A member on an older release still puts clients in its cohorts.** A serving machine running Optimystic 1.27.0 or earlier classifies a peer by the requests it sends rather than by its identify list. Every Sereus package is on 1.29.0, so a strand whose members all run one Sereus release is safe; a cross-party strand with a member on an older Sereus release is not. *A stated limit.*
- **`strandFilter` is unaffected** — it decides which strands run, not how. A client with `{ mode: 'all' }` and `hostUnclaimedStrands` defaulting false runs the strands its app claims and announces the rest. *By inspection.*
- **The strand repair yardstick.** `StartStrandConfig.servingMachines` is plumbed but fed by nothing in production, so no count changes here. `backlog/feat-strand-yardstick-from-serving-machines` carries the arm saying its source must count serving machines only. *No work in this ticket.*
- **No strand node passes `kvStore`** today, so a client's HLC high-water mark is in memory exactly as a serving strand node's already is (`peer-join-backfill.ts` records this). Nothing new. *By inspection.*

## Tests

- **`packages/integration-tests/src/scenarios/strand-client-node-holds-no-blocks.integration.ts`** — the reproduction of the whole capability, and the one place the invariant that keeps a client out of cohorts is observed end to end. Two serving nodes and one `roles: { strandCohortMember: false }` node in one party, on the reference chat schema: the client writes a row; a serving node reads it; both serving nodes hold its blocks; the client's storage provider was never asked for the strand's scope; neither serving node names the client in a cohort or picks it as a coordinator after that traffic; and the client reads a row a serving node wrote.
- **`packages/cadre-core/test/cadre-node-control-node-options.spec.ts`** — one assertion that the control node's options carry no `servesBlocks`, on a config whose roles set `strandCohortMember: false`. It pins the one invariant whose breach is silent and severe (a party that cannot read its own control database offline), at the existing spec that already owns the control node's option set.
- **`packages/cadre-core/test/cadre-node.spec.ts`** — replace the existing `refuses strandCohortMember: false` case with the two that now hold: `strandCohortMember: false` alone constructs, and together with an explicit `hostUnclaimedStrands: true` throws naming both settings.

Nothing else. The option pass-through, the skipped backfill, the skipped `StrandPeer` publish and the reactivity profile are all observed by the scenario above or carried by a type; a unit test on each would pin wiring.

## TODO

**cadre-core**

- Drop the `strandCohortMember: false` refusal from the `CadreNode` constructor; resolve `hostUnclaimedStrands` as `config.hostUnclaimedStrands ?? (roles.alwaysOn && roles.strandCohortMember)`, and refuse an explicit `true` against `strandCohortMember: false` with a message naming both.
- `types.ts`: `Libp2pNodeWithRepo.coordinatedRepo` optional plus `servesBlocks?: boolean`, each with its reason; update the `CadreNodeConfig.roles` comment, which still says the role is refused.
- `strand-database.ts`: `StrandDatabaseConfig.coordinatedRepo` optional, passed on to `connectToStrand` only when present.
- `strand-instance-manager.ts`: read the role once; pass `servesBlocks`; skip `storage`, `arachnode` and `rebalance` on a client; skip the storage resolution in `startStrand`; skip the `publishOwn` call; treat a client as already synced in `buildStrandDatabase`. Replace the `NOTE:` on `StartStrandConfig.roles` with what the field now drives.
- `node-roles.ts`: rewrite the `strandCohortMember` doc comment — it says the role is refused and names this ticket.

**Docs** (each in the section that owns the topic; no new documents)

- `docs/cadre/node.md` → "Node classes": the role now works; what a client does and does not do; the `hostUnclaimedStrands` interaction; remove the "refused when the node is constructed" sentences and the "Every node transacts and stores today" paragraph's claim.
- `docs/strands/lifecycle.md`: a client in "What a launch does"; the all-clients and older-member limits under "Limits and accepted tradeoffs".
- `docs/strands/formation.md` → "Joining: no writes before the first sync": why the gate does not apply to a client, and what `addStrand` resolving means there.
- `docs/strands/writes.md`: under "A commit's durability", that `strand:commit-held` never fires on a client and `recordedBy` names the coordinating machine; under "Offline mode", that a client's queued write waits for a serving machine (its own gate reads an empty cohort as closed) and that no read is served from a local copy, because there is none.
- `docs/contributing/topology-coverage.md`: the new scenario.
- `packages/cadre-core/README.md` and `packages/cadre-cli/README.md`: the role is no longer refused; what setting it to `false` means and what it refuses with.
- `.release-notes.pending.md`: a section for the capability, and correct the two existing bullets that say the role is refused.

**Checks**

- `yarn build`, `yarn typecheck`, `yarn lint` (which runs `yarn check:docs` — mind the 6,000-word document and 120-word list-item budgets), the `@serfab/cadre-core` unit suite, and the new scenario.
- Do NOT build, install into or edit `../optimystic`, `../quereus` or `../Fret` (`tickets/rules/sibling-repos.md`).
