/**
 * A join asked for while the inviter is offline finishes after the joiner restarts, with no
 * further call from the app (gotchoices/sereus#25: `CadreNode.requestJoin` and the retry loop
 * in cadre-core's `pending-join-runner.ts`).
 *
 * ── Topology ──
 *
 *   HOST   — its own party, sole owner. Founds a CLOSED strand and publishes a single-use
 *            invitation bound to it, then stops. It later restarts on the same identity,
 *            storage and port, so the invitation's address reaches it again, and relaunches
 *            its strand.
 *   JOINER — another party's genesis owner. Asks to join while the host is stopped
 *            (`requestJoin` answers `waiting`), then restarts on the same identity and storage.
 *
 * After both restarts the joiner's loop finishes the join from its stored `PendingJoin` row:
 * `pendingJoin:changed` reaches `joined`, the strand is offered as `strand:discovered`, and once
 * claimed the joiner's party is seated as a `Strand.Member` through the membership invitation
 * the approval carried.
 *
 * Both parties declare a 100 ms link, so a retry comes 5 s after a failure rather than 39 s
 * (`formationDeadlines`). Each restart is a new `CadreNode` over the same raw stores, as
 * `control-offline-read-after-restart` does it.
 */

import { describe, it, expect } from 'vitest';
import { generateKeyPair } from '@libp2p/crypto/keys';
import type { PrivateKey } from '@libp2p/interface';
import {
	CadreNode,
	ed25519KeyPairFromLibp2p,
	generateStrandMemberKey,
	isStrandMember,
	strandMemberKeyPair,
} from '@serfab/cadre-core';
import type { PendingJoinStatus, SAppConfig, StrandInstance } from '@serfab/cadre-core';
import {
	controlNodeConfig,
	createSignedSAppConfig,
	captureRawStorage,
	waitUntil,
	type RawStorageCapture,
} from '../harness/index.js';

const SIMPLE_SCHEMA = `
table Data (
    Key text primary key,
    Val text
);
`;

const SAPP_ID = 'sapp-pending-join-restart';
const YEAR_MS = 365 * 24 * 3600_000;
const LINK_ROUND_TRIP_MS = 100;
const STRAND_WATCH_MS = 1_000;
const CONVERGE_BUDGET_MS = 90_000;

/** What one machine keeps across a restart. */
interface Machine {
	partyId: string;
	key: PrivateKey;
	capture: RawStorageCapture;
	listenAddrs?: string[];
}

function nodeFor(machine: Machine): CadreNode {
	const config = controlNodeConfig({
		partyId: machine.partyId,
		privateKey: machine.key,
		storageProvider: machine.capture.provider,
		strandWatchMs: STRAND_WATCH_MS,
		...(machine.listenAddrs ? { listenAddrs: machine.listenAddrs } : {}),
	});
	return new CadreNode({ ...config, network: { ...config.network, linkRoundTripMs: LINK_ROUND_TRIP_MS } });
}

/**
 * Start `machine` and wire its owner key, as an app does on every launch
 * (`runOwnerGenesis` in the reference apps). `beforeStart` subscribes to events first.
 */
async function startOwner(machine: Machine, running: Set<CadreNode>, beforeStart?: (node: CadreNode) => void): Promise<CadreNode> {
	const node = nodeFor(machine);
	beforeStart?.(node);
	running.add(node);
	await node.start();
	const { privateKeyB64, publicKeyB64 } = ed25519KeyPairFromLibp2p(machine.key);
	await node.getControlDatabase()!.ensureOwnerKey(publicKeyB64);
	await node.initializeSeedBootstrap(privateKeyB64);
	return node;
}

async function stopNode(node: CadreNode, running: Set<CadreNode>): Promise<void> {
	running.delete(node);
	await node.stop();
}

/** The loopback port `node` listens on, as a listen address a restart can bind again. */
function sameListenAddr(node: CadreNode): string {
	const port = node.getMultiaddrs().map(String)
		.map((addr) => /^\/ip4\/127\.0\.0\.1\/tcp\/(\d+)\/ws/.exec(addr)?.[1])
		.find((found) => found !== undefined);
	if (!port) throw new Error(`no loopback listen address among ${node.getMultiaddrs().join(', ')}`);
	return `/ip4/127.0.0.1/tcp/${port}/ws`;
}

/** Claim `strandId` from `strand:discovered` with the app's config and wait until it is writable. */
async function claim(node: CadreNode, strandId: string, sApp: SAppConfig, label: string): Promise<StrandInstance> {
	await waitUntil(() => node.getDiscoveredStrands().has(strandId), {
		timeoutMs: CONVERGE_BUDGET_MS, intervalMs: 250, description: `${label} is offered ${strandId}`,
	});
	await node.addStrand({ strandRow: node.getDiscoveredStrands().get(strandId)!, sAppConfig: sApp, awaitFirstSync: false });
	return node.whenStrandWritable(strandId, { timeoutMs: CONVERGE_BUDGET_MS });
}

describe('Pending join across a restart', () => {
	it('finishes a join asked for while the inviter was stopped, after the joiner restarts', async () => {
		const runTag = Date.now();
		const running = new Set<CadreNode>();
		try {
			const host: Machine = { partyId: `host-${runTag}`, key: await generateKeyPair('Ed25519'), capture: captureRawStorage() };
			const joiner: Machine = { partyId: `joiner-${runTag}`, key: await generateKeyPair('Ed25519'), capture: captureRawStorage() };
			const strandId = `strand-pending-join-${runTag}`;
			const sApp = createSignedSAppConfig(SIMPLE_SCHEMA, '1.0.0');

			// ── Step 1: the host founds a closed strand, publishes a bound invitation, and stops ──
			let hostNode = await startOwner(host, running);
			await hostNode.foundStrand({ strandId, type: 'c', memberPrivateKey: await generateStrandMemberKey(), sAppConfig: sApp });
			const invitation = await hostNode.createOpenInvitation(SAPP_ID, YEAR_MS);
			await hostNode.publishFormationInvite(invitation.token, SAPP_ID, { strandId, expiresAtMs: Date.now() + YEAR_MS, totalUses: 1 });
			host.listenAddrs = [sameListenAddr(hostNode)];
			await stopNode(hostNode, running);

			// ── Step 2: the joiner asks to join while the host is down ──
			let joinerNode = await startOwner(joiner, running);
			const asked = await joinerNode.requestJoin(invitation, { purpose: 'pending join across a restart' });
			expect(asked).toMatchObject({ state: 'waiting', sAppId: SAPP_ID, lastError: { code: 'unreachable' } });
			expect((await joinerNode.listPendingJoins()).map((status) => status.id)).toEqual([asked.id]);
			await stopNode(joinerNode, running);

			// ── Step 3: the joiner restarts; only its stored row asks for the join now ──
			const statuses: PendingJoinStatus[] = [];
			joinerNode = await startOwner(joiner, running, (node) => node.on('pendingJoin:changed', (status) => statuses.push(status)));

			// ── Step 4: the host comes back at the invitation's address and relaunches its strand ──
			hostNode = await startOwner(host, running);
			await claim(hostNode, strandId, sApp, 'the restarted host');

			// ── Step 5: the joiner's loop finishes the join ──
			await waitUntil(() => statuses.some((status) => status.id === asked.id && status.state === 'joined'), {
				timeoutMs: CONVERGE_BUDGET_MS, intervalMs: 250, description: "the restarted joiner's loop reports the join",
			});
			expect(statuses.find((status) => status.state === 'joined')?.strandId).toBe(strandId);
			const row = await joinerNode.getControlDatabase()!.queryPendingJoin(asked.id);
			expect(row).toMatchObject({ Outcome: 'joined', StrandId: strandId, FailureCode: null });
			expect(row!.MembershipInvite, "a closed strand's approval carries the joiner's membership invitation").not.toBeNull();

			// ── Step 6: the strand is offered, claimed, and the joiner's party seated ──
			const instance = await claim(joinerNode, strandId, sApp, 'the restarted joiner');
			const partyKey = await joinerNode.getControlDatabase()!.queryStrandPartyKey(strandId);
			expect(partyKey, 'the join seated this party\'s StrandPartyKey').not.toBeNull();
			const memberKey = strandMemberKeyPair(partyKey!).publicKeyB64;
			await waitUntil(() => isStrandMember(instance.database!.getDatabase(), memberKey), {
				timeoutMs: CONVERGE_BUDGET_MS, intervalMs: 500, description: "the joiner's party is a Strand.Member",
			});
		} finally {
			for (const node of running) {
				await node.stop().catch((error: unknown) => console.warn('[pending-join-restart] node teardown failed:', error));
			}
		}
	}, 300_000);
});
