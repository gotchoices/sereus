import { describe, it, expect } from 'vitest';
import { resolveLinkDeadlines } from '@optimystic/db-p2p';
import { COHORT_READ_DEADLINE_MS } from '@serfab/quereus-plugin-sereus';
import {
	ADMISSION_DECISION_TIMEOUT_MS,
	CIRCUIT_REQUEST_ROUND_TRIPS,
	COMMIT_ROUND_TRIPS,
	DECLARED_LINK_ROUND_TRIP_MS,
	PROTOCOL_NEGOTIATION_ROUND_TRIPS,
	PUSH_TRANSFER_ALLOWANCE_MS,
	RELAYED_DIAL_ROUND_TRIPS,
	RELAYED_REQUEST_ROUND_TRIPS,
	RELAY_RESERVATION_ROUND_TRIPS,
	RELAY_RESERVE_REQUEST_ROUND_TRIPS,
	circuitRequestBudgetMs,
	cohortReadDeadlineMs,
	commitBudgetMs,
	declaredCohortReadDeadlineMs,
	relayAdmissionReserveDeadlineMs,
	relayReservationBudgetMs,
	relayedDialBudgetMs,
	relayedRequestBudgetMs,
	relayedStreamOpenBudgetMs,
	resolveLinkRoundTripMs
} from '../src/link-budget.js';

/**
 * The derivation itself — a measured round-trip count times one declared round trip, plus a flat
 * allowance per admission decision the called machine may make, and a host's own declaration
 * winning over the default. The COUNTS are not asserted against literal
 * milliseconds here on purpose: the point of the module is that the numbers move together, so a
 * case that re-spelled 8000 would have to be edited by the very change it is supposed to guard.
 *
 * The measurement the counts come from is `relayed-dial-cost-by-latency.integration.ts`
 * (opt-in). Nothing here dials anything.
 */
describe('link budgets', () => {
	it('multiplies each operation\'s round-trip count by the declared link round trip, plus its admission decisions', () => {
		expect(relayedDialBudgetMs()).toBe(RELAYED_DIAL_ROUND_TRIPS * DECLARED_LINK_ROUND_TRIP_MS + ADMISSION_DECISION_TIMEOUT_MS);
		expect(relayReservationBudgetMs()).toBe(RELAY_RESERVATION_ROUND_TRIPS * DECLARED_LINK_ROUND_TRIP_MS + 2 * ADMISSION_DECISION_TIMEOUT_MS);
		expect(relayedRequestBudgetMs()).toBe(RELAYED_REQUEST_ROUND_TRIPS * DECLARED_LINK_ROUND_TRIP_MS + ADMISSION_DECISION_TIMEOUT_MS);
		expect(relayedStreamOpenBudgetMs()).toBe((RELAYED_DIAL_ROUND_TRIPS + PROTOCOL_NEGOTIATION_ROUND_TRIPS) * DECLARED_LINK_ROUND_TRIP_MS + ADMISSION_DECISION_TIMEOUT_MS);
		expect(commitBudgetMs()).toBe(COMMIT_ROUND_TRIPS * DECLARED_LINK_ROUND_TRIP_MS);
		expect(relayAdmissionReserveDeadlineMs()).toBe(RELAY_RESERVE_REQUEST_ROUND_TRIPS * DECLARED_LINK_ROUND_TRIP_MS + ADMISSION_DECISION_TIMEOUT_MS);

		// A host that declares a slower link moves the round-trip part of every budget at once,
		// which is the whole reason the declaration exists. The admission allowance is local
		// decision time, so it stays flat.
		const declared = 3 * DECLARED_LINK_ROUND_TRIP_MS;
		const added = declared - DECLARED_LINK_ROUND_TRIP_MS;
		expect(relayedDialBudgetMs(declared) - relayedDialBudgetMs()).toBe(RELAYED_DIAL_ROUND_TRIPS * added);
		expect(relayReservationBudgetMs(declared) - relayReservationBudgetMs()).toBe(RELAY_RESERVATION_ROUND_TRIPS * added);
		expect(relayedRequestBudgetMs(declared) - relayedRequestBudgetMs()).toBe(RELAYED_REQUEST_ROUND_TRIPS * added);
	});

	it('scales only the latency part of a circuit request, leaving the transfer allowance flat', () => {
		// The payload's own bytes cost bandwidth, not round trips, so doubling the declared link
		// must not double the allowance — otherwise a slow-link declaration quietly inflates a
		// transfer budget that has nothing to do with latency.
		const atDefault = circuitRequestBudgetMs();
		const atDouble = circuitRequestBudgetMs(2 * DECLARED_LINK_ROUND_TRIP_MS);

		expect(atDefault).toBe(CIRCUIT_REQUEST_ROUND_TRIPS * DECLARED_LINK_ROUND_TRIP_MS + PUSH_TRANSFER_ALLOWANCE_MS);
		expect(atDouble - atDefault).toBe(CIRCUIT_REQUEST_ROUND_TRIPS * DECLARED_LINK_ROUND_TRIP_MS);
	});

	it('gets a listener limit from Optimystic that outlasts cadre\'s relayed dial at every declared link', () => {
		// cadre states its declared link to Optimystic and no longer sets libp2p's two
		// connection limits itself, so the listener's `inboundUpgradeTimeout` is Optimystic's
		// derivation: five round trips with a 10 000 ms floor, against cadre's four plus a flat
		// admission allowance. A listener limit below the dial budget discards connections the
		// dialer still accepts, silently. The two formulas meet at 2 000 ms, where Optimystic's
		// floor hands over to its multiple, so the declarations straddle it.
		for (const linkRoundTripMs of [1, 500, 1999, 2000, 2001, DECLARED_LINK_ROUND_TRIP_MS, 10_000, 100_000]) {
			expect(resolveLinkDeadlines(linkRoundTripMs).connectionTimeoutMs).toBeGreaterThanOrEqual(relayedDialBudgetMs(linkRoundTripMs));
		}
	});

	it('declares the plugin\'s cohort read deadline equal to the derivation at the default link', () => {
		// The one fact two packages must agree on. The plugin cannot import cadre-core, so it
		// spells the same arithmetic as a number, and nothing else would catch the two drifting
		// apart: a host that declares no link takes the plugin's frozen policy whole, and a host
		// that declares one takes the derivation, so a drift would give two hosts on the same
		// link two different deadlines.
		expect(COHORT_READ_DEADLINE_MS).toBe(cohortReadDeadlineMs());
	});

	it('settles the policy deadline as explicit, else derived from a declared link, else nothing', () => {
		// `undefined` with nothing declared is load-bearing: it is what lets the policy builders
		// return the frozen constant by identity, which the control-node options and plugin
		// specs pin. An explicit deadline wins over the link, so a host that set it by hand is
		// not overridden by declaring its link too.
		expect(declaredCohortReadDeadlineMs(undefined)).toBeUndefined();
		expect(declaredCohortReadDeadlineMs({})).toBeUndefined();
		expect(declaredCohortReadDeadlineMs({ linkRoundTripMs: 1000 })).toBe(cohortReadDeadlineMs(1000));
		expect(declaredCohortReadDeadlineMs({ cohortQueryTimeoutMs: 12_000, linkRoundTripMs: 1000 })).toBe(12_000);
	});

	it('refuses a declaration that is not a finite number above zero', () => {
		// Every consumer multiplies this into a setTimeout deadline, where 0 means "give up at
		// once" and NaN means "never time out" — both silent. So it fails loudly instead.
		for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
			expect(() => resolveLinkRoundTripMs(bad)).toThrow(/linkRoundTripMs/);
		}
		expect(resolveLinkRoundTripMs(undefined)).toBe(DECLARED_LINK_ROUND_TRIP_MS);
		expect(resolveLinkRoundTripMs(1234)).toBe(1234);
	});
});
