/**
 * Machines and steps shared by the cadre invitation scenarios (`cadre-invite-*.integration.ts`):
 * an always-on member that pins the owner's key, its owner-online admission, and a device's
 * redemption that keeps trying while members answer retryably.
 */

import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { CadreNode, CadreInviteUnreachableError, type CadreInvitation, type RawStorageProvider, type RedeemCadreInvitationResult } from '@serfab/cadre-core';
import { controlNodeConfig, controlAddrs, hasOutboundTo } from './node-fixtures.js';
import { waitUntil } from './wait-utils.js';

/** Pause between a device's redemption attempts while the members answer retryably. */
const REDEEM_RETRY_PAUSE_MS = 2_000;

export interface InviteMember { node: CadreNode; peerId: string }

/**
 * An always-on member: `storage` profile on a WebSocket listen address, pinning `ownerKey` as an
 * operator would (`--pin-owner-key`), with the seed handler `cadre start --listen-for-seeds`
 * registers. `storageProvider` lets a scenario look inside the member's raw stores.
 */
export async function startPinningMember(partyId: string, ownerKey: string, storageProvider?: RawStorageProvider): Promise<InviteMember> {
	const key = await generateKeyPair('Ed25519');
	const node = new CadreNode(controlNodeConfig({
		partyId, privateKey: key, profile: 'storage', strandFilter: 'none', pinnedOwnerKeys: [ownerKey],
		...(storageProvider ? { storageProvider } : {}),
	}));
	await node.start();
	await node.enableSeedListener();
	return { node, peerId: peerIdFromPrivateKey(key).toString() };
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
 * What a device does with a retryable outcome: try again after a pause, until `budgetMs` is
 * spent. A scenario that pins one attempt still retries, so a regression shows as the count of
 * attempts the member needed rather than a failure at the first retryable refusal.
 */
export async function redeemWithRetry(
	device: CadreNode,
	invitation: CadreInvitation,
	budgetMs: number,
	label: string
): Promise<{ joined: RedeemCadreInvitationResult; attempts: number }> {
	const deadline = Date.now() + budgetMs;
	for (let attempts = 1; ; attempts++) {
		try {
			return { joined: await device.redeemCadreInvitation(invitation), attempts };
		} catch (err) {
			if (!(err instanceof CadreInviteUnreachableError) || Date.now() + REDEEM_RETRY_PAUSE_MS > deadline) throw err;
			console.log('[%s] attempt %d answered retryably: %s', label, attempts, err.message);
			await new Promise<void>((resolve) => setTimeout(resolve, REDEEM_RETRY_PAUSE_MS));
		}
	}
}
