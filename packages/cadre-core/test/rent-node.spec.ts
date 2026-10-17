import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';

import type { CadreInvitation } from '../src/cadre-invite-protocol.js';
import { encodeNodeClaimPayload, type NodeClaimPayload } from '../src/node-claim-payload.js';
import { ProviderApiError, type ContainerJoinState, type CreateContainerBody, type ProviderClient, type RentedContainer, type RentedContainerStatus, type RentedContainerStatusReport } from '../src/provider/client.js';
import { RENTAL_INVITATION_TTL_MS, finishRental, rentNode, type RentNodeError, type RentNodeStep, type RentingNode } from '../src/provider/rent-node.js';
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
		createCadreInvitation: async (options = {}) => {
			node.minted.push(options);
			return { invitation: { invite: { key: 'invite-key' } } as unknown as CadreInvitation, encoded: 'sereus-invite:1.bundle', reach };
		},
		withdrawCadreInvitation: async (key) => { node.withdrawn.push(key); return true; },
		claimNode: async (payload) => { node.claimed.push(payload); },
	};
	return node;
}

function container(id: string, join: 'claim' | 'invitation' | undefined, status: RentedContainerStatus = 'creating', peerId?: string): RentedContainer {
	const partyId = join === 'claim' ? 'unclaimed' : 'party-1';
	return { id, partyId, profile: 'storage', status, createdAt: 0, updatedAt: 0, ...(join ? { join: { kind: join } } : {}), ...(peerId ? { peerId } : {}), tags: {} };
}

type NodeCode = { code: string; peerId: string; multiaddrs: string[] };

interface FakeClient extends ProviderClient {
	created: CreateContainerBody[];
	codeRequests: number;
}

interface FakeClientOptions {
	code: NodeCode;
	createFails?: boolean;
	/** What `getContainer` answers, in order; the last answer repeats. */
	reports?: RentedContainerStatusReport[];
	/** The refusal `getNodeCode` throws once the code would be ready. */
	codeRefusal?: ProviderApiError;
}

/** A provider whose node code is not ready on the first ask; `createFails` makes the create throw. */
function fakeClient(options: FakeClientOptions): FakeClient {
	const unexpected = (what: string) => async (): Promise<never> => { throw new Error(`${what} not expected here`); };
	const reports = [...(options.reports ?? [])];
	const client: FakeClient = {
		created: [],
		codeRequests: 0,
		createContainer: async (body) => {
			if (options.createFails) throw new Error('403 QUOTA_EXCEEDED');
			client.created.push(body);
			return container(`ctr_${client.created.length}`, body.join.kind);
		},
		getNodeCode: async () => {
			if (++client.codeRequests === 1) return { notReady: true };
			if (options.codeRefusal) throw options.codeRefusal;
			return options.code;
		},
		getContainer: async () => {
			if (reports.length === 0) throw new Error('getContainer not expected here');
			return reports.length === 1 ? reports[0]! : reports.shift()!;
		},
		listContainers: unexpected('listContainers'),
		deleteContainer: unexpected('deleteContainer'),
		getBillingStatus: unexpected('getBillingStatus'),
	};
	return client;
}

function report(record: RentedContainer, join?: ContainerJoinState): RentedContainerStatusReport {
	return { container: { ...record, ...(join ? { joinState: join } : {}) }, ...(join ? { join } : {}) };
}

async function nodeCode(): Promise<{ payload: NodeClaimPayload; code: { code: string; peerId: string; multiaddrs: string[] } }> {
	const peerId = peerIdFromPrivateKey(await generateKeyPair('Ed25519')).toString();
	const payload = { peerId, multiaddrs: [`/dns4/nodes.example/tcp/10004/ws/p2p/${peerId}`], secret: randomBytes(32).toString('base64url') };
	return { payload, code: { code: encodeNodeClaimPayload(payload), peerId, multiaddrs: payload.multiaddrs } };
}

describe('rentNode', () => {
	it('invites when a member is reachable from anywhere: one single-use invitation, a create with it, no claim', async () => {
		const node = fakeNode('anywhere');
		const client = fakeClient({ code: (await nodeCode()).code });
		const steps: RentNodeStep[] = [];

		const result = await rentNode(node, client, { onProgress: (step) => steps.push(step) });

		expect(node.minted).toEqual([{ uses: 1, expiresInMs: RENTAL_INVITATION_TTL_MS }]);
		expect(client.created).toEqual([{ join: { kind: 'invitation', invitation: 'sereus-invite:1.bundle' }, profile: 'storage' }]);
		expect(node.claimed).toEqual([]);
		expect(client.codeRequests).toBe(0);
		expect(result).toEqual({ containerId: 'ctr_1', join: 'invitation' });
		expect(steps).toEqual(['inviting', 'creating', 'done']);
	});

	it('claims when only the issuer is reachable: a claim create, the code polled past one not-ready answer, then the decoded payload claimed', async () => {
		const node = fakeNode('issuer-only');
		const { payload, code } = await nodeCode();
		const client = fakeClient({ code });
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
		const client = fakeClient({ code: (await nodeCode()).code, createFails: true });

		await expect(rentNode(node, client)).rejects.toThrow(/QUOTA_EXCEEDED/);

		expect(node.minted).toHaveLength(1);
		expect(node.withdrawn).toEqual(['invite-key']);
		expect(client.created).toEqual([]);
	});
});

describe('finishRental', () => {
	const claimed = (partyId: string): ContainerJoinState => ({ kind: 'claim', state: 'claimed', ownerKey: 'owner', partyId });
	const refusal = (code: string): ProviderApiError => new ProviderApiError(409, code, code);

	/** Each row: what the provider reports (and, after a refused code, the re-read), and what the resume yields. */
	const cases: { name: string; reports: (peerId: string) => RentedContainerStatusReport[]; codeRefusal?: string; expect: 'claims' | 'done-claim' | 'done-invitation' | 'failed' | RentNodeError['code'] }[] = [
		{ name: 'a stopped container is gone', reports: () => [report(container('ctr_1', 'claim', 'stopped'))], expect: 'container-gone' },
		{ name: 'a container with no join was never a rental', reports: () => [report(container('ctr_1', undefined))], expect: 'not-a-rental' },
		{ name: 'a claim container not yet claimed is taken through the code and the claim', reports: () => [report(container('ctr_1', 'claim'), { kind: 'claim', state: 'awaiting' })], expect: 'claims' },
		{ name: 'a claim container claimed into this party is done without a second claim', reports: (peerId) => [report(container('ctr_1', 'claim', 'running', peerId), claimed('party-1'))], expect: 'done-claim' },
		{ name: 'a claim container claimed into another party is refused', reports: () => [report(container('ctr_1', 'claim', 'running'), claimed('party-2'))], expect: 'claimed-by-another' },
		{ name: 'a code refused as already claimed re-reads the record and judges it', reports: (peerId) => [report(container('ctr_1', 'claim')), report(container('ctr_1', 'claim', 'running', peerId), claimed('party-1'))], codeRefusal: 'ALREADY_CLAIMED', expect: 'done-claim' },
		{ name: 'a container that dies while the code is awaited is gone', reports: () => [report(container('ctr_1', 'claim'))], codeRefusal: 'CONTAINER_GONE', expect: 'container-gone' },
		{ name: 'an invitation container still pending is done; the app keeps watching', reports: () => [report(container('ctr_1', 'invitation'), { kind: 'invitation', state: 'pending' })], expect: 'done-invitation' },
		{ name: 'an invitation the node could not redeem is the failed outcome', reports: () => [report(container('ctr_1', 'invitation'), { kind: 'invitation', state: 'failed', error: 'no member answered', retryable: true })], expect: 'failed' },
	];

	it.each(cases)('$name', async ({ reports, codeRefusal, expect: expected }) => {
		const node = fakeNode('issuer-only');
		const { payload, code } = await nodeCode();
		const client = fakeClient({ code, reports: reports(payload.peerId), ...(codeRefusal ? { codeRefusal: refusal(codeRefusal) } : {}) });

		const run = finishRental(node, client, 'ctr_1', { nodeCodePollMs: 1 });

		switch (expected) {
			case 'claims':
				expect(await run).toEqual({ containerId: 'ctr_1', join: 'claim', peerId: payload.peerId });
				expect(node.claimed).toEqual([payload]);
				break;
			case 'done-claim':
				expect(await run).toEqual({ containerId: 'ctr_1', join: 'claim', peerId: payload.peerId });
				expect(node.claimed).toEqual([]);
				break;
			case 'done-invitation':
				expect(await run).toEqual({ containerId: 'ctr_1', join: 'invitation' });
				break;
			case 'failed':
				expect(await run).toEqual({ containerId: 'ctr_1', outcome: 'failed', error: 'no member answered', retryable: true });
				break;
			default:
				await expect(run).rejects.toMatchObject({ name: 'RentNodeError', code: expected, containerId: 'ctr_1' });
				expect(node.claimed).toEqual([]);
		}
		expect(client.created).toEqual([]);
	});
});
