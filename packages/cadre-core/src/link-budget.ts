/**
 * Dial and reservation budgets derived from ONE declared link round trip, instead of fixed
 * millisecond numbers chosen on a fast local network.
 *
 * Reaching another machine through a relay costs a FIXED NUMBER OF EXCHANGES, not a fixed
 * number of milliseconds. So every budget written as milliseconds has a link speed above which
 * it can never open a connection at all — and the slower the link, the more of them fall over,
 * silently, because an abandoned dial looks the same as a peer that is not there. Counting round
 * trips instead is what stops that class of defect coming back: the next person to widen a
 * budget changes ONE declaration, and the next person to add a dial writes down its round-trip
 * count beside the arithmetic.
 *
 * This module is the only place a new deadline over the link should be written, and in
 * cadre-core's source `yarn lint` enforces it (`LINK_DEADLINE_GUARD` in `eslint.config.mjs`): a
 * value named `…TIMEOUT_MS`, `…BUDGET_MS` or `…DEADLINE_MS` (or `…TimeoutMs` and the like) set
 * to a number rather than a derivation fails, unless the line above it gives one of four
 * reasons. `// eslint-disable-next-line no-restricted-syntax -- link-independent: <why>` keeps a
 * deadline that never waits on the link; `-- link-bound, not yet derived: <ticket slug>` marks
 * one that does and names the ticket that owns converting it. Grep for the second to list the
 * deadlines this module does not yet cover. `-- cuts off by design: <why>; see
 * docs/cadre-consistency.md → "Deadlines Over Optimystic's Reads and Commits"` keeps a deadline
 * that does wait on the link, through an Optimystic read or commit, but whose value is what its
 * caller can tolerate: it gives up on purpose and must not grow with the link. That doc section
 * lists every such site. `-- measured, not derived: <where the measurement lives>` keeps a
 * deadline that waits on the link but has no round-trip count to derive from, because it bounds
 * a whole phase of many exchanges whose number depends on the data (a joining machine's first
 * sync): its value is sized from a recorded measurement, which the directive names, and it is
 * re-measured rather than recomputed when a number under it moves.
 *
 * Optimystic's per-peer cohort read deadline is derived here too ({@link cohortReadDeadlineMs}),
 * but declared in another package: `COHORT_READ_DEADLINE_MS` in
 * `quereus-plugin-sereus/src/cluster-size.ts` is the same arithmetic at the default declaration,
 * spelled as a number because that package cannot import this one. `link-budget.spec.ts` pins
 * the two equal.
 *
 * ── The instrument ──
 *
 * Every count and every number below, except the commit count, comes from
 * `packages/integration-tests/src/scenarios/relayed-dial-cost-by-latency.integration.ts`, which
 * is committed and opt-in (`RELAY_DIAL_COST=1`). **Its doc comment is the single home of the
 * measurement**; this module holds only what the derivation needs. Re-run it before changing
 * anything here. The commit count ({@link COMMIT_ROUND_TRIPS}) is a whole-operation
 * measurement from `relay-round-trip-measure.integration.ts` instead, and its figures live on
 * the constant.
 *
 * ── The unit ──
 *
 * ONE LINK ROUND TRIP is a message from one machine reaching the other and a reply coming
 * back, over the path those two machines actually use — through the relay, when that is the
 * only way they can reach each other. In the instrument, which injects a constant ONE-WAY
 * frame delay `d`, one link round trip is `2d`.
 *
 * A leg between a node and the RELAY is half a link round trip, because it crosses one of the
 * two hops rather than both. That is why the reservation drive's cost reads as "four
 * node-to-relay round trips" in one telling and "two link round trips" in another: same
 * quantity, different unit. This module uses the LINK round trip throughout, so there is one
 * unit to reason in.
 *
 * ── The counts, and what they cost ──
 *
 * | operation                                            | link round trips | at the declared default |
 * | ---------------------------------------------------- | ---------------- | ----------------------- |
 * | open a relayed connection to another machine          | 4                | 14 000 ms               |
 * | dial the relay itself                                 | 1                | 3 500 ms                |
 * | request a reservation on an open relay connection     | 1                | 3 500 ms                |
 * | negotiate a protocol over an established circuit      | 1                | 3 500 ms                |
 * | one request and its answer over an open circuit       | 2                | 7 000 ms                |
 * | open a relayed connection, then negotiate one protocol| 5                | 17 500 ms               |
 * | open a relayed connection, then one request on it     | 6                | 21 000 ms               |
 * | one Optimystic commit over connections already open   | 20               | 70 000 ms               |
 *
 * The commit row is a measurement of a whole write, not a count of exchanges; its doc comment
 * ({@link COMMIT_ROUND_TRIPS}) holds the figures and says when to re-measure it.
 *
 * **Measured** 2026-09-26, one Windows machine, loopback dedicated relay: a relayed dial took
 * 20-25 ms at no delay, **7 255-7 279 ms at 900 ms one-way**, and **12 066-12 094 ms at 1 500 ms
 * one-way**. Four link round trips of pure delay would be 7 200 and 12 000, so the real cost
 * sits about 60-95 ms ABOVE the arithmetic — the handshakes, which no delay figure contains.
 * That residue is why {@link DECLARED_LINK_ROUND_TRIP_MS} carries headroom over the link sereus
 * supports rather than matching it exactly: a declaration equal to the supported round trip
 * would derive a budget marginally BELOW the dial it has to contain.
 *
 * ── The listener's admission decision ──
 *
 * The table is link time only. Every budget that OPENS a connection also adds
 * {@link ADMISSION_DECISION_TIMEOUT_MS} (2 000 ms) per admission decision the machine being
 * called may make on the way, because that machine's gate runs on the dialer's clock (the
 * constant's doc says why). So a relayed dial is budgeted at 14 000 + 2 000 = 16 000 ms at the
 * default declaration, a dial plus one request at 23 000 ms, and a reservation drive, which a
 * party-run relay decides twice, at 18 000 ms. The allowance is flat: it is local decision
 * time, not link time, so it does not scale with the declaration.
 *
 * The measurement above crossed no gate. The instrument is bare libp2p on both sides, with no
 * cadre connection gater, so the 12 094 ms contains no admission decision at all. The
 * allowance is therefore on top of the measured dial rather than already inside it.
 *
 * NOTE: the measured dial also reused a connection to the relay that the dialer already held
 * (the instrument dials the relay first). A relayed dial that has to open that connection itself
 * spends one more link round trip, plus the relay's own admission decision when the relay is a
 * party-run control node, and the count counts neither; at the supported link such a dial fits
 * only while the called machine decides in under about 0.9 s.
 * `bug-relayed-dial-budget-omits-opening-the-relay-connection`.
 *
 * ── libp2p's own two limits ──
 *
 * Two limits inside libp2p bound the same relayed dial as cadre's budgets do, and both were
 * 10 000 ms until `@optimystic/db-p2p` 1.7.0 let an embedder set them: the DIALER's
 * `connectionManager.dialTimeout`, which bounds every dial that carries no abort signal of its
 * own, and the LISTENER's `connectionManager.inboundUpgradeTimeout`, which is how long the
 * machine being called lets a half-built connection finish its handshakes. At 10 000 ms each,
 * no relayed connection could be opened above about 1 250 ms one-way (a 2.5-second link round
 * trip) whatever cadre declared. The listener's limit is the one that makes that failure
 * silent: at 1 500 ms one-way the dialer's own 12 094 ms dial RESOLVED while the listener had
 * already thrown the connection away at 10 s, so the first stream over it died with
 * `Unexpected EOF - stream closed while reading 0/1 bytes` and the listener reported no peer at
 * all. cadre now declares both from this module ({@link connectionManagerTimeouts}) on the
 * control node and every strand node.
 *
 * ── What still fails at the supported link ──
 *
 * - **Optimystic's own request dials.** `@optimystic/db-p2p`'s RPC clients dial with fixed
 *   3 000 ms deadlines of their own (`DEFAULT_DIAL_TIMEOUT_MS`, the `pushDialTimeoutMs`
 *   defaults), which neither limit above reaches because a caller's signal replaces
 *   `dialTimeout`. So an Optimystic request that has to OPEN a relayed connection fails above
 *   375 ms one-way. A request over a connection that is already open does not dial, but its
 *   protocol negotiation runs under the same signal (`openProtocolStream` forwards it into
 *   `newStream`), and one negotiation is one link round trip: at the supported link every
 *   cohort consult is therefore aborted at 3.0 s, before {@link cohortReadDeadlineMs} is
 *   reached (measured 2026-09-29; the figures are on `COHORT_READ_DEADLINE_MS`). The
 *   connections cadre opens itself are budgeted here. Upstream:
 *   `debt-rpc-dial-deadlines-cannot-open-a-slow-relayed-connection` in optimystic, and
 *   `tickets/blocked/report-request-dial-deadline-cuts-cohort-consults-on-open-connections-to-optimystic`
 *   here, carrying the open-connection finding to it.
 * - **One cadre deadline still typed as milliseconds.** The relay's reservation-admission
 *   deadline bounds an exchange over the same link but does not derive from it:
 *   `relay-admission-reserve-deadline-derived-from-the-link`.
 * - **A machine that declares a faster link than its peers.** Every machine is the listener
 *   for the others, so its `inboundUpgradeTimeout` — derived from ITS declaration — bounds
 *   connections other machines open to it. A peer declaring 3 500 ms dialing a machine that
 *   declared 500 ms gets exactly the silent failure above. Strand formation has the same
 *   shape: the joiner derives how long it waits for the host's reply from ITS declaration and
 *   the host derives its provisioning budget from its own, so a joiner declaring a faster
 *   link than the host gives up on a reply the host is still entitled to send. Declare the
 *   same link on every machine of a party.
 */

import type { Libp2pConnectionTimeouts } from '@optimystic/db-p2p';

/**
 * The link round trip cadre assumes when a host declares none, in milliseconds. A deployment
 * that knows its own link states it with `NetworkConfig.linkRoundTripMs` instead.
 *
 * **Why 3 500.** Sereus supports two machines that reach each other only through a relay up to
 * a **3-second link round trip** (1 500 ms each way — a congested mobile or satellite link;
 * `docs/architecture.md` → "Relay Integration"). The worst relayed dial measured at that link
 * was 12 094 ms, above the 12 000 ms a declaration of exactly 3 000 would derive, so the
 * declaration rounds the supported link up to the next half second. 3 500 derives 14 000 ms
 * of link time and leaves about 1.9 s over that dial: room for a phone's Noise handshake,
 * which the loopback measurement on a desktop does not contain. The listener's admission
 * decision is not in that 1.9 s; it has its own allowance on top (the module doc's "The
 * listener's admission decision"). (The previous 2 000 followed the same convention for the
 * 1.8 s band sereus supported before, with about 720 ms to spare.)
 *
 * One budget outside this module does NOT move with it: `DEFAULT_STRAND_FIRST_SYNC_TIMEOUT_MS`
 * (`strand-first-sync-gate.ts`) bounds a whole first sync, which has no round-trip count, so it
 * is sized from a measurement instead and re-measured when this declaration or the cohort read
 * deadline moves. The per-peer cohort read deadline itself does move with it
 * ({@link cohortReadDeadlineMs}).
 *
 * What 3 500 costs, against 2 000: a peer that is genuinely gone holds each operation longer
 * before it is abandoned and retried — the link part of a relayed dial or a reservation drive
 * 14 s instead of 8 s, and of a control-cohort dial of one peer across all its addresses 56 s
 * instead of 32 s. The admission allowance adds to both (see {@link relayedDialBudgetMs}).
 * Raise it further for a link slower still; lower it only on a deployment where EVERY machine
 * of the party is that close, for the reason the "What still fails" list gives.
 */
export const DECLARED_LINK_ROUND_TRIP_MS = 3500;

/**
 * Link round trips one relayed connection setup costs: transport, encryption and multiplexer
 * handshakes to the relay, the circuit open, then both handshakes again end to end through it.
 * Measured at 8 one-way delays, which is 4 link round trips.
 */
export const RELAYED_DIAL_ROUND_TRIPS = 4;

/**
 * Link round trips one whole reservation drive is budgeted for
 * (`relay-reservation.ts`'s `driveRelayReservation`, whose ONE deadline covers the dial, the
 * reservation request and the wait together).
 *
 * The protocol work measured is 2 — dial the relay (1) plus request the reservation (1). It is
 * budgeted at 4, the relayed-dial count, because the wait afterwards may instead be satisfied
 * by libp2p's own relay discovery, which repeats both legs after identify has run; 4 is
 * therefore the largest thing this one deadline can be asked to contain, and the poll interval
 * (`DEFAULT_RELAY_RESERVE_POLL_MS`) rounds up on top of it.
 */
export const RELAY_RESERVATION_ROUND_TRIPS = 4;

/**
 * Link round trips negotiating one protocol over an ALREADY-OPEN connection costs: the
 * multistream-select exchange that `dialProtocol` / `newStream` runs before the stream is
 * handed back. Measured at 2 one-way delays.
 */
export const PROTOCOL_NEGOTIATION_ROUND_TRIPS = 1;

/**
 * Link round trips one request-and-answer over an ALREADY-OPEN circuit costs: the protocol
 * negotiation ({@link PROTOCOL_NEGOTIATION_ROUND_TRIPS}) plus the request and its response (1).
 * It does not include a dial — a caller that may have to open the connection budgets
 * {@link RELAYED_DIAL_ROUND_TRIPS} separately, which is exactly what the two-field shape of
 * Optimystic's `dialTimeoutMs` / `responseTimeoutMs` pair is for.
 */
export const CIRCUIT_REQUEST_ROUND_TRIPS = PROTOCOL_NEGOTIATION_ROUND_TRIPS + 1;

/**
 * Link round trips one Optimystic commit is budgeted for, over connections that are ALREADY
 * open. **Measured, not counted**: a commit is many sequential exchanges whose exact number
 * the transactor decides, so this is a whole-operation figure and it depends on the Optimystic
 * version.
 *
 * Measured 2026-09-23 at optimystic `9e5c1e85` with
 * `packages/integration-tests/src/scenarios/relay-round-trip-measure.integration.ts`,
 * `delayed` configuration (`RELAY_RRT_MEASURE=1 RELAY_RRT_CONFIG=delayed`: a 150 ms one-way
 * delay on one party's link, so a 300 ms link round trip): one strand insert took 3.8–6.1 s
 * (the founder 4.46, 4.43, 3.84 s; the joiner 5.11, 5.09, 6.09 s), which is up to 20.3 link
 * round trips, including about 0.1–0.2 s of local work (the same inserts on an undelayed
 * loopback took 57–165 ms). A static count of the write path agrees on the order: three repo
 * messages through three consensus rounds each, nine sequential requests of a negotiation plus
 * a request, so 18.
 *
 * It measures a strand insert; a control-database insert runs the same network transactor
 * against the responder's own party's machines, which the module doc already says must
 * declare the same link. Re-measure with that scenario, rather than recompute, whenever
 * `@optimystic/*` is bumped.
 */
export const COMMIT_ROUND_TRIPS = 20;

/**
 * Link round trips one request-and-answer costs when the connection may first have to be OPENED,
 * possibly through a relay: {@link RELAYED_DIAL_ROUND_TRIPS} + {@link CIRCUIT_REQUEST_ROUND_TRIPS}.
 * The shape of cadre's own one-frame control protocols (strand wake, strand address, seed
 * delivery), each of which bounds the dial and the exchange with ONE deadline. Link time only:
 * {@link relayedRequestBudgetMs} adds the listener's admission allowance on top.
 */
export const RELAYED_REQUEST_ROUND_TRIPS = RELAYED_DIAL_ROUND_TRIPS + CIRCUIT_REQUEST_ROUND_TRIPS;

/**
 * What a block-transfer push message's BYTES get to cross, on top of the latency
 * {@link CIRCUIT_REQUEST_ROUND_TRIPS} covers, in milliseconds.
 *
 * This part is bandwidth, not latency, so it does not scale with the declared round trip: a
 * chunk is capped at `PeerJoinBackfillConfig.maxChunkBytes` (1 MiB by default) and crossing it
 * costs whatever the link's throughput costs.
 *
 * NOTE: 6 000 ms is not a measurement of any throughput — it is the residue of the 10 000 ms
 * this deadline shipped as before it was split into a latency part and a transfer part, chosen
 * so that at the declaration then in force (2 000 ms) the derived value stayed 10 000 and no
 * fast link got slower. Nobody has measured how long 1 MiB takes to cross a relayed mobile
 * link. If pushes ever time out with the transfer only part done, measure that and raise THIS,
 * not the declared round trip.
 */
export const PUSH_TRANSFER_ALLOWANCE_MS = 6000;

/**
 * Deadline for one admission decision, after which the fail-open outcome is
 * used (connection admitted / reservation admitted). Both inbound gaters use
 * it: the control node's membership gate (`membership-connection-gater.ts`),
 * and the closed-strand revoked-peer gate (`strand-revocation-enforcer.ts`).
 * It lives here, not beside the gaters, because the dial budgets below add it
 * and this module imports nothing of cadre-core's own: importing the gater
 * would close the cycle link-budget → membership-connection-gater →
 * seed-bootstrap → link-budget.
 *
 * libp2p awaits `denyInboundEncryptedConnection` inside the inbound upgrade
 * WITHOUT racing its inbound-upgrade timeout signal (unlike the pre-encryption
 * `denyInboundConnection` hook), so a decision that never settles wedges that
 * upgrade forever — the connection-manager's inbound-upgrade slot is taken by
 * `acceptIncomingConnection` and released in the `finally` that never runs. The
 * real policy reads the control DB (`listAuthorizedMembers`), which can pull
 * over the network, so "never settles" is reachable. Bounding it keeps the
 * fail-open contract honest: a slow decision admits rather than silently
 * failing closed (or not at all).
 *
 * The control gate's decision waits on the link, through two live control reads
 * (`Revocation`, then `CadrePeer`) that can consult the cohort, yet this deadline
 * cuts it off on purpose and must not grow with the link:
 *
 * - **Fail-open is the designed outcome.** An expired decision admits a
 *   connection and nothing more: the per-protocol stream gates still refuse
 *   every members-only protocol from the materialized snapshot, and unplaced
 *   relay reservations stay capped (`MAX_UNAUTHORIZED_RELAY_RESERVATIONS`).
 * - **The slow case is bring-up, not steady state.** A membership read consults
 *   the cohort only for a block this node does not hold, or before the
 *   `Revocation` ledger marker exists; once the marker exists every block the
 *   decision reads is held (`control-founding-consult-budget.spec.ts` pins both
 *   states). So the gate always fails open only on a node whose membership reads
 *   still consult: one consult costs about two link round trips, and asking a
 *   silent peer costs the per-peer read deadline ({@link cohortReadDeadlineMs}, 7 s
 *   at the default declaration).
 * - **The decision is spent on the dialing machine's clock.** libp2p's listener
 *   runs this gate before it answers the multiplexer negotiation the dialer is
 *   waiting on (`libp2p/dist/src/upgrader.js`), and the listener's own
 *   `inboundUpgradeTimeout` is already running while it does. So
 *   {@link relayedDialBudgetMs}, and every budget built on it, adds this
 *   deadline once per decision the called machine may make, and the two libp2p
 *   limits ({@link connectionManagerTimeouts}) contain it by construction.
 *   Raising it therefore lengthens every dial budget with it: a slow decision
 *   still fits, and a dial to a peer that is gone takes that much longer to
 *   give up.
 *
 * `CONTROL_READ_RETRY_BUDGET_MS` must stay below this, which
 * `control-read-retry.spec.ts` pins.
 */
// eslint-disable-next-line no-restricted-syntax -- cuts off by design: an expired decision admits a connection only, and the dial budgets add it as a flat allowance; see docs/cadre-consistency.md → "Deadlines Over Optimystic's Reads and Commits"
export const ADMISSION_DECISION_TIMEOUT_MS = 2_000;

/**
 * Resolve a host's declared link round trip, falling back to
 * {@link DECLARED_LINK_ROUND_TRIP_MS}.
 *
 * Validated here rather than downstream because nothing downstream would: every consumer
 * multiplies this value into a `setTimeout` deadline, where a zero silently turns a budget into
 * "give up immediately" and a `NaN` turns it into "never time out".
 *
 * Both node bring-up paths call this EAGERLY — `CadreNode.start()`, and
 * `StrandInstanceManager.buildStrandRuntime` behind `addStrand`/`resumeStrand` — so a bad
 * declaration fails the same start that Optimystic's own check on `cohortQueryTimeoutMs` fails.
 * The eager call is what makes that true: every budget derived here is behind a condition (a
 * node with no control storage builds no catch-up, a node with no relay addrs drives no
 * reservation), so waiting for a first consumer would let a broken declaration boot and then
 * throw inside a best-effort path that logs and carries on.
 */
export function resolveLinkRoundTripMs(linkRoundTripMs?: number): number {
	if (linkRoundTripMs === undefined) {
		return DECLARED_LINK_ROUND_TRIP_MS;
	}
	if (!Number.isFinite(linkRoundTripMs) || linkRoundTripMs <= 0) {
		throw new Error(
			`network.linkRoundTripMs must be a finite number of milliseconds above zero, not ${String(linkRoundTripMs)}`
		);
	}
	return linkRoundTripMs;
}

/**
 * Deadline for OPENING a connection to another machine that may only be reachable through a
 * relay: {@link RELAYED_DIAL_ROUND_TRIPS} at the declared link round trip, plus one
 * {@link ADMISSION_DECISION_TIMEOUT_MS} for the called machine's inbound gate, which runs on
 * this dial's clock. 4 x 3 500 + 2 000 = 16 000 ms at the default declaration.
 *
 * What the allowance costs: a peer that is truly gone holds each dial 2 s longer before it is
 * abandoned — a per-address dial 16 s instead of 14 s, a control-cohort dial of one peer across
 * its 4 addresses 64 s instead of 56 s, and a wake call's two attempts 46 s instead of 42 s. A
 * machine that runs no gate (the dedicated relay container, an open-strand node) gets the same
 * budget; the extra 2 s only lengthens a failure there, never a success.
 *
 * A per-field override of a deadline derived from this one
 * (`network.controlCohort.perAddressDialTimeoutMs`, `strandBackfill.dialTimeoutMs`,
 * `DialWakeOptions.timeoutMs`, …) replaces the whole derived value, allowance included.
 */
export function relayedDialBudgetMs(linkRoundTripMs?: number): number {
	return RELAYED_DIAL_ROUND_TRIPS * resolveLinkRoundTripMs(linkRoundTripMs) + ADMISSION_DECISION_TIMEOUT_MS;
}

/**
 * Deadline for what `dialProtocol` does end to end: OPEN a possibly relayed connection
 * ({@link relayedDialBudgetMs}, admission allowance included) and then NEGOTIATE one protocol
 * on it ({@link PROTOCOL_NEGOTIATION_ROUND_TRIPS} at the declared link round trip). 16 000 +
 * 3 500 = 19 500 ms at the default declaration. The strand formation dial is bounded by this;
 * the one-frame control exchanges bound the negotiation together with their request instead
 * ({@link relayedRequestBudgetMs}).
 */
export function relayedStreamOpenBudgetMs(linkRoundTripMs?: number): number {
	return relayedDialBudgetMs(linkRoundTripMs) + PROTOCOL_NEGOTIATION_ROUND_TRIPS * resolveLinkRoundTripMs(linkRoundTripMs);
}

/**
 * Deadline for one Optimystic commit over connections that are already open:
 * {@link COMMIT_ROUND_TRIPS} at the declared link round trip, 70 000 ms at the default
 * declaration. No admission allowance: a commit dials nothing, so no called machine decides
 * on its clock.
 */
export function commitBudgetMs(linkRoundTripMs?: number): number {
	return COMMIT_ROUND_TRIPS * resolveLinkRoundTripMs(linkRoundTripMs);
}

/**
 * libp2p's two connection-manager limits for a node at the declared link, handed to
 * `@optimystic/db-p2p`'s `NodeOptions.connectionManager` on the control node and every strand
 * node.
 *
 * Both bound the same thing — opening a relayed connection, measured at 8 one-way link delays,
 * which is {@link RELAYED_DIAL_ROUND_TRIPS} (4) link round trips, and the listener's admission
 * decision inside it — so both are {@link relayedDialBudgetMs}: 4 x 3 500 + 2 000 = 16 000 ms
 * at the default declaration, covering the 12 094 ms measured at the supported 3-second link
 * plus a decision that takes its whole {@link ADMISSION_DECISION_TIMEOUT_MS}.
 *
 * The listener's limit is deliberately NOT smaller than the dialer's. The listener's clock
 * starts only when the relay hands it the circuit, a few one-way delays after the dialer's
 * started, and both sides finish the handshakes at about the same moment; so with equal limits
 * the listener never discards a connection that the dialer's own dial would still accept. A
 * listener limit below the dialer's is what produced the silent failure in the module doc.
 *
 * The cost of a longer `inboundUpgradeTimeout` is that a peer which opens a connection and then
 * stalls its handshake holds that half-built connection 16 s instead of 10 s.
 *
 * NOTE: derived from the declaration alone, so a per-field override that raises a cadre dial
 * budget above it (`controlCohort.perAddressDialTimeoutMs`, `strandBackfill.dialTimeoutMs`)
 * does not raise these; a dial that outlasts the listener's limit gets the silent failure
 * again. If such overrides start being used for slow links, raise the declaration instead or
 * take the largest configured dial budget here.
 */
export function connectionManagerTimeouts(linkRoundTripMs?: number): Libp2pConnectionTimeouts {
	const budgetMs = relayedDialBudgetMs(linkRoundTripMs);
	return { dialTimeout: budgetMs, inboundUpgradeTimeout: budgetMs };
}

/**
 * Deadline for one whole relay reservation drive: {@link RELAY_RESERVATION_ROUND_TRIPS} at the
 * declared link round trip, plus two {@link ADMISSION_DECISION_TIMEOUT_MS}.
 * 4 x 3 500 + 2 x 2 000 = 18 000 ms at the default declaration.
 *
 * Two, because a party-run relay is a control node and decides twice on the drive's clock:
 * once for the connection (`denyInboundEncryptedConnection`), then again for the reservation
 * (`denyInboundRelayReservation`), each under the same deadline. The count's slack of 2 round
 * trips over the measured protocol work happens to cover both at the default declaration, but
 * not at a declared round trip under 2 000 ms; counting them makes the budget hold at every
 * declaration.
 */
export function relayReservationBudgetMs(linkRoundTripMs?: number): number {
	return RELAY_RESERVATION_ROUND_TRIPS * resolveLinkRoundTripMs(linkRoundTripMs) + 2 * ADMISSION_DECISION_TIMEOUT_MS;
}

/**
 * Deadline for one request and its answer over a circuit that is already open —
 * {@link CIRCUIT_REQUEST_ROUND_TRIPS} at the declared link round trip, plus `transferAllowanceMs`
 * for the payload's own bytes.
 */
export function circuitRequestBudgetMs(
	linkRoundTripMs?: number,
	transferAllowanceMs = PUSH_TRANSFER_ALLOWANCE_MS
): number {
	return CIRCUIT_REQUEST_ROUND_TRIPS * resolveLinkRoundTripMs(linkRoundTripMs) + transferAllowanceMs;
}

/**
 * Deadline for opening a (possibly relayed) connection and completing one small request on it:
 * {@link relayedDialBudgetMs}, admission allowance included, plus
 * {@link CIRCUIT_REQUEST_ROUND_TRIPS} at the declared link round trip — so
 * {@link RELAYED_REQUEST_ROUND_TRIPS} of link time in all. 16 000 + 2 x 3 500 = 23 000 ms at the
 * default declaration.
 *
 * No transfer allowance, unlike {@link circuitRequestBudgetMs}: the requests this bounds are a few
 * hundred bytes to a few KB, so their bytes cost nothing a round trip does not already cover.
 */
export function relayedRequestBudgetMs(linkRoundTripMs?: number): number {
	return relayedDialBudgetMs(linkRoundTripMs) + CIRCUIT_REQUEST_ROUND_TRIPS * resolveLinkRoundTripMs(linkRoundTripMs);
}

/**
 * How long ONE cohort peer gets to answer ONE read-path request — Optimystic's
 * `clusterPolicy.cohortQueryTimeoutMs`, which bounds the latest-revision query a read runs when
 * its local copy may be stale and the archive fetch that follows it.
 *
 * {@link CIRCUIT_REQUEST_ROUND_TRIPS} at the declared link round trip: 2 x 3 500 = 7 000 ms at
 * the default declaration. A read-path request opens a fresh protocol stream over a connection
 * that is already open (`@optimystic/db-p2p`'s `openProtocolStream`), so it costs the protocol
 * negotiation plus the request and its answer, and no dial. No admission allowance either: the
 * called machine decided that when the connection was opened. This deadline governs only what
 * Optimystic's own fixed 3 000 ms dial deadline lets through: a request that must first dial,
 * and at the supported link the stream negotiation itself, is cut off by that one first (the
 * module doc's "What still fails").
 *
 * Optimystic derives its whole-reconcile-pass bound from this value, `max(5 000, 5 x per-peer)`
 * (`db-p2p/src/cluster/cluster-policy.ts`): 35 000 ms at the default declaration.
 *
 * What it costs, against the 5 000 ms that preceded it: a peer that is truly gone holds a read
 * of a block missing locally 7 s instead of 5 s before the read is declined and retried, and a
 * joining machine's first sync runs several such consults. That is why
 * `DEFAULT_STRAND_FIRST_SYNC_TIMEOUT_MS` is re-measured whenever this moves; the bands are on
 * that constant.
 *
 * The plugin declares the same number as `COHORT_READ_DEADLINE_MS` (it cannot import this
 * module), and `link-budget.spec.ts` pins the two equal.
 */
export function cohortReadDeadlineMs(linkRoundTripMs?: number): number {
	return CIRCUIT_REQUEST_ROUND_TRIPS * resolveLinkRoundTripMs(linkRoundTripMs);
}

/** The two `NetworkConfig` fields the per-peer cohort read deadline is settled from. */
export interface DeclaredReadDeadline {
	/** The host's own per-peer read deadline, which wins over the link derivation. */
	cohortQueryTimeoutMs?: number;
	/** The host's declared link round trip, from which the deadline is derived when no explicit one is set. */
	linkRoundTripMs?: number;
}

/**
 * The per-peer cohort read deadline to declare onto a network's cluster policy, or `undefined`
 * for "declare nothing and take the plugin's frozen policy whole". One helper for both policy
 * construction sites (`CadreNode`'s control policy and `StrandInstanceManager`'s strand policy),
 * because the two networks ride one link and must get the same value.
 *
 * An explicit `cohortQueryTimeoutMs` wins over the derivation, so a host that set the deadline
 * by hand keeps it whatever link it declared. With a declared link and no explicit deadline,
 * the deadline is {@link cohortReadDeadlineMs} at that link. With neither, `undefined`: the
 * plugin's frozen policy already carries `COHORT_READ_DEADLINE_MS`, which equals the derivation
 * at the default declaration, and returning `undefined` lets the builders return that frozen
 * object by identity, which existing specs pin.
 */
export function declaredCohortReadDeadlineMs(network?: DeclaredReadDeadline): number | undefined {
	return network?.cohortQueryTimeoutMs
		?? (network?.linkRoundTripMs === undefined ? undefined : cohortReadDeadlineMs(network.linkRoundTripMs));
}

/** The two deadlines one peer-join catch-up push needs, both derived from the declared link. */
export interface PeerJoinPushBudget {
	/** Opening the connection to the peer being caught up — a relayed dial, in the worst case. */
	dialTimeoutMs: number;
	/** The push request and its answer over that connection, including the chunk's own bytes. */
	responseTimeoutMs: number;
}

/**
 * The dial and response deadlines a peer-join catch-up push needs at a declared link. One
 * helper rather than two call-site expressions, because the two construction sites
 * (`CadreNode`'s control catch-up and `StrandInstanceManager`'s per-strand one) and
 * `DEFAULT_PEER_JOIN_BACKFILL` must not drift apart.
 */
export function peerJoinPushBudget(linkRoundTripMs?: number): PeerJoinPushBudget {
	return {
		dialTimeoutMs: relayedDialBudgetMs(linkRoundTripMs),
		responseTimeoutMs: circuitRequestBudgetMs(linkRoundTripMs)
	};
}
