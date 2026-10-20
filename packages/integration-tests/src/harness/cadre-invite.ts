/**
 * Machines and steps shared by the cadre invitation scenarios (`cadre-invite-*.integration.ts`,
 * `app-joins-cadre-by-invitation`), the owner grant scenarios (`owner-grant-*.integration.ts`)
 * and the owner-anchor scenario: an always-on member that pins the owner's key, its
 * owner-online admission, a device started in the party that no one has admitted, and a
 * redemption that waits while members answer retryably.
 */

import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import type { PrivateKey } from '@libp2p/interface';
import {
	CadreNode,
	type CadreInvitation, type CadreJoinProgress, type RawStorageProvider,
	type RedeemCadreInvitationOptions, type RedeemCadreInvitationResult,
} from '@serfab/cadre-core';
import { controlNodeConfig, controlAddrs, hasOutboundTo } from './node-fixtures.js';
import type { TestOwnerKey } from './owner-key.js';
import { waitUntil } from './wait-utils.js';

export interface InviteMember { node: CadreNode; peerId: string; key: PrivateKey }

export interface PinningMemberOptions {
	/** The member's identity; default a fresh one. Pass the stopped member's key, with its storage and address, to restart it. */
	key?: PrivateKey;
	/** The member's listen addresses; default one loopback WebSocket address on a free port. */
	listenAddrs?: string[];
	/** Lets a scenario look inside the member's raw stores. */
	storageProvider?: RawStorageProvider;
	/**
	 * Wire this owner key as the member's owner signer (`useOwnerSigner`) in place of the
	 * listener-only seed service, for a machine an owner will make a second owner
	 * (`CadreNode.addOwner(ownerKey.publicKey)`). A node registers one seed handler, so this has
	 * to replace the listener rather than follow it; the owner-capable service answers the
	 * admitting owner's seed the same way. It anchors the key on the member alone.
	 */
	ownerKey?: TestOwnerKey;
	/** The member's `network.controlCohort.reconcileMs`; on a pinning member that timer is what runs its membership refresh. */
	reconcileMs?: number;
	/**
	 * Run a storage replica of every strand the party lists (`hostUnclaimedStrands`), as the
	 * production storage profile does. Default false: the member runs no strand at all.
	 */
	hostUnclaimedStrands?: boolean;
	/** The member's strand watcher backstop; meaningful only with {@link hostUnclaimedStrands}. */
	strandWatchMs?: number;
}

/**
 * An always-on member: `storage` profile on a WebSocket listen address, pinning `ownerKey` as an
 * operator would (`--pin-owner-key`), with the seed handler `cadre start --listen-for-seeds`
 * registers.
 */
export async function startPinningMember(partyId: string, ownerKey: string, options: PinningMemberOptions = {}): Promise<InviteMember> {
	const key = options.key ?? await generateKeyPair('Ed25519');
	const node = new CadreNode(controlNodeConfig({
		partyId, privateKey: key, profile: 'storage', pinnedOwnerKeys: [ownerKey],
		...(options.hostUnclaimedStrands
			? { strandFilter: 'all', hostUnclaimedStrands: true }
			: { strandFilter: 'none' }),
		...(options.listenAddrs ? { listenAddrs: options.listenAddrs } : {}),
		...(options.storageProvider ? { storageProvider: options.storageProvider } : {}),
		...(options.reconcileMs !== undefined ? { reconcileMs: options.reconcileMs } : {}),
		...(options.strandWatchMs !== undefined ? { strandWatchMs: options.strandWatchMs } : {}),
	}));
	await node.start();
	if (options.ownerKey) {
		await node.useOwnerSigner(options.ownerKey.signer);
	} else {
		await node.enableSeedListener();
	}
	return { node, peerId: peerIdFromPrivateKey(key).toString(), key };
}

/** The owner-online path: `owner` vouches the member, delivers the seed, and dials it from the retained address. */
export async function admitMember(owner: CadreNode, member: InviteMember, timeoutMs: number): Promise<void> {
	const addrs = controlAddrs(member.node);
	const { seed } = await owner.addDrone({ dronePeerId: member.peerId, droneMultiaddrs: addrs });
	const delivered = await owner.deliverSeed(addrs[0]!, seed);
	if (!delivered.accepted) throw new Error(`the member refused the owner's seed: ${delivered.reason ?? 'no reason given'}`);
	await owner.reconcileControlCohort();
	await waitUntil(() => hasOutboundTo(owner, member.peerId), {
		timeoutMs, intervalMs: 250, description: `the owner holds an outbound control connection to ${member.peerId}`,
	});
}

/**
 * A phone-shaped device for `partyId` on an empty store, not yet started: no listen address, no
 * pinned owner key, no strand, and a stable identity (`joinWithOwnerGrant` signs its
 * self-invitation for that identity). Not a member until something admits it: an invitation it
 * redeems, or the self-admission an owner grant gives it. Unstarted, like `buildPhoneOwner`, so
 * the caller holds the node for its `finally` before `start()` can throw.
 */
export async function buildPartyDevice(partyId: string, key?: PrivateKey): Promise<CadreNode> {
	return new CadreNode(controlNodeConfig({
		partyId, privateKey: key ?? await generateKeyPair('Ed25519'), profile: 'transaction', listenAddrs: [], strandFilter: 'none',
	}));
}

/** The options every redemption call takes (`redeemCadreInvitation`, `redeemOwnerGrant`, `joinWithOwnerGrant`), all set. */
export type MemberWaitOptions = Required<RedeemCadreInvitationOptions>;

/**
 * Run a redemption that waits for a member (`waitForMember`), bounded by `budgetMs`, with each
 * pass that found no member ready logged. A scenario that pins one pass still waits, so a
 * regression shows as the count of passes the member needed rather than a failure at the first
 * retryable answer. `passes` is the most passes any one redemption made: `joinWithOwnerGrant`
 * reports its grant redemption and its self-invitation through one callback, each counting
 * from 1. `onProgress` sees every report too.
 */
export async function waitingForMember<T>(
	budgetMs: number,
	label: string,
	redeem: (options: MemberWaitOptions) => Promise<T>,
	onProgress?: (progress: CadreJoinProgress) => void
): Promise<{ result: T; passes: number }> {
	const budget = new AbortController();
	const timer = setTimeout(() => budget.abort(new Error(`[${label}] no member accepted the redemption within ${budgetMs} ms`)), budgetMs);
	let passes = 0;
	try {
		const result = await redeem({
			waitForMember: true,
			signal: budget.signal,
			onProgress: (progress) => {
				if (progress.state === 'redeeming') {
					passes = Math.max(passes, progress.pass);
				} else {
					console.log('[%s] pass %d found no member ready (%s): %s', label, progress.pass, progress.reason,
						progress.outcomes.map((outcome) => `${outcome.addr}: ${outcome.error.message}`).join('; '));
				}
				onProgress?.(progress);
			},
		});
		return { result, passes };
	} finally {
		clearTimeout(timer);
	}
}

/** A device's invitation redemption, waiting for a member as {@link waitingForMember} does. */
export async function redeemWaitingForMember(
	device: CadreNode,
	invitation: CadreInvitation,
	budgetMs: number,
	label: string,
	onProgress?: (progress: CadreJoinProgress) => void
): Promise<{ joined: RedeemCadreInvitationResult; passes: number }> {
	const { result: joined, passes } = await waitingForMember(budgetMs, label, (options) => device.redeemCadreInvitation(invitation, options), onProgress);
	return { joined, passes };
}
