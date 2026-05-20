/**
 * cadre-host SSE event-stream integration scenarios.
 *
 * Verifies the seam between route adapters, the EventBus, and the
 * `/api/events` SSE endpoint:
 *   - trust-circle invite POST → `trust-circle-changed: invited`
 *   - trust-circle invite DELETE → `trust-circle-changed: revoked`
 *   - settings PUT does NOT emit a connectivity-changed (no route adapter
 *     exists today — see events/types.ts)
 *   - SSE close releases the listener slot in the bus
 *   - Direct bus publish flows through the SSE serializer
 *
 * The boot-time `connectivity-changed` publish at server.start() is fired
 * before any SSE client connects, so it's deliberately not asserted here —
 * `packages/cadre-host/src/server/__tests__/publishers.test.ts` covers
 * that boot-time path by subscribing to the bus directly.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { createTestCadreHost, type TestCadreHost } from '../harness/index.js';

describe('cadre-host SSE events', () => {
	let host: TestCadreHost;

	beforeEach(async () => {
		host = await createTestCadreHost({ sseHeartbeatMs: 200 });
	});

	afterEach(async () => {
		await host.stop();
	});

	/** Wait until the SSE handler has subscribed to the bus before publishing. */
	async function awaitSubscribed(target: number): Promise<void> {
		const deadline = Date.now() + 2_000;
		while (host.server.events.listenerCount() < target && Date.now() < deadline) {
			await new Promise<void>((r) => setTimeout(r, 20));
		}
	}

	it('delivers events published directly onto the bus', async () => {
		const baseline = host.server.events.listenerCount();
		const stream = await host.openEventStream();
		try {
			await awaitSubscribed(baseline + 1);
			host.server.events.publish({ type: 'connectivity-changed', portMode: 'disabled', directReachability: 'unknown' });
			const ev = await stream.next((e) => e.type === 'connectivity-changed');
			expect(ev).toMatchObject({ type: 'connectivity-changed', portMode: 'disabled', directReachability: 'unknown' });
		} finally {
			stream.close();
		}
	});

	it('emits trust-circle-changed: invited when POST /auth/invites succeeds', async () => {
		const baseline = host.server.events.listenerCount();
		const stream = await host.openEventStream();
		try {
			await awaitSubscribed(baseline + 1);
			const post = await host.request({
				method: 'POST',
				path: '/auth/invites',
				body: { label: 'Test phone' },
			});
			expect(post.status).toBe(200);
			const ev = await stream.next((e) => e.type === 'trust-circle-changed' && e.kind === 'invited');
			expect(ev).toMatchObject({ type: 'trust-circle-changed', kind: 'invited' });
		} finally {
			stream.close();
		}
	});

	it('emits trust-circle-changed: revoked when DELETE /auth/invites/:token succeeds', async () => {
		const post = await host.request({
			method: 'POST',
			path: '/auth/invites',
			body: { label: 'To-be-revoked' },
		});
		expect(post.status).toBe(200);
		const token = (post.body as { token: string }).token;
		expect(typeof token).toBe('string');

		const baseline = host.server.events.listenerCount();
		const stream = await host.openEventStream();
		try {
			await awaitSubscribed(baseline + 1);
			const del = await host.request({
				method: 'DELETE',
				path: `/auth/invites/${encodeURIComponent(token)}`,
			});
			expect(del.status).toBe(200);
			const ev = await stream.next((e) => e.type === 'trust-circle-changed' && e.kind === 'revoked');
			expect(ev).toMatchObject({ type: 'trust-circle-changed', kind: 'revoked' });
		} finally {
			stream.close();
		}
	});

	it('settings PUT mutates state but does not publish an event in v1', async () => {
		const baseline = host.server.events.listenerCount();
		const stream = await host.openEventStream();
		try {
			await awaitSubscribed(baseline + 1);
			const before = stream.received().length;

			const put = await host.request({
				method: 'PUT',
				path: '/api/settings',
				body: { upnpEnabled: false },
			});
			expect(put.status).toBe(200);

			// Give the bus a beat to fan out anything it might (it shouldn't).
			await new Promise<void>((r) => setTimeout(r, 100));

			const after = stream.received();
			const novel = after.slice(before);
			expect(novel.filter((e) => e.type === 'connectivity-changed')).toEqual([]);
			expect(host.nat.getSettings().upnpEnabled).toBe(false);
		} finally {
			stream.close();
		}
	});

	it('closing the SSE stream releases the listener slot', async () => {
		const beforeCount = host.server.events.listenerCount();
		const stream = await host.openEventStream();
		const deadline = Date.now() + 1_000;
		while (host.server.events.listenerCount() <= beforeCount && Date.now() < deadline) {
			await new Promise<void>((r) => setTimeout(r, 20));
		}
		expect(host.server.events.listenerCount()).toBe(beforeCount + 1);
		stream.close();
		const releaseDeadline = Date.now() + 1_000;
		while (host.server.events.listenerCount() > beforeCount && Date.now() < releaseDeadline) {
			await new Promise<void>((r) => setTimeout(r, 20));
		}
		expect(host.server.events.listenerCount()).toBe(beforeCount);
	});
});
