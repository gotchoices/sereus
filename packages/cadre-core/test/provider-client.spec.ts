import { describe, expect, it } from 'vitest';

import { ProviderApiError, createProviderClient } from '../src/provider/client.js';
import type { TokenSource } from '../src/provider/oauth.js';

/** A provider that refuses the first bearer and serves the second, recording what it was asked. */
function provider(): { fetch: typeof fetch; requests: { path: string; bearer: string | null }[] } {
	const requests: { path: string; bearer: string | null }[] = [];
	const container = {
		id: 'ctr_1', customerId: 'c1', partyId: 'unclaimed', profile: 'storage', status: 'running',
		resources: {}, tags: {}, createdAt: '2026-10-12T10:00:00.000Z', updatedAt: '2026-10-12T10:00:05.000Z',
		join: { kind: 'claim' }, joinState: { kind: 'claim', state: 'awaiting' },
	};
	const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
	return {
		requests,
		fetch: (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			const url = new URL(String(input));
			const bearer = (init?.headers as Record<string, string> | undefined)?.authorization?.replace('Bearer ', '') ?? null;
			requests.push({ path: url.pathname, bearer });
			if (bearer !== 'good') return json(401, { ok: false, error: { code: 'UNAUTHORIZED', message: 'Authentication required' } });
			switch (url.pathname) {
				case '/api/v1/containers/ctr_1':
					return json(200, { ok: true, data: { container, health: { status: 'healthy', uptime: 5, peerId: '12D3KooWpeer', multiaddrs: ['/dns4/h/tcp/1/ws/p2p/12D3KooWpeer'] } } });
				case '/api/v1/containers/ctr_1/code':
					return json(503, { ok: false, error: { code: 'NOT_AVAILABLE', message: 'not yet' } });
				case '/api/v1/containers/ctr_2/code':
					return json(409, { ok: false, error: { code: 'ALREADY_CLAIMED', message: 'The node has an owner' } });
				default:
					return json(404, { ok: false, error: { code: 'NOT_FOUND', message: 'Container not found' } });
			}
		}) as typeof fetch,
	};
}

describe('provider client', () => {
	it('retries a 401 once with a refreshed token, parses dates to milliseconds, and maps the envelope', async () => {
		const invalidated: (string | undefined)[] = [];
		const tokens: TokenSource = {
			accessToken: async () => 'stale',
			invalidate: async (stale) => { invalidated.push(stale); return 'good'; },
		};
		const api = provider();
		const client = createProviderClient({ apiBaseUrl: 'https://nodes.example/api/v1/', tokens, fetch: api.fetch });

		const report = await client.getContainer('ctr_1');
		expect(invalidated).toEqual(['stale']);
		expect(api.requests.map((r) => r.bearer)).toEqual(['stale', 'good']);
		expect(report.container.createdAt).toBe(Date.parse('2026-10-12T10:00:00.000Z'));
		expect(report.join).toEqual({ kind: 'claim', state: 'awaiting' });
		expect(report.health).toEqual({ status: 'healthy', peerId: '12D3KooWpeer', multiaddrs: ['/dns4/h/tcp/1/ws/p2p/12D3KooWpeer'] });

		expect(await client.getNodeCode('ctr_1')).toEqual({ notReady: true });

		let caught: unknown;
		try {
			await client.getNodeCode('ctr_2');
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(ProviderApiError);
		expect(caught).toMatchObject({ status: 409, code: 'ALREADY_CLAIMED', message: expect.stringContaining('The node has an owner') });
	});
});
