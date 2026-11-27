/**
 * The cadre client over a running cadre-core node: `createCadreClient(host)`.
 *
 * Everything an app's cadre screens need, without UI: the machine list, claiming a node by
 * its code, removing a machine, backing up the owner key, relays, and reachability. Every
 * operation returns a `CadreResult`; nothing here throws for a failure a screen handles.
 *
 * REACHABILITY counts the party's own machines. A phone cannot accept a connection, so on
 * its own it is reachable only through a relay reservation. But an invitation names the
 * party's other machines too (cadre-core's `createOpenInvitation` puts their signed,
 * recently published addresses in its bootstrap list), and an always-on machine answers a
 * strand join for the party and hosts its strands. So a device is also reachable when
 * one of its always-on machines has a public address: cadre-core's `invitationReach()`
 * says `anywhere` (judged from the same records an invitation is built from), and
 * `listMachines()` shows a trusted machine that says it stays on. A relay is then not
 * needed to invite anybody.
 *
 * Caveat (sereus, docs/network/relay.md): a cadre-host node behind a home router forwards
 * its control ports only; its strand networks listen on ports the router does not map, so
 * an outsider may complete the join and still not sync. A machine with a public address
 * and open ports (a server, a rented node) is the case this is for.
 */
import { readOwnerPrivateKey, type CadreNode } from '@serfab/cadre-core';
import type {
	CadreMachine, CadreModel, CadreStatus, CadreView, InvitationsModel, InvitationsView, Reachability, ReachabilityModel, ReachabilityView,
	ReachedVia, RelaysModel,
} from '../model.js';
import { ownerFingerprint } from '../model.js';
import { nodeReach } from '../address.js';
import {
	cadreAttempt, CadreFailure, cadreFail, cadreOk, withTimeout, type CadreResult,
} from '../result.js';
import { classifyClaimFailure, readNodeCode } from './node-code.js';
import type { CadreHost } from './host.js';
import { createInvitations } from './invitations.js';

export interface CadreClientOptions {
	/** Bound on a claim: `claimNode` dials each address in turn (~115 s worst case when none answers). Default 150 s. */
	claimTimeoutMs?: number;
	/** Bound on the control reads behind the machine list and reachability; with no cohort they can hang. Default 6 s. */
	controlReadMs?: number;
	/** Bound on a one-off control write (removing a machine). Default 15 s. */
	controlOpMs?: number;
	/** How long a reading of the party's own machines' reach is reused. Default 15 s. */
	ownMachineTtlMs?: number;
	/** Where the client reports (claims by peer id only; never a code). Default `console`. */
	log?: { info(...args: unknown[]): void; warn(...args: unknown[]): void };
}

export interface CadreClient extends CadreView, ReachabilityView, InvitationsView {
	cadre: CadreModel;
	reachability: ReachabilityModel;
	relays: RelaysModel;
	/** What an invitation names, whether it is ready to hand out, and what it says in words. */
	invitations: InvitationsModel;
	changes: {
		/** Cadron preferences changed, or a cadron came to hold a strand (readiness). */
		invitations(onChange: () => void): () => void;
		/** The control network connected or dropped: the machine list may have changed. */
		cadre(onChange: () => void): () => void;
		/** This device's addresses changed, its node restarted, or the control network connected or dropped. */
		reachability(onChange: () => void): () => void;
	};
	/**
	 * Before minting a strand invitation: who will answer it, or `unreachable` when nobody
	 * could. Fresh (not the cached reading) when the cached one says nobody.
	 */
	invitable(): Promise<CadreResult<ReachedVia>>;
}

export function createCadreClient(host: CadreHost, opts: CadreClientOptions = {}): CadreClient {
	const claimTimeoutMs = opts.claimTimeoutMs ?? 150_000;
	const controlReadMs = opts.controlReadMs ?? 6000;
	const controlOpMs = opts.controlOpMs ?? 15_000;
	const ownMachineTtlMs = opts.ownMachineTtlMs ?? 15_000;
	const log = opts.log ?? console;
	let claiming = false;
	let ownMachine: { node: CadreNode; at: number; answers: boolean } | null = null;
	const { invitations, onChange: onInvitations } = createInvitations({ host, controlReadMs, log });

	const requireNode = (): CadreNode => {
		const node = host.node.node;
		if (!node) throw new CadreFailure('unavailable', 'The cadre node is not running yet.');
		return node;
	};

	/**
	 * One of the party's always-on machines has a public address an invitation would name,
	 * so it can answer for this device. Best effort and bounded: a read that fails or hangs
	 * counts as no.
	 */
	async function ownMachineAnswers(node: CadreNode, fresh = false): Promise<boolean> {
		const now = Date.now();
		if (!fresh && ownMachine && ownMachine.node === node && now - ownMachine.at < ownMachineTtlMs) return ownMachine.answers;
		let answers: boolean;
		try {
			const [reach, machines] = await Promise.all([
				withTimeout(node.invitationReach(), controlReadMs, 'invitationReach'),
				withTimeout(node.listMachines(), controlReadMs, 'listMachines'),
			]);
			answers = reach === 'anywhere' && machines.some(m => !m.isSelf && m.trusted && m.alwaysOn === true);
		} catch {
			answers = false;
		}
		ownMachine = { node, at: Date.now(), answers };
		return answers;
	}

	async function reachedVia(fresh: boolean): Promise<ReachedVia | null> {
		const node = host.node.node;
		if (!node) return null;
		if (node.getMultiaddrs().length > 0) return 'this-device';
		if (await ownMachineAnswers(node, fresh)) return 'own-machine';
		return null;
	}

	const reachability: ReachabilityModel = {
		async get(): Promise<Reachability> {
			const via = await reachedVia(false);
			const relays = await host.node.getRelayAddrs().catch(() => [] as string[]);
			return { reachable: via !== null, via, relayPending: via === null && relays.length > 0, relays, relayStatus: host.node.relayStatus() };
		},
	};

	const cadre: CadreModel = {
		status: () => cadreAttempt(async (): Promise<CadreStatus> => {
			const node = host.node.node;
			const peerId = node?.peerId?.toString() ?? null;
			// The owner key this node signs with (sereus 1.17: separate from the machine's identity).
			const ownerKey = node?.getOwnerSigner()?.publicKey;
			const machines: CadreMachine[] = peerId
				? [{ peerId, thisDevice: true, addresses: [], alwaysOn: null, lastSeenAt: null }]
				: [];
			if (node) {
				// Best effort and bounded: the list fills in when the control network answers.
				const [members, records] = await Promise.all([
					withTimeout(node.listMembers(), controlReadMs, 'listMembers').catch(() => []),
					withTimeout(node.listMachines(), controlReadMs, 'listMachines').catch(() => []),
				]);
				const record = new Map(records.map(r => [r.peerId, r]));
				const seen = new Set<string>(peerId ? [peerId] : []);
				for (const m of members) {
					if (seen.has(m.peerId)) continue;
					seen.add(m.peerId);
					const r = record.get(m.peerId);
					machines.push({
						peerId: m.peerId, thisDevice: false,
						// Stored comma-joined.
						addresses: m.multiaddr ? m.multiaddr.split(',').map(a => a.trim()).filter(Boolean) : [],
						alwaysOn: r?.alwaysOn ?? null,
						lastSeenAt: r?.lastPublishedAt ?? null,
					});
				}
				for (const r of records) {
					if (r.isSelf || seen.has(r.peerId)) continue;
					seen.add(r.peerId);
					machines.push({ peerId: r.peerId, thisDevice: false, addresses: [], alwaysOn: r.alwaysOn, lastSeenAt: r.lastPublishedAt });
				}
			}
			// The person's own names and preferred cadrons.
			const { names, preferred } = await invitations.preferences();
			for (const m of machines) {
				m.name = names[m.peerId]?.trim() || null;
				m.preferred = preferred.includes(m.peerId);
			}
			return {
				running: !!node,
				partyId: host.node.partyId(),
				peerId,
				ownerEnrolled: host.node.ownerEnrolled(),
				ownerFingerprint: ownerKey ? ownerFingerprint(ownerKey) : null,
				machines,
			};
		}),

		async inspectNodeCode(text) {
			const reading = readNodeCode(text);
			if (!reading.ok) {
				return cadreFail('invalid-node-code', reading.problem === 'newer-version'
					? 'This code comes from a newer version of the node software; update the app to use it.'
					: reading.problem === 'damaged' ? 'This code is incomplete or damaged.' : 'This is not a node code.',
				{ reason: reading.problem });
			}
			const { peerId, multiaddrs } = reading.payload;
			return cadreOk({ peerId, addresses: multiaddrs, reach: nodeReach(multiaddrs) });
		},

		async claimNode(text) {
			const reading = readNodeCode(text);
			if (!reading.ok) return cadreFail('invalid-node-code', 'This is not a usable node code.', { reason: reading.problem });
			if (claiming) return cadreFail('claim-failed', 'A machine is already being added.', { retryable: true, reason: 'busy' });
			claiming = true;
			try {
				const node = host.node.node;
				if (!node) return cadreFail('unavailable', 'The cadre node is not running yet.');
				if (!host.node.ownerEnrolled()) {
					return cadreFail('unavailable', 'This device is not yet an owner of its cadre; try again in a moment.', { reason: 'owner-not-ready' });
				}
				// The code carries the claim secret: log the peer id only.
				log.info('[cadre-client] claiming node', reading.payload.peerId);
				try {
					await withTimeout(node.claimNode(reading.payload), claimTimeoutMs, 'claimNode');
				} catch (err) {
					const failure = classifyClaimFailure(err, reading.payload);
					const message = failure.kind === 'node-unreachable'
						? (failure.reach === 'home-network'
							? 'Could not reach that machine. It is only reachable on its own network: join that Wi-Fi and try again.'
							: 'Could not reach that machine. Check that it is running and try again.')
						: failure.kind === 'claim-refused'
							? `The machine refused: ${failure.detail}`
							: `Adding the machine did not finish: ${failure.detail}`;
					return cadreFail(failure.kind, message, {
						retryable: failure.retryable,
						reason: failure.kind === 'node-unreachable' ? failure.reach : failure.kind === 'claim-refused' ? failure.refusal : undefined,
						cause: err,
					});
				}
				ownMachine = null; // a new machine may answer for this device now
				log.info('[cadre-client] ✓ node accepted the claim:', reading.payload.peerId);
				return cadreOk();
			} finally {
				claiming = false;
			}
		},

		removeMachine: peerId => cadreAttempt(async () => {
			await withTimeout(requireNode().removePeer(peerId), controlOpMs, 'removePeer');
			ownMachine = null;
		}),

		exportOwnerKey: () => cadreAttempt(async () => {
			// The owner key lives in the host's key store (its owner slot), not in the node.
			const key = host.ownerKeyStore ? await readOwnerPrivateKey(host.ownerKeyStore) : undefined;
			if (!key) throw new CadreFailure('not-supported', 'This device holds no owner key to export.');
			return key;
		}),
	};

	const relays: RelaysModel = {
		get: () => host.node.getRelayAddrs().catch(() => [] as string[]),
		async set(addrs) {
			// Applying relays can rebuild the node, so it is not awaited: the caller returns at once
			// and the node reconnects behind it.
			void host.node.applyRelays(addrs).catch(err => log.warn('[cadre-client] applying relays failed:', err));
			return cadreOk();
		},
	};

	const onControl = (onChange: () => void) => {
		const off = [
			host.node.on('control:connected', () => onChange()),
			host.node.on('control:disconnected', () => onChange()),
		];
		return () => off.forEach(u => u());
	};

	return {
		cadre,
		reachability,
		relays,
		invitations,
		changes: {
			cadre: onChange => {
				const offControl = onControl(onChange);
				const offPrefs = onInvitations(onChange); // names and preferred show in the machine list
				return () => { offControl(); offPrefs(); };
			},
			invitations: onInvitations,
			reachability(onChange) {
				const offAddrs = host.node.onReachabilityChange(onChange);
				const offControl = onControl(() => { ownMachine = null; onChange(); });
				return () => { offAddrs(); offControl(); };
			},
		},
		async invitable() {
			if (!host.node.node) return cadreFail('unavailable', 'The cadre node is not running yet.');
			const via = await reachedVia(false) ?? await reachedVia(true);
			return via ? cadreOk(via) : cadreFail('unreachable', 'There is nowhere for them to answer yet.');
		},
	};
}
