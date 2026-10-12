import { describe, expect, it } from 'vitest';

import { parseProviderDescriptor, type ProviderDescriptor } from '../src/provider/descriptor.js';
import {
	ProviderAuthError,
	TOKEN_REFRESH_MARGIN_MS,
	createPkce,
	createTokenSource,
	pkceChallenge,
	readAuthorizationRedirect,
	type ProviderTokens,
} from '../src/provider/oauth.js';

/** The descriptor of a provider at a public name, as `GET /descriptor` returns it. */
function descriptorJson(apiBaseUrl = 'https://nodes.example/api/v1'): Record<string, unknown> {
	return {
		v: 1,
		id: 'example-nodes',
		name: 'Example Nodes',
		apiBaseUrl,
		oauth: { authorizeUrl: `${apiBaseUrl}/oauth/authorize`, tokenUrl: `${apiBaseUrl}/oauth/token`, scopes: ['containers:*', 'billing:read'] },
		plansUrl: `${apiBaseUrl}/billing/plans`,
	};
}

/** A token endpoint that answers every refresh with a fresh pair, counting them; `refuse` turns it into a refusal. */
function tokenEndpoint(): { fetch: typeof fetch; calls: () => number; refuse: () => void } {
	let calls = 0;
	let refused = false;
	return {
		fetch: (async (_input: string | URL | Request, _init?: RequestInit): Promise<Response> => {
			calls++;
			if (refused) {
				return new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'refresh token unknown' }), { status: 400 });
			}
			return new Response(JSON.stringify({ access_token: `access-${calls}`, token_type: 'Bearer', expires_in: 3600, refresh_token: `refresh-${calls}`, scope: 'containers:*' }), { status: 200 });
		}) as typeof fetch,
		calls: () => calls,
		refuse: () => { refused = true; },
	};
}

describe('provider sign-in (OAuth 2 with PKCE)', () => {
	it('derives the S256 challenge of RFC 7636 appendix B, and mints a 43-character verifier', () => {
		expect(pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
		const { verifier, challenge } = createPkce();
		expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(challenge).toBe(pkceChallenge(verifier));
	});

	it('reads the redirect only when its state is the one sent', () => {
		expect(readAuthorizationRedirect('sereus-chat://provider-auth?code=abc&state=s1', { expectedState: 's1' })).toEqual({ code: 'abc' });
		expect(readAuthorizationRedirect('sereus-chat://provider-auth?error=access_denied&error_description=no&state=s1', { expectedState: 's1' }))
			.toEqual({ error: 'access_denied', description: 'no' });
		let caught: unknown;
		try {
			readAuthorizationRedirect('sereus-chat://provider-auth?code=abc&state=other', { expectedState: 's1' });
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(ProviderAuthError);
		expect((caught as ProviderAuthError).code).toBe('state-mismatch');
		// The code is a credential: a refusal never repeats it.
		expect((caught as ProviderAuthError).message).not.toContain('abc');
	});

	it('refuses plain http API URLs except at a loopback host', () => {
		expect(() => parseProviderDescriptor(descriptorJson('http://nodes.example/api/v1'))).toThrow(/https unless its host is loopback/);
		expect(parseProviderDescriptor(descriptorJson('http://127.0.0.1:3000/api/v1')).apiBaseUrl).toBe('http://127.0.0.1:3000/api/v1');
		expect(parseProviderDescriptor(descriptorJson('http://localhost:3000/api/v1')).oauth.tokenUrl).toBe('http://localhost:3000/api/v1/oauth/token');
		expect(() => parseProviderDescriptor({ ...descriptorJson(), v: 2 })).toThrow(/v: 1/);
		expect(() => parseProviderDescriptor({ ...descriptorJson(), name: ' ' })).toThrow(/name/);
	});

	it('shares one refresh among concurrent callers near expiry, persists it, and reports a refused refresh as reauthorize', async () => {
		const descriptor = parseProviderDescriptor(descriptorJson()) satisfies ProviderDescriptor;
		const endpoint = tokenEndpoint();
		const persisted: ProviderTokens[] = [];
		const now = 1_000_000;
		const source = createTokenSource({
			descriptor,
			clientId: 'sereus-chat',
			tokens: { accessToken: 'access-0', refreshToken: 'refresh-0', expiresAt: now + TOKEN_REFRESH_MARGIN_MS / 2, scopes: [] },
			persist: (tokens) => { persisted.push(tokens); },
			fetch: endpoint.fetch,
			now: () => now,
		});

		const [a, b] = await Promise.all([source.accessToken(), source.accessToken()]);
		expect([a, b]).toEqual(['access-1', 'access-1']);
		expect(endpoint.calls()).toBe(1);
		expect(persisted.map((tokens) => tokens.refreshToken)).toEqual(['refresh-1']);
		// Fresh now: no further request.
		expect(await source.accessToken()).toBe('access-1');
		// A 401 against a token a refresh already replaced costs no rotation; against the current one, exactly one.
		expect(await source.invalidate('access-0')).toBe('access-1');
		expect(await source.invalidate('access-1')).toBe('access-2');
		expect(endpoint.calls()).toBe(2);

		// A refused refresh: the pair is gone and only a new sign-in helps.
		endpoint.refuse();
		let caught: unknown;
		try {
			await source.invalidate('access-2');
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(ProviderAuthError);
		expect((caught as ProviderAuthError).code).toBe('reauthorize');
		expect(((caught as ProviderAuthError).cause as ProviderAuthError).code).toBe('invalid_grant');
	});
});
