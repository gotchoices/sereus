/**
 * cadre-member.ts — an in-process headless cadre the browser tab can JOIN, for the
 * join-cadre e2e (`e2e/distributed/join-cadre.spec.ts`) and the owner-grant e2e
 * (`e2e/distributed/owner-grants.spec.ts`).
 *
 * Boots a real cadre-core `CadreNode` inside the Playwright **worker** process (the spec's
 * `beforeAll`, for the reason `formation-responder.ts` gives: `global-setup` runs in another
 * process and could not share the live handle). The node founds a party of its own under a
 * generated owner key (owner genesis, as `cadre-web.ts` runs it for a founded tab) and listens on a loopback
 * WebSocket address, so it is the one always-on machine of that party: the owner that mints a
 * cadre invitation or an owner grant, and the member a device redeems it at (`CadreNode.start` registers the
 * redemption handler on every node). The browser only dials out, so it needs no relay.
 *
 * In-memory storage: the party exists for one spec run. The tab's own party (the one it
 * founded on first load) is what the join leaves behind and the tab's IndexedDB keeps.
 */

import { generateKeyPair } from '@libp2p/crypto/keys';
import { webSockets } from '@libp2p/websockets';
import { MemoryRawStorage, type Libp2pTransports } from '@optimystic/db-p2p';
import { CadreNode, createOwnerKey, InMemoryKeyStore } from '@serfab/cadre-core';
import type { CadreInvitationReach, CadreNodeConfig } from '@serfab/cadre-core';

/** A live handle to the in-process cadre, consumed by the spec. */
export interface CadreMemberHandle {
	/** The party the tab joins. */
	partyId: string;
	/** This machine's peer id: the one member the invitation names. */
	peerId: string;
	/**
	 * Mint a machine invitation into this party, for `peerId` alone or for whoever redeems first
	 * (`CadreNode.createCadreInvitation`); it admits a member and no owner. `reach` is
	 * `issuer-only` here: this machine is the party's only one.
	 */
	mintInvitation(options: { peerId?: string }): Promise<{ encoded: string; reach: CadreInvitationReach }>;
	/**
	 * Mint an owner grant into this party (`CadreNode.createOwnerGrant`): 15 minutes, one use, and
	 * whoever redeems it becomes an owner with a key of its own, listed under `label`.
	 */
	mintOwnerGrant(options: { label?: string }): Promise<{ encoded: string }>;
	/** The peer ids of the party's machines (`CadrePeer` rows), this one included. */
	listMembers(): Promise<string[]>;
	/** Stop the node and release its listener. */
	stop(): Promise<void>;
}

/**
 * WebSocket only: the browser (the only client) dials the `/ws` listen address, and this
 * node dials nobody, so like the browser's own stack it needs no TCP transport.
 */
function memberTransports(): Libp2pTransports {
	return [webSockets()];
}

/**
 * An always-on member of its own party: `storage` profile on an ephemeral loopback WebSocket
 * port, running no strand (the tab's chat strand is local to the tab, and nothing publishes a
 * strand into this party).
 */
function buildMemberConfig(privateKey: CadreNodeConfig['privateKey'], partyId: string): CadreNodeConfig {
	return {
		privateKey,
		controlNetwork: { partyId, bootstrapNodes: [] },
		profile: 'storage',
		strandFilter: { mode: 'none' },
		storage: { provider: () => new MemoryRawStorage() },
		network: {
			transports: memberTransports(),
			listenAddrs: ['/ip4/127.0.0.1/tcp/0/ws'],
		},
		hibernation: { enabled: false },
	};
}

/**
 * Genesis-seed the node's own owner, as `cadre-web.ts` does for a founded tab: an owner key
 * of its own (in memory, since the party lasts one spec run), the idempotent `OwnerKey` insert,
 * then the signer wired, which also anchors the key in the node-local trusted-owner store that
 * `createCadreInvitation` hands out as the device's pins. Unlike the browser's fail-soft path
 * this throws on failure: a party with no owner can mint nothing, so there is nothing to test.
 */
async function runOwnerGenesis(node: CadreNode): Promise<void> {
	const owner = await createOwnerKey(new InMemoryKeyStore());
	const controlDb = node.getControlDatabase();
	if (!controlDb) {
		throw new Error('control database unavailable after start; cannot run the member’s owner genesis');
	}
	await controlDb.ensureOwnerKey(owner.publicKey);
	await node.useOwnerSigner(owner);
}

/** Boot the in-process cadre and return a live handle. */
export async function startCadreMember(): Promise<CadreMemberHandle> {
	const identityKey = await generateKeyPair('Ed25519');
	const partyId = `join-cadre-member-${crypto.randomUUID()}`;

	const node = new CadreNode(buildMemberConfig(identityKey, partyId));
	await node.start();
	try {
		await runOwnerGenesis(node);
		const peerId = node.peerId?.toString();
		if (!peerId) throw new Error('the member node has no peer id after start');
		return {
			partyId,
			peerId,
			mintInvitation: async (options) => {
				const { encoded, reach } = await node.createCadreInvitation(options);
				return { encoded, reach };
			},
			mintOwnerGrant: async (options) => {
				const { encoded } = await node.createOwnerGrant(options);
				return { encoded };
			},
			listMembers: async () => (await node.listMembers()).map((member) => member.peerId),
			stop: () => node.stop(),
		};
	} catch (err) {
		// Bring-up failed after start(): tear the node down so a failed boot leaves no
		// dangling listener, then rethrow (fail loud, like genesis).
		await node.stop().catch(() => {
			/* best-effort cleanup; surface the ORIGINAL error below */
		});
		throw err;
	}
}
