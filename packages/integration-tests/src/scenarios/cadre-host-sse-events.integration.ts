/**
 * cadre-host SSE event-stream integration scenarios.
 *
 * Verifies the seam between route adapters, the EventBus, and the
 * `/api/events` SSE endpoint:
 *   - a settings PUT that toggles UPnP reaches the SSE client as a
 *     connectivity-changed, through NatService's own change listener (no
 *     route adapter publishes for /api/settings)
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
			host.server.events.publish({ type: 'connectivity-changed', directReachability: 'cgnat' });
			const ev = await stream.next((e) => e.type === 'connectivity-changed' && e.directReachability === 'cgnat');
			expect(ev).toEqual({ type: 'connectivity-changed', directReachability: 'cgnat' });
		} finally {
			stream.close();
		}
	});

	it('a settings PUT that toggles UPnP reaches the stream through the NAT change listener', async () => {
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
			expect(host.nat.getSettings().upnpEnabled).toBe(false);

			// No route adapter publishes for /api/settings; the event comes from
			// NatService.onChange, which the server wires to the bus.
			await stream.next((e) => e.type === 'connectivity-changed');
			const novel = stream.received().slice(before);
			expect(novel.filter((e) => e.type === 'connectivity-changed')).toEqual([
				{ type: 'connectivity-changed', directReachability: 'unknown' },
			]);
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
