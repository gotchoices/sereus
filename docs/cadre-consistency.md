# Cadre Control Consistency Model

**Status**: Design exploration. Not yet implemented. Captures a target architecture for the cadre control network's consistency model, intended to sit between Optimystic's synchronous quorum semantics and Quereus Sync's eventually-consistent CRDT semantics. The exceptions are [What Ships Today](#what-ships-today-the-control-database-replicates-to-the-whole-party) and [Deadlines Over Optimystic's Reads and Commits](#deadlines-over-optimystics-reads-and-commits), which describe current behaviour and are marked as such.

## Motivation

The cadre control network has two pressures that the current toolkit doesn't fully reconcile:

1. **Cadre members are often unreachable.** Mobile devices, sleeping laptops, NAT'd nodes — a super-majority quorum at transaction time means an authority holder with several offline nodes can be locked out of their own cadre.
2. **Some changes are still constraint-bearing.** Membership, role assignment, formation invites, and key revocation aren't arbitrary writes — they have integrity rules that the network as a whole should respect.

Optimystic's `Right-is-Right` ([details](../../optimystic/docs/right-is-right.md)) solves the second concern with cluster validation + escalation, but synchronously: a dispute blocks the transaction. Quereus Sync ([details](../../quereus/docs/sync.md)) solves the first with offline-first CRDT replication, but discards SQL constraints and transactional atomicity in the process.

The cadre control network needs **both** properties: a holder of a locally-integrity-satisfying change should be able to commit and proceed, and a holder of new information that invalidates a previously-accepted change should be able to reconcile without violating convergence.

## What Ships Today: The Control Database Replicates to the Whole Party

> **This section is shipped behaviour, not design exploration.** Everything from [Two Layers](#two-layers) onward is the target architecture and is not yet implemented; this section and the next describe what the code does now. Read them as the baseline the rest of the document proposes to improve on.

Today the control network gets its durability from Optimystic's cluster replication, with no sync/CRDT layer underneath. Each block is replicated to a **cohort** — a group of nodes drawn from the network — and the number of nodes Cadre asks for is the constant `CONTROL_REPLICATION_BREADTH` (currently 16) in `packages/quereus-plugin-sereus/src/cluster-size.ts`. Optimystic caps a cohort at the peers that actually serve the network and shrinks a cohort it cannot fill, so any number at or above the party's node count has the same effect: **every member of the party holds every control block.** 16 is roughly twice the largest deployment [`architecture.md`](architecture.md) documents, so in practice the cohort is the whole party.

**Why the control database is treated differently from strand data.** Strand data is application data. No single strand node needs all of it, so replicating each block to a subset is a storage-versus-availability tradeoff, and strand networks keep a default breadth of 4 (`DEFAULT_STRAND_CLUSTER_SIZE`) rather than the whole party. Four, not two: the commit bar is a 0.75 super-majority of the cohort, and `ceil(4 × 0.75) = 3` is the first breadth that still commits with one holder offline. (Breadth alone does *not* lift the read-repair corroboration floor off a single voter — that takes a third machine; see below and [`architecture.md` → Replication cluster size](architecture.md#replication-cluster-size).) The control database is the opposite: membership, peer addresses and the strand list are read *in full* by every control node, so a member left out of a block's cohort is a member that may never learn the fact.

Partial replication is supposed to make that safe via **read repair** — on reading a block a node asks the block's cohort for the newest revision and catches up. At a cohort of two that mechanism cannot converge at all: the one peer it can ask may be the member that also missed the write, and a single peer's answer is accepted as the cluster's truth. Measured on the control-DB replication scenario: 4 failures in 10 runs at breadth 2, 0 failures in 20 runs at full-party breadth. Replicating to everyone removes the control path's *routine* dependence on read repair — a member serving the network at write time now receives the block directly. It does not remove read repair: a member offline at write time is never in the cohort, so it still catches up by read repair on its next read, by the peer-join block catch-up when it (re)connects (`peer-join-backfill.ts`), or, when the writer was alone, by the write-while-alone re-replication queue (`CadreNode.drainPendingControlReplication`). Full mechanism, including why the wider cohort *strengthens* the read repair that remains and the one case where that cuts the other way: [`architecture.md` → Replication cluster size](architecture.md#replication-cluster-size).

**Measured on the strand side.** `strand-membership-closed-strand-e2e.integration.ts` reads a node's raw block store directly (never its database, so the probe cannot itself pull a block in) and confirms two properties on a two-node strand. First, *ongoing* replication: every block the founder authors *after* the second node is dialled in is physically in that node's own store on the first poll — roughly 1 ms after the write returns, so the push is part of the commit rather than a later sweep. Second, the *peer-join catch-up*: blocks committed **before** the dial reach the joiner too. This used to be a measured gap — a 2026-08-01 run showed 9 of the founder's 27 blocks (the bootstrap membership data blocks, their unique-index blocks, and the founder's collection roots, all written while the cohort was one node) never reached the joiner, invisibly, because a read resolves a coordinator that is the founder answering from its own storage — so the missing copies only mattered once the founder went offline. cadre-core's `peer-join-backfill.ts` closes it: when a strand's libp2p node opens a connection to a peer (its first, or a reconnect after its last one closed), it pushes every block in the strand's own raw store that the peer is not known to hold, each block once per peer (chunked, capped and logged; the receiver persists through Optimystic's monotonic `saveReplicatedBlock`, so crossing pushes from both ends cannot regress a revision). Both nodes run it, so the catch-up is symmetric without coordination. Measured 2026-08-03: the founder's whole store — 29 committed blocks — is covered by the joiner's own store within one debounce of the dial. The same catch-up is what carries a strand to a machine added to the party *after* the strand already existed: `strand-late-cadre-join.integration.ts` enrols a second machine once the founder has already written, and pins both halves of the claim — every block the founder wrote while alone lands in the newcomer's own raw store, and the newcomer still reads those rows with the founder stopped and again after a cold restart with zero connections. Its second test pins the boundary: a cadre machine that sees the strand and never runs it is handed no strand-scoped store at all, so joining the party is not what delivers a strand — running it is. An always-on (storage-profile) machine runs every strand its party publishes as a storage replica, app or not, so it does receive the store: `strand-always-on-replica-survives-phone-loss.integration.ts` checks that every block a phone holds is in the replica's own raw store, then loses the phone and reads every row back on a freshly enrolled machine with the replica as its only strand peer. `strand-late-cadre-join`'s third test covers the **seam between the catch-up and ordinary replication**, which is where real use lives: the founder keeps writing throughout the newcomer's enrollment, so the rows written before the newcomer's strand node connects are delivered by the catch-up's one-shot store enumeration while the rest arrive by ordinary cohort replication, the newcomer's strand node now being in the cohort. The enumeration runs once per connection and then marks the peer caught up until it disconnects, so a block committed after its own id was passed over — but before the peer was marked done — is never pushed and must arrive by replication instead. Measured 2026-09-08 over 18 runs: the newcomer is genuinely behind mid-window (3 to 6 blocks absent at the instant the strand mesh forms, once one held at a stale revision), and the gap is closed by the time the writer stops — every one of roughly 30 straddling rows, and the latest revision of a row the founder kept updating throughout, covered in the newcomer's own raw store and then read back **with the founder stopped and the newcomer's strand node at zero connections**, so no coordinator resolving to the author could have answered in its place. One limit worth stating: the coverage poll has never observed a non-empty gap — it completes on its first poll every run — so the gate proves the end state, and it is the mid-flight diagnostic sample that shows the newcomer was behind while the writing was still going on. The row-level write-while-alone re-replication queue is the control path's sibling mechanism at a different granularity — it re-issues *rows* (which needs the right signing key and misses unchanged index blocks) where the catch-up copies *blocks* — and the two are complements, not substitutes: re-issuing a row never rewrites an untouched collection-header block, so the **control network now runs the same block catch-up too** (gated at push time on the node's authorized-member snapshot, the rows and rule `CadreNode.isAuthorizedMember` reads, because its inbound gate deliberately admits non-members; see [`architecture.md` → Replication cluster size](architecture.md#replication-cluster-size)). That is what makes a control block committed during the founder's solo genesis physically reach members that joined later — without it, such a member restarting offline read whole control tables as empty (`control-offline-read-after-restart.integration.ts` pins the property). Tuning and the off switches: `CadreNodeConfig.strandBackfill` / `CadreNodeConfig.controlBackfill`.

And the payoff, measured 2026-08-03 in the same file: **a strand founder can now go offline without taking its founding membership rows with it.** Once whole-store coverage is confirmed through the raw store alone, the founder's node is *stopped* and the second node is polled down to zero strand connections — so nobody is left to answer remotely — and it still resolves the strand's `Header` (type closed), the founding member's key and the founding manager's key out of its own storage, the first such read landing in 5-137 ms across four runs. That is the property the block-level claim above exists for, and it was not previously demonstrated anywhere: every other cross-node read in the suite runs while both nodes are up, where a coordinator that resolves to the *author* answers from the author's storage.

**And it holds for ordinary writes too, not only the founding rows** — measured 2026-09-03 in a second test in the same file. Everything the paragraph above reads was seated by the founder's bootstrap and carried to the joiner by the peer-join catch-up, which runs when the joiner connects and again only after it reconnects. The case an application actually lives in is the other one: a strand is set up once and written to from then on, and those later rows ride to the cohort with their own commit, never with the sweep. So the second test waits for whole-store coverage **first**, then writes only on the founder — an invite, a member admitted through the real invite flow, and that member's signed `App.Items` row — gates on exactly those later blocks (13 of them, against 20 held when the sweep completed and 29 after) reaching the joiner's raw store, stops the founder, polls to zero connections, and only then reads back the row *contents* from four collections: the `App.Items` row's name, value and author, the new member's key, the invitation, and the consumption record. First read: 19-68 ms across three runs. Both tests are two-machine, where the cohort is both machines; above `DEFAULT_STRAND_CLUSTER_SIZE` a machine outside a block's cohort is neither written to at commit nor swept afterwards, and that case remains unmeasured (`backlog/debt-replication-proof-above-cohort-size`).

**What it costs.** A commit needs a super-majority of its cohort to approve. With the cohort now the whole party rather than two nodes, a single flaky or slow member counts against that threshold where before it would simply have been outside the cohort and ignored. Broader replication buys convergence and pays for it in write availability — which is the tradeoff the asynchronous-authority design below exists to remove; meanwhile the *transient* slice of that cost (a cohort that hiccuped rather than refused) is absorbed by a bounded retry at the control-write funnel (see [architecture.md → "Replication cluster size"](architecture.md#replication-cluster-size)).

**Two things this does *not* change.** The breadth is frozen when a node's libp2p node is created, so it does not track a party that grows at runtime — see [`architecture.md` → Replication cluster size](architecture.md#replication-cluster-size) for why it is a constant rather than the live member count. And it is not the same knob as `assumedClusterSize`, the separate "smallest cohort this deployment can genuinely field" value that feeds Optimystic's membership admission gate; both Cadre policies declare it as 2, because a party — and a strand — legitimately runs one or two machines. Declaring it matters even though the admission gate already defaults to the same 2: it is also the read-repair corroboration floor's last fallback before `clusterSize`, so a policy that omits the field makes two corroborators mandatory on a mesh that can field one, and repair then never converges. The corroboration floor prefers a *separate* declaration, `repairCorroborationClusterSize`, which the **control** network derives per node from the machines enrolled in the party — unlike the breadth, that number does track a growing party, applied on the node's next launch. A **strand** declares nothing there and so runs on the 2: the only count a node holds is the party's machines, and a strand runs on a subset of them, so declaring it would over-state the cohort and make repair impossible rather than merely weak. See [`architecture.md` → Replication cluster size](architecture.md#replication-cluster-size), "Two yardsticks, not one".

## Deadlines Over Optimystic's Reads and Commits

> **This section is shipped behaviour too**, like the one above. It records how cadre-core's own deadlines relate to the bounds Optimystic puts on the reads and commits they wait on, so a change to a number on either side starts here.

Optimystic bounds a read in two ways. Each cohort peer gets `clusterPolicy.cohortQueryTimeoutMs` to answer one read-path request, and a whole reconcile pass is bounded at `max(5000, 5 × per-peer)`. Sereus derives the per-peer figure from the declared link: one request and its answer over an open circuit costs two link round trips (`cohortReadDeadlineMs` in `packages/cadre-core/src/link-budget.ts`), 7 000 ms at the default declaration, which `COHORT_READ_DEADLINE_MS` in `packages/quereus-plugin-sereus/src/cluster-size.ts` spells out as a number for the hosts that declare no link; so the pass bound is 35 000 ms. Optimystic's own defaults are 1 000 and 5 000 ms, and from 1.8.0 Optimystic would derive the per-peer figure itself from the link round trip cadre-core states to it, at three round trips; cadre-core states its own two instead (`link-budget.ts` says why). From 1.8.0 that per-peer figure is the only limit on a consult: before it, Optimystic's fixed 3 000 ms request dial deadline also bounded the stream negotiation and cut every consult off at 3 s on the supported link. A host moves the per-peer figure with cadre-core's `NetworkConfig.linkRoundTripMs`, or overrides it with `NetworkConfig.cohortQueryTimeoutMs`.

Optimystic bounds a write with two budgets on the network transactor, which `quereus-plugin-optimystic`'s `collection-factory.ts` derives from the RPC dial deadline. These budgets contain the work. Sereus sets neither directly, but it states the dial deadline they come from: Optimystic's eleven round trips plus two admission decisions, 42 500 ms at the default declaration (`optimysticDialLimits` in `packages/cadre-core/src/link-budget.ts`).

- **Transaction budget** (`transactionTimeoutMs`): four RPC dial deadlines for each phase of one write (pend, then commit), 170 000 ms at the default declaration. Sereus cannot shorten it without shortening the dial deadline, which has to contain a cold relayed connection open through a party-run relay's gate and the called machine's.
- **Cancel budget** (`abortOrCancelTimeoutMs`): the larger of 5 000 ms and one dial deadline, 42 500 ms at the default declaration. A failed write spends it on cancelling its pend.

A silent cohort member costs less than the transaction budget, because what ends each consensus round is the `ClusterClient` response deadline, paid twice: 21 000 ms per round at the default declaration.
- The pend fails after one round, because the coordinator answers with the shortfall instead of timing out.
- The cancel then keeps starting rounds until its budget has passed, which is three rounds. The budget outlasts two rounds by only 500 ms, so a machine whose two rounds overrun by more than that stops at two, and the write fails after about 63 s.
- So a failing control write takes about 84 s. `control-write-degraded-cohort-member.integration.ts` derives its bounds from these budgets.

A member that answers a write's pend and goes silent before its commit costs more. The pend succeeds, each commit attempt fails in two rounds (the one-round commit, then the tail), and the cancel runs its three rounds. A write that spans several collections, as `authorizePeer` does (the `CadrePeer` table and its unique index), is committed by Optimystic's transaction coordinator in one batched commit of all its collections, which throws after one round; the transactor then commits each collection on its own, three attempts each: ten rounds, about 210 s from the moment the member goes silent. The cancel misses the bar too, so it stays owed by the writer's transactor and is re-sent before the writer's next pend of those blocks and on a timer until it lands (Optimystic 1.14.0); the next write after the member recovers commits. `control-write-degraded-cohort-member.integration.ts` covers this path.

The transaction budget is reached only by a phase that keeps retrying, for example one that re-picks a coordinator that does not answer.

**A stalled member holds the control write lock.** Control writes run one at a time under `ControlDatabase.withWriteLock`. While a member stalls, each failing write therefore holds every other control write on the node (self-record updates, authorizations, revocations) for its whole failure: about 84 s; when the member answered the pend first, the pend plus about 210 s; and up to the transaction budget plus the cancel budget on the retrying path. A write queued behind one failing write settles after about 168 s. The control-write retry adds nothing to this, because one such attempt already exceeds `CONTROL_WRITE_RETRY_BUDGET_MS`.

A cadre-core deadline that waits on one of those reads, or on a commit, does one of two things:

- It **cuts off** the work: its caller cannot wait longer, and what happens when it expires is designed. It is sized by what the caller can tolerate, so it must not grow with the link or with Optimystic's bounds. These sites carry the lint reason `cuts off by design`, and the rows marked "cuts off" below are exactly those sites.
- It **contains** the work: it has to be longer than what it waits on, so it grows when that work does.

The reasoning for each value lives in the constant's own comment, in `packages/cadre-core/src/`. This table only indexes them.

| deadline | value | waits on | intent | reasoning at |
| --- | --- | --- | --- | --- |
| `ADMISSION_DECISION_TIMEOUT_MS` | 2 000 ms | one inbound admission decision, in both gaters: the control node's membership policy (`listAuthorizedMembers`, which reads `Revocation` then `CadrePeer` live) and the closed-strand revoked-peer gate (the strand's revocation state) | cuts off; every dial budget adds it as a flat allowance | `link-budget.ts` |
| `CONTROL_READ_RETRY_BUDGET_MS` | 1 500 ms | the control-read retry loop, checked between attempts | cuts off | `control-read-retry.ts` |
| `CONTROL_WRITE_RETRY_BUDGET_MS` | 10 000 ms | the control-write retry loop, checked between attempts | cuts off | `control-write-retry.ts` |
| the formation provisioning budget (`formationDeadlines`: `provisionWorkMs` + `provisionGraceMs`) | 171 000 ms at the default declared link (work 94 000 + grace 77 000) | the formation provisioning hook: control reads, one strand-database commit, the approval hook, then the `FormationUsage` commit inside the grace; each commit is budgeted at `COMMIT_ROUND_TRIPS` (20, measured), which contains a successful commit; a failing one can run on to the transaction budget, and the cut-off ends the wait on it | contains, with a designed cut-off at its end | `strand-formation-deadlines.ts` |
| `DEFAULT_STRAND_FIRST_SYNC_TIMEOUT_MS` | 360 000 ms | a joining machine's whole first sync, which runs several cohort consults | contains | `strand-first-sync-gate.ts` |
| `DEFAULT_OWNER_GENESIS_TIMEOUT_MS` | 60 000 ms | an edge node's owner step at start: the control reads that judge its key and, on a founding start, the one `OwnerKey` commit; a joined party granted owner is re-read every 2 s inside it | cuts off; the start goes on as `timed-out` and the step keeps running | `edge-node/config.ts` |
| wake and strand-address attempt deadlines (`DEFAULT_WAKE_TIMEOUT_MS`, `attemptTimeoutMs`) | 28 500 ms at the default declared link | a dial and one request, plus the receiver's membership check | contains, except the membership check (see the last bullet below) | `strand-wake-protocol.ts`, `strand-addr-protocol.ts` |
| `DEFAULT_SEED_READ_TIMEOUT_MS` | 10 000 ms | one inbound seed frame; the trust decision and peer-store merge run after it, and touch no Optimystic data | neither: `link-independent` | `seed-bootstrap.ts` |
| `DEFAULT_CONTROL_COHORT_RECONCILE_MS` | 15 000 ms | nothing: an interval between reconcile passes | not a deadline | `control-cohort.ts` |

Three relationships between these numbers are load-bearing:

- **The read-retry budget is below the admission deadline**, so a read that recovers on its second attempt still decides the admission instead of arriving after the gate failed open. Checked by `control-read-retry.spec.ts`.
- **Every dial into a gated node has room for the admission decisions.** libp2p's listener runs the gate before it answers the multiplexer negotiation the dialer is waiting on, so the decision is spent inside the dialer's budget, and a dial that first opens its connection to a party-run relay passes that relay's gate too. It holds by construction: `link-budget.ts` derives `relayedDialBudgetMs` as five link round trips, opening the relay connection included, plus two `ADMISSION_DECISION_TIMEOUT_MS`, the relay's and the called machine's (21 500 ms at the default declared link, against a relayed dial measured at 15 113 ms with no gate in it), `relayedRequestBudgetMs` as that dial plus two round trips, and `relayReservationBudgetMs` as four round trips plus two decisions, because a party-run relay decides the connection and then the reservation. The three limits on opening a connection that cadre-core states to Optimystic (`optimysticDialLimits`: libp2p's `addressDialTimeout` and `dialTimeout`, and Optimystic's request dial) are Optimystic's derivation from the same declared link plus two decisions, a party-run relay's and the called machine's, because a dial that first opens its connection to the relay passes both gates: 39 000, 39 000 and 42 500 ms at the default. The listener's `inboundUpgradeTimeout` is Optimystic's alone, five round trips, never below 10 000 ms (17 500 ms at the default), because its clock starts when the relay hands it the circuit and runs over the listener's own upgrade and its own decision only; that contains the part of the dial its clock covers (the four-round-trip circuit leg plus one decision) at every declaration, so the listener's own limit contains its gate too. `link-budget.spec.ts` pins each of cadre's own budget formulas, and pins that containment against Optimystic's own derivation.
- **The plugin's per-peer read deadline equals cadre-core's derivation from the declared link.** A host that declares no link takes the plugin's frozen policy whole, and one that declares a link takes `cohortReadDeadlineMs` at that link, so the two must agree at the default declaration or two hosts on one link get two different deadlines. Checked by `link-budget.spec.ts`.

One gap is deliberate, with a stated condition for revisiting it:

- **The receiver's membership check inside a wake or strand-address exchange is not counted** in the sender's attempt deadline. The receiver answers only after its membership check (the control-protocol guard's live check, `isAuthorizedMember`, which refuses when it outlasts the asker's own attempt deadline at the receiver's declared link), and that is two live control reads: `Revocation`, then `CadrePeer`. In steady state those reads touch only held blocks and do not consult the cohort. If a wake or address request is seen timing out while the receiver's membership read is consulting, count one membership decision in the attempt deadline, or answer the check from the materialized authorized-peer snapshot.

### Deadlines Below Cadre

Under cadre-core's deadlines, a strand's reads and writes wait on Optimystic's, FRET's and libp2p's, and on a slow link those are the ones that fire. This table indexes them as the one above indexes cadre's: the reasoning for each value is at the site in its last column. The rule above, that the rows marked "cuts off" are exactly the sites carrying the lint reason `cuts off by design`, does not reach this table: its rows are other projects' constants, which no lint in this repository checks. "Follows the declared link" means the value is derived from `NetworkConfig.linkRoundTripMs` (3 500 ms by default), with the round-trip count; "fixed" means it does not move with the declaration, and "no option" that no host can set it either; "option" names the setting a host can use, which cadre leaves alone. cadre-core sites are in `packages/cadre-core/src/`, Optimystic's in `packages/<package>/src/` of that repository, FRET's in `packages/fret/src/`. Read at `@optimystic/*` 1.19.0 (`f1f774ea`) and `p2p-fret` 1.2.1 (`439b85e`); after a bump of either, recheck each row at its site.

| deadline | owner | at the default declaration | follows the declared link | bounds | defined at |
| --- | --- | --- | --- | --- | --- |
| **Opening and keeping a connection** | | | | | |
| `addressDialTimeout` and `dialTimeout` | libp2p, value stated by cadre-core | 39 000 ms each | yes: Optimystic's 10 round trips plus two admission decisions | one address of a dial, inside every dial including Optimystic's requests; a whole dial that carries no signal of its own | `optimysticDialLimits` in `link-budget.ts`; `CONNECTION_ROUND_TRIPS` in db-p2p `rpc-deadline.ts` |
| request dial (`rpcDeadlines.dialTimeoutMs`) | Optimystic, value stated by cadre-core | 42 500 ms | yes: 11 round trips plus two admission decisions | connecting to a peer and negotiating the stream of one Optimystic request | `optimysticDialLimits` in `link-budget.ts`; `DIAL_ROUND_TRIPS` in db-p2p `rpc-deadline.ts` |
| `inboundUpgradeTimeout` | libp2p, value derived by Optimystic | 17 500 ms | yes: 5 round trips, never below 10 000 | the listener's side of a connection open: its own upgrade and its own admission decision | `INBOUND_UPGRADE_ROUND_TRIPS` in db-p2p `rpc-deadline.ts` |
| stream hedge (`hedgeDelayMs`) | Optimystic | 5 250 ms | yes: 1.5 round trips, never below 250 | how long one stream open to a peer stays pending before the next connection, then a fresh dial, is tried beside it | `STREAM_HEDGE_ROUND_TRIPS` in db-p2p `rpc-deadline.ts` |
| dead connection (`deadConnectionDelayMs`) | Optimystic | 42 500 ms | yes: equal to the request dial | how long a stream open on an existing connection stays pending before that connection is aborted as dead | `resolveLinkDeadlines` in db-p2p `rpc-deadline.ts` |
| FRET's redial (`FretConfig.dialTimeoutMs`) | FRET, value passed by Optimystic | 39 000 ms | yes: the node's libp2p `dialTimeout` | each connection FRET's ring maintenance reopens, outside its stabilization tick | the `fret` service in db-p2p `libp2p-node-base.ts` |
| connection monitor ping deadline | libp2p, value set by cadre-core | 30 000 ms | fixed by design: sized for a phone's CPU, not the link; a host can replace it (`NetworkConfig.connectionMonitor`) | one liveness ping per connection every 35 000 ms; a miss aborts the connection | `DEFAULT_CONNECTION_MONITOR` in `types.ts` |
| ping handler on the node being pinged | libp2p (`@libp2p/ping`), value derived by Optimystic | 60 000 ms | no: twice the node's own monitor deadline (`connectionMonitor.pingTimeout.maxTimeout`), never below 10 000; option: `NodeOptions.pingHandlerTimeoutMs`, which cadre does not set | the echo of one ping this node answers; it outlasts the pinging node's 30 000 ms, so that node's own deadline is the one that fires | `resolvePingHandlerTimeoutMs` in db-p2p `rpc-deadline.ts` |
| **Keeping the ring (which peers are in a block's cohort)** | | | | | |
| `MAINTENANCE_RPC_TIMEOUT_MS` | FRET | 2 000 ms | fixed, no option | one maintenance ping or announce over an open connection | FRET `service/fret-service.ts` |
| `MAINTENANCE_SNAPSHOT_TIMEOUT_MS` | FRET | 1 000 ms | fixed, no option | one neighbor-snapshot fetch over an open connection | FRET `service/fret-service.ts` |
| `STABILIZE_PHASE_ONE_BUDGET_MS` | FRET | 3 000 ms | fixed, no option | phase 1 of a stabilization tick: the near-peer pings, then the snapshot fetches | FRET `service/fret-service.ts` |
| `STABILIZE_TICK_BUDGET_MS` | FRET | 5 000 ms | fixed, no option | one whole stabilization tick | FRET `service/fret-service.ts` |
| `RPC_TIMEOUT_MS` | FRET | 5 000 ms | fixed, no option | any other FRET request, dial through reply, and the default of FRET's `readFramed` | FRET `rpc/protocols.ts` |
| dead-verdict grace (`maxDeadGraceMs`) | FRET | 0 for a peer seen up under 10 minutes, then 1/12 of the time it was seen up, at most 300 000 ms | fixed: Optimystic passes no value | a hold, not a deadline: a peer whose strikes have not lasted this long is not marked `dead` and stays in every cohort, so after a long-lived member leaves, reads of blocks this node lacks can report `cohort-unreachable` for that long | `deadGraceMs` in FRET `store/tenure.ts` |
| **A read** | | | | | |
| per-peer cohort read (`cohortQueryTimeoutMs`) | Optimystic, value stated by cadre-core | 7 000 ms | yes: cadre's 2 round trips | one cohort peer's answer to one read-path request; [described above](#deadlines-over-optimystics-reads-and-commits) | `cohortReadDeadlineMs` in `link-budget.ts` |
| reconcile pass | Optimystic | 35 000 ms | yes: 5 × the per-peer read, never below 5 000 | one whole reconcile pass over the cohort | `reconcilePassTimeoutMs` in db-p2p `cluster/cluster-policy.ts` |
| read-repair window (`readRepairWindowMs`) | Optimystic | 10 000 ms | option: `clusterPolicy.readRepairWindowMs`, which cadre does not set | an interval, not a deadline: a read of a held block last checked longer ago than this starts a background cohort consult, so on a link whose rounds outlast it every such read costs a consult; a consult that finds a cohort peer silent does not count as a check, but holds that block's next consult for one declared round trip, doubling with each consecutive silent consult up to the reconcile pass bound, and ends the hold as soon as that peer answers this node (`SilentConsultHolds` in db-p2p `repo/silent-consult-holds.ts`); cadre-core waits it out after a sibling connects before reloading its membership views (`MEMBERSHIP_VIEW_RECONNECT_RELOAD_MS` in `membership-view.ts`, which copies the default and must follow it) | `CoordinatorRepo` in db-p2p `repo/coordinator-repo.ts` |
| read retry (`get:retry`) | Optimystic | waits 3 500 ms first, doubling per further coordinator | yes: one round trip (`retryBackoffBaseMs`), and at least as long as the failed request was outstanding when the retry goes back through that peer | one extra round, against coordinators not yet asked, for the blocks no coordinator answered authoritatively; not sent when its wait would outrun the transaction budget | `NetworkTransactor.get` in db-core `transactor/network-transactor.ts`; `retryWaitWithinBudget` in db-core `utility/batch-coordinator.ts` |
| **A write** | | | | | |
| request response (`responseTimeoutMs`) | Optimystic | 10 500 ms | yes: 3 round trips, never below 10 000 | one cluster member's reply to one consensus request; the coordinator asks each member at most twice (`ClusterCoordinator.updateMember`, one immediate retry, fixed), which makes the 21 000 ms round [described above](#deadlines-over-optimystics-reads-and-commits) | `RESPONSE_ROUND_TRIPS` in db-p2p `rpc-deadline.ts`; db-p2p `repo/cluster-coordinator.ts` |
| transaction budget (`transactionTimeoutMs`) | Optimystic | 170 000 ms | yes: four request dials | one transactor operation, a read or one phase of a write, [described above](#deadlines-over-optimystics-reads-and-commits); it is also the only bound on the coordinator's reply, since `RepoClient` sets no response deadline | `TRANSACTION_DIALS` in db-p2p `rpc-deadline.ts`; quereus-plugin-optimystic `optimystic-adapter/collection-factory.ts` |
| cancel budget (`abortOrCancelTimeoutMs`) | Optimystic | 42 500 ms | yes: one request dial, never below 5 000 | cancelling a failed write's pend; [described above](#deadlines-over-optimystics-reads-and-commits) | quereus-plugin-optimystic `optimystic-adapter/collection-factory.ts` |
| coordinator retry | Optimystic | waits 3 500 ms first, doubling per further coordinator | yes: one round trip (`retryBackoffBaseMs`), and at least as long as the failed request was outstanding when the retry goes back through that peer | after a failed batch, a retry against the next coordinator, excluding every one already tried, until the transaction budget runs out or none is left (`No coordinator available (all candidates excluded)`); a wait that would outrun the budget sends no retry; on a two-member strand that is two attempts | `processBatches` and `retryWaitWithinBudget` in db-core `utility/batch-coordinator.ts` |
| commit broadcast retry (`commitBroadcastRetry*`) | Optimystic | first after 250 ms, each interval doubled (capped at 8 000 ms), at most 5 attempts | fixed, no node option | re-sending a decided commit to the members that missed it; each attempt is a request under the deadlines above, and the first broadcast asks each member twice (`commitBroadcastImmediateRetries`, one immediate retry) before it counts as missed | `ClusterConsensusConfig` in db-core `cluster/structs.ts`; defaults in db-p2p `repo/cluster-coordinator.ts` |
| pend delivery deferral (`pendDeliveryDeferralMs`) | Optimystic | 2 000 ms | fixed, no node option | a hold, not a deadline: on a two-member cohort the coordinator holds a pend's final delivery up to this long so it rides on the commit's first request | `DEFAULT_PEND_DELIVERY_DEFERRAL_MS` in db-p2p `repo/cluster-coordinator.ts` |
| change hold (`changeHoldMs`) | Optimystic | 10 000 ms | fixed: a `StorageRepo` option the node does not expose | a hold, not a deadline: when this node pended several collections of one commit (a table and its index trees, or several tables), the change event for each that lands waits until the others land here too, at most this long; cadre's [table change subscriptions](architecture.md#table-change-subscriptions) hear a replicated commit then | `DEFAULT_CHANGE_HOLD_MS` in db-p2p `storage/storage-repo.ts` |
| **Only with strand reactivity on** (`CadreNodeConfig.strandReactivity`, off by default) | | | | | |
| cohort-topic frame read | Optimystic, under FRET's `readFramed` | 5 000 ms | fixed, no option | one framed read in Optimystic's change-notification protocols | db-p2p `cohort-topic/stream-util.ts`; FRET `rpc/protocols.ts` |
| `DEFAULT_SIGN_COLLECT_TIMEOUT_MS` | Optimystic | 5 000 ms | fixed, no option | one round of collecting cohort endorsements | db-p2p `cohort-topic/threshold-crypto.ts` |
| **Not on the link in cadre** | | | | | |
| `DEFAULT_INBOUND_AUTHORIZATION_TIMEOUT_MS` | Optimystic | 5 000 ms | option: `NodeOptions.authorizeInboundStreamTimeoutMs` | an asynchronous inbound-stream authorization predicate; cadre's two (`CadreNode.authorizeInboundControlStream`, `StrandRevocationEnforcer.authorizeStream`) are synchronous, so cadre never waits on it | db-p2p `inbound-authorization.ts` |

The ring's deadlines matter to a write because a timed-out maintenance ping is a contact strike, FRET marks a peer `dead` after three (`deadAfterFailures`, which Optimystic leaves at its default), and a `dead` peer is in no cohort (`blocked/fret-maintenance-deadlines-below-the-declared-link`).

Which of these deadlines fire on a phone-shaped link, and how often, is measured by `packages/integration-tests/src/scenarios/strand-workload-on-a-phone-link.integration.ts`; its numbers live in that file's doc comment.

## Two Layers

The design separates two concerns that have been conflated in earlier discussion:

| Layer | Concern | Mechanism |
|-------|---------|-----------|
| **Authority** | Quorum requirement for committing a change | Asynchronous Right-is-Right (this doc) |
| **Replication** | Propagating committed changes between cadre members | Quereus Sync with transactional extensions (this doc) |

They meet at one specific place: when a sync apply discovers that an arriving change is inconsistent with locally-known state, the reconciliation procedure invokes the authority layer (compensation + optional dispute).

## Authority Model: Asynchronous Right-is-Right

### Default Mode

The cadre control network runs in **asynchronous validation mode** by default:

1. The originator validates the change locally against its own integrity rules (signatures verified, single-record CHECKs satisfied, schema-shape correct).
2. If locally valid, the change commits **immediately at the originator**. No quorum required.
3. The change propagates to other cadre members lazily (via the replication layer).
4. Each receiving member re-validates the change against its own state.
5. If re-validation passes, the receiver records it as a committed change.
6. If re-validation fails, the receiver emits a **compensating change** (see below) and may optionally raise an **asynchronous dispute** against the originator.

A change is therefore "locally committed" at the moment of authoring, "tentatively replicated" while in flight, and "globally committed" once it has propagated to all live cadre members without compensation. There is no synchronous quorum decision.

### Validity Has a Causal Context

In synchronous Right-is-Right, a peer rejecting validity means "this change is wrong." In the asynchronous model, the meaning weakens:

- The originator's endorsement now means *"valid given the state I had observed at HLC = H."*
- A receiver rejecting at HLC = H′ with more information is not asserting that the originator was malicious or buggy — they are noting that **the global picture invalidates the change**.
- Each change carries a `causalContext` field: the set of HLCs (or transaction IDs) the originator had observed at commit time. This lets the receiver distinguish "concurrent conflict" (no fault) from "should-have-known violation" (originator's fault).

### Outcomes of Re-Validation

When a member re-validates an incoming change against current local state, the outcome is one of three:

| Outcome | Meaning | Response |
|---------|---------|----------|
| **Pass** | Change is consistent with local state | Apply, mark committed |
| **Concurrent-invalid** | Two locally-valid changes conflict because their authors didn't see each other (causally concurrent) | Emit compensation; no penalty |
| **Should-have-known invalid** | The originator's `causalContext` included the information that would have rejected the change | Emit compensation **and** raise async dispute; reputation penalty on originator |

The distinction between concurrent-invalid and should-have-known is the only thing the `causalContext` field is for. It is not consulted during normal operation.

### Asynchronous Dispute

When the should-have-known case is detected, the existing Right-is-Right escalation machinery applies almost unchanged:

- A dissent coordinator is selected deterministically from cadre members that have observed the offending change.
- The dispute escalates by enlisting additional cadre members (and, if needed, additional rings).
- The disputed claim is *"did the originator have causal access to the rejecting information?"* — a deterministic, post-hoc question. All re-validators reach the same answer given the same causal evidence.
- Resolution applies reputation penalties and, in repeat cases, ejection from the cadre.

Disputes never block subsequent transactions. They run alongside normal traffic.

## Convergence Primitive: Compensation, Not Rollback

A change that has been propagated cannot be unaccepted — peers may have derived state, signed artifacts, or made downstream changes based on it. The convergence primitive is therefore **compensation**:

- A receiver discovering an invariant violation issues a new change, signed by themselves, with a higher HLC, that restores the invariant. Concrete examples:
  - Two members concurrently granted the same exclusive role to different parties → compensator revokes the role assignment with the lower HLC.
  - Member X added by A; member X simultaneously banned by B → compensator records the membership as `revoked` regardless of which arrived first.
  - Duplicate identity insertions → compensator keeps the lower-HLC identity, marks the other a duplicate-of pointer.
- The original change remains in history (auditable, traceable to the originating signature).
- Live state reflects the compensated form.
- Compensations propagate like any other change. Replicas converge on `(C, then compensation)` — same end state regardless of arrival order.

This pattern is the same one used by financial systems: bad transactions are not rewound; they are corrected forward with traceable adjustments.

## Replication Layer: Sync with Transactional Extensions

The replication layer is Quereus Sync, extended in three ways so that the authority layer above can rely on it:

### 1. Transaction-Grouped HLC

Today, each column change carries its own HLC. Extension: a single HLC per `ChangeSet`, shared by all changes in that transaction.

- The `ChangeSet` already groups by `transactionId` (`quereus-sync/src/sync/protocol.ts`).
- Promote `hlc` from per-`Change` to per-`ChangeSet`.
- Consequence: a "transaction" is now a meaningful unit that the apply procedure can be atomic about.

### 2. All-or-Nothing Apply Through SQL

Today, the store adapter (`quereus-sync/src/sync/store-adapter.ts`) writes column changes directly to the KV store, bypassing the SQL execution layer. Constraints don't fire.

Extension: route remote applies through SQL inside a single store transaction.

- Per-column CHECK and NOT NULL constraints fire and can reject a change-set as a whole.
- A failed constraint check causes the whole change-set to be rejected at the receiver (which then either compensates or escalates per the authority layer).
- Uses `MultiStoreWriteBatch` for cross-table atomicity.

This is a precondition for the authority layer's "re-validate against local state" step.

### 3. Causal Delivery

Today, Sync orders by HLC but does not strictly enforce causal predecessors. Extension: each `ChangeSet` carries a `predecessors: HLC[]` field. A receiver defers applying T₂ until all of T₂'s predecessors have arrived locally.

This guarantees that re-validation runs against the same causal universe the originator saw, which is what makes the `causalContext` field meaningful for the should-have-known determination.

## Schema Discipline: I-Confluent by Default

The fundamental theorem (Bailis et al., "Coordination Avoidance in Database Systems") states that an invariant can be maintained without coordination if and only if it is **I-confluent** — i.e., mergeable states preserving the invariant. UNIQUE, multi-row CHECK, and most FK invariants are not I-confluent in the general case.

Cadre control schema design therefore commits to expressing operations in I-confluent form wherever possible:

| Naive form | I-confluent form |
|---|---|
| `Member.id` user-chosen, `UNIQUE` | `Member.id = hash(publicKey)` — uniqueness by construction |
| "Only one admin" (`SoleAdmin` row) | Threshold of M-of-N signers count as admin authority — grow-only set |
| `Role.member_id REFERENCES Member.id` (snapshot FK) | Tombstone-aware FK: reference valid if member ever existed and tombstone HLC ≥ role HLC |
| Global quota counter | Escrow-style bounded counter: each replica holds a share, rebalanced lazily |
| `Permission.granted_at < Permission.revoked_at` (multi-column CHECK) | Two separate facts (`Granted`, `Revoked`) with HLCs; live state = `Granted ∧ ¬Revoked` |

When an operation cannot be expressed I-confluently (rare, but real for some irreversible transfers), the schema author explicitly opts that operation out of asynchronous mode. Those changes go through the **synchronous Right-is-Right path** (existing Optimystic semantics) and require quorum at commit time. The mode is a per-operation declaration, not a global setting.

## Anatomy of a Cadre Control Change

Putting it all together, a change in this regime has the following shape on the wire:

```typescript
interface CadreControlChange {
  // From Quereus Sync (transaction-grouped extension)
  hlc: HLC;                          // Single HLC for the whole transaction
  predecessors: HLC[];               // Causal predecessors
  transactionId: string;
  changes: Change[];                 // Grouped, atomic

  // Authority layer additions
  signature: Signature;              // Originator's signature
  signerKey: PublicKey;              // For verification
  causalContext: HLC[];              // What originator had observed at commit
  validationMode: 'async' | 'sync';  // Per-operation mode declaration
  validityClaim: {                   // What invariants the originator asserts hold
    invariants: string[];            // Symbolic names
    evidence?: object;               // Optional evidence for replay
  };
}
```

### Apply Procedure (Receiver)

```
applyCadreControlChange(change):
  1. verifySignature(change)                       // auth gate
  2. checkCausalReadiness(change.predecessors)     // defer if missing
  3. if validationMode == 'sync':
       → defer to synchronous Right-is-Right path
  4. beginStoreTransaction()
  5. for c in change.changes:
       applyViaSQL(c)                              // CHECK / NOT NULL fire here
  6. evaluateInvariants(change.validityClaim.invariants)
  7. if any violation:
       rollback
       classify: concurrent-invalid | should-have-known
       emit compensation
       if should-have-known: raiseAsyncDispute(change)
     else:
       commit
       emit remote events
```

Steps 1, 2, 3, 6, 7 are new relative to today's Sync apply path. Step 5 replaces the direct-KV-patch with a SQL-routed apply (see `quereus-sync/src/sync/store-adapter.ts:270-329` for the current direct-KV implementation).

## What This Does Not Solve

- **Truly non-I-confluent operations** still need synchronous quorum. The design does not eliminate that need; it scopes it to the rare cases that genuinely require it.
- **Byzantine cadre membership.** A cadre member who lies about their `causalContext` can avoid should-have-known classification. The signed-history and reputation mechanisms make repeated dishonesty expensive, but the model assumes the cadre is *mostly* honest. (The cadre is a party's own nodes plus their formation partners — this is a much weaker assumption than for an open network.)
- **Pathological concurrency.** Many simultaneous concurrent changes can produce a cascade of compensations. In practice cadre control writes are rare; if pressure exists in a specific subdomain it is a signal to either (a) introduce I-confluent schema for that subdomain or (b) opt that subdomain into `sync` mode.

## Implementation Sequence (when this lands)

Approximate order of work, each step independently useful:

1. **Quereus Sync: transaction-grouped HLC.** Promote `hlc` from per-`Change` to per-`ChangeSet`. No behavioral change in default Sync mode; enables (2).
2. **Quereus Sync: SQL-routed apply.** New `mode: 'sql' | 'kv'` on the store adapter. Per-column constraints start firing on remote applies.
3. **Quereus Sync: causal delivery.** `predecessors: HLC[]` on `ChangeSet`; receiver deferral.
4. **Cadre control schema audit.** Convert non-I-confluent invariants to I-confluent form (or explicit `sync` mode flag).
5. **Authority layer wrapper.** Wrap Sync's apply with the cadre-specific re-validation, compensation, and async-dispute hooks.
6. **Optimystic: async dispute path.** Extension of existing Right-is-Right dispute machinery to support "did the originator have causal access" claims as the disputed proposition, with the change already committed at the originator. Most of the existing escalation / dissent-coordinator / reputation code carries over.

## References

- [Optimystic: Right-is-Right](../../optimystic/docs/right-is-right.md) — synchronous validity dispute and escalation
- [Quereus: Sync](../../quereus/docs/sync.md) — CRDT replication module
- Bailis, Fekete, Franklin, Ghodsi, Hellerstein, Stoica — *Coordination Avoidance in Database Systems* (VLDB 2015) — I-confluence theorem
- Terry et al. — *Bayou: Managing Update Conflicts in a Weakly Connected Replicated Storage System* (SOSP 1995) — tentative/committed states, dependency checks, merge procedures
