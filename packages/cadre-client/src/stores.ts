/**
 * The stores a cadre screen binds to. Each reads through a view (`CadreView`,
 * `ReachabilityView`), so it works over the Sereus client, an app's mock, or an app's
 * whole model when that has the same two members.
 */
import type { CadreStatus, CadreView, InvitationReadiness, InvitationsView, Reachability, ReachabilityView } from './model.js';
import { writable, type Readable } from './store.js';
import { cadreOk } from './result.js';
import { loader, type Loader } from './loader.js';

/** How often a store re-reads with nothing announcing a change, while subscribed. */
export interface StoreOptions {
	/** Milliseconds; 0 turns the poll off. Default 30 s. */
	pollMs?: number;
}

/**
 * The cadre: this device, its cadrons, and whether it is an enrolled owner. Re-read on every
 * change that has an event: this node starting or stopping, a cadron connecting or dropping, the
 * cadron preferences. The poll catches what has none: a cadron added or removed on another
 * device (it arrives by control replication), and a cadron's `lastSeenAt` ageing, so its
 * presence turns from recent to quiet. A store kept subscribed app-wide (a status badge) can poll
 * less often, or not at all if those can wait for the next screen.
 */
export function cadreStore(view: CadreView, opts: StoreOptions = {}): Loader<CadreStatus> {
	return loader({
		load: () => view.cadre.status(),
		changes: onChange => view.changes.cadre(onChange),
		pollMs: opts.pollMs ?? 30_000,
	});
}

/**
 * Reachability: can anybody answer an invitation from this device, which relays it is
 * configured with, and whether the relay reservation holds — read live, because a
 * configured relay is not a working one and a reservation can be lost after it was
 * granted. Re-read when this device's addresses change; a slow backstop poll covers a
 * change no event announces (a machine of the party's coming up or going quiet).
 */
export function reachabilityStore(view: ReachabilityView, opts: StoreOptions = {}): Loader<Reachability> {
	return loader({
		load: async () => cadreOk(await view.reachability.get()),
		changes: onChange => view.changes.reachability(onChange),
		debounceMs: 250,
		pollMs: opts.pollMs ?? 30_000,
	});
}

/**
 * Whether a new invitation to `strandId` is ready to hand out (`InvitationReadiness`), live: it
 * turns `ready` when a cadron comes to hold the strand.
 */
export function invitationReadinessStore(view: InvitationsView, strandId: string, opts: { newStrand?: boolean } = {}): Readable<InvitationReadiness> {
	const read = () => view.invitations.readiness(strandId, opts);
	return writable<InvitationReadiness>(read(), set => {
		set(read());
		return view.changes.invitations(() => set(read()));
	});
}
