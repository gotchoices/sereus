/**
 * Invitations over a running node: which addresses one names (`bootstrap.ts` plans, this
 * gathers the evidence), whether it is ready to hand out, and what it says in words.
 *
 * The evidence for each cadron (each other machine of the party), best first:
 * - `connection`: a connection this device opened to it with no relay hop is open now;
 * - `record`: its signed, recently published record (`resolvePeerAddrs`), every address;
 * - `claim`: what this device was handed when it claimed it (cadre-core's bootstrap peer store),
 *   which is all there is in the minute before the cadron's first record arrives. cadre-core's
 *   own invitation leaves such a cadron out altogether.
 *
 * READINESS. A new strand's copy is on a cadron once a commit of the strand is held elsewhere
 * (`strand:commit-held`, or a commit reported `heldElsewhere`). The cadron may still be starting
 * then, but it holds the strand's data and finishes starting on its own. Its `StrandPeer` row is
 * not enough: it is written before the cadron's copy is live, and a join answered by a cadron
 * whose copy is not live is refused `host-strand-unavailable`.
 * WORKAROUND(sereus: a readiness signal for an invitation): read from commit durability.
 */
import { multiaddr } from '@multiformats/multiaddr';
import type { CadreNode } from '@serfab/cadre-core';
import { normalizePreferences, planBootstrap, type CadronCandidate, type CadronPreferences } from '../bootstrap.js';
import { describeInvitation } from '../invitation-text.js';
import type { InvitationReadiness, InvitationsModel } from '../model.js';
import { cadreAttempt, CadreFailure, withTimeout } from '../result.js';
import type { CadreHost } from './host.js';

/** `addr` ending in `/p2p/<peerId>` (a claim's or a connection's address may not); unchanged when it does not parse. */
function withPeer(addr: string, peerId: string): string {
	try {
		const ma = multiaddr(addr);
		return ma.getComponents().at(-1)?.value === peerId ? ma.toString() : ma.encapsulate(`/p2p/${peerId}`).toString();
	} catch {
		return addr;
	}
}

export interface InvitationsDeps {
	host: CadreHost;
	controlReadMs: number;
	log: { info(...args: unknown[]): void; warn(...args: unknown[]): void };
}

export function createInvitations({ host, controlReadMs, log }: InvitationsDeps): {
	invitations: InvitationsModel;
	onChange(listener: () => void): () => void;
} {
	const listeners = new Set<() => void>();
	const changed = () => { for (const l of [...listeners]) l(); };

	// Preferences: per device, in the host's slot. Without one, kept in memory for the session.
	let prefs: CadronPreferences | null = null;
	async function loadPrefs(): Promise<CadronPreferences> {
		if (prefs) return prefs;
		let raw: Partial<CadronPreferences> | null = null;
		try {
			const text = await host.preferences?.load();
			raw = text ? JSON.parse(text) as Partial<CadronPreferences> : null;
		} catch (err) {
			log.warn('[cadre-client] cadron preferences unreadable; using defaults:', err instanceof Error ? err.message : err);
		}
		prefs = normalizePreferences(raw);
		return prefs;
	}

	// Strands with a commit held elsewhere this session.
	const held = new Set<string>();
	const markHeld = (strandId: string) => {
		if (held.has(strandId)) return;
		held.add(strandId);
		changed();
	};
	host.node.on('strand:commit-durability', d => { if (d.heldElsewhere) markHeld(d.strandId); });
	host.node.on('strand:commit-held', d => markHeld(d.strandId));

	// Established strands: how many other cadrons serve each (their `StrandPeer` rows), read in
	// the background and cached; null while unknown.
	const serving = new Map<string, number | null>();
	function servingOthers(node: CadreNode, strandId: string): number | null {
		if (!serving.has(strandId)) {
			serving.set(strandId, null);
			const self = node.peerId?.toString();
			void withTimeout(node.getControlDatabase()?.queryStrandPeers(strandId) ?? Promise.resolve([]), controlReadMs, 'queryStrandPeers')
				.then(rows => { serving.set(strandId, rows.filter(r => r.peerId !== self && r.role === null).length); changed(); })
				.catch(() => { serving.delete(strandId); });
		}
		return serving.get(strandId) ?? null;
	}
	// A cadron coming or going changes who serves: forget the cached counts.
	host.node.on('control:connected', () => { serving.clear(); changed(); });

	async function candidates(node: CadreNode): Promise<CadronCandidate[]> {
		const machines = await withTimeout(node.listMachines(), controlReadMs, 'listMachines').catch(() => []);
		const claimed = node.getBootstrapPeerStore()?.all() ?? new Map<string, { addrs: string[] }>();
		const connections = node.getControlNode()?.getConnections() ?? [];
		const others = machines.filter(m => !m.isSelf && m.trusted);
		return Promise.all(others.map(async (m): Promise<CadronCandidate> => {
			const addrs: CadronCandidate['addrs'][number][] = [];
			const record = await withTimeout(node.resolvePeerAddrs(m.peerId), controlReadMs, 'resolvePeerAddrs').catch(() => []);
			for (const a of record) addrs.push({ addr: withPeer(a.toString(), m.peerId), source: 'record' });
			// WORKAROUND(sereus: name a just-claimed machine): until its first record arrives, what its
			// node code carried. cadre-core's own invitation leaves such a machine out.
			for (const a of claimed.get(m.peerId)?.addrs ?? []) addrs.push({ addr: withPeer(a, m.peerId), source: 'claim' });
			for (const c of connections) {
				const remote = c.remoteAddr.toString();
				if (c.remotePeer.toString() !== m.peerId || c.direction !== 'outbound' || c.limits !== undefined || remote.includes('/p2p-circuit')) continue;
				addrs.push({ addr: withPeer(remote, m.peerId), source: 'connection' });
			}
			return { peerId: m.peerId, alwaysOn: m.alwaysOn === true, lastPublishedAt: m.lastPublishedAt, addrs };
		}));
	}

	const requireNode = (): CadreNode => {
		const node = host.node.node;
		if (!node) throw new CadreFailure('unavailable', 'The cadre node is not running yet.');
		return node;
	};

	async function plan() {
		const node = requireNode();
		return planBootstrap({
			cadrons: await candidates(node),
			thisDevice: { peerId: node.peerId?.toString() ?? '', addrs: node.getMultiaddrs().map(a => a.toString()) },
			prefs: await loadPrefs(),
		});
	}

	const invitations: InvitationsModel = {
		preferences: loadPrefs,

		setPreferences: changes => cadreAttempt(async () => {
			const next = normalizePreferences({ ...(await loadPrefs()), ...changes });
			if (host.preferences) await host.preferences.save(JSON.stringify(next));
			prefs = next;
			changed();
			return next;
		}),

		bootstrapPlan: () => cadreAttempt(plan),

		// WORKAROUND(sereus: an option on `createOpenInvitation`): the list is replaced after minting,
		// before the app encodes it. It is not signed; the responder checks only the token.
		async withBootstrap(invitation) {
			try {
				const { entries, warnings } = await plan();
				if (entries.length === 0) return invitation;
				if (warnings.length) log.info('[cadre-client] invitation bootstrap:', warnings.join(', '));
				return { ...invitation, bootstrap: entries.map(e => e.addr) };
			} catch (err) {
				log.warn('[cadre-client] kept cadre-core\'s bootstrap list:', err instanceof Error ? err.message : err);
				return invitation;
			}
		},

		readiness(strandId, opts = {}): InvitationReadiness {
			if (held.has(strandId)) return 'ready';
			const node = host.node.node;
			if (!node) return 'waiting';
			const others = servingOthers(node, strandId);
			if (opts.newStrand) return others === 0 ? 'no-cadron' : 'waiting';
			if (others === null) return 'waiting';
			return others > 0 ? 'ready' : 'no-cadron';
		},

		describe: (token, link) => cadreAttempt(async () => {
			const node = requireNode();
			const decoded = node.decodeInvitation(token);
			const { names } = await loadPrefs();
			return describeInvitation(decoded, { link: link ?? token, names, thisDevicePeerId: node.peerId?.toString() ?? null });
		}),
	};

	return {
		invitations,
		onChange(listener) { listeners.add(listener); return () => listeners.delete(listener); },
	};
}

