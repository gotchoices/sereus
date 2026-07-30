/**
 * Write-while-alone re-replication over the live control network.
 *
 * The inverse of `control-db-two-node-convergence.integration.ts`. That scenario
 * CONNECTS BEFORE WRITING so the cohort is ≥2 and the commit broadcasts. This one
 * does the opposite — the writer authors a control row while it is ALONE (no
 * sibling connected), so Optimystic commits it **local-only** (the block's cluster
 * is ≤1, so nothing is broadcast). It then connects and asserts the row still
 * converges to the reader, proving `control-write-ensure-replicated`: the writer
 * re-issues its local-only writes on the 0→≥1 control-connection growth edge.
 *
 * Without the fix these tests HANG (the reader never observes the row) — they are
 * the regression guard for the write-while-alone durability gap.
 *
 * `bootPair` still boots A and B DISCONNECTED (no dial yet), but A vouches B
 * (`authorizePeer`) right after B starts — a control-DB write, not a dial — so that
 * A's inbound connection gate (`admitInboundControlConnection`) will later admit B's
 * connect attempt. Without the vouch, A's cold-start carve-out (which admits any
 * peer while A has zero authorized members) closes the moment this scenario's own
 * `authorizePeer(xPeerId)` write lands, and B's connect would be refused.
 *
 * The connection itself is still formed with a test-only manual `dial()` over the
 * public `getControlNode()` seam (as the sibling convergence scenario does) — that
 * only forms the cohort; the RE-REPLICATION of the pre-connection write is the
 * production behaviour under test and is NOT test-scaffolded.
 */

import { describe, it, expect } from 'vitest';
import type { CadreNode } from '@serfab/cadre-core';
import {
	waitUntil,
	waitForCadrePeerConverged,
	connectControlNodes,
	randomPeerId,
	bootPair,
} from '../harness/index.js';

// ═══════════════════════════════════════════════════════════════════════════════

describe('Control-DB write-while-alone re-replication', () => {
	it('re-replicates an owner CadrePeer row written while alone, once the cohort forms', async () => {
		let A: CadreNode | undefined;
		let B: CadreNode | undefined;
		try {
			({ A, B } = await bootPair('cadrepeer', 'ctrl-alone'));

			// WRITE BEFORE CONNECT: A authorizes X while B is disconnected → local-only commit.
			const xPeerId = await randomPeerId();
			await A.authorizePeer(xPeerId);
			expect(await A.isMember(xPeerId)).toBe(true);

			// Sanity: A is genuinely alone at write time (no control connections).
			// NOTE: holds because `bootPair` vouches B by peer id ALONE — A's copy of B's
			// CadrePeer row carries no multiaddr, so A's cohort reconcile has nothing to
			// dial. If the vouch ever carries B's addresses, A could connect to B here and
			// this assertion (and the write-while-alone premise) would break.
			expect(A.getControlNode()!.getConnections().length).toBe(0);

			// NOW connect. A's connection:open drains the queue and re-issues the X write,
			// which — now that the cohort is ≥2 — broadcasts. Without the fix this hangs.
			await connectControlNodes(B, A);

			await waitForCadrePeerConverged(B.getControlDatabase()!, xPeerId, {
				timeoutMs: 30_000,
				description: 'B observes the X CadrePeer row written on A while alone',
			});
			// ADDRESSABLE surface on purpose (`isMember` — row presence): the subject is
			// the write-while-alone re-replication drain, not trust. B pins no owner key,
			// so the trust-facing `isAuthorizedMember` would be false here by design —
			// the authorized surface is proven in push-wake-e2e scenario 4.
			expect(await B.isMember(xPeerId)).toBe(true);
		} finally {
			await B?.stop();
			await A?.stop();
		}
	}, 60_000);

	it('converges a DeviceToken self-registered while alone, once the cohort forms', async () => {
		let A: CadreNode | undefined;
		let B: CadreNode | undefined;
		try {
			({ A, B } = await bootPair('devtoken', 'ctrl-alone'));
			const aPeerId = A.peerId!.toString();

			// A publishes its OWN CadrePeer record AND DeviceToken while ALONE → both
			// commit local-only. (registerSelf is idempotent with the startup publish.)
			await A.registerSelf();
			await A.registerDeviceToken('fcm', 'tok-written-while-alone');
			expect(A.getControlNode()!.getConnections().length).toBe(0);

			// Connect — A's growth edge re-touches BOTH self rows so they broadcast.
			await connectControlNodes(B, A);

			// B resolving A's push token requires A's CadrePeer.PublicKey AND DeviceToken,
			// both of which reach B only via the re-replication drain.
			await waitUntil(
				async () => {
					const rec = await B!.resolveDeviceToken(aPeerId);
					return rec?.token === 'tok-written-while-alone';
				},
				{
					timeoutMs: 30_000,
					intervalMs: 250,
					description: 'B resolves A DeviceToken re-replicated after cohort growth',
				}
			);
			const resolved = await B.resolveDeviceToken(aPeerId);
			expect(resolved?.token).toBe('tok-written-while-alone');
			expect(resolved?.platform).toBe('fcm');
		} finally {
			await B?.stop();
			await A?.stop();
		}
	}, 60_000);
});
