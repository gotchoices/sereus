# Deadlines and the link budget

Every wait in Sereus that crosses the network between two machines has a deadline, and almost all of those deadlines are computed from one number a node declares about its link. This document states that rule, lists the deadlines cadre-core sets and the ones beneath it in Optimystic, FRET and libp2p, and names the relationships between them that must keep holding. It is for operators who run nodes on slow links and for maintainers who add or change a deadline.

Related: [relays](relay.md) · [control database replication](../cadre/control-replication.md) · [inviting and joining](../strands/formation.md) · [hibernation and wake](../strands/hibernation.md) · [gates](../contributing/gates.md)

## Dial budgets are counted in round trips, not milliseconds

Opening a connection to another machine through a relay costs a fixed number of message exchanges. A deadline written as a number of milliseconds therefore has a link speed above which it can never open a connection, and the failure looks like an absent peer, not like a timeout.

Sereus avoids that by stating the link once. A node declares one figure, the round trip it assumes between itself and another machine. Every deadline that waits on the link is that figure multiplied by the number of round trips the operation costs. A deployment on a slower link changes one declaration and every deadline moves with it.

`packages/cadre-core/src/link-budget.ts` holds the counts and the arithmetic, and is the only place a new deadline over the link is written.

### The unit and the counts

One **link round trip** is a message from one machine reaching the other and a reply coming back, over the path the two machines actually use. When they can reach each other only through a relay, that path crosses the relay.

| Operation | Link round trips |
|-----------|------------------|
| The dialer opens its own connection to the relay | 1 |
| Open a relayed connection over a relay connection the dialer already holds | 4 |
| Open a relayed connection, opening the relay connection first | 5 |
| Request a reservation on an open relay connection | 1 |
| Negotiate one protocol on an open connection | 1 |
| One request and its answer on an open connection, negotiation included | 2 |
| One Optimystic commit over open connections | 20 |

Every budget for a relayed dial counts five, because a dialer cannot know beforehand whether it already holds a connection to the relay.

The commit figure is different in kind. A commit is many exchanges whose number the transactor decides, so 20 (`COMMIT_ROUND_TRIPS`) is a measurement of a whole write. It is measured again, not recomputed, when `@optimystic/*` is upgraded.

### The declared link

The declaration is `NetworkConfig.linkRoundTripMs`, in milliseconds, and it applies to the control node and every strand node of the machine. In `cadre-cli` it is `network.linkRoundTripMs` in the configuration file; an edge node sets it through its `configure` option.

The default is 3,500 ms (`DECLARED_LINK_ROUND_TRIP_MS`). Sereus supports a machine that reaches its cadre only through a relay up to a 3-second round trip, which is a congested mobile or satellite link. The default is rounded up from 3,000 because a relayed dial costs slightly more than its round trips of pure delay: the handshakes take time of their own.

A value that is not a finite number above zero makes `CadreNode.start` fail.

Above the declared round trip a relayed connection cannot be opened at all. A machine on a slower link must declare that link.

### Admission decisions

The counts are link time only. A node that is being dialed runs an admission decision before it answers the dialer, and that decision can take up to 2 seconds (`ADMISSION_DECISION_TIMEOUT_MS`). libp2p runs the decision before it replies to the negotiation the dialer is waiting on, so the time is spent inside the dialer's deadline.

Every budget that opens a connection therefore adds 2 seconds for each decision the dial may pass:

- **A relayed dial adds two.** A relay run by the party decides on the dialer's connection to it, and then the called machine decides.
- **A relay reservation adds two.** A relay run by the party decides once for the connection and once for the reservation.

The allowance is flat. It is local decision time, so it does not grow with the declared round trip.

### What cadre-core derives

`L` is the declared round trip. The defaults are at `L` = 3,500 ms. A block's **cluster** is the group of peers that hold and vote on that block; Optimystic's identifiers call it a cohort (`cohortQueryTimeoutMs`, `cohort-unreachable`).

| Budget | Formula | Default | Used for | Defined in |
|--------|---------|---------|----------|------------|
| Relayed dial | 5L + 4,000 | 21,500 ms | One address of a control-cohort dial, a strand redial, a block catch-up push | `relayedDialBudgetMs` |
| Relayed dial and one negotiation | 6L + 4,000 | 25,000 ms | The strand formation dial | `relayedStreamOpenBudgetMs` |
| Relayed dial and one request | 7L + 4,000 | 28,500 ms | One attempt of a wake, a strand-address request, a seed delivery or an invitation redemption; how long a control node keeps a connection it admitted provisionally | `relayedRequestBudgetMs` |
| Relay reservation drive | 4L + 4,000 | 18,000 ms | The dial, the reservation request and the wait, together | `relayReservationBudgetMs` |
| Request on an open connection, with payload | 2L + 6,000 | 13,000 ms | The response to one block catch-up push. The 6,000 ms covers the chunk's bytes and does not scale with `L` | `circuitRequestBudgetMs` |
| Per-peer cluster read | 2L | 7,000 ms | Optimystic's `clusterPolicy.cohortQueryTimeoutMs` | `cohortReadDeadlineMs` |
| One commit | 20L | 70,000 ms | A term in the formation deadlines | `commitBudgetMs` |
| WebRTC upgrade dial | 9L + 4,000 + 25,000 | 60,500 ms | One background attempt to replace a relayed connection with a direct one. The 25,000 ms is ICE's own, longer than the stack's give-up time on purpose: nothing waits on this dial | `webrtcUpgradeDialBudgetMs` |

All of these functions are in `link-budget.ts`. Three budgets are built from them elsewhere:

- **Dialing one control-cohort peer across all its addresses** gets four relayed-dial budgets, 86,000 ms (`DEFAULT_CONTROL_COHORT_DIAL_TIMEOUT_MS` in `peer-dial.ts`). Four fits a peer that reports three dead addresses ahead of the one that works.
- **A whole wake call** gets two attempts, 57,000 ms (`DEFAULT_WAKE_DIAL_BUDGET_MS` in `strand-wake-protocol.ts`).
- **Strand formation** derives every deadline of a session from the same declaration (`formationDeadlines` in `strand-formation-deadlines.ts`): 213,500 ms for a whole session at the default. See [The formation protocol](../strands/formation.md#the-formation-protocol).

### What Optimystic derives, and what cadre-core states on top

cadre-core passes the declaration to Optimystic on every node it builds (`NodeOptions.linkRoundTripMs`), the default included. Optimystic derives its own deadlines from it, each never below the fixed value it used before, and passes the declaration on to FRET. The table under [Deadlines below cadre](#deadlines-below-cadre) lists them.

Optimystic's derivation is link time only. cadre-core therefore states three limits itself (`optimysticDialLimits` in `link-budget.ts`), each being Optimystic's value plus two admission decisions: libp2p's `addressDialTimeout` and `dialTimeout`, and the dial deadline of every Optimystic request.

cadre-core also states the per-peer cluster read deadline, at two round trips where Optimystic would derive three. The declaration already carries headroom over the supported link, and a third round trip would lengthen every read against a peer that is gone.

An undeclared Optimystic node uses deadlines sized for a local network; its 3,000 ms request dial cannot open a relayed connection on a slow link. This is why cadre-core always states the value.

### Declare the same value on every machine of a party

Every machine is the listener for connections the others open to it. The listener's limit on finishing a half-built connection (libp2p's `inboundUpgradeTimeout`) comes from the listener's own declaration. A machine that declares a faster link than its peers discards their connections while they are still being built.

The failure is silent on the dialer's side. The dialer's own dial resolves, every stream it then opens ends with `Unexpected EOF`, and the listener reports no peer at all.

Two other waits have the same shape:

- **Strand formation.** The joiner derives how long it waits for the host's reply from its own declaration, and the host derives its provisioning budget from its own. A joiner that declares a faster link gives up on a reply the host is still entitled to send.
- **Provisional admission.** A member derives how long it keeps the connection of a machine it cannot yet place from its own declaration. A member that declares a faster link can close a redeeming device's connection while the device still waits.

Lower the declaration only where every machine of the party is that close.

### Overriding a budget

A host that knows its deployment is slower raises `linkRoundTripMs`. A few budgets also have their own setting, which wins where given: `network.controlCohort.dialTimeoutMs` and `perAddressDialTimeoutMs`, the `dialTimeoutMs` and `responseTimeoutMs` of `strandBackfill` and `controlBackfill`, and `network.cohortQueryTimeoutMs`. An override replaces the whole derived value, admission allowances included.

`network.cohortQueryTimeoutMs` is the one override with a routine use. A deployment where every machine is on one local network can lower it so that a departed peer stops delaying reads, without declaring a faster link and shortening the dial budgets too.

The relay container sets its listener limit by hand to the default's 17,500 ms (`ops/docker/libp2p-infra/src/main.ts`). It needs no dial limits, because a relay serves a circuit over a connection its target already holds and dials nothing.

### The lint rule

In cadre-core's source, `yarn lint` rejects a value named like a deadline (`…TIMEOUT_MS`, `…BUDGET_MS`, `…DEADLINE_MS`, `…TimeoutMs`) that is set to a plain number, unless the line above it carries a directive that says why the value is not derived. [Lint coverage](../contributing/gates.md#lint-coverage) lists the four accepted reasons and what the rule cannot catch.

## Deadlines over Optimystic's reads and commits

cadre-core's own deadlines wait on Optimystic reads and commits, which have bounds of their own. A change to a number on either side starts with the relationships in this section.

### How Optimystic bounds a read and a write

Optimystic's own bounds are listed under [A read](#a-read) and [A write](#a-write). Three of them decide what a failing write costs. The values are at the default declaration.

- **The response deadline** is 10,500 ms for one cluster member's reply to one consensus request. The coordinator asks each member twice, so one round against a silent member lasts 21 seconds.
- **The cancel budget** is 42,500 ms. A failed write spends it cancelling its pend, the phase in which the cluster promises the write.
- **The transaction budget** is 170,000 ms for each phase of a write, the pend and the commit.

### What a silent member costs a control write

The cancel of a failed write starts another round for as long as its budget has not run out, and each round runs to its end, so at the default the cancel budget starts three rounds.

- **A member that is connected and never answers** makes a control write fail after four rounds, about 84 seconds: one pend round, then the three cancel rounds. The pend is not retried, because its round ends with the coordinator's answer and not with a timeout.
- **A member that answers the pend and then goes silent** costs ten rounds, about 210 seconds from the moment it goes silent, for a write that spans several collections (a table and its unique index). The commit of all collections together fails after one round. Optimystic then makes three more commit attempts of two rounds each, and the cancel runs its three rounds.
- **A cancel that could not complete stays owed.** The writer sends it again before its next write to those blocks.
- **The transaction budget itself** is reached only by a phase that keeps retrying, for example one that keeps choosing a coordinator that does not answer.

The round counts are Optimystic's and can change with its version.

Control writes run one at a time on a node ([Local write serialization](../cadre/control-replication.md#local-write-serialization)). While a member stalls, each failing write holds every other control write on that node for the whole of its failure. The [control-write retry](../cadre/control-replication.md#control-write-retry) adds nothing to that, because one such attempt already exceeds its budget.

### Deadlines that cut off and deadlines that contain

A cadre-core deadline over a read or a commit does one of two things.

- It **cuts off** the work. Its caller cannot wait longer, and what happens when it expires is designed. It is sized by what the caller can tolerate, so it must not grow with the link or with Optimystic's bounds. These are the sites that carry the lint reason `cuts off by design`.
- It **contains** the work. It has to be longer than what it waits on, so it grows when that work does.

The reasoning for each value is in the comment on the constant. The files are in `packages/cadre-core/src/`.

| Deadline | Default | Waits on | Intent | Defined in |
|----------|---------|----------|--------|------------|
| `ADMISSION_DECISION_TIMEOUT_MS` | 2,000 ms | One inbound admission decision: the control node's membership check, or a closed strand's revoked-peer check | Cuts off. An expired decision admits the connection | `link-budget.ts` |
| `CONTROL_READ_RETRY_BUDGET_MS` | 1,500 ms | The control-read retry loop, checked between attempts | Cuts off | `control-read-retry.ts` |
| `CONTROL_WRITE_RETRY_BUDGET_MS` | 10,000 ms | The control-write retry loop, checked between attempts | Cuts off | `control-write-retry.ts` |
| `DEFAULT_OWNER_GENESIS_TIMEOUT_MS` | 60,000 ms | An edge node's owner step at start: control reads and at most one `OwnerKey` commit | Cuts off. The start continues with the step reported as `timed-out` | `edge-node/config.ts` |
| `OWNER_ROW_SYNC_TIMEOUT_MS` | 60,000 ms | `joinWithOwnerGrant` waiting for its own `OwnerKey` row to reach this node | Cuts off. The call returns with the key not yet in use | `cadre-node.ts` |
| Formation provisioning budget (`provisionWorkMs` + `provisionGraceMs`) | 171,000 ms (94,000 + 77,000) | The host's side of a formation: control reads, the approval hook, one strand commit, then the `FormationUsage` commit inside the grace | Contains, with a designed cut-off at its end | `strand-formation-deadlines.ts` |
| `DEFAULT_STRAND_FIRST_SYNC_TIMEOUT_MS` | 360,000 ms | A joining machine's whole first sync, which runs several cluster reads | Contains. Measured, not derived | `strand-first-sync-gate.ts` |
| `DEFAULT_CONTROL_COHORT_RECONCILE_MS` | 120,000 ms | Nothing. It is the longest interval between two reconcile passes | Not a deadline | `control-cohort.ts` |

Two of these have their own settings: `CadreNodeConfig.strandFirstSync.timeoutMs` and `network.controlCohort.reconcileMs`.

### Relationships that must hold

A unit test in `packages/cadre-core/test` fails when one of these breaks, except where the item says it is kept by hand.

- **The read-retry budget is below the admission deadline.** The admission decision reads the control database and admits when it times out. A read that recovers on its second attempt must still arrive in time to decide the admission.
- **Every dial into a node that runs an admission decision has room for it.** It holds by construction and needs no test, because the budgets under [What cadre-core derives](#what-cadre-core-derives) and the three limits stated to Optimystic each add the allowances. Raising `ADMISSION_DECISION_TIMEOUT_MS` lengthens all of them.
- **The listener's limit contains the part of a relayed dial its clock covers.** The listener's clock starts when the relay hands it the circuit, so it covers at most four round trips and the listener's own decision. Optimystic's five round trips, never below 10,000 ms, contain that at every declaration.
- **The plugin's per-peer read deadline equals cadre-core's derivation at the default.** `COHORT_READ_DEADLINE_MS` in `packages/quereus-plugin-sereus/src/cluster-size.ts` is the same 7,000 ms written as a number, because that package cannot import cadre-core. A host that declares no link takes the plugin's value and one that declares the default takes the derivation, so they must agree.
- **Each formation deadline is shorter than the one around it.** The approval hook's timeout, the host's work budget, work plus grace, the joiner's wait for the reply, and the whole session are strictly ordered at every declaration, so each layer fails and reports before the layer above gives up.
- **The first-sync budget is coupled to the per-peer read deadline.** A first sync runs several cluster reads, and each one against a peer that cannot answer costs the read deadline. The budget is kept at no less than three times the slowest first sync measured, so it is measured again whenever the declared default or the read deadline changes. Kept by hand; the rule is on the constant.
- **A connection's liveness ping interval is longer than its ping deadline.** cadre-core pins the deadline at 30 seconds and the interval at 35 (`DEFAULT_CONNECTION_MONITOR` in `types.ts`), so one ping is always finished or aborted before the next opens a stream.
- **The membership view's reload wait follows Optimystic's read-repair window.** After a sibling reconnects, cadre-core waits out that window, plus one second, before it reloads its membership views (`MEMBERSHIP_VIEW_RECONNECT_RELOAD_MS` in `membership-view.ts`). The file holds a copy of Optimystic's 10,000 ms default, kept in step by hand.
- **The membership view's maximum age is below the reconcile interval.** At 15 seconds against 120, a pass started by the interval alone always reads storage, which is what brings in a change the node received no event for. Kept by hand.

## Deadlines below cadre

Under cadre-core's deadlines, reads and writes wait on Optimystic's, FRET's and libp2p's, and on a slow link those expire first. The reasoning for each value is at the site in the last column.

"Follows the link" means the value is computed from the declared round trip `L`, and the default column is at `L` = 3,500 ms. "Fixed" means it does not move with the declaration. No lint rule in this repository checks these values, because they are other projects' constants. They were read at `@optimystic/*` 1.27 and `p2p-fret` 1.3; after an upgrade of either, check each row at its site.

Optimystic's files are under `packages/<package>/src/` in its repository and FRET's under `packages/fret/src/`. cadre-core's are in `packages/cadre-core/src/`.

### Opening and keeping a connection

| Deadline | Owner | Default | Follows the link | Bounds | Defined in |
|----------|-------|---------|------------------|--------|------------|
| `addressDialTimeout`, `dialTimeout` | libp2p; stated by cadre-core | 39,000 ms each | Yes: 10L plus two admission decisions | One address of any dial; a whole dial that carries no deadline of its own | `optimysticDialLimits` in `link-budget.ts` |
| Request dial (`rpcDeadlines.dialTimeoutMs`) | Optimystic; stated by cadre-core | 42,500 ms | Yes: 11L plus two admission decisions | Connecting to a peer and negotiating the stream of one Optimystic request | `optimysticDialLimits` in `link-budget.ts` |
| `inboundUpgradeTimeout` | libp2p; derived by Optimystic | 17,500 ms | Yes: 5L, never below 10,000 | The listener's side of a connection open | db-p2p `rpc-deadline.ts` |
| Stream hedge (`hedgeDelayMs`) | Optimystic | 5,250 ms | Yes: 1.5L, never below 250 | How long one stream open stays pending before the next connection, then a fresh dial, is tried beside it | db-p2p `rpc-deadline.ts` |
| Dead connection (`deadConnectionDelayMs`) | Optimystic | 42,500 ms | Yes: equal to the request dial | How long a stream open on an existing connection stays pending before the connection is aborted as dead | db-p2p `rpc-deadline.ts` |
| FRET redial (`FretConfig.dialTimeoutMs`) | FRET; passed by Optimystic | 39,000 ms | Yes: the node's `dialTimeout` | Each connection FRET's ring maintenance reopens | db-p2p `libp2p-node-base.ts` |
| Connection monitor ping | libp2p; set by cadre-core | 30,000 ms, every 35,000 ms | Fixed by design: sized for a phone's CPU. `NetworkConfig.connectionMonitor` replaces it | One liveness ping per connection; a miss aborts the connection | `DEFAULT_CONNECTION_MONITOR` in `types.ts` |
| Ping handler | libp2p; derived by Optimystic | 60,000 ms | No: twice the node's own monitor deadline | The answering side of one ping. It outlasts the pinging node's 30,000 ms, so the pinging node's deadline is the one that expires | `resolvePingHandlerTimeoutMs` in db-p2p `rpc-deadline.ts` |

### Keeping the ring

FRET's ring decides which peers are in a block's cluster.

| Deadline | Owner | Default | Follows the link | Bounds | Defined in |
|----------|-------|---------|------------------|--------|------------|
| Maintenance ping (`pingMs`) | FRET | 7,000 ms | Yes: 2L, never below 2,000 | One maintenance ping or announce on an open connection | FRET `service/maintenance-deadlines.ts` |
| Snapshot fetch (`snapshotMs`) | FRET | 10,500 ms | Yes: 3L, never below 1,000 | One neighbor-snapshot fetch on an open connection | FRET `service/maintenance-deadlines.ts` |
| Tick phase 1 (`phaseOneMs`) | FRET | 17,500 ms | Yes: one ping plus one snapshot, never below 3,000 | The pings and snapshot fetches of one stabilization tick | FRET `service/maintenance-deadlines.ts` |
| Stabilization tick (`tickMs`) | FRET | 24,500 ms | Yes: phase 1 plus one ping, never below 5,000 | One whole stabilization tick | FRET `service/maintenance-deadlines.ts` |
| Routed request (`routeMs`) | FRET | 14,000 ms | Yes: two hops of 2L, never below 5,000 | One routed request, from dial to the route's answer | FRET `service/maintenance-deadlines.ts` |
| `RPC_TIMEOUT_MS` | FRET | 5,000 ms | Fixed; no option | Any other FRET request, from dial to reply | FRET `rpc/protocols.ts` |
| Dead-verdict grace (`maxDeadGraceMs`) | FRET | None for a peer seen up under 10 minutes, then 1/12 of the time it was seen up, at most 300,000 ms | Fixed; Optimystic passes no value | A hold, not a deadline: how long a peer's failures must last before FRET marks it `dead` | FRET `store/tenure.ts` |

The ring's deadlines matter to a write. A maintenance ping that times out counts as a failed contact, FRET marks a peer `dead` after three, and a `dead` peer is in no cluster. A ping deadline shorter than the link would therefore remove a connected member from every cluster, which is why the ping follows the declaration.

The grace works in the other direction. A long-lived member that leaves stays in every cluster until its grace ends, so reads of blocks this node lacks can report `cohort-unreachable` for up to five minutes after it goes.

### A read

| Deadline | Owner | Default | Follows the link | Bounds | Defined in |
|----------|-------|---------|------------------|--------|------------|
| Per-peer cluster read (`cohortQueryTimeoutMs`) | Optimystic; stated by cadre-core | 7,000 ms | Yes: 2L | One cluster member's answer to one read request | `cohortReadDeadlineMs` in `link-budget.ts` |
| Reconcile pass | Optimystic | 35,000 ms | Yes: five per-peer reads, never below 5,000 | One whole reconcile pass over the cluster | `reconcilePassTimeoutMs` in db-p2p `cluster/cluster-policy.ts` |
| Read-repair window (`readRepairWindowMs`) | Optimystic | 10,000 ms | Fixed. `clusterPolicy.readRepairWindowMs` sets it; cadre-core does not | An interval, not a deadline: how old a held block's last check may be before a read starts a background cluster read | db-p2p `repo/coordinator-repo.ts` |
| Read retry | Optimystic | Waits 3,500 ms first, doubling per further coordinator | Yes: 1L | One more round, against coordinators not yet asked, for blocks no coordinator answered for | db-core `transactor/network-transactor.ts` |

On a link whose rounds take longer than the read-repair window, every read of a held block starts a background cluster read. Two rules limit that.

- **A silent peer delays the next check.** A background read that finds a cluster member silent holds that block's next one for one declared round trip, doubling with each consecutive silent read up to the reconcile pass bound. The hold ends as soon as that peer answers any request from this node.
- **A small cluster that stayed connected is not asked.** On a cluster of two or three whose members have all stayed connected to this node since the block's last check, a read starts no background read for up to 300,000 ms (`readRepairQuietWindowMs`). Every commit to such a cluster needs this node's promise, so nothing can have changed without it.

### A write

| Deadline | Owner | Default | Follows the link | Bounds | Defined in |
|----------|-------|---------|------------------|--------|------------|
| Request response (`responseTimeoutMs`) | Optimystic | 10,500 ms | Yes: 3L, never below 10,000 | One cluster member's reply to one consensus request. The coordinator asks each member at most twice | db-p2p `rpc-deadline.ts` |
| Transaction budget (`transactionTimeoutMs`) | Optimystic | 170,000 ms | Yes: four request dials | One transactor operation: a read, or one phase of a write | quereus-plugin-optimystic `optimystic-adapter/collection-factory.ts` |
| Cancel budget (`abortOrCancelTimeoutMs`) | Optimystic | 42,500 ms | Yes: one request dial, never below 5,000 | Cancelling a failed write's pend | quereus-plugin-optimystic `optimystic-adapter/collection-factory.ts` |
| Coordinator retry | Optimystic | Waits 3,500 ms first, doubling per further coordinator | Yes: 1L | After a failed batch, a retry against the next coordinator, until the transaction budget runs out or none is left | db-core `utility/batch-coordinator.ts` |
| Commit broadcast retry | Optimystic | First after 250 ms, doubling to at most 8,000 ms, at most 5 attempts | Fixed; no node option | Sending a decided commit again to members that missed it | db-p2p `repo/cluster-coordinator.ts` |
| Pend delivery deferral | Optimystic | 2,000 ms | Fixed; no node option | A hold: on a two-member cluster the coordinator holds a pend's final delivery this long so it can travel with the commit's first request | `DEFAULT_PEND_DELIVERY_DEFERRAL_MS` in db-p2p `repo/cluster-coordinator.ts` |
| Change hold | Optimystic | 10,000 ms | Fixed; the node does not expose it | A hold: when one commit touches several collections, each change event waits for the others to arrive, at most this long | `DEFAULT_CHANGE_HOLD_MS` in db-p2p `storage/storage-repo.ts` |

The change hold is when cadre-core's [table change subscriptions](../cadre/control-convergence.md#table-change-subscriptions) hear of a replicated commit.

### Other

| Deadline | Owner | Default | Follows the link | Bounds | Defined in |
|----------|-------|---------|------------------|--------|------------|
| Change-notification frame read | Optimystic | 5,000 ms | Fixed; no option | One framed read in Optimystic's change-notification protocols. Applies only with `CadreNodeConfig.strandReactivity` on | db-p2p `cohort-topic/stream-util.ts` |
| `DEFAULT_SIGN_COLLECT_TIMEOUT_MS` | Optimystic | 5,000 ms | Fixed; no option | One round of collecting cluster endorsements. Applies only with `strandReactivity` on | db-p2p `cohort-topic/threshold-crypto.ts` |

## Limits and accepted tradeoffs

- **A longer declaration is paid against a machine that is gone.** At the default, an unreachable peer holds one relayed dial 21.5 seconds, a control-cohort dial of that peer 86 seconds, an Optimystic request up to 42.5 seconds and a read of a block missing locally 7 seconds.
- **Nothing compares declarations between machines.** A party whose machines declare different links gets the silent failures described under [Declare the same value on every machine of a party](#declare-the-same-value-on-every-machine-of-a-party), and no check reports the mismatch.
- **On a link slower than the one declared, a dial can fail silently.** The relayed dial budget (21.5 seconds at the default) is longer than the listener's limit (17.5 seconds). Over a relay connection the dialer already holds, a dial can therefore outlast the listener while its own budget still runs; at the default this happens between about a 4.4 and a 5.4 second round trip. If streams end with `Unexpected EOF` on such a link, declare its real round trip.
- **A per-budget override does not move the listener's limit.** Raising `controlCohort.perAddressDialTimeoutMs` or a backfill `dialTimeoutMs` above the declaration lets a dial outlast the listener, with the same silent failure. For a slow link, raise the declaration.
- **The counts assume the delay is spread over both hops.** On a link whose whole delay is on one machine's hop to the relay, the exchanges that cross only that hop may cost up to twice their share. This is not measured. If relayed dials fail near their budget on such a link, measure that split before raising a count or the declaration.
- **The first-sync budget is measured, not derived.** It does not move with the declaration, and nothing warns when a slower link or a larger schema uses up its margin. The symptom is `StrandAwaitingFirstSyncError` on a join that was progressing. A strand with no reachable member also takes the full six minutes to report; the rejection is retryable ([Joining: no writes before the first sync](../strands/formation.md#joining-no-writes-before-the-first-sync)).
- **The block transfer allowance is not a measurement.** Nobody has measured how long a 1 MiB chunk takes to cross a relayed mobile link. If catch-up pushes time out with the transfer partly done, raise the 6,000 ms `PUSH_TRANSFER_ALLOWANCE_MS`, not the declared round trip.
- **The receiver's membership check is not counted in a wake or strand-address attempt.** The receiver answers only after two control reads. In steady state those touch only blocks it holds and ask no peer. If these requests are seen timing out while the receiver's membership read is asking its cluster, count one membership decision in the attempt deadline or answer the check from the in-memory member snapshot.
- **A cut-off budget is checked between attempts.** One attempt can outlast `CONTROL_READ_RETRY_BUDGET_MS` or `CONTROL_WRITE_RETRY_BUDGET_MS` by as long as the underlying read or commit takes; the budget only stops further retries.
- **An expired admission decision admits the connection.** The per-stream protocol guard still refuses every members-only protocol, and relay reservations from unknown peers stay capped ([The connection gate](../cadre/control-security.md#the-connection-gate)).
- **Some deadlines below cadre are fixed.** The rows marked "fixed" with no option do not grow with the declaration, and no host can set them.
- **No deadline adapts to a peer's measured response time.** Where a link's cost is per frame, the send queue grows with traffic, so a deadline from the declared count gives up on requests whose answers are only queued, and each request sent again lengthens the queue. The accepted rule is that a deadline over an open connection is the larger of its declared count and the same count of that peer's measured response time, with a ceiling. The deadlines concerned belong to Optimystic and FRET (ticket `decide-link-deadlines-from-measured-response-time`).
