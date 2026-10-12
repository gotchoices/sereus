/**
 * Authentication middleware for the Provider API.
 */

import { createHash } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import debug from 'debug';
import type { AuthConfig } from '../config/types.js';
import { validateAuthConfig } from '../config/validate.js';
import type { ProviderStore } from '../service/store.js';
import type { ApiKey } from '../types.js';
import type { CustomerIdentity } from './routes.js';

const log = debug('cadre:provider:auth');

/**
 * What `GET /oauth/authorize` hands the operator's account system once the client, redirect
 * URI and scopes have been checked. `headers` carries the browser's cookies, which is how the
 * operator's site knows who is signed in; `query` is the authorize request as received.
 */
export interface AuthorizationRequest {
  clientId: string;
  scopes: string[];
  headers: IncomingHttpHeaders;
  query: Record<string, string>;
}

/**
 * The account system's answer: the signed-in, paid-up customer (with the plan the billing
 * record is created with when the customer has none); a page to send the browser to first
 * (login or checkout, which brings it back to the same authorize URL afterwards); or a
 * refusal, redirected to the app as `access_denied` with this reason.
 */
export type AuthorizationDecision =
  | { customerId: string; planId?: string }
  | { redirect: string }
  | { deny: string };

/** Authentication hooks for custom auth logic */
export interface AuthHooks {
  /** Validate an API key and return customer identity */
  validateApiKey?(key: string): Promise<CustomerIdentity | undefined>;
  /** Validate a JWT token and return customer identity */
  validateJwt?(token: string): Promise<CustomerIdentity | undefined>;
  /**
   * Resolve the customer behind a browser at `GET /oauth/authorize`: the one place the
   * operator's account and checkout system touches the provider. Without it, the built-in
   * endpoints need `auth.oauth.devConsentPage` to resolve a customer at all.
   */
  authorizeCustomer?(request: AuthorizationRequest): Promise<AuthorizationDecision>;
}

/** Authentication context */
export interface AuthContext {
  config: AuthConfig;
  store: ProviderStore;
  hooks?: AuthHooks;
  /**
   * API base path (e.g. '/api/v1'). Used to recognize the unauthenticated
   * endpoints precisely, so customer-scoped routes that merely end in
   * '/status' (e.g. '/billing/status') are still authenticated.
   */
  basePath: string;
}

/** Hash an API key for storage/comparison */
export function hashApiKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

/**
 * The routes that need no bearer: health, and what a browser or an app reaches before it has
 * a token (the descriptor, the plan list it names, and the sign-in endpoints). Matched by
 * exact path.
 */
function publicPaths(basePath: string): ReadonlySet<string> {
  return new Set(
    ['/status', '/health', '/descriptor', '/billing/plans', '/oauth/authorize', '/oauth/token'].map((route) => `${basePath}${route}`),
  );
}

/** The credential in an `Authorization` header, with or without the `Bearer` scheme. */
function bearerOf(header: string): string {
  return header.startsWith('Bearer ') ? header.slice(7) : header;
}

/**
 * The stored key record for `keyHash` while it is valid. An expired record is deleted and
 * treated as absent: nothing can ever accept it again, and the built-in OAuth endpoints mint
 * a record per sign-in, so keeping them would only grow the store.
 */
async function liveApiKey(store: ProviderStore, keyHash: string): Promise<ApiKey | undefined> {
  const apiKey = await store.getApiKey(keyHash);
  if (!apiKey) return undefined;
  if (apiKey.expiresAt && apiKey.expiresAt < new Date()) {
    log('Stored key expired; deleting');
    await store.deleteApiKey(keyHash);
    return undefined;
  }
  return apiKey;
}

/** Mode `api-key`: the hook, else the static admin hashes, else the store. */
async function apiKeyIdentity(ctx: AuthContext, key: string): Promise<CustomerIdentity | undefined> {
  if (ctx.hooks?.validateApiKey) return ctx.hooks.validateApiKey(key);
  const keyHash = hashApiKey(key);
  if (ctx.config.apiKeyHashes?.includes(keyHash)) return { customerId: 'admin', permissions: ['*'] };
  const apiKey = await liveApiKey(ctx.store, keyHash);
  if (!apiKey) return undefined;
  apiKey.lastUsedAt = new Date();
  await ctx.store.saveApiKey(apiKey);
  return { customerId: apiKey.customerId, permissions: apiKey.permissions };
}

/**
 * Mode `oauth`: a token the built-in endpoints minted is a stored key record, consulted first;
 * anything else goes to the `validateJwt` hook, so one provider can serve both its own tokens
 * and an external identity provider's.
 */
async function oauthIdentity(ctx: AuthContext, token: string): Promise<CustomerIdentity | undefined> {
  const apiKey = await liveApiKey(ctx.store, hashApiKey(token));
  if (apiKey) return { customerId: apiKey.customerId, permissions: apiKey.permissions };
  if (ctx.hooks?.validateJwt) return ctx.hooks.validateJwt(token);
  log('Bearer is not a built-in token and no validateJwt hook is installed');
  return undefined;
}

/**
 * Refuse at start a configuration under which the built-in endpoints have no single way to
 * resolve a customer at `GET /oauth/authorize`. Neither an `authorizeCustomer` hook nor the
 * dev consent page: every sign-in would fail at request time. Both: the page's `POST` would
 * still issue a code to anyone for any customer id beside the hook, a sign-in the operator's
 * account system never sees, so a dev flag left on in production fails loudly here instead.
 */
function assertOneCustomerResolver(config: AuthConfig, hooks: AuthHooks | undefined): void {
  if (config.mode !== 'oauth' || !config.oauth) return;
  const hook = hooks?.authorizeCustomer !== undefined;
  const page = config.oauth.devConsentPage === true;
  if (!hook && !page) {
    throw new Error(
      'auth.oauth is configured but nothing can resolve a customer at GET /oauth/authorize: ' +
        'pass an authorizeCustomer hook to createProviderServer, or set auth.oauth.devConsentPage: true ' +
        '(with auth.allowInsecureNoAuth: true) for development.'
    );
  }
  if (hook && page) {
    throw new Error(
      'auth.oauth.devConsentPage is true and an authorizeCustomer hook is installed: the page would ' +
        'sign anyone in as any customer beside the hook. Unset auth.oauth.devConsentPage ' +
        '(or PROVIDER_OAUTH_DEV_CONSENT_PAGE) for a provider with an account system.'
    );
  }
}

/** Register authentication middleware */
export function registerAuth(app: FastifyInstance, ctx: AuthContext): void {
  const { config, basePath } = ctx;

  // Defense in depth: programmatic construction that bypasses loadConfig must
  // not silently go fully open in 'none' mode without an explicit opt-in.
  validateAuthConfig(config);
  assertOneCustomerResolver(config, ctx.hooks);

  const open = publicPaths(basePath);

  app.addHook('preHandler', async (request: FastifyRequest, reply: FastifyReply) => {
    // Skip auth for the public endpoints only. Match the exact paths (ignoring any query
    // string) so customer-scoped routes that merely end in '/status' — e.g.
    // '/billing/status' — are not accidentally left open.
    const path = request.url.split('?', 1)[0];
    if (open.has(path)) {
      return;
    }

    // No auth mode - for development
    if (config.mode === 'none') {
      request.customer = {
        customerId: 'dev-customer',
        permissions: ['*'],
      };
      return;
    }

    const authHeader = request.headers.authorization;
    if (!authHeader) {
      log('Missing authorization header');
      return reply.status(401).send({
        ok: false,
        error: { code: 'UNAUTHORIZED', message: 'Authorization header required' },
      });
    }

    try {
      const credential = bearerOf(authHeader);
      const customer = config.mode === 'api-key'
        ? await apiKeyIdentity(ctx, credential)
        : await oauthIdentity(ctx, credential);

      if (!customer) {
        log('Authentication failed');
        return reply.status(401).send({
          ok: false,
          error: { code: 'UNAUTHORIZED', message: 'Invalid credentials' },
        });
      }

      request.customer = customer;
      log('Authenticated customer: %s', customer.customerId);

    } catch (error) {
      log('Auth error: %O', error);
      return reply.status(401).send({
        ok: false,
        error: { code: 'AUTH_ERROR', message: 'Authentication failed' },
      });
    }
  });

  log('Authentication middleware registered, mode: %s', config.mode);
}
