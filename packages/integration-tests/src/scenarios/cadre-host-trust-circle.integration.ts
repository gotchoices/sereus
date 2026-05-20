/**
 * Trust-circle integration scenarios with a real CadreNode.
 *
 * The cadre-host harness wires its own TrustCircleService against a real
 * `CadreNode` (full Quereus control DB), so the issue → list → remove cycle
 * actually writes/reads the canonical `CadrePeer` table.
 *
 * Redemption is driven via `trustCircle.redeemInvite(...)` because v1
 * does not expose an `POST /auth/redeem` HTTP route — the SPA-side
 * second-device flow lives off-host. See "Known gaps" in the implement
 * ticket for the follow-up.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { generatePrivateKey, getPublicKey } from '@optimystic/quereus-plugin-crypto';
import { CadreNode } from '@serfab/cadre-core';

import { createTestCadreHost, type TestCadreHost } from '../harness/index.js';

describe('cadre-host trust-circle', () => {
	let cadreNode: CadreNode;
	let host: TestCadreHost;

	beforeEach(async () => {
		const authorityPrivateKey = generatePrivateKey('ed25519', 'base64url') as string;
		const authorityPublicKey = getPublicKey(authorityPrivateKey, 'ed25519', 'base64url', 'base64url') as string;
		const baseId = Math.random().toString(36).slice(2);

		cadreNode = new CadreNode({
			controlNetwork: { partyId: `host-${baseId}`, bootstrapNodes: [] },
			profile: 'transaction',
		});
		await cadreNode.start();
		const db = cadreNode.getControlDatabase();
		if (!db) throw new Error('control database missing');
		await db.insertAuthorityKey(authorityPublicKey);
		cadreNode.initializeSeedBootstrap(authorityPrivateKey);

		host = await createTestCadreHost({ cadreNodeForTrustCircle: cadreNode });
	}, 60_000);

	afterEach(async () => {
		try { await host.stop(); } catch { /* ignore */ }
		try { await cadreNode.stop(); } catch { /* ignore */ }
	});

	it('completes issue → list → redeem → list → remove cycle over the HTTP+service surface', async () => {
		// 1. POST /auth/invites
		const post = await host.request({
			method: 'POST',
			path: '/auth/invites',
			body: { label: "Mom's phone" },
		});
		expect(post.status).toBe(200);
		const issued = post.body as { encodedInvite: string; token: string };
		expect(issued.encodedInvite).toBeTruthy();
		expect(issued.token).toBeTruthy();

		// 2. GET /auth/trust-circle — sees the pending invite.
		const before = await host.request({ method: 'GET', path: '/auth/trust-circle' });
		expect(before.status).toBe(200);
		const beforeBody = before.body as { pending: Array<{ label: string }> };
		expect(beforeBody.pending).toHaveLength(1);
		expect(beforeBody.pending[0]!.label).toBe("Mom's phone");

		// 3. Redeem via the service handle (no HTTP route exists in v1).
		const phoneKey = await generateKeyPair('Ed25519');
		const phonePeerId = peerIdFromPrivateKey(phoneKey).toString();
		const redeemed = await host.trustCircle.redeemInvite({ token: issued.token, peerId: phonePeerId });
		expect(redeemed).toEqual({ peerId: phonePeerId, label: "Mom's phone" });

		// 4. GET /auth/trust-circle — sees one member, no pending.
		const after = await host.request({ method: 'GET', path: '/auth/trust-circle' });
		expect(after.status).toBe(200);
		const afterBody = after.body as { members: Array<{ peerId: string; label: string }>; pending: unknown[] };
		expect(afterBody.members).toHaveLength(1);
		expect(afterBody.members[0]!.peerId).toBe(phonePeerId);
		expect(afterBody.members[0]!.label).toBe("Mom's phone");
		expect(afterBody.pending).toHaveLength(0);

		// 5. DELETE /auth/members/:peerId.
		const del = await host.request({
			method: 'DELETE',
			path: `/auth/members/${encodeURIComponent(phonePeerId)}`,
		});
		expect(del.status).toBe(200);

		// 6. GET /auth/trust-circle — no members.
		const final = await host.request({ method: 'GET', path: '/auth/trust-circle' });
		expect(final.status).toBe(200);
		const finalBody = final.body as { members: unknown[] };
		expect(finalBody.members).toHaveLength(0);
	}, 90_000);

	it('DELETE on an unknown pending token returns 404 with not_found', async () => {
		const res = await host.request({
			method: 'DELETE',
			path: '/auth/invites/this-token-was-never-issued',
		});
		expect(res.status).toBe(404);
		expect(res.body).toMatchObject({ ok: false, error: { code: 'not_found' } });
	});

	it('POST /auth/invites with a blank label returns 400 with invalid_label', async () => {
		const res = await host.request({
			method: 'POST',
			path: '/auth/invites',
			body: { label: '   ' },
		});
		expect(res.status).toBe(400);
		expect(res.body).toMatchObject({ ok: false, error: { code: 'invalid_label' } });
	});
});
