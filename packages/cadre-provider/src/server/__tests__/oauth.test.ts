import { describe, it, expect, vi } from 'vitest';
import type { AuthConfig, ProviderConfig, ProviderIdentityConfig } from '../../config/types.js';
import { DEFAULT_CONFIG } from '../../config/types.js';
import { MemoryStore } from '../../service/store.js';
import { MockOrchestrator } from '../../service/orchestrator.js';
import { createProviderServer, type ProviderServer } from '../server.js';
import type { AuthHooks } from '../auth.js';
import { codeChallengeFor } from '../pkce.js';

/**
 * The built-in OAuth 2 authorization code + PKCE endpoints and the descriptor, over Fastify
 * `inject`: the round trip from authorize to a scoped bearer, the two faults that must not
 * redirect, the faults that do, single-use codes, refresh rotation, the dev consent page,
 * the hook's three decisions, and the start-time refusal. The config rules are in
 * `config/__tests__/config-validation.test.ts`.
 */

const CLIENT = {
  clientId: 'sereus-chat',
  redirectUris: ['sereus-chat://provider-auth', 'http://127.0.0.1:8080/cb'],
  scopes: ['containers:*', 'billing:read'],
};

const IDENTITY: ProviderIdentityConfig = {
  id: 'acme-nodes',
  name: 'Acme Cadre Nodes',
  publicUrl: 'https://nodes.acme.example',
  termsUrl: 'https://acme.example/terms',
  regions: ['eu-west'],
};

// RFC 7636 appendix B: the verifier and the S256 challenge it hashes to.
const VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

const OAUTH_AUTH: AuthConfig = { mode: 'oauth', oauth: { clients: [CLIENT] } };

/** A hook that signs every browser in as `cust-1` on the starter plan. */
const SIGNED_IN: AuthHooks = { authorizeCustomer: async () => ({ customerId: 'cust-1', planId: 'starter' }) };

interface ServerOptions {
  auth?: AuthConfig;
  provider?: ProviderIdentityConfig;
  hooks?: AuthHooks;
  billingEnabled?: boolean;
}

async function makeServer(options: ServerOptions = {}): Promise<ProviderServer> {
  const config: ProviderConfig = {
    ...DEFAULT_CONFIG,
    server: { ...DEFAULT_CONFIG.server, port: 0 },
    auth: options.auth ?? OAUTH_AUTH,
    docker: { ...DEFAULT_CONFIG.docker, socketPath: undefined as unknown as string },
    billing: { enabled: options.billingEnabled ?? false },
    storage: { type: 'memory' },
    ...('provider' in options ? { provider: options.provider } : { provider: IDENTITY }),
  };
  const server = await createProviderServer({
    config,
    orchestrator: new MockOrchestrator(),
    store: new MemoryStore(),
    authHooks: 'hooks' in options ? options.hooks : SIGNED_IN,
    exitFn: vi.fn(),
  });
  await server.app.ready();
  return server;
}

const AUTHORIZE_DEFAULTS: Record<string, string> = {
  response_type: 'code',
  client_id: CLIENT.clientId,
  redirect_uri: 'sereus-chat://provider-auth',
  scope: 'containers:read billing:read',
  state: 'xyz',
  code_challenge: CHALLENGE,
  code_challenge_method: 'S256',
};

function authorizeUrl(overrides: Record<string, string | undefined> = {}): string {
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries({ ...AUTHORIZE_DEFAULTS, ...overrides })) {
    if (value !== undefined) params.set(name, value);
  }
  return `/api/v1/oauth/authorize?${params.toString()}`;
}

/** The query the authorize endpoint redirected with. */
function redirectQuery(location: string | undefined): URLSearchParams {
  expect(location).toBeDefined();
  return new URL(location!).searchParams;
}

async function obtainCode(server: ProviderServer, overrides: Record<string, string | undefined> = {}): Promise<string> {
  const res = await server.app.inject({ method: 'GET', url: authorizeUrl(overrides) });
  expect(res.statusCode).toBe(302);
  const query = redirectQuery(res.headers.location as string | undefined);
  expect(query.get('state')).toBe('xyz');
  const code = query.get('code');
  expect(code).toBeTruthy();
  return code!;
}

interface Tokens { access_token: string; token_type: string; expires_in: number; refresh_token: string; scope: string }

/** `POST /oauth/token`, form-encoded as RFC 6749 specifies, or JSON for a `fetch`-built client. */
async function token(server: ProviderServer, form: Record<string, string>, encoding: 'form' | 'json' = 'form') {
  return server.app.inject({
    method: 'POST',
    url: '/api/v1/oauth/token',
    headers: { 'content-type': encoding === 'form' ? 'application/x-www-form-urlencoded' : 'application/json' },
    payload: encoding === 'form' ? new URLSearchParams(form).toString() : JSON.stringify(form),
  });
}

function exchangeForm(code: string, overrides: Record<string, string> = {}): Record<string, string> {
  return {
    grant_type: 'authorization_code',
    code,
    code_verifier: VERIFIER,
    client_id: CLIENT.clientId,
    redirect_uri: 'sereus-chat://provider-auth',
    ...overrides,
  };
}

async function exchange(server: ProviderServer, code: string): Promise<Tokens> {
  const res = await token(server, exchangeForm(code));
  expect(res.statusCode).toBe(200);
  return res.json() as Tokens;
}

function bearer(accessToken: string): Record<string, string> {
  return { authorization: `Bearer ${accessToken}` };
}

function errorCode(res: { json(): unknown }): string {
  return (res.json() as { error: string }).error;
}

describe('OAuth 2 authorization code with PKCE', () => {
  it('round trip: authorize → code → tokens → a bearer scoped to the customer', async () => {
    const server = await makeServer();
    const code = await obtainCode(server);

    const res = await token(server, exchangeForm(code));
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const tokens = res.json() as Tokens;
    expect(tokens.token_type).toBe('Bearer');
    expect(tokens.expires_in).toBe(3600);
    expect(tokens.scope).toBe('containers:read billing:read');
    expect(tokens.refresh_token).toBeTruthy();

    const list = await server.app.inject({ method: 'GET', url: '/api/v1/containers', headers: bearer(tokens.access_token) });
    expect(list.statusCode).toBe(200);

    // The token carries only what was asked for: containers:read, not containers:delete.
    const del = await server.app.inject({ method: 'DELETE', url: '/api/v1/containers/ctr_x', headers: bearer(tokens.access_token) });
    expect(del.statusCode).toBe(403);
    expect((del.json() as { error: { code: string } }).error.code).toBe('INSUFFICIENT_SCOPE');

    // The billing record was created at sign-in, with the plan the hook named.
    const billing = await server.app.inject({ method: 'GET', url: '/api/v1/billing/status', headers: bearer(tokens.access_token) });
    expect(billing.statusCode).toBe(200);
    expect((billing.json() as { data: { billing: { customerId: string; planId: string } } }).data.billing).toMatchObject({ customerId: 'cust-1', planId: 'starter' });

    await server.stop();
  });

  it('a wrong verifier is invalid_grant and burns the code', async () => {
    const server = await makeServer();
    const code = await obtainCode(server);

    const wrong = await token(server, exchangeForm(code, { code_verifier: codeChallengeFor('not-the-verifier-not-the-verifier-not-the-verifier') }));
    expect(wrong.statusCode).toBe(400);
    expect(errorCode(wrong)).toBe('invalid_grant');

    const right = await token(server, exchangeForm(code));
    expect(errorCode(right)).toBe('invalid_grant');

    await server.stop();
  });

  it('a code is single-use: presenting it again after a successful exchange is invalid_grant', async () => {
    const server = await makeServer();
    const code = await obtainCode(server);
    await exchange(server, code);

    const again = await token(server, exchangeForm(code));
    expect(again.statusCode).toBe(400);
    expect(errorCode(again)).toBe('invalid_grant');

    await server.stop();
  });

  // Redirecting to an unregistered URI is the attack, so these are the two faults answered on
  // the page instead. Exact string match: no trailing slash, case or query normalization.
  it('an unknown client or an unregistered redirect URI gets a 400 page, escaped, and no redirect', async () => {
    const server = await makeServer();

    for (const redirect_uri of ['sereus-chat://provider-auth/', 'SEREUS-CHAT://provider-auth', 'sereus-chat://provider-auth?x=1', 'https://evil.example/cb']) {
      const res = await server.app.inject({ method: 'GET', url: authorizeUrl({ redirect_uri }) });
      expect(res.statusCode, redirect_uri).toBe(400);
      expect(res.headers.location, redirect_uri).toBeUndefined();
      expect(res.headers['content-type']).toContain('text/html');
    }

    const unknown = await server.app.inject({ method: 'GET', url: authorizeUrl({ client_id: '<script>alert(1)</script>' }) });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.body).toContain('&lt;script&gt;');
    expect(unknown.body).not.toContain('<script>');

    await server.stop();
  });

  it('every other fault redirects to the registered URI with the error and the state', async () => {
    const server = await makeServer();

    const faults: [Record<string, string | undefined>, string][] = [
      [{ code_challenge_method: 'plain' }, 'invalid_request'],
      [{ code_challenge: 'too-short' }, 'invalid_request'],
      [{ state: undefined }, 'invalid_request'],
      [{ response_type: 'token' }, 'unsupported_response_type'],
      [{ scope: 'containers:read billing:write' }, 'invalid_scope'],
      [{ scope: 'billing:*' }, 'invalid_scope'],
      [{ scope: undefined }, 'invalid_scope'],
    ];
    for (const [overrides, error] of faults) {
      const res = await server.app.inject({ method: 'GET', url: authorizeUrl(overrides) });
      expect(res.statusCode, JSON.stringify(overrides)).toBe(302);
      const query = redirectQuery(res.headers.location as string | undefined);
      expect(query.get('error'), JSON.stringify(overrides)).toBe(error);
      expect(query.get('code')).toBeNull();
      if (overrides.state !== undefined) expect(query.get('state')).toBe('xyz');
    }

    await server.stop();
  });

  it('refresh rotates: the old refresh token and the old access token stop working', async () => {
    const server = await makeServer();
    const first = await exchange(server, await obtainCode(server));

    const refreshed = await token(server, { grant_type: 'refresh_token', refresh_token: first.refresh_token, client_id: CLIENT.clientId }, 'json');
    expect(refreshed.statusCode).toBe(200);
    const second = refreshed.json() as Tokens;
    expect(second.scope).toBe(first.scope);
    expect(second.access_token).not.toBe(first.access_token);

    const replay = await token(server, { grant_type: 'refresh_token', refresh_token: first.refresh_token, client_id: CLIENT.clientId });
    expect(errorCode(replay)).toBe('invalid_grant');

    const stale = await server.app.inject({ method: 'GET', url: '/api/v1/containers', headers: bearer(first.access_token) });
    expect(stale.statusCode).toBe(401);
    const fresh = await server.app.inject({ method: 'GET', url: '/api/v1/containers', headers: bearer(second.access_token) });
    expect(fresh.statusCode).toBe(200);

    await server.stop();
  });

  it('the hook may send the browser to the site first, or deny', async () => {
    let decision: 'redirect' | 'deny' = 'redirect';
    const server = await makeServer({
      hooks: {
        authorizeCustomer: async () => decision === 'redirect'
          ? { redirect: 'https://acme.example/login?next=authorize' }
          : { deny: 'no subscription' },
      },
    });

    const login = await server.app.inject({ method: 'GET', url: authorizeUrl() });
    expect(login.statusCode).toBe(302);
    expect(login.headers.location).toBe('https://acme.example/login?next=authorize');

    decision = 'deny';
    const denied = await server.app.inject({ method: 'GET', url: authorizeUrl() });
    const query = redirectQuery(denied.headers.location as string | undefined);
    expect(query.get('error')).toBe('access_denied');
    expect(query.get('error_description')).toBe('no subscription');
    expect(query.get('state')).toBe('xyz');

    await server.stop();
  });

  it('the dev consent page shows the form and its approval issues a code for the typed customer', async () => {
    const server = await makeServer({
      auth: { mode: 'oauth', allowInsecureNoAuth: true, oauth: { clients: [CLIENT], devConsentPage: true } },
      hooks: undefined,
    });

    const page = await server.app.inject({ method: 'GET', url: authorizeUrl() });
    expect(page.statusCode).toBe(200);
    expect(page.headers['content-type']).toContain('text/html');
    expect(page.body).toContain('name="state" value="xyz"');
    expect(page.body).toContain('name="customer_id"');

    const approved = await server.app.inject({
      method: 'POST',
      url: '/api/v1/oauth/authorize',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({ ...AUTHORIZE_DEFAULTS, customer_id: 'dev-7', plan_id: 'professional', decision: 'approve' }).toString(),
    });
    expect(approved.statusCode).toBe(302);
    const code = redirectQuery(approved.headers.location as string | undefined).get('code');
    expect(code).toBeTruthy();

    const tokens = await exchange(server, code!);
    const billing = await server.app.inject({ method: 'GET', url: '/api/v1/billing/status', headers: bearer(tokens.access_token) });
    expect((billing.json() as { data: { billing: { customerId: string; planId: string } } }).data.billing).toMatchObject({ customerId: 'dev-7', planId: 'professional' });

    await server.stop();
  });

  it('refuses to start with auth.oauth but no way to resolve a customer', async () => {
    await expect(makeServer({ hooks: undefined })).rejects.toThrow(/authorizeCustomer/);
  });
});

describe('GET /descriptor', () => {
  it('derives every URL from publicUrl and basePath, with the union of the clients\' scopes', async () => {
    const server = await makeServer();

    const res = await server.app.inject({ method: 'GET', url: '/api/v1/descriptor' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      v: 1,
      id: 'acme-nodes',
      name: 'Acme Cadre Nodes',
      apiBaseUrl: 'https://nodes.acme.example/api/v1',
      oauth: {
        authorizeUrl: 'https://nodes.acme.example/api/v1/oauth/authorize',
        tokenUrl: 'https://nodes.acme.example/api/v1/oauth/token',
        scopes: ['containers:*', 'billing:read'],
      },
      plansUrl: 'https://nodes.acme.example/api/v1/billing/plans',
      termsUrl: 'https://acme.example/terms',
      regions: ['eu-west'],
    });

    await server.stop();
  });

  it('answers 404 NOT_CONFIGURED without a provider block', async () => {
    const server = await makeServer({ provider: undefined });

    const res = await server.app.inject({ method: 'GET', url: '/api/v1/descriptor' });
    expect(res.statusCode).toBe(404);
    expect((res.json() as { error: { code: string } }).error.code).toBe('NOT_CONFIGURED');

    await server.stop();
  });
});
