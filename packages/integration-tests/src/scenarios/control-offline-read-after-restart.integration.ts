/**
 * Offline read after an offline restart — the property the control network's peer-join
 * block catch-up (`cadre-core`'s `peer-join-backfill.ts`, wired for the control network in
 * `CadreNode.startControlBackfill`) exists for.
 *
 * A cadre member that has fully converged the party's control database over the network
 * can still be missing the *storage blocks* that database is made of: a block committed
 * while its writer was alone has a cohort of one, and the named collection-header blocks
 * (`default/CadrePeer`, `default/OwnerKey`, …) are written exactly once, at collection
 * creation during the founder's solo genesis — their revision never moves again, so no
 * later commit ever carries them to a member that joined after them. While the member is
 * connected that gap is invisible (reads resolve a coordinator that answers from the
 * founder's storage); the moment it restarts with no connections, every table whose
 * header it never received reads as EMPTY — silently, with no error. `isMember()` answers
 * false for peers the node demonstrably knew about before it stopped.
 *
 * So this scenario asserts the property at both layers, per the ticket's test plan:
 *
 * 1. PHYSICAL — the joiner's own raw control store covers the founder's whole store
 *    (headers included) while both nodes are still up. Asserted through the raw store,
 *    never the joiner's database, because reading through the database is exactly the
 *    thing that can mask the gap (see `block-store-probe.ts`).
 * 2. BEHAVIOURAL — after BOTH nodes stop and the joiner restarts ALONE (zero
 *    connections, empty FRET view), it still answers reads over TWO control tables:
 *    `CadrePeer` (`isMember`) and `OwnerKey` (`getOwnerKeys`) — covering the class, not
 *    just the collection the defect was found on
 *    (`control-delete-while-alone-convergence.integration.ts:154`).
 *
 * Before the catch-up was wired for the control network, whether the joiner held a given
 * header was a hash-proximity coin flip between the fixed block id and the run's random
 * peer ids — the measured failure rate of the delete-while-alone scenario was ~45% of
 * cases. A single green run of this file therefore proves little; the gate is a series.
 */

import { describe, it, expect } from 'vitest';
import { generateKeyPair } from '@libp2p/crypto/keys';
import type { PrivateKey } from '@libp2p/interface';
import type { IRawStorage } from '@optimystic/db-p2p';
import { CadreNode, ed25519KeyPairFromLibp2p } from '@serfab/cadre-core';
import {
	waitUntil,
	waitForCadrePeerConverged,
	connectControlNodes,
	randomPeerId,
	wsTransports,
	captureRawStorage,
	compareBlockCoverage,
	blockCoverageIsComplete,
	formatBlockCoverageGap,
	readBlockIndex,
	type RawStorageCapture,
} from '../harness/index.js';

function nodeOn(
	partyId: string,
	privateKey: PrivateKey,
	capture: RawStorageCapture,
	profile: 'storage' | 'transaction',
): CadreNode {
	return new CadreNode({
		controlNetwork: { partyId, bootstrapNodes: [] },
		profile,
		strandFilter: { mode: 'all' },
		storage: { provider: capture.provider },
		privateKey,
		network: { transports: wsTransports(), listenAddrs: ['/ip4/127.0.0.1/tcp/0/ws'] },
		hibernation: { enabled: false },
	});
}

/** The joiner's control store, from its capture — the store the restarted node reads. */
function controlStore(capture: RawStorageCapture): IRawStorage {
	// The capture's provider keys by scope; 'control' is the CadreNode control scope.
	return capture.provider('control');
}

describe('Control-network peer-join block catch-up', () => {
	it('a member restarted ALONE still reads rows it converged before stopping (CadrePeer + OwnerKey)', async () => {
		const partyId = `ctrl-offline-read-${Date.now()}`;
		const aKey = await generateKeyPair('Ed25519');
		const bKey = await generateKeyPair('Ed25519');
		const captureA = captureRawStorage();
		const captureB = captureRawStorage();
		const { privateKeyB64, publicKeyB64 } = ed25519KeyPairFromLibp2p(aKey);
		const xPeerId = await randomPeerId();

		// ── Phase 1: founder A up alone — its genesis writes the collection headers
		// with a cohort of one, which is exactly the single-holder state under test.
		let A: CadreNode | undefined = nodeOn(partyId, aKey, captureA, 'storage');
		let B: CadreNode | undefined;
		try {
			await A.start();
			await A.getControlDatabase()!.insertOwnerKey(publicKeyB64);
			A.initializeSeedBootstrap(privateKeyB64);

			// ── Phase 2: B joins; a third peer X is authorized and converges onto B ──
			B = nodeOn(partyId, bKey, captureB, 'transaction');
			await B.start();
			// Vouch B BEFORE the dial so A's inbound gate admits it — and so A's
			// push-time membership gate authorizes the catch-up push to it.
			await A.authorizePeer(B.peerId!.toString());
			await connectControlNodes(B, A);
			await A.authorizePeer(xPeerId);
			await waitForCadrePeerConverged(B.getControlDatabase()!, xPeerId, {
				timeoutMs: 30_000,
				description: 'B observes X before the stop',
			});
			expect(await B.isMember(xPeerId)).toBe(true);

			// ── Phase 3: the PHYSICAL gate — B's own raw store covers A's, headers
			// included. Raw stores only on both sides: nothing here reads through B's
			// database, so nothing here can pull a block in and mask the gap.
			const storeA = controlStore(captureA);
			const storeB = controlStore(captureB);
			let lastGap = '';
			await waitUntil(async () => {
				const gap = await compareBlockCoverage(storeA, storeB);
				lastGap = formatBlockCoverageGap(gap);
				return blockCoverageIsComplete(gap);
			}, {
				timeoutMs: 30_000,
				intervalMs: 250,
				description: 'peer-join catch-up covers B\'s raw control store (last gap: see failure message)',
			}).catch((error) => {
				throw new Error(`${(error as Error).message} — last coverage gap: ${lastGap}`);
			});
			// The two collection headers this file's behavioural reads depend on, named
			// explicitly so a coverage regression fails naming the load-bearing blocks.
			const indexB = await readBlockIndex(storeB);
			expect([...indexB.keys()]).toEqual(expect.arrayContaining(['default/CadrePeer', 'default/OwnerKey']));

			// ── Phase 4: both nodes stop; B restarts ALONE on its own storage ──
			await B.stop();
			B = undefined;
			await A.stop();
			A = undefined;

			B = nodeOn(partyId, bKey, captureB, 'transaction');
			await B.start();
			expect(B.getControlNode()!.getConnections().length).toBe(0);

			// The headers survived the restart in B's OWN store (nothing was lost at
			// shutdown — and nothing could have been fetched since).
			const indexAfter = await readBlockIndex(controlStore(captureB));
			expect([...indexAfter.keys()]).toEqual(expect.arrayContaining(['default/CadrePeer', 'default/OwnerKey']));

			// ── The property: two control tables answer from B's own storage ──
			expect(await B.isMember(xPeerId)).toBe(true);
			const ownerKeys = await B.getControlDatabase()!.getOwnerKeys();
			expect(ownerKeys.has(publicKeyB64)).toBe(true);
		} finally {
			await B?.stop();
			await A?.stop();
		}
	}, 240_000);
});
