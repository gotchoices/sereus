import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';

import type { CadreInvitation } from '../src/cadre-invite-protocol.js';
import { encodeNodeClaimPayload, type NodeClaimPayload } from '../src/node-claim-payload.js';
import type { CreateContainerBody, ProviderClient, RentedContainer } from '../src/provider/client.js';
import { RENTAL_INVITATION_TTL_MS, rentNode, type RentNodeStep, type RentingNode } from '../src/provider/rent-node.js';
import type { CadreInvitationReach, CreateCadreInvitationOptions } from '../src/types.js';

/**
 * `rentNode` over hand-written `RentingNode` and `ProviderClient` objects (no module mocks):
 * which join path it takes from the invitation's reach, and what each path asks of the node and
 * the provider.
 */

interface FakeNode extends RentingNode {
	minted: CreateCadreInvitationOptions[];
	withdrawn: string[];
	claimed: NodeClaimPayload[];
}

function fakeNode(reach: CadreInvitationReach): FakeNode {
	const node: FakeNode = {
		partyId: 'party-1',
		minted: [],
		withdrawn: [],
		claimed: [],
		isOwner: async () => true,
		invitationReach: async () => reach,
		createCadreInvitation: async (options) => {
			node.minted.push(options);
			return { invitation: { invite: { key: 'invite-key' } } as unknown as CadreInvitation, encoded: 'sereus-invite:1.bundle', reach };
		},
		withdrawCadreInvitation: async (key) => { node.withdrawn.push(key); return true; },
		claimNode: async (payload) => { node.claimed.push(payload); },
	};
	return node;
}

function container(id: string, join: 'claim' | 'invitation'): RentedContainer {
	return { id, partyId: join === 'claim' ? 'unclaimed' : 'party-1', profile: 'storage', status: 'creating', createdAt: 0, updatedAt: 0, join: { kind: join }, tags: {} };
}

interface FakeClient extends ProviderClient {
	created: CreateContainerBody[];
	codeRequests: number;
}

/** A provider whose node code is not ready on the first ask; `createFails` makes the create throw. */
function fakeClient(code: { code: string; peerId: string; multiaddrs: string[] }, createFails = false): FakeClient {
	const unexpected = (what: string) => async (): Promise<never> => { throw new Error(`${what} not expected here`); };
	const client: FakeClient = {
		created: [],
		codeRequests: 0,
		createContainer: async (body) => {
			if (createFails) throw new Error('403 QUOTA_EXCEEDED');
			client.created.push(body);
			return container(`ctr_${client.created.length}`, body.join.kind);
		},
		getNodeCode: async () => (++client.codeRequests === 1 ? { notReady: true } : code),
		getContainer: unexpected('getContainer'),
		listContainers: unexpected('listContainers'),
		deleteContainer: unexpected('deleteContainer'),
		getBillingStatus: unexpected('getBillingStatus'),
	};
	return client;
}

async function nodeCode(): Promise<{ payload: NodeClaimPayload; code: { code: string; peerId: string; multiaddrs: string[] } }> {
	const peerId = peerIdFromPrivateKey(await generateKeyPair('Ed25519')).toString();
	const payload = { peerId, multiaddrs: [`/dns4/nodes.example/tcp/10004/ws/p2p/${peerId}`], secret: randomBytes(32).toString('base64url') };
	return { payload, code: { code: encodeNodeClaimPayload(payload), peerId, multiaddrs: payload.multiaddrs } };
}

describe('rentNode', () => {
	it('invites when a member is reachable from anywhere: one single-use non-owner invitation, a create with it, no claim', async () => {
		const node = fakeNode('anywhere');
		const client = fakeClient((await nodeCode()).code);
		const steps: RentNodeStep[] = [];

		const result = await rentNode(node, client, { onProgress: (step) => steps.push(step) });

		expect(node.minted).toEqual([{ grantsOwner: false, uses: 1, expiresInMs: RENTAL_INVITATION_TTL_MS }]);
		expect(client.created).toEqual([{ join: { kind: 'invitation', invitation: 'sereus-invite:1.bundle' }, profile: 'storage' }]);
		expect(node.claimed).toEqual([]);
		expect(client.codeRequests).toBe(0);
		expect(result).toEqual({ containerId: 'ctr_1', join: 'invitation' });
		expect(steps).toEqual(['inviting', 'creating', 'done']);
	});

	it('claims when only the issuer is reachable: a claim create, the code polled past one not-ready answer, then the decoded payload claimed', async () => {
		const node = fakeNode('issuer-only');
		const { payload, code } = await nodeCode();
		const client = fakeClient(code);
		const steps: RentNodeStep[] = [];

		const result = await rentNode(node, client, { nodeCodePollMs: 1, onProgress: (step) => steps.push(step) });

		expect(client.created).toEqual([{ join: { kind: 'claim' }, profile: 'storage' }]);
		expect(client.codeRequests).toBe(2);
		expect(node.claimed).toEqual([payload]);
		expect(node.minted).toEqual([]);
		expect(result).toEqual({ containerId: 'ctr_1', join: 'claim', peerId: payload.peerId });
		expect(steps).toEqual(['creating', 'waiting-for-code', 'claiming', 'done']);
	});

	it('withdraws the invitation when the create fails, and rethrows the create\'s error', async () => {
		const node = fakeNode('anywhere');
		const client = fakeClient((await nodeCode()).code, true);

		await expect(rentNode(node, client)).rejects.toThrow(/QUOTA_EXCEEDED/);

		expect(node.minted).toHaveLength(1);
		expect(node.withdrawn).toEqual(['invite-key']);
		expect(client.created).toEqual([]);
	});
});
