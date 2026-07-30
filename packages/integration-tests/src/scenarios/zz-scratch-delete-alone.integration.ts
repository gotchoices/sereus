/**
 * SCRATCH experiment (plan stage, control-delete-while-alone-tombstone).
 * DELETE THIS FILE after the experiment settles. Not a regression test yet.
 *
 * v1 finding: blocking dials does NOT produce a local-only commit — Optimystic's
 * cluster for the block still contained B (FRET retains it after the connection
 * closes), so `pend` dialed out and the write FAILED with
 * "Failed to get super-majority". So "0 libp2p connections" != "cluster <= 1".
 *
 * v2 therefore reproduces the only shape that really commits local-only: the
 * writer's FRET table does not know the sibling at all. A restarts on the SAME
 * storage while B is DOWN, removes X, and only then does B come back.
 */

import { describe, it, expect } from 'vitest';
import { generateKeyPair } from '@libp2p/crypto/keys';
import type { PrivateKey } from '@libp2p/interface';
import { MemoryRawStorage } from '@optimystic/db-p2p';
import { CadreNode, ed25519KeyPairFromLibp2p } from '@serfab/cadre-core';
import {
	waitUntil,
	waitForCadrePeerConverged,
	connectControlNodes,
	randomPeerId,
	wsTransports,
} from '../harness/index.js';

function nodeOn(
	partyId: string,
	privateKey: PrivateKey,
	store: MemoryRawStorage,
	profile: 'storage' | 'transaction',
): CadreNode {
	return new CadreNode({
		controlNetwork: { partyId, bootstrapNodes: [] },
		profile,
		strandFilter: { mode: 'all' },
		storage: { provider: () => store },
		privateKey,
		network: { transports: wsTransports(), listenAddrs: ['/ip4/127.0.0.1/tcp/0/ws'] },
		hibernation: { enabled: false },
	});
}

function conns(node: CadreNode): number {
	return node.getControlNode()!.getConnections().length;
}

describe('SCRATCH delete-while-alone v2', () => {
	it('does a genuinely local-only removePeer reach a sibling that already has the row?', async () => {
		const partyId = `ctrl-scratch-del-${Date.now()}`;
		const aKey = await generateKeyPair('Ed25519');
		const bKey = await generateKeyPair('Ed25519');
		const storeA = new MemoryRawStorage();
		const storeB = new MemoryRawStorage();
		const { privateKeyB64, publicKeyB64 } = ed25519KeyPairFromLibp2p(aKey);

		let A: CadreNode | undefined;
		let B: CadreNode | undefined;
		const xPeerId = await randomPeerId();
		try {
			// ── Phase 1: A + B up, X authorized, converged on B ──────────────────
			A = nodeOn(partyId, aKey, storeA, 'storage');
			await A.start();
			await A.getControlDatabase()!.insertOwnerKey(publicKeyB64);
			A.initializeSeedBootstrap(privateKeyB64);

			B = nodeOn(partyId, bKey, storeB, 'transaction');
			await B.start();
			await A.authorizePeer(B.peerId!.toString());

			await connectControlNodes(B, A);
			await A.authorizePeer(xPeerId);
			await waitForCadrePeerConverged(B.getControlDatabase()!, xPeerId, {
				timeoutMs: 30_000,
				description: 'B observes X before the removal',
			});
			expect(await B.isMember(xPeerId)).toBe(true);

			// ── Phase 2: B goes DOWN, A restarts on the same storage ─────────────
			await B.stop();
			B = undefined;
			await A.stop();
			A = nodeOn(partyId, aKey, storeA, 'storage');
			await A.start();
			A.initializeSeedBootstrap(privateKeyB64);
			// A must still hold X locally (storage survived the restart).
			expect(await A.isMember(xPeerId)).toBe(true);
			// eslint-disable-next-line no-console
			console.log('[scratch] after restart: A conns=%d', conns(A));

			// ── Phase 3: the write under test — remove X while truly alone ───────
			await A.removePeer(xPeerId);
			// eslint-disable-next-line no-console
			console.log('[scratch] post-remove: A conns=%d isMember(X)=%s', conns(A), await A.isMember(xPeerId));
			expect(await A.isMember(xPeerId)).toBe(false);

			// ── Phase 4: B comes back and reconnects ─────────────────────────────
			B = nodeOn(partyId, bKey, storeB, 'transaction');
			await B.start();
			expect(await B.isMember(xPeerId)).toBe(true);
			await connectControlNodes(B, A);

			const dropped = async (): Promise<boolean> => !(await B!.isMember(xPeerId));
			let droppedOnReconnect = false;
			try {
				await waitUntil(dropped, { timeoutMs: 20_000, intervalMs: 500, description: 'B drops X on reconnect' });
				droppedOnReconnect = true;
			} catch { /* recorded below */ }
			// eslint-disable-next-line no-console
			console.log('[scratch] RESULT droppedOnReconnect=%s', droppedOnReconnect);

			let droppedAfterBroadcast = droppedOnReconnect;
			if (!droppedOnReconnect) {
				await A.registerSelf();
				const yPeerId = await randomPeerId();
				await A.authorizePeer(yPeerId);
				try {
					await waitUntil(dropped, { timeoutMs: 20_000, intervalMs: 500, description: 'B drops X after broadcast' });
					droppedAfterBroadcast = true;
				} catch { /* recorded below */ }
				// eslint-disable-next-line no-console
				console.log('[scratch] Y converged on B=%s', await B.isMember(yPeerId));
			}
			// eslint-disable-next-line no-console
			console.log('[scratch] RESULT droppedAfterBroadcast=%s', droppedAfterBroadcast);
			// eslint-disable-next-line no-console
			console.log('[scratch] B revoked CadrePeer stamps=%d',
				(await B.getControlDatabase()!.queryRevokedStamps('CadrePeer')).size);
		} finally {
			await B?.stop();
			await A?.stop();
		}
	}, 240_000);
});
