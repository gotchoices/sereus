/**
 * Which addresses an invitation names: the few that will reach one of the person's cadrons
 * (the machines of their cadre) from anywhere, in the order a joiner should try them.
 *
 * WORKAROUND(sereus: ranked open invitations, curated published records). cadre-core's
 * `createOpenInvitation` names each other machine's first four addresses in the order the
 * machine published them, and a machine publishes every address libp2p reports, loopback,
 * private and plain TCP first. A cadre-host machine on a VPS so ends up named only by
 * addresses no phone can dial, its public WebSocket address cut. This plans the list itself from the
 * machines' full records, and the app puts it in the invitation before encoding it (the list is
 * not signed; the responder checks only the token).
 *
 * Pure: the evidence comes in (`BootstrapInput`), the plan goes out. `/sereus` gathers it.
 */
import { addressKind, ADDRESS_KIND_RANK, reachesAnywhere, type CadronAddressKind } from './address.js';

/** Where an address of a cadron came from, best evidence first. */
export type AddressSource =
	/** A connection this device opened to it, with no relay hop, is open now: it answered. */
	| 'connection'
	/** The cadron's own signed, recently published record. */
	| 'record'
	/** What this device was handed when it claimed the cadron, kept until its record arrives. */
	| 'claim';

export interface CadronCandidate {
	/** The cadron's control peer id: what an invitation's addresses end in (`/p2p/<peerId>`). */
	peerId: string;
	/** It declares itself always on (its signed record); unknown counts as not. */
	alwaysOn: boolean;
	/** When its record was last published (ms), or null when none has reached this device yet. */
	lastPublishedAt: number | null;
	addrs: ReadonlyArray<{ addr: string; source: AddressSource }>;
}

/** How invitations name the person's cadrons. Kept per device for now. */
export interface CadronPreferences {
	/**
	 * Cadrons to name first, in this order (control peer ids).
	 * WORKAROUND(sereus: a party-level bootstrap preference): kept on this device, so each of the
	 * person's devices has its own.
	 */
	preferred: string[];
	/** The person's own names for their cadrons, by peer id, for screens and the readable invitation. */
	names: Record<string, string>;
	/** How many addresses an invitation names in all (1–8). Fewer: a shorter link, a sparser QR. */
	maxAddrs: number;
	/**
	 * This device's own addresses (a phone: its relay addresses): `fallback`, only when no cadron
	 * reaches from anywhere; `always`, in the last slot when one is left; `never`.
	 */
	thisDevice: 'fallback' | 'always' | 'never';
	/** Name private-network addresses too (a joiner on the same network). Off by default. */
	allowPrivate: boolean;
}

export const DEFAULT_CADRON_PREFERENCES: CadronPreferences = {
	preferred: [], names: {}, maxAddrs: 2, thisDevice: 'fallback', allowPrivate: false,
};
export const MAX_BOOTSTRAP_ADDRS = 8;
/**
 * The stored form's version (`format` beside the fields). The app keeps the text opaque; a later
 * format is read and migrated here, and a field this version does not know is dropped.
 */
export const CADRON_PREFERENCES_FORMAT = 1;

/** Preferences as stored, made whole and in range (missing fields defaulted, ids deduplicated). */
export function normalizePreferences(raw: Partial<CadronPreferences> | null | undefined): CadronPreferences {
	const p = { ...DEFAULT_CADRON_PREFERENCES, ...(raw ?? {}) };
	const maxAddrs = Number.isInteger(p.maxAddrs) ? Math.min(MAX_BOOTSTRAP_ADDRS, Math.max(1, p.maxAddrs)) : DEFAULT_CADRON_PREFERENCES.maxAddrs;
	return {
		preferred: [...new Set((Array.isArray(p.preferred) ? p.preferred : []).filter(id => typeof id === 'string' && id))],
		names: typeof p.names === 'object' && p.names ? { ...p.names } : {},
		maxAddrs,
		thisDevice: p.thisDevice === 'always' || p.thisDevice === 'never' ? p.thisDevice : 'fallback',
		allowPrivate: p.allowPrivate === true,
	};
}

export interface BootstrapInput {
	cadrons: readonly CadronCandidate[];
	thisDevice: { peerId: string; addrs: readonly string[] };
	prefs: CadronPreferences;
}

export interface BootstrapEntry {
	addr: string;
	peerId: string;
	/** This device rather than one of its cadrons. */
	thisDevice: boolean;
	kind: CadronAddressKind;
	source: AddressSource | 'this-device';
	preferred: boolean;
	alwaysOn: boolean;
}

export type BootstrapWarning =
	/** No cadron has an address that reaches from anywhere: only this device (if anything) answers. */
	| 'no-cadron-reachable-from-anywhere'
	/** A named cadron's address comes from its claim: its signed record has not reached this device yet. */
	| 'cadron-record-not-yet-published'
	/** Nothing at all reaches from anywhere: the invitation works only on the inviter's own network, if at all. */
	| 'unreachable';

export interface BootstrapPlan {
	entries: BootstrapEntry[];
	warnings: BootstrapWarning[];
}

const SOURCE_RANK: Record<AddressSource, number> = { connection: 0, record: 1, claim: 2 };

/**
 * The plan: preferred cadrons first (in the person's order), then other always-on cadrons, then
 * the rest, each group newest record first; each cadron's addresses best first (reach, then
 * evidence), loopback and undialable ones never; at most `maxAddrs` in all, one address per
 * cadron before any cadron gets a second, so a second cadron backs up the first. This device's
 * addresses go in as `prefs.thisDevice` says.
 */
export function planBootstrap(input: BootstrapInput): BootstrapPlan {
	const { prefs } = input;
	const usable = (kind: CadronAddressKind | null): kind is CadronAddressKind =>
		kind !== null && kind !== 'loopback' && (reachesAnywhere(kind) || (prefs.allowPrivate && kind === 'private'));

	const preferredAt = (peerId: string) => {
		const i = prefs.preferred.indexOf(peerId);
		return i < 0 ? Infinity : i;
	};
	const cadrons = input.cadrons
		.filter(c => c.peerId !== input.thisDevice.peerId)
		.map(c => {
			// One entry per address, its best evidence kept.
			const best = new Map<string, AddressSource>();
			for (const { addr, source } of c.addrs) {
				const had = best.get(addr);
				if (had === undefined || SOURCE_RANK[source] < SOURCE_RANK[had]) best.set(addr, source);
			}
			const addrs = [...best]
				.map(([addr, source]) => ({ addr, source, kind: addressKind(addr) }))
				.filter((a): a is { addr: string; source: AddressSource; kind: CadronAddressKind } => usable(a.kind))
				.sort((a, b) => ADDRESS_KIND_RANK[a.kind] - ADDRESS_KIND_RANK[b.kind] || SOURCE_RANK[a.source] - SOURCE_RANK[b.source]);
			return { ...c, addrs, preferred: preferredAt(c.peerId) !== Infinity };
		})
		.filter(c => c.addrs.length > 0)
		.sort((a, b) => preferredAt(a.peerId) - preferredAt(b.peerId)
			|| Number(b.alwaysOn) - Number(a.alwaysOn)
			|| (b.lastPublishedAt ?? 0) - (a.lastPublishedAt ?? 0));

	const own = input.thisDevice.addrs
		.map(addr => ({ addr, kind: addressKind(addr) }))
		.filter((a): a is { addr: string; kind: CadronAddressKind } => usable(a.kind))
		.sort((a, b) => ADDRESS_KIND_RANK[a.kind] - ADDRESS_KIND_RANK[b.kind]);
	const ownEntry = (a: { addr: string; kind: CadronAddressKind }): BootstrapEntry => ({
		addr: a.addr, peerId: input.thisDevice.peerId, thisDevice: true, kind: a.kind, source: 'this-device', preferred: false, alwaysOn: false,
	});

	const anywhereCadron = cadrons.some(c => c.addrs.some(a => reachesAnywhere(a.kind)));
	const wantOwn = prefs.thisDevice === 'always' || (prefs.thisDevice === 'fallback' && !anywhereCadron);
	const cadronSlots = wantOwn && own.length > 0 && cadrons.length > 0 ? Math.max(1, prefs.maxAddrs - 1) : prefs.maxAddrs;

	// Round robin: each cadron's best address, then each one's second, until the slots are filled.
	const entries: BootstrapEntry[] = [];
	for (let round = 0; entries.length < cadronSlots; round++) {
		let added = false;
		for (const c of cadrons) {
			const a = c.addrs[round];
			if (!a || entries.length >= cadronSlots) continue;
			entries.push({ addr: a.addr, peerId: c.peerId, thisDevice: false, kind: a.kind, source: a.source, preferred: c.preferred, alwaysOn: c.alwaysOn });
			added = true;
		}
		if (!added) break;
	}
	if (wantOwn) for (const a of own) { if (entries.length >= prefs.maxAddrs) break; entries.push(ownEntry(a)); }

	const warnings: BootstrapWarning[] = [];
	if (!anywhereCadron) warnings.push('no-cadron-reachable-from-anywhere');
	if (entries.some(e => e.source === 'claim')) warnings.push('cadron-record-not-yet-published');
	if (!entries.some(e => reachesAnywhere(e.kind))) warnings.push('unreachable');
	return { entries, warnings };
}
