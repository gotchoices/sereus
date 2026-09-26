import { describe, it, expect } from 'vitest';
import {
	CIRCUIT_REQUEST_ROUND_TRIPS,
	DECLARED_LINK_ROUND_TRIP_MS,
	PUSH_TRANSFER_ALLOWANCE_MS,
	RELAYED_DIAL_ROUND_TRIPS,
	RELAY_RESERVATION_ROUND_TRIPS,
	circuitRequestBudgetMs,
	relayReservationBudgetMs,
	relayedDialBudgetMs,
	resolveLinkRoundTripMs
} from '../src/link-budget.js';

/**
 * The derivation itself — a measured round-trip count times one declared round trip, and a
 * host's own declaration winning over the default. The COUNTS are not asserted against literal
 * milliseconds here on purpose: the point of the module is that the numbers move together, so a
 * case that re-spelled 8000 would have to be edited by the very change it is supposed to guard.
 *
 * The measurement the counts come from is `relayed-dial-cost-by-latency.integration.ts`
 * (opt-in). Nothing here dials anything.
 */
describe('link budgets', () => {
	it('multiplies each operation\'s round-trip count by the declared link round trip', () => {
		expect(relayedDialBudgetMs()).toBe(RELAYED_DIAL_ROUND_TRIPS * DECLARED_LINK_ROUND_TRIP_MS);
		expect(relayReservationBudgetMs()).toBe(RELAY_RESERVATION_ROUND_TRIPS * DECLARED_LINK_ROUND_TRIP_MS);

		// A host that declares a slower link moves every budget at once, which is the whole
		// reason the declaration exists.
		const declared = 3 * DECLARED_LINK_ROUND_TRIP_MS;
		expect(relayedDialBudgetMs(declared)).toBe(3 * relayedDialBudgetMs());
		expect(relayReservationBudgetMs(declared)).toBe(3 * relayReservationBudgetMs());
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
