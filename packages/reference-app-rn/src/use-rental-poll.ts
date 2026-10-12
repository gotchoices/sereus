/**
 * use-rental-poll.ts — the rows of Settings → "Rent an always-on node"
 * (`provider-store-section.tsx`), re-read from the provider every few seconds: `getContainer`
 * per rental, `getBillingStatus` once, and the cadre's machine list while any rental names a
 * peer id, for whether a stopped node is still a member. Settings stays mounted behind the Chat
 * tab and Android keeps the app's timers running in the background, so the poll runs only while
 * the Settings tab is in front and the app is in the foreground, as the relay posture poll in
 * `use-cadre.ts` does. One read runs at a time, and a token the provider refuses marks every row
 * signed out without opening the browser.
 */

import { useCallback, useEffect, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import type { BillingStatus, CadreMachine, ProviderClient } from '@serfab/cadre-core';
import type { Rental } from '@serfab/cadre-rn/provider';
import { useCadre } from './cadre-context';
import type { ProviderSession } from './provider-session';
import { readingFromError, type ContainerReading } from './rentals';

/** How often the rows are re-read from the provider while the poll is active. */
export const RENTAL_POLL_MS = 5_000;

export interface RentalPoll {
	/** This party's rental records, oldest first, as of the last read. */
	rentals: Rental[];
	/** The provider's answer per container id; a rental not read yet is absent. */
	readings: ReadonlyMap<string, ContainerReading>;
	/** The subscription, kept from the last read that answered. */
	billing: BillingStatus | undefined;
	/** The cadre's machines, as of the last read made while a rental named a peer id. */
	machines: CadreMachine[];
	/** Whether the session holds a pair, as of the last read or the last `tick`. */
	signedIn: boolean;
}

/**
 * The rows for `session`, null before the provider is read. The section bumps `tick` after each
 * action so the rows are re-read at once rather than at the next interval, and the sign-in
 * state with them even while the poll is paused.
 */
export function useRentalPoll(session: ProviderSession | null, tick: number): RentalPoll {
	const cadre = useCadre();
	const focused = useScreenFocused();
	const active = focused && cadre.runnerState === 'foreground';
	const [signedIn, setSignedIn] = useState(false);
	const [rentals, setRentals] = useState<Rental[]>([]);
	const [readings, setReadings] = useState<ReadonlyMap<string, ContainerReading>>(new Map());
	const [billing, setBilling] = useState<BillingStatus | undefined>(undefined);
	const [machines, setMachines] = useState<CadreMachine[]>([]);

	useEffect(() => {
		if (!session) return;
		setSignedIn(session.signedIn());
		if (!active) return;
		let stopped = false;
		// One read at a time: a slow provider must not pile polls up.
		let inFlight = false;
		const poll = async () => {
			if (inFlight) return;
			inFlight = true;
			try {
				const list = await cadre.listRentals();
				if (stopped) return;
				setRentals(list);
				const client = session.client();
				setSignedIn(client !== null);
				if (!client) {
					setReadings(signedOutReadings(list));
					return;
				}
				const next = await readContainers(session, client, list, cadre.noteRentalPeer);
				if (stopped) return;
				if (next === 'signed-out') {
					setSignedIn(false);
					setReadings(signedOutReadings(list));
					return;
				}
				setReadings(next);
				const status = await quietly('the subscription\'s standing', () => client.getBillingStatus());
				if (!stopped && status !== null) setBilling(status);
				// NOTE: re-reads the whole machine list every poll while any rental names a peer id. A
				// local read, cheap for a cadre of a few machines; if it ever shows in profiles, read it
				// only when a row is stopped or gone.
				if (!list.some((rental) => rental.peerId)) return;
				const listed = await quietly('this cadre\'s machines', () => cadre.listMachines());
				if (!stopped && listed !== null) setMachines(listed);
			} catch (err) {
				console.warn('[settings] could not read this phone\'s rentals:', err);
			} finally {
				inFlight = false;
			}
		};
		void poll();
		const timer = setInterval(() => void poll(), RENTAL_POLL_MS);
		return () => {
			stopped = true;
			clearInterval(timer);
		};
	}, [session, cadre.node, tick, active]);

	return { rentals, readings, billing, machines, signedIn };
}

/**
 * The provider's answer for each rental, noting a peer id the record lacks yet; `'signed-out'`
 * when the provider refused the pair part-way, after which the session holds none.
 */
async function readContainers(
	session: ProviderSession,
	client: ProviderClient,
	list: readonly Rental[],
	noteRentalPeer: (containerId: string, peerId: string) => Promise<void>,
): Promise<ReadonlyMap<string, ContainerReading> | 'signed-out'> {
	const next = new Map<string, ContainerReading>();
	for (const rental of list) {
		try {
			const report = await client.getContainer(rental.containerId);
			next.set(rental.containerId, { kind: 'live', report });
			if (!rental.peerId && report.container.peerId) await noteRentalPeer(rental.containerId, report.container.peerId);
		} catch (err) {
			// A poll never opens the browser: a spent pair leaves the rows saying to sign in.
			if (await session.tokensRefused(err)) return 'signed-out';
			next.set(rental.containerId, readingFromError(err));
		}
	}
	return next;
}

/** Every row reads "Sign in to see its status". */
function signedOutReadings(list: readonly Rental[]): ReadonlyMap<string, ContainerReading> {
	return new Map(list.map((rental) => [rental.containerId, { kind: 'signed-out' } as const]));
}

/** `read()`'s answer, or null, logged, when it fails: one unreadable part must not blank the rows. */
async function quietly<T>(what: string, read: () => Promise<T>): Promise<T | null> {
	try {
		return await read();
	} catch (err) {
		console.warn(`[settings] could not read ${what}:`, err);
		return null;
	}
}

/** Whether the screen this renders in is the one in front; the tab navigator keeps the others mounted. */
function useScreenFocused(): boolean {
	const [focused, setFocused] = useState(false);
	useFocusEffect(useCallback(() => {
		setFocused(true);
		return () => setFocused(false);
	}, []));
	return focused;
}
