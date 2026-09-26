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
 * ── The instrument ──
 *
 * Every count and every number below comes from
 * `packages/integration-tests/src/scenarios/relayed-dial-cost-by-latency.integration.ts`, which
 * is committed and opt-in (`RELAY_DIAL_COST=1`). **Its doc comment is the single home of the
 * measurement**; this module holds only what the derivation needs. Re-run it before changing
 * anything here.
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
 * | open a relayed connection to another machine          | 4                | 8 000 ms                |
 * | dial the relay itself                                 | 1                | 2 000 ms                |
 * | request a reservation on an open relay connection     | 1                | 2 000 ms                |
 * | negotiate a protocol over an established circuit      | 1                | 2 000 ms                |
 *
 * **Measured** 2026-09-26, one Windows machine, loopback dedicated relay, re-run for this
 * change: a relayed dial took 20-25 ms at no delay, **7 255-7 279 ms at 900 ms one-way**, and
 * **12 066-12 094 ms at 1 500 ms one-way**. Four link round trips of pure delay would be 7 200
 * and 12 000, so the real cost sits about 60-95 ms ABOVE the arithmetic — the handshakes and a
 * phone's pure-JS crypto, which no delay figure contains. That residue is small but it is why
 * {@link DECLARED_LINK_ROUND_TRIP_MS} carries headroom over the band sereus supports rather
 * than matching it exactly: a declaration equal to the measured round trip would derive a
 * budget marginally BELOW the dial it has to contain.
 *
 * ── The ceiling this does NOT lift ──
 *
 * Above roughly 1 250 ms one-way — a 2.5-second link round trip — no relayed connection can be
 * established by this stack whatever cadre declares here. Two budgets of 10 000 ms each inside
 * libp2p bound the same dial and cannot be reached from sereus at all:
 * `connectionManager.dialTimeout` (libp2p's own default, which `@optimystic/db-p2p`'s
 * `libp2p-node-base.ts` neither sets nor exposes) and `connectionManager.inboundUpgradeTimeout`
 * (which it sets to 10 000). Both appear in the same re-run: at 1 500 ms one-way the dial under
 * libp2p's default failed with `The operation was aborted due to timeout`, and with the shipped
 * inbound-upgrade budget the DIALER's own 12 094 ms dial resolved while the LISTENER had
 * already thrown the half-built connection away — so the first stream over it died with
 * `Unexpected EOF - stream closed while reading 0/1 bytes` and the listener reported no peer at
 * all. That is why a too-slow link produces silence rather than an error.
 *
 * Two consequences for a reader choosing a declaration. Below that ceiling, the DEFAULT
 * declaration of 2 000 ms does not reach it: four round trips of 2 000 ms is 8 000 ms, which
 * covers a one-way delay up to 1 000 ms, so a deployment somewhere between 1 000 and 1 250 ms
 * one-way has to declare its own (about 2 200-2 500) to use the band libp2p still allows. And
 * declaring much ABOVE 2 500 buys nothing: the budgets here grow, and
 * the connection still fails inside libp2p. Lifting that needs an upstream change and a
 * decision about how slow a link sereus intends to carry —
 * `tickets/blocked/how-slow-a-relayed-link-does-sereus-carry`. A reader who raised these
 * numbers and still cannot connect at 1 500 ms one-way has met that ceiling, not this module.
 */

/**
 * The link round trip cadre assumes when a host declares none, in milliseconds. A deployment
 * that knows its own link states it with `NetworkConfig.linkRoundTripMs` instead.
 *
 * **Why 2 000.** It states the slowest link sereus already claims to support, and two other
 * budgets fix that claim independently: `COHORT_READ_DEADLINE_MS`
 * (`quereus-plugin-sereus/src/cluster-size.ts`, 5 000 ms) and
 * `DEFAULT_STRAND_FIRST_SYNC_TIMEOUT_MS` (`strand-first-sync-gate.ts`, 120 000 ms) were both
 * sized against two parties reaching each other only through a public relay at a round trip
 * near 1.8 s. Declaring 2 000 rounds that band up and leaves about 720 ms over the worst
 * relayed dial measured at it (7 279 ms against a derived 8 000 ms).
 *
 * Raising it is how a deployment that KNOWS its link is slower moves every derived budget at
 * once. The cost is the ordinary cost of a longer deadline: a peer that is genuinely gone holds
 * the operation for that much longer before it is abandoned and retried. Above about 2 500 it
 * buys nothing — see the module doc's ceiling paragraph.
 */
export const DECLARED_LINK_ROUND_TRIP_MS = 2000;

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
 * Link round trips one request-and-answer over an ALREADY-OPEN circuit costs: the protocol
 * negotiation (1, measured at 2 one-way delays) plus the request and its response (1). It does
 * not include a dial — a caller that may have to open the connection budgets
 * {@link RELAYED_DIAL_ROUND_TRIPS} separately, which is exactly what the two-field shape of
 * Optimystic's `dialTimeoutMs` / `responseTimeoutMs` pair is for.
 */
export const CIRCUIT_REQUEST_ROUND_TRIPS = 2;

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
 * so that at the default declaration the derived value is the same 10 000 and no fast link got
 * slower. Nobody has measured how long 1 MiB takes to cross a relayed mobile link. If pushes
 * ever time out with the transfer only part done, measure that and raise THIS, not the declared
 * round trip.
 */
export const PUSH_TRANSFER_ALLOWANCE_MS = 6000;

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
 * relay: {@link RELAYED_DIAL_ROUND_TRIPS} at the declared link round trip.
 */
export function relayedDialBudgetMs(linkRoundTripMs?: number): number {
	return RELAYED_DIAL_ROUND_TRIPS * resolveLinkRoundTripMs(linkRoundTripMs);
}

/**
 * Deadline for one whole relay reservation drive: {@link RELAY_RESERVATION_ROUND_TRIPS} at the
 * declared link round trip.
 */
export function relayReservationBudgetMs(linkRoundTripMs?: number): number {
	return RELAY_RESERVATION_ROUND_TRIPS * resolveLinkRoundTripMs(linkRoundTripMs);
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
