// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

import { apiFetch, ApiError, apiPost, apiDelete } from '../src/lib/api.js';

function mockFetch(impl: typeof fetch): void {
	vi.stubGlobal('fetch', impl);
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
	return new Response(JSON.stringify(body), {
		status: init.status ?? 200,
		headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
	});
}

describe('apiFetch', () => {
	beforeEach(() => vi.restoreAllMocks());
	afterEach(() => vi.unstubAllGlobals());

	it('unwraps { ok: true, data }', async () => {
		mockFetch(async () => jsonResponse({ ok: true, data: { hello: 'world' } }));
		const r = await apiFetch<{ hello: string }>('/api/x');
		expect(r).toEqual({ hello: 'world' });
	});

	it('returns bare body when there is no envelope', async () => {
		mockFetch(async () => jsonResponse({ portMode: 'auto-upnp' }));
		const r = await apiFetch<{ portMode: string }>('/nat/status');
		expect(r.portMode).toBe('auto-upnp');
	});

	it('throws ApiError on { ok: false, error }', async () => {
		mockFetch(async () =>
			jsonResponse({ ok: false, error: { code: 'not_found', message: 'gone' } }, { status: 404 }),
		);
		await expect(apiFetch('/api/missing')).rejects.toMatchObject({
			name: 'ApiError',
			code: 'not_found',
			message: 'gone',
			status: 404,
		});
	});

	it('throws ApiError on non-2xx without envelope', async () => {
		mockFetch(async () => new Response('boom', { status: 500, statusText: 'Internal Server Error' }));
		const err = await apiFetch('/x').catch((e) => e);
		expect(err).toBeInstanceOf(ApiError);
		expect((err as ApiError).code).toBe('http_500');
		expect((err as ApiError).status).toBe(500);
	});

	it('throws ApiError("network", ...) on fetch failure', async () => {
		mockFetch(async () => {
			throw new TypeError('connection refused');
		});
		const err = await apiFetch('/x').catch((e) => e);
		expect(err).toBeInstanceOf(ApiError);
		expect((err as ApiError).code).toBe('network');
		expect((err as ApiError).message).toBe('connection refused');
	});

	it('throws ApiError on ok:false body with HTTP 200', async () => {
		mockFetch(async () =>
			jsonResponse({ ok: false, error: { code: 'invalid_setting', message: 'nope' } }),
		);
		const err = await apiFetch('/api/settings').catch((e) => e);
		expect(err).toBeInstanceOf(ApiError);
		expect((err as ApiError).code).toBe('invalid_setting');
	});

	it('apiPost sends JSON body with content-type', async () => {
		const calls: Array<{ url: string; init: RequestInit }> = [];
		mockFetch(async (input, init) => {
			calls.push({ url: String(input), init: init ?? {} });
			return jsonResponse({ ok: true, data: { id: 'abc' } });
		});
		const r = await apiPost<{ id: string }>('/auth/invites', { label: 'Mom' });
		expect(r).toEqual({ id: 'abc' });
		expect(calls).toHaveLength(1);
		expect(calls[0]!.init.method).toBe('POST');
		expect(calls[0]!.init.body).toBe(JSON.stringify({ label: 'Mom' }));
		const headers = calls[0]!.init.headers as Record<string, string>;
		expect(headers['content-type']).toBe('application/json');
	});

	it('apiDelete issues DELETE without body', async () => {
		const calls: Array<RequestInit> = [];
		mockFetch(async (_input, init) => {
			calls.push(init ?? {});
			return jsonResponse({ ok: true });
		});
		await apiDelete('/auth/invites/tkn');
		expect(calls[0]!.method).toBe('DELETE');
		expect(calls[0]!.body).toBeUndefined();
	});
});
