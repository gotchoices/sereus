/**
 * The provider's built-in OAuth 2 authorization code endpoints with PKCE (RFC 6749 §4.1,
 * RFC 7636): `GET /oauth/authorize`, `POST /oauth/authorize` (the dev consent page's form)
 * and `POST /oauth/token`. A public client such as a phone app opens the authorize URL in a
 * browser, the operator's account system resolves the customer (`AuthHooks.authorizeCustomer`),
 * and the app exchanges the code it is redirected back with for a bearer scoped to that
 * customer. The bearer is an `ApiKey` record, so `registerAuth` validates it like any other.
 *
 * Only an unknown client or an unregistered redirect URI is answered with an error page:
 * redirecting to an unregistered URI is the attack. Every other fault is redirected to the
 * registered URI with the RFC's `error` code and the request's `state`.
 */

import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import debug from 'debug';
import type { OAuthClientConfig, OAuthConfig } from '../config/types.js';
import type { ProviderStore } from '../service/store.js';
import type { BillingService } from '../service/billing-service.js';
import { hashApiKey, type AuthHooks, type AuthorizationDecision } from './auth.js';
import { hasPermission, isKnownScope } from './permissions.js';
import { isPkceText, verifyCodeVerifier } from './pkce.js';
import { renderConsentPage, renderErrorPage } from './oauth-consent-page.js';

const log = debug('cadre:provider:oauth');

export const DEFAULT_ACCESS_TOKEN_TTL_SEC = 3600;
export const DEFAULT_REFRESH_TOKEN_TTL_SEC = 30 * 24 * 3600;

/**
 * How long an issued code waits for its exchange: enough for a slow browser hand-off back to
 * the app, short enough that a code seen in a log or a referrer is worth little.
 */
const AUTHORIZATION_CODE_TTL_MS = 10 * 60_000;

/** The token endpoint's answer (RFC 6749 §5.1). */
export interface TokenResponse {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  refresh_token: string;
  /** Space-separated, as requested. */
  scope: string;
}

export interface OAuthRouteContext {
  basePath: string;
  oauth: OAuthConfig;
  store: ProviderStore;
  billingService: BillingService;
  hooks?: AuthHooks;
}

/** The authorize request's parameters, from the query (`GET`) or the consent form (`POST`). */
interface AuthorizeParams {
  responseType?: string;
  clientId?: string;
  redirectUri?: string;
  scope?: string;
  state?: string;
  codeChallenge?: string;
  codeChallengeMethod?: string;
}

/** The wire names of {@link AuthorizeParams}, in the order the consent form carries them. */
const AUTHORIZE_PARAM_NAMES: Record<keyof AuthorizeParams, string> = {
  responseType: 'response_type',
  clientId: 'client_id',
  redirectUri: 'redirect_uri',
  scope: 'scope',
  state: 'state',
  codeChallenge: 'code_challenge',
  codeChallengeMethod: 'code_challenge_method',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The parsed query or body as a record; anything else (no body, a list) counts as empty. */
function recordOf(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

/** `source[name]` when it is one string; a repeated parameter or a non-string is absent. */
function stringParam(source: Record<string, unknown>, name: string): string | undefined {
  const value = source[name];
  return typeof value === 'string' ? value : undefined;
}

function readAuthorizeParams(source: Record<string, unknown>): AuthorizeParams {
  const params: AuthorizeParams = {};
  for (const [key, name] of Object.entries(AUTHORIZE_PARAM_NAMES) as [keyof AuthorizeParams, string][]) {
    const value = stringParam(source, name);
    if (value !== undefined) params[key] = value;
  }
  return params;
}

/** {@link AuthorizeParams} back in wire form, for the consent form's hidden fields. */
function wireParams(params: AuthorizeParams): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, name] of Object.entries(AUTHORIZE_PARAM_NAMES) as [keyof AuthorizeParams, string][]) {
    const value = params[key];
    if (value !== undefined) out[name] = value;
  }
  return out;
}

/** Every string-valued entry of the query, as the `authorizeCustomer` hook sees it. */
function stringEntries(source: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === 'string') out[key] = value;
  }
  return out;
}

function findClient(clients: OAuthClientConfig[], clientId: string | undefined): OAuthClientConfig | undefined {
  return clients.find((client) => client.clientId === clientId);
}

/**
 * The registered client and the redirect URI the browser may be sent to, or the message for
 * the 400 page. The comparison is exact string equality with no normalization: the registered
 * list is what makes that safe, and any looser match is a place to send a code elsewhere.
 */
function resolveClient(
  clients: OAuthClientConfig[],
  params: AuthorizeParams,
): { client: OAuthClientConfig; redirectUri: string } | { problem: string } {
  if (params.clientId === undefined) return { problem: 'client_id is required' };
  const client = findClient(clients, params.clientId);
  if (!client) return { problem: `Unknown client_id ${params.clientId}` };
  if (params.redirectUri === undefined) return { problem: 'redirect_uri is required' };
  if (!client.redirectUris.includes(params.redirectUri)) {
    return { problem: `redirect_uri ${params.redirectUri} is not registered for client ${client.clientId}` };
  }
  return { client, redirectUri: params.redirectUri };
}

/** A fault answered by redirecting to the registered URI (RFC 6749 §4.1.2.1). */
interface RedirectedFault {
  error: 'invalid_request' | 'invalid_scope' | 'unsupported_response_type' | 'access_denied';
  description: string;
}

/** The scopes to grant, or the fault to redirect with, once the client and redirect URI are known. */
function checkAuthorizeRequest(client: OAuthClientConfig, params: AuthorizeParams): { scopes: string[] } | RedirectedFault {
  if (params.responseType !== 'code') {
    return { error: 'unsupported_response_type', description: 'response_type must be code' };
  }
  if (params.state === undefined || params.state === '') {
    return { error: 'invalid_request', description: 'state is required' };
  }
  if (params.codeChallengeMethod !== 'S256') {
    return { error: 'invalid_request', description: 'code_challenge_method must be S256' };
  }
  if (params.codeChallenge === undefined || !isPkceText(params.codeChallenge)) {
    return { error: 'invalid_request', description: 'code_challenge must be 43 to 128 base64url characters' };
  }
  const scopes = (params.scope ?? '').split(' ').filter((scope) => scope !== '');
  if (scopes.length === 0) {
    return { error: 'invalid_scope', description: 'scope is required' };
  }
  const refused = scopes.find((scope) => !isKnownScope(scope) || !hasPermission(client.scopes, scope));
  if (refused !== undefined) {
    return { error: 'invalid_scope', description: `scope ${refused} is unknown or not allowed for this client` };
  }
  return { scopes: [...new Set(scopes)] };
}

/** `uri` with `params` added to its query; a custom scheme (`app://cb`) is appended to like any other. */
function withQuery(uri: string, params: Record<string, string | undefined>): string {
  const url = new URL(uri);
  for (const [name, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(name, value);
  }
  return url.toString();
}

function sendErrorPage(reply: FastifyReply, status: number, message: string): FastifyReply {
  return reply.status(status).type('text/html; charset=utf-8').send(renderErrorPage(message));
}

function redirectWithFault(reply: FastifyReply, redirectUri: string, fault: RedirectedFault, state: string | undefined): FastifyReply {
  log('Authorize refused: %s (%s)', fault.error, fault.description);
  return reply.redirect(withQuery(redirectUri, { error: fault.error, error_description: fault.description, state }), 302);
}

/** 32 random bytes as base64url: a code, an access token or a refresh token. */
function randomToken(): string {
  return randomBytes(32).toString('base64url');
}

/** The data every issued code is minted from. */
interface Grant {
  client: OAuthClientConfig;
  redirectUri: string;
  scopes: string[];
  codeChallenge: string;
  state: string;
}

/**
 * Mint a code for `customerId`, record it hashed, and send the browser back to the app with
 * it. A customer with no billing record gets one here, so `GET /billing/status` answers for
 * every signed-in customer and `canCreateContainer` applies the chosen plan from the first
 * create.
 */
async function issueCode(
  ctx: OAuthRouteContext,
  reply: FastifyReply,
  grant: Grant,
  customerId: string,
  planId: string | undefined,
): Promise<FastifyReply> {
  const code = randomToken();
  await ctx.store.saveAuthorizationCode({
    codeHash: hashApiKey(code),
    clientId: grant.client.clientId,
    customerId,
    scopes: grant.scopes,
    codeChallenge: grant.codeChallenge,
    redirectUri: grant.redirectUri,
    expiresAt: new Date(Date.now() + AUTHORIZATION_CODE_TTL_MS),
  });
  if (!(await ctx.billingService.getCustomerBilling(customerId))) {
    await ctx.billingService.initializeCustomer(customerId, planId);
  }
  log('Issued code to client %s for customer %s', grant.client.clientId, customerId);
  return reply.redirect(withQuery(grant.redirectUri, { code, state: grant.state }), 302);
}

async function applyDecision(
  ctx: OAuthRouteContext,
  reply: FastifyReply,
  grant: Grant,
  decision: AuthorizationDecision,
): Promise<FastifyReply> {
  if ('redirect' in decision) return reply.redirect(decision.redirect, 302);
  if ('deny' in decision) {
    return redirectWithFault(reply, grant.redirectUri, { error: 'access_denied', description: decision.deny }, grant.state);
  }
  return issueCode(ctx, reply, grant, decision.customerId, decision.planId);
}

/** Mint an access token and a refresh token for `customerId`, both stored hashed. */
async function mintTokens(ctx: OAuthRouteContext, clientId: string, customerId: string, scopes: string[]): Promise<TokenResponse> {
  const accessToken = randomToken();
  const refreshToken = randomToken();
  const accessKeyHash = hashApiKey(accessToken);
  const now = new Date();
  const accessTtlSec = ctx.oauth.accessTokenTtlSec ?? DEFAULT_ACCESS_TOKEN_TTL_SEC;
  const refreshTtlSec = ctx.oauth.refreshTokenTtlSec ?? DEFAULT_REFRESH_TOKEN_TTL_SEC;
  await ctx.store.saveApiKey({
    keyHash: accessKeyHash,
    customerId,
    name: `oauth:${clientId}`,
    permissions: scopes,
    createdAt: now,
    expiresAt: new Date(now.getTime() + accessTtlSec * 1000),
  });
  await ctx.store.saveRefreshToken({
    tokenHash: hashApiKey(refreshToken),
    clientId,
    customerId,
    scopes,
    accessKeyHash,
    expiresAt: new Date(now.getTime() + refreshTtlSec * 1000),
  });
  return {
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: accessTtlSec,
    refresh_token: refreshToken,
    scope: scopes.join(' '),
  };
}

type TokenError = 'invalid_request' | 'invalid_client' | 'invalid_grant' | 'unsupported_grant_type';

/** RFC 6749 §5.2: 400 with `error` and `error_description`. */
function tokenError(reply: FastifyReply, error: TokenError, description: string): FastifyReply {
  log('Token refused: %s (%s)', error, description);
  return reply.status(400).send({ error, error_description: description });
}

async function exchangeCode(ctx: OAuthRouteContext, body: Record<string, unknown>, reply: FastifyReply): Promise<FastifyReply> {
  const code = stringParam(body, 'code');
  const verifier = stringParam(body, 'code_verifier');
  const clientId = stringParam(body, 'client_id');
  const redirectUri = stringParam(body, 'redirect_uri');
  if (code === undefined || verifier === undefined || clientId === undefined || redirectUri === undefined) {
    return tokenError(reply, 'invalid_request', 'code, code_verifier, client_id and redirect_uri are required');
  }
  if (!findClient(ctx.oauth.clients, clientId)) return tokenError(reply, 'invalid_client', 'unknown client_id');
  if (!isPkceText(verifier)) return tokenError(reply, 'invalid_request', 'code_verifier must be 43 to 128 unreserved characters');

  // Taken, not read: the code is gone after this whether or not the exchange succeeds.
  // NOTE: a code presented twice is refused, but the tokens its first exchange minted are not
  // revoked (RFC 6819 §5.2.1.1 recommends it); add revocation if a leaked code is ever a worry,
  // since a code lives ten minutes and is useless without the verifier.
  const record = await ctx.store.takeAuthorizationCode(hashApiKey(code));
  const valid = record !== undefined
    && record.expiresAt >= new Date()
    && record.clientId === clientId
    && record.redirectUri === redirectUri
    && verifyCodeVerifier(verifier, record.codeChallenge);
  if (!valid) {
    return tokenError(reply, 'invalid_grant', 'authorization code is unknown, expired, already used, or not for this client, redirect_uri and code_verifier');
  }
  return reply.send(await mintTokens(ctx, clientId, record.customerId, record.scopes));
}

async function refreshTokens(ctx: OAuthRouteContext, body: Record<string, unknown>, reply: FastifyReply): Promise<FastifyReply> {
  const token = stringParam(body, 'refresh_token');
  const clientId = stringParam(body, 'client_id');
  if (token === undefined || clientId === undefined) {
    return tokenError(reply, 'invalid_request', 'refresh_token and client_id are required');
  }
  if (!findClient(ctx.oauth.clients, clientId)) return tokenError(reply, 'invalid_client', 'unknown client_id');

  // Rotation: the presented token is gone after this, and the new pair replaces it.
  const record = await ctx.store.takeRefreshToken(hashApiKey(token));
  if (record === undefined || record.expiresAt < new Date() || record.clientId !== clientId) {
    return tokenError(reply, 'invalid_grant', 'refresh token is unknown, expired, already used, or not for this client');
  }
  // Best-effort: the access key may already be gone (expired and deleted on presentation, or a
  // crash between the two deletes of an earlier rotation); the new pair is minted either way.
  await ctx.store.deleteApiKey(record.accessKeyHash);
  return reply.send(await mintTokens(ctx, clientId, record.customerId, record.scopes));
}

/** Register the authorize and token endpoints under `basePath`; the auth preHandler skips them by path. */
export function registerOAuthRoutes(app: FastifyInstance, ctx: OAuthRouteContext): void {
  const { basePath, oauth, hooks } = ctx;
  const authorizePath = `${basePath}/oauth/authorize`;

  app.get(authorizePath, async (request, reply) => {
    const query = recordOf(request.query);
    const params = readAuthorizeParams(query);
    const target = resolveClient(oauth.clients, params);
    if ('problem' in target) return sendErrorPage(reply, 400, target.problem);
    const checked = checkAuthorizeRequest(target.client, params);
    if ('error' in checked) return redirectWithFault(reply, target.redirectUri, checked, params.state);
    const grant: Grant = { ...target, scopes: checked.scopes, codeChallenge: params.codeChallenge!, state: params.state! };

    if (hooks?.authorizeCustomer) {
      const decision = await hooks.authorizeCustomer({
        clientId: target.client.clientId,
        scopes: grant.scopes,
        headers: request.headers,
        query: stringEntries(query),
      });
      return applyDecision(ctx, reply, grant, decision);
    }
    if (oauth.devConsentPage) {
      return reply.type('text/html; charset=utf-8').send(renderConsentPage({
        action: authorizePath,
        clientId: target.client.clientId,
        scopes: grant.scopes,
        plans: ctx.billingService.listPlans(),
        params: wireParams(params),
      }));
    }
    // `registerAuth` refuses this configuration at start; reached only by a server built around it.
    return reply.status(500).send({
      ok: false,
      error: { code: 'NOT_CONFIGURED', message: 'No authorizeCustomer hook and no dev consent page: nothing can resolve a customer' },
    });
  });

  if (oauth.devConsentPage) {
    app.post(authorizePath, async (request, reply) => {
      const body = recordOf(request.body);
      const params = readAuthorizeParams(body);
      const target = resolveClient(oauth.clients, params);
      if ('problem' in target) return sendErrorPage(reply, 400, target.problem);
      const checked = checkAuthorizeRequest(target.client, params);
      if ('error' in checked) return redirectWithFault(reply, target.redirectUri, checked, params.state);
      const grant: Grant = { ...target, scopes: checked.scopes, codeChallenge: params.codeChallenge!, state: params.state! };

      if (stringParam(body, 'decision') !== 'approve') {
        return applyDecision(ctx, reply, grant, { deny: 'The user denied the request' });
      }
      const customerId = stringParam(body, 'customer_id')?.trim();
      if (!customerId) return sendErrorPage(reply, 400, 'customer_id is required');
      const planId = stringParam(body, 'plan_id') || undefined;
      if (planId !== undefined && !ctx.billingService.getPlan(planId)) {
        return sendErrorPage(reply, 400, `Unknown plan ${planId}`);
      }
      return applyDecision(ctx, reply, grant, { customerId, planId });
    });
  }

  app.post(`${basePath}/oauth/token`, async (request, reply) => {
    // Tokens are credentials: nothing between the app and this route may keep a copy.
    reply.header('Cache-Control', 'no-store').header('Pragma', 'no-cache');
    const body = recordOf(request.body);
    const grantType = stringParam(body, 'grant_type');
    if (grantType === undefined) return tokenError(reply, 'invalid_request', 'grant_type is required');
    if (grantType === 'authorization_code') return exchangeCode(ctx, body, reply);
    if (grantType === 'refresh_token') return refreshTokens(ctx, body, reply);
    return tokenError(reply, 'unsupported_grant_type', `grant_type ${grantType} is not supported`);
  });

  log('OAuth routes registered at %s/oauth (%d clients, dev consent page: %s)', basePath, oauth.clients.length, oauth.devConsentPage === true);
}
