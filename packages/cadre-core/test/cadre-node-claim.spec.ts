import { describe, it, expect } from 'vitest';
import { randomBytes } from '@optimystic/quereus-plugin-crypto';
import { CadreNode } from '../src/cadre-node.js';
import { MemoryTrustedOwnerStore } from '../src/trusted-owner-store.js';
import type { CadreNodeConfig } from '../src/types.js';

/**
 * What a node waiting to be claimed (`CadreNodeConfig.claim`, `CadreNode.isAwaitingClaim`)
 * lets a stranger do: the connection, so the claim seed can ride it, and nothing else —
 * its control-database streams and relay reservations are refused ahead of the
 * empty-anchor admission that an un-enrolled node without a claim secret gets. The claim
 * itself is the policy's (`seed-trust-policy-claim.spec.ts`); here it is modelled by the
 * anchor write the policy makes, after which the ordinary rules apply.
 *
 * Driven on the private predicates with the same fakes `cadre-node-authorized-surface.spec.ts`
 * injects: a running-looking node whose control database holds no member rows.
 */
describe('CadreNode admission while awaiting a claim', () => {
	const SELF = '12D3KooWSelf';
	const STRANGER = '12D3KooWStranger';
	const OWNER_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
	const REPO_PROTOCOL = '/optimystic/control-p/repo/1.0.0';

	interface Predicates {
		authorizeInboundControlStream(remotePeerId: string, protocol: string): boolean;
		admitControlRelayReservation(remotePeerId: string): Promise<boolean>;
		admitInboundControlConnection(remotePeerId: string): Promise<'admit' | 'admit-for-relay' | 'deny'>;
	}

	/** A started-looking node with an empty anchor, optionally waiting to be claimed. */
	function wire(claim?: CadreNodeConfig['claim']): { node: CadreNode; anchor: MemoryTrustedOwnerStore; predicates: Predicates } {
		const node = new CadreNode({ controlNetwork: { partyId: 'p', bootstrapNodes: [] }, profile: 'transaction', claim });
		const anchor = new MemoryTrustedOwnerStore('p');
		const internals = node as unknown as Record<string, unknown>;
		internals._running = true;
		internals.controlNode = { peerId: { toString: () => SELF } };
		internals.controlDatabase = { queryCadrePeers: async () => [], queryRevokedStamps: async () => new Set<string>() };
		internals.trustedOwnerStore = anchor;
		return { node, anchor, predicates: node as unknown as Predicates };
	}

	it('admits a stranger\'s connection, refuses its streams and reservations, and admits streams once claimed', async () => {
		const { node, anchor, predicates } = wire({ secret: randomBytes(256, 'base64url') as string });
		expect(node.isAwaitingClaim()).toBe(true);

		expect(await predicates.admitInboundControlConnection(STRANGER)).toBe('admit');
		expect(predicates.authorizeInboundControlStream(STRANGER, REPO_PROTOCOL)).toBe(false);
		expect(await predicates.admitControlRelayReservation(STRANGER)).toBe(false);

		// The claim policy's commit point is this anchor write; the gates read it live.
		await anchor.trust(OWNER_KEY, 'claim');
		expect(node.isAwaitingClaim()).toBe(false);
		// The replication cold start the claimant's own streams need: empty authorized snapshot, admitted.
		expect(predicates.authorizeInboundControlStream(STRANGER, REPO_PROTOCOL)).toBe(true);
		expect(await predicates.admitControlRelayReservation(STRANGER)).toBe(true);

		// The refusal is keyed on the claim, not on the empty anchor: the same node with no
		// claim secret is the un-enrolled shape that must take replication from its siblings.
		const unenrolled = wire();
		expect(unenrolled.node.isAwaitingClaim()).toBe(false);
		expect(unenrolled.predicates.authorizeInboundControlStream(STRANGER, REPO_PROTOCOL)).toBe(true);
		expect(await unenrolled.predicates.admitControlRelayReservation(STRANGER)).toBe(true);
	});
});
