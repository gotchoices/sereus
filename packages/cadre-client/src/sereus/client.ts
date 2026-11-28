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
import { MachineRemovalRefusedError, readOwnerPrivateKey, type CadreNode } from '@serfab/cadre-core';
import type {
	CadreMachine, CadreModel, CadreStatus, CadreView, InvitationsModel, InvitationsView, Reachability, ReachabilityModel, ReachabilityView,
	ReachedVia, RelaysModel,
} from '../model.js';
import { ownerFingerprint } from '../model.js';
import { addressComponents, nodeReach } from '../address.js';
import { destinationPeerId } from '../invitation-text.js';
import {
	cadreAttempt, CadreFailure, cadreFail, cadreOk, describeThrown, withTimeout, type CadreResult,
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
	/** A burst of cadrons connecting or dropping is reported once, this long after the last. Default 750 ms. */
	peerChangeMs?: number;
	/** Bound on a removal, which also replaces the party's key in each closed strand. Default 60 s. */
	removeTimeoutMs?: number;
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
		/**
		 * A cadron left the cadre: removed through this client, or found gone when the machine list is
		 * read again (a removal on another device; seen only while something reads the list, such as a
		 * subscribed `cadreStore`). For per-cadron state an app keeps, such as saved addresses.
		 */
		removed(onRemoved: (peerId: string) => void): () => void;
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
	const peerChangeMs = opts.peerChangeMs ?? 750;
	const removeTimeoutMs = opts.removeTimeoutMs ?? 60_000;
	// Cadrons removed: by this client, or seen gone between two complete reads of the list.
	const removedListeners = new Set<(peerId: string) => void>();
	const announceRemoved = (peerId: string) => { for (const l of [...removedListeners]) l(peerId); };
	let knownCadrons: Set<string> | null = null;
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
				? [{ peerId, thisDevice: true, addresses: [], alwaysOn: null, lastSeenAt: null, connected: node?.running === true }]
				: [];
			let complete = true;
			if (node) {
				// Best effort and bounded: the list fills in when the control network answers.
				const partial = <T>(): T[] => { complete = false; return []; };
				const [members, records] = await Promise.all([
					withTimeout(node.listMembers(), controlReadMs, 'listMembers').catch(() => partial<Awaited<ReturnType<CadreNode['listMembers']>>[number]>()),
					withTimeout(node.listMachines(), controlReadMs, 'listMachines').catch(() => partial<Awaited<ReturnType<CadreNode['listMachines']>>[number]>()),
				]);
				const record = new Map(records.map(r => [r.peerId, r]));
				// Who this device holds a control connection to now.
				const connected = new Set(node.getControlNode()?.getConnections().map(c => c.remotePeer.toString()) ?? []);
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
						connected: connected.has(m.peerId),
					});
				}
				for (const r of records) {
					if (r.isSelf || seen.has(r.peerId)) continue;
					seen.add(r.peerId);
					machines.push({
						peerId: r.peerId, thisDevice: false, addresses: [], alwaysOn: r.alwaysOn, lastSeenAt: r.lastPublishedAt,
						connected: connected.has(r.peerId),
					});
				}
			}
			// A cadron gone between two complete reads was removed (here or by another device). A read
			// that timed out is incomplete and compares nothing.
			if (node && complete) {
				const now = new Set(machines.filter(m => !m.thisDevice).map(m => m.peerId));
				if (knownCadrons) for (const gone of knownCadrons) if (!now.has(gone)) announceRemoved(gone);
				knownCadrons = now;
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
			const ownerKey = host.node.node?.getOwnerSigner()?.publicKey;
			return cadreOk({
				peerId, addresses: multiaddrs, reach: nodeReach(multiaddrs),
				partyId: host.node.partyId(),
				ownerFingerprint: host.node.ownerEnrolled() && ownerKey ? ownerFingerprint(ownerKey) : null,
			});
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

		connectNode: address => cadreAttempt(async () => {
			const node = requireNode();
			const target = address.trim();
			if (!addressComponents(target)) throw new CadreFailure('invalid-address', 'That is not an address.', { reason: 'unparsable' });
			const peerId = destinationPeerId(target);
			if (!peerId) throw new CadreFailure('invalid-address', 'The address must end in /p2p/<peer id>, so the node can be identified.', { reason: 'no-peer-id' });
			if (!host.node.ownerEnrolled()) throw new CadreFailure('not-supported', 'This device holds no owner key, so it cannot add a node.');
			// Authorizes (an owner-signed record) and mints the seed; dials nothing itself.
			const { seed, encodedSeed } = await withTimeout(node.addDrone({ dronePeerId: peerId, droneMultiaddrs: [target] }), controlOpMs, 'addDrone');
			log.info('[cadre-client] node authorized:', peerId);
			let delivered = false;
			let reason: string | undefined;
			try {
				const ack = await withTimeout(node.deliverSeed(target, seed), controlOpMs, 'deliverSeed');
				delivered = ack.accepted;
				reason = ack.accepted ? undefined : ack.code ?? ack.reason;
			} catch (err) {
				reason = describeThrown(err);
			}
			// The connection: now rather than at the next timed pass.
			await withTimeout(node.reconcileControlCohort(), controlOpMs, 'reconcileControlCohort').catch(() => undefined);
			ownMachine = null;
			return { peerId, delivered, ...(reason ? { reason } : {}), ...(delivered ? {} : { seed: encodedSeed }) };
		}),

		createSeed: () => cadreAttempt(async () => {
			const node = requireNode();
			if (!host.node.ownerEnrolled()) throw new CadreFailure('not-supported', 'This device holds no owner key, so it cannot make a seed.');
			return node.encodeSeed(await withTimeout(node.createSeed(), controlOpMs, 'createSeed'));
		}),

		planRemoval: peerId => cadreAttempt(async () => {
			const plan = await withTimeout(requireNode().planMachineRemoval(peerId), controlReadMs, 'planMachineRemoval');
			return {
				refusal: plan.refusal,
				alreadyRemoved: plan.machine === null,
				invitations: plan.invitations.length,
				closedStrands: plan.strands.map(s => ({ strandId: s.strandId, replaced: s.rotation })),
			};
		}),

		removeMachine: peerId => cadreAttempt(async () => {
			let result;
			try {
				// The complete removal: record, invitations, the party's key in each closed strand.
				result = await withTimeout(requireNode().removeMachine(peerId), removeTimeoutMs, 'removeMachine');
			} catch (err) {
				if (err instanceof MachineRemovalRefusedError) {
					throw new CadreFailure('removal-refused', err.code === 'self'
						? 'This is this device: to leave the cadre, stop the app and delete its data.'
						: 'This device holds no owner key, so it cannot remove a machine.', { reason: err.code });
				}
				throw err;
			}
			ownMachine = null;
			knownCadrons?.delete(peerId);
			announceRemoved(peerId);
			return {
				withdrawnInvitations: result.withdrawnInvitations.length,
				closedStrands: result.strands.map(s => ({ strandId: s.strandId, outcome: s.outcome })),
			};
		}),

		exportOwnerKey: () => cadreAttempt(async () => {
			// The host's own export (an app keeping the owner key its own way), else the key store's
			// owner slot (the kits').
			const key = host.exportOwnerKey
				? await host.exportOwnerKey()
				: host.ownerKeyStore ? await readOwnerPrivateKey(host.ownerKeyStore) : undefined;
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

	/**
	 * A cadron connecting or dropping. cadre-core emits no per-peer event, so this listens to the
	 * control node's libp2p `peer:connect` / `peer:disconnect`, collapsing a burst into one call
	 * `peerChangeMs` after the last, and re-attaches when the node restarts (`control:connected`).
	 */
	const onPeers = (onChange: () => void) => {
		let timer: unknown = null;
		const fire = () => {
			if (timer !== null) clearTimeout(timer);
			timer = setTimeout(() => { timer = null; onChange(); }, peerChangeMs);
		};
		let detach: (() => void) | null = null;
		const attach = () => {
			detach?.();
			const control = host.node.node?.getControlNode();
			if (!control) { detach = null; return; }
			control.addEventListener('peer:connect', fire);
			control.addEventListener('peer:disconnect', fire);
			detach = () => {
				control.removeEventListener('peer:connect', fire);
				control.removeEventListener('peer:disconnect', fire);
			};
		};
		attach();
		const offStart = host.node.on('control:connected', attach);
		return () => {
			offStart();
			detach?.();
			if (timer !== null) clearTimeout(timer);
		};
	};

	return {
		cadre,
		reachability,
		relays,
		invitations,
		changes: {
			cadre: onChange => {
				const offControl = onControl(onChange);
				const offPeers = onPeers(onChange); // `connected` in the machine list
				const offPrefs = onInvitations(onChange); // names and preferred show in the machine list
				return () => { offControl(); offPeers(); offPrefs(); };
			},
			invitations: onInvitations,
			removed(onRemoved) {
				removedListeners.add(onRemoved);
				return () => { removedListeners.delete(onRemoved); };
			},
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
