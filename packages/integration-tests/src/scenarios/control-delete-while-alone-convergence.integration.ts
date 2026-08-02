/**
 * Delete-while-alone re-replication over the live control network — the DELETE
 * counterpart of `control-write-while-alone-convergence.integration.ts`.
 *
 * A removal (`removePeer`) that commits while the owner is ALONE deletes the
 * `CadrePeer` row and writes a `CadreControl.Revocation` tombstone in the same
 * transaction — both local-only. The row itself can never be re-replicated (it
 * is gone), so durability rides entirely on the tombstone: `CadreNode` queues it
 * (in-session) or sweeps every locally-held tombstone (first cohort growth after
 * a process start) and re-issues it with an owner-signed monotonic `ReissuedAt`
 * bump on the 0→≥1 control-connection growth edge. A sibling that still holds
 * the removed row then retires its stamp — membership reads treat a retired
 * stamp as absent, even though the row is not physically deleted there.
 *
 * "Alone" is stricter than "0 libp2p connections": with the sibling still in
 * Optimystic's FRET routing table the write DIALS OUT and fails with
 * "Failed to get super-majority" instead of committing local-only. The only
 * shape that truly commits alone is a writer whose FRET table does not know the
 * sibling at all — hence the restart choreography here: B goes down, then A
 * restarts on the SAME storage (rows survive, FRET view empty) before removing.
 *
 * Both tests exercise the FIRST-GROWTH SWEEP (the remove commits in a process
 * whose in-memory queue is then discarded — test 2 restarts A once more after
 * the removal to prove the sweep needs nothing in memory; in test 1 the removal
 * itself happens in the freshly-restarted process, so its entry is also queued
 * in-session). The in-session queue path is covered by
 * `packages/cadre-core/test/cadre-node-control-replication.spec.ts`.
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

interface AloneRemoval {
	partyId: string;
	aKey: PrivateKey;
	privateKeyB64: string;
	storeA: MemoryRawStorage;
	storeB: MemoryRawStorage;
	bKey: PrivateKey;
	xPeerId: string;
	xStampId: string;
	/** A, restarted and having just removed X while alone. Caller owns stop(). */
	A: CadreNode;
}

/**
 * Phases 1–3 shared by both tests: converge X onto B, take B down, restart A on
 * the same storage (zero connections AND an empty FRET view of B), then remove X
 * — the commit that is genuinely local-only. Returns with A live and B down.
 *
 * Phase order matters: A vouches B BEFORE `connectControlNodes(B, A)` so A's
 * inbound gate admits B's dial, and after every A restart
 * `initializeSeedBootstrap` runs BEFORE any sibling connects — the growth-edge
 * drain is owner-gated (`canAuthorize()`), so a drain fired before the seed
 * bootstrap re-wire would drop the queued tombstone instead of re-issuing it.
 */
async function removeWhileAlone(tag: string): Promise<AloneRemoval> {
	const partyId = `ctrl-del-alone-${tag}-${Date.now()}`;
	const aKey = await generateKeyPair('Ed25519');
	const bKey = await generateKeyPair('Ed25519');
	const storeA = new MemoryRawStorage();
	const storeB = new MemoryRawStorage();
	const { privateKeyB64, publicKeyB64 } = ed25519KeyPairFromLibp2p(aKey);
	const xPeerId = await randomPeerId();

	// ── Phase 1: A + B up, X authorized, X converged on B ────────────────────
	let A = nodeOn(partyId, aKey, storeA, 'storage');
	let B: CadreNode | undefined;
	try {
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
		// ADDRESSABLE surface (`isMember` — row presence), as in the write-alone
		// scenario: B pins no owner key, so trust-facing reads are out of scope.
		expect(await B.isMember(xPeerId)).toBe(true);

		// ── Phase 2: B goes DOWN, A restarts on the same storage ───────────────
		await B.stop();
		B = undefined;
		await A.stop();
		A = nodeOn(partyId, aKey, storeA, 'storage');
		await A.start();
		// OwnerKey row survived on storeA — only the seed-bootstrap wiring is
		// per-process. No re-insert.
		A.initializeSeedBootstrap(privateKeyB64);
		expect(await A.isMember(xPeerId)).toBe(true);
		expect(A.getControlNode()!.getConnections().length).toBe(0);

		// ── Phase 3: the write under test — remove X while truly alone ─────────
		// The stamp the delete retires, captured BEFORE the row disappears; the
		// tombstone B must converge on is keyed by it.
		const xStampId = await A.getControlDatabase()!.queryCadrePeerStampId(xPeerId);
		expect(xStampId).not.toBeNull();
		await A.removePeer(xPeerId);
		expect(await A.isMember(xPeerId)).toBe(false);
		expect(A.getControlNode()!.getConnections().length).toBe(0);

		return { partyId, aKey, privateKeyB64, storeA, storeB, bKey, xPeerId, xStampId: xStampId!, A };
	} catch (error) {
		await A.stop();
		throw error;
	} finally {
		// Success path leaves B stopped-and-undefined after Phase 2; any failure
		// path still holding B lands here (stop() is idempotent).
		await B?.stop();
	}
}

/**
 * Phase 4 shared by both tests: B comes back on its own storage (still holding
 * X's row), reconnects, and must converge on the removal — `isMember(X)` flips
 * false once the re-issued tombstone lands and retires X's stamp.
 */
async function expectRemovalConverges(ctx: AloneRemoval, B: CadreNode): Promise<void> {
	// B still holds the row it converged on before going down.
	expect(await B.isMember(ctx.xPeerId)).toBe(true);

	// Reconnect — A's 0→≥1 growth edge re-issues the tombstone, which now broadcasts.
	await connectControlNodes(B, ctx.A);

	await waitUntil(async () => !(await B.isMember(ctx.xPeerId)), {
		timeoutMs: 30_000,
		intervalMs: 500,
		description: 'B drops X once the re-issued Revocation tombstone converges',
	});
	expect(await B.isMember(ctx.xPeerId)).toBe(false);
	const revoked = await B.getControlDatabase()!.queryRevokedStamps('CadrePeer');
	expect(revoked.has(ctx.xStampId)).toBe(true);
}

describe('Control-DB delete-while-alone re-replication', () => {
	it('converges a removePeer committed while alone, once the sibling reconnects', async () => {
		let ctx: AloneRemoval | undefined;
		let B: CadreNode | undefined;
		try {
			ctx = await removeWhileAlone('reconnect');

			// ── Phase 4: B comes back and reconnects ───────────────────────────────
			B = nodeOn(ctx.partyId, ctx.bKey, ctx.storeB, 'transaction');
			await B.start();
			await expectRemovalConverges(ctx, B);
		} finally {
			await B?.stop();
			await ctx?.A.stop();
		}
	}, 240_000);

	it('survives ANOTHER restart of the remover before any connection (first-growth sweep)', async () => {
		let ctx: AloneRemoval | undefined;
		let B: CadreNode | undefined;
		try {
			ctx = await removeWhileAlone('sweep');

			// ── Phase 3b: restart A AGAIN, still with no connections ───────────────
			// The process that committed the removal dies with its in-memory queue;
			// the fresh process holds only the durable tombstone row. The first
			// cohort growth after start must SWEEP it — nothing in memory points at it.
			await ctx.A.stop();
			ctx.A = nodeOn(ctx.partyId, ctx.aKey, ctx.storeA, 'storage');
			await ctx.A.start();
			ctx.A.initializeSeedBootstrap(ctx.privateKeyB64);
			expect(await ctx.A.isMember(ctx.xPeerId)).toBe(false);
			expect(ctx.A.getControlNode()!.getConnections().length).toBe(0);

			// ── Phase 4: only now does B come back ─────────────────────────────────
			B = nodeOn(ctx.partyId, ctx.bKey, ctx.storeB, 'transaction');
			await B.start();
			await expectRemovalConverges(ctx, B);
		} finally {
			await B?.stop();
			await ctx?.A.stop();
		}
	}, 240_000);
});
