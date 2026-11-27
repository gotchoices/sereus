/**
 * The stores a cadre screen binds to. Each reads through a view (`CadreView`,
 * `ReachabilityView`), so it works over the Sereus client, an app's mock, or an app's
 * whole model when that has the same two members.
 */
import type { CadreStatus, CadreView, InvitationReadiness, InvitationsView, Reachability, ReachabilityView } from './model.js';
import { writable, type Readable } from './store.js';
import { cadreOk } from './result.js';
import { loader, type Loader } from './loader.js';

/**
 * The cadre: this device, its other machines, and whether it is an enrolled owner. Re-read
 * when the control network connects or drops; a slow backstop poll catches machines added
 * or removed elsewhere.
 */
export function cadreStore(view: CadreView): Loader<CadreStatus> {
	return loader({
		load: () => view.cadre.status(),
		changes: onChange => view.changes.cadre(onChange),
		pollMs: 30_000,
	});
}

/**
 * Reachability: can anybody answer an invitation from this device, which relays it is
 * configured with, and whether the relay reservation holds — read live, because a
 * configured relay is not a working one and a reservation can be lost after it was
 * granted. Re-read when this device's addresses change; a slow backstop poll covers a
 * change no event announces (a machine of the party's coming up or going quiet).
 */
export function reachabilityStore(view: ReachabilityView): Loader<Reachability> {
	return loader({
		load: async () => cadreOk(await view.reachability.get()),
		changes: onChange => view.changes.reachability(onChange),
		debounceMs: 250,
		pollMs: 30_000,
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
