/**
 * Origin guard scenarios.
 *
 * Verifies that the loopback HTTP listener defeats DNS-rebind attacks by
 * rejecting requests whose Host or Origin header doesn't match the bound
 * 127.0.0.1:<port>. Covers both branches of origin-guard.ts that the
 * per-module smoke test only partially exercises (it skips the Origin
 * header check).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { createTestCadreHost, type TestCadreHost } from '../harness/index.js';

describe('cadre-host origin guard', () => {
	let host: TestCadreHost;

	beforeEach(async () => {
		host = await createTestCadreHost();
	});

	afterEach(async () => {
		await host.stop();
	});

	it('accepts loopback requests (default Host header)', async () => {
		const res = await host.request({ method: 'GET', path: '/api/status' });
		expect(res.status).toBe(200);
	});

	it('rejects a foreign Host header with forbidden_origin', async () => {
		const res = await host.request({
			method: 'GET',
			path: '/api/status',
			headers: { host: 'evil.example.com' },
		});
		expect(res.status).toBe(403);
		expect(res.body).toMatchObject({
			ok: false,
			error: { code: 'forbidden_origin' },
		});
	});

	it('rejects a foreign Origin header with forbidden_origin', async () => {
		const res = await host.request({
			method: 'GET',
			path: '/api/status',
			headers: {
				host: `127.0.0.1:${host.port}`,
				origin: 'http://evil.example.com',
			},
		});
		expect(res.status).toBe(403);
		expect(res.body).toMatchObject({
			ok: false,
			error: { code: 'forbidden_origin' },
		});
	});

	it('accepts a matching loopback Origin header', async () => {
		const res = await host.request({
			method: 'GET',
			path: '/api/status',
			headers: {
				host: `127.0.0.1:${host.port}`,
				origin: `http://127.0.0.1:${host.port}`,
			},
		});
		expect(res.status).toBe(200);
	});
});
