/**
 * The app's side of signing in to a hosting provider: OAuth 2 authorization code with PKCE
 * (RFC 6749 §4.1, RFC 7636), the flow for a public client that holds no secret, against the
 * endpoints a provider descriptor names (`docs/architecture.md` → "Provider descriptor and
 * sign-in"). Opening the browser is the app's or its kit's; this module builds the URL it
 * opens, reads the redirect it comes back with, exchanges and refreshes tokens, and keeps a
 * token fresh for the provider client ({@link createTokenSource}).
 *
 * Imports `@noble/hashes` for SHA-256 and the CSPRNG (`crypto.getRandomValues`, which the
 * React Native kit polyfills) and `uint8arrays` for base64url, so it loads on React Native
 * and in the browser as well as Node. Codes and tokens are credentials: none is ever logged.
 */

import debug from 'debug';
import { sha256 } from '@noble/hashes/sha2.js';
import { randomBytes } from '@noble/hashes/utils.js';
import { toString as uint8ArrayToString } from 'uint8arrays';
import { requireFetch } from '../fetch-impl.js';
import type { ProviderDescriptor } from './descriptor.js';

const log = debug('sereus:cadre:provider-oauth');

/**
 * A sign-in fault, with a machine-readable `code`: the provider's own OAuth error code
 * (`invalid_grant`, `access_denied`, ... per RFC 6749 §5.2) when it answered one;
 * `state-mismatch` or `missing-code` when the redirect could not be read; `invalid_response`
 * when the token endpoint answered something that is not a token response; `reauthorize`
 * when a refresh was refused, the app's cue to run the authorization again.
 */
export class ProviderAuthError extends Error {
	constructor(readonly code: string, description?: string, options?: { cause?: unknown }) {
		super(description ? `${code}: ${description}` : code, options);
		this.name = 'ProviderAuthError';
	}
}

/** What a token exchange or refresh yields, with `expiresAt` already in epoch milliseconds. */
export interface ProviderTokens {
	accessToken: string;
	refreshToken: string;
	/** Epoch ms when `accessToken` stops working. */
	expiresAt: number;
	scopes: string[];
}

/** A PKCE pair (RFC 7636): the verifier the app keeps, and the S256 challenge it sends first. */
export interface Pkce {
	verifier: string;
	challenge: string;
}

/** The S256 challenge for `verifier`: base64url(SHA-256(ascii(verifier))), unpadded. */
export function pkceChallenge(verifier: string): string {
	return uint8ArrayToString(sha256(new TextEncoder().encode(verifier)), 'base64url');
}

/** A fresh pair: 32 random bytes as a 43-character base64url verifier, and its challenge. */
export function createPkce(): Pkce {
	const verifier = uint8ArrayToString(randomBytes(32), 'base64url');
	return { verifier, challenge: pkceChallenge(verifier) };
}

/** A random `state` for one authorization, which {@link readAuthorizationRedirect} checks the redirect against. */
export function createAuthorizationState(): string {
	return uint8ArrayToString(randomBytes(16), 'base64url');
}

export interface AuthorizationUrlOptions {
	/** The client id the app registered with the provider. */
	clientId: string;
	/** One of that client's registered redirect URIs, exactly as registered. */
	redirectUri: string;
	state: string;
	/** The S256 challenge of the verifier the app keeps ({@link createPkce}). */
	challenge: string;
	/** Scopes to ask for; defaults to every scope the descriptor lists. */
	scopes?: readonly string[];
}

/** The authorize URL to open in the system browser: `response_type=code`, the client, the redirect URI, the scopes space-joined, the state and the S256 challenge. */
export function authorizationUrl(descriptor: ProviderDescriptor, options: AuthorizationUrlOptions): string {
	const url = new URL(descriptor.oauth.authorizeUrl);
	url.searchParams.set('response_type', 'code');
	url.searchParams.set('client_id', options.clientId);
	url.searchParams.set('redirect_uri', options.redirectUri);
	url.searchParams.set('scope', (options.scopes ?? descriptor.oauth.scopes).join(' '));
	url.searchParams.set('state', options.state);
	url.searchParams.set('code_challenge', options.challenge);
	url.searchParams.set('code_challenge_method', 'S256');
	return url.toString();
}

/** What the browser came back with: a code to exchange, or the provider's refusal (RFC 6749 §4.1.2.1). */
export type AuthorizationRedirect =
	| { code: string }
	| { error: string; description?: string };

/**
 * Read the redirect URL the browser returned to the app. Throws `ProviderAuthError`
 * (`state-mismatch`) when its `state` is not `expectedState`, whichever outcome it carries,
 * and (`missing-code`) when it carries neither a code nor an error. The code is a credential
 * and never appears in a message or a log line.
 */
export function readAuthorizationRedirect(url: string, options: { expectedState: string }): AuthorizationRedirect {
	const params = new URL(url).searchParams;
	if (params.get('state') !== options.expectedState) {
		throw new ProviderAuthError('state-mismatch', 'the redirect\'s state is not the one this authorization sent');
	}
	const error = params.get('error');
	if (error !== null) {
		const description = params.get('error_description');
		return description === null ? { error } : { error, description };
	}
	const code = params.get('code');
	if (code === null || code === '') {
		throw new ProviderAuthError('missing-code', 'the redirect carries neither a code nor an error');
	}
	return { code };
}

export interface ExchangeAuthorizationCodeOptions {
	clientId: string;
	/** The redirect URI the authorization was sent with, exactly. */
	redirectUri: string;
	code: string;
	/** The verifier of the challenge the authorization was sent with. */
	verifier: string;
	fetch?: typeof fetch;
}

/** `grant_type=authorization_code` at the descriptor's token endpoint, form-encoded; a refusal is a `ProviderAuthError` with the provider's error code. */
export async function exchangeAuthorizationCode(descriptor: ProviderDescriptor, options: ExchangeAuthorizationCodeOptions): Promise<ProviderTokens> {
	return await requestTokens(descriptor, {
		grant_type: 'authorization_code',
		code: options.code,
		code_verifier: options.verifier,
		client_id: options.clientId,
		redirect_uri: options.redirectUri,
	}, options.fetch);
}

export interface RefreshTokensOptions {
	clientId: string;
	refreshToken: string;
	fetch?: typeof fetch;
}

/** `grant_type=refresh_token`: rotates the pair (the presented one stops working); a refusal is a `ProviderAuthError` with the provider's error code. */
export async function refreshTokens(descriptor: ProviderDescriptor, options: RefreshTokensOptions): Promise<ProviderTokens> {
	return await requestTokens(descriptor, {
		grant_type: 'refresh_token',
		refresh_token: options.refreshToken,
		client_id: options.clientId,
	}, options.fetch);
}

/** Hands the provider client a working bearer; see {@link createTokenSource}. */
export interface TokenSource {
	/** The current access token, refreshed first when it is within a minute of expiry. */
	accessToken(): Promise<string>;
	/**
	 * The provider answered 401 to `stale`: refresh and return the new token. A refresh that
	 * already replaced `stale` is not repeated, so two requests refused at once cost one
	 * rotation.
	 */
	invalidate(stale?: string): Promise<string>;
}

export interface TokenSourceOptions {
	descriptor: ProviderDescriptor;
	clientId: string;
	/** The tokens the app holds, from the exchange or from its store. */
	tokens: ProviderTokens;
	/** Called with the new pair after every refresh; the old pair has stopped working by then. */
	persist: (tokens: ProviderTokens) => void | Promise<void>;
	fetch?: typeof fetch;
	/** The clock, for tests. */
	now?: () => number;
}

/** A token is refreshed this long before it expires, so a request does not leave with one about to lapse. */
export const TOKEN_REFRESH_MARGIN_MS = 60_000;

/**
 * A {@link TokenSource} over one token pair: refreshes within {@link TOKEN_REFRESH_MARGIN_MS}
 * of expiry and on `invalidate`, calls `persist` after every refresh, and shares one refresh
 * among concurrent callers (a rotation spends the presented refresh token, so two at once
 * would leave one caller with a refused pair). A refused refresh throws
 * `ProviderAuthError('reauthorize')`: the pair is gone and the app signs in again; a network
 * failure is rethrown as is, since the pair may still be good.
 */
export function createTokenSource(options: TokenSourceOptions): TokenSource {
	const now = options.now ?? Date.now;
	let current = options.tokens;
	let inFlight: Promise<ProviderTokens> | null = null;

	const refresh = (): Promise<ProviderTokens> => {
		if (!inFlight) {
			inFlight = rotate().finally(() => { inFlight = null; });
		}
		return inFlight;
	};

	async function rotate(): Promise<ProviderTokens> {
		let next: ProviderTokens;
		try {
			next = await refreshTokens(options.descriptor, { clientId: options.clientId, refreshToken: current.refreshToken, fetch: options.fetch });
		} catch (error) {
			if (error instanceof ProviderAuthError) {
				log('token refresh refused (%s); the app must authorize again', error.code);
				throw new ProviderAuthError('reauthorize', `the provider refused to refresh the token (${error.code})`, { cause: error });
			}
			throw error;
		}
		current = next;
		await options.persist(next);
		log('token refreshed; expires in %ds', Math.round((next.expiresAt - now()) / 1000));
		return next;
	}

	return {
		async accessToken(): Promise<string> {
			const fresh = now() < current.expiresAt - TOKEN_REFRESH_MARGIN_MS ? current : await refresh();
			return fresh.accessToken;
		},
		async invalidate(stale?: string): Promise<string> {
			if (stale !== undefined && stale !== current.accessToken) return current.accessToken;
			return (await refresh()).accessToken;
		},
	};
}

/** One token-endpoint request (RFC 6749 §4.1.3, §6): form-encoded in, a token response or a `{ error, error_description }` refusal out. */
async function requestTokens(descriptor: ProviderDescriptor, form: Record<string, string>, fetchImpl?: typeof fetch): Promise<ProviderTokens> {
	const doFetch = requireFetch(fetchImpl);
	const requestedAt = Date.now();
	const response = await doFetch(descriptor.oauth.tokenUrl, {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
		body: new URLSearchParams(form).toString(),
	});
	const body = await readJson(response);
	if (!response.ok) {
		const error = body && typeof body.error === 'string' ? body.error : 'invalid_response';
		const description = body && typeof body.error_description === 'string'
			? body.error_description
			: `the token endpoint answered ${response.status}`;
		throw new ProviderAuthError(error, description);
	}
	return tokensFrom(body, requestedAt);
}

/** The response's JSON object, or null when the body is not one. */
async function readJson(response: Response): Promise<Record<string, unknown> | null> {
	try {
		const parsed: unknown = await response.json();
		return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
	} catch (error) {
		log('token endpoint answered %d with a body that is not JSON: %o', response.status, error);
		return null;
	}
}

/** `{ access_token, expires_in, refresh_token, scope }` as {@link ProviderTokens}; `expires_in` counts from when the request left. */
function tokensFrom(body: Record<string, unknown> | null, requestedAt: number): ProviderTokens {
	const accessToken = body?.access_token;
	const refreshToken = body?.refresh_token;
	const expiresIn = body?.expires_in;
	if (typeof accessToken !== 'string' || accessToken === '') {
		throw new ProviderAuthError('invalid_response', 'the token response carries no access_token');
	}
	if (typeof refreshToken !== 'string' || refreshToken === '') {
		throw new ProviderAuthError('invalid_response', 'the token response carries no refresh_token, which a token source needs to outlive the access token');
	}
	if (typeof expiresIn !== 'number' || !Number.isFinite(expiresIn) || expiresIn <= 0) {
		throw new ProviderAuthError('invalid_response', 'the token response carries no positive expires_in');
	}
	const scope = body?.scope;
	return {
		accessToken,
		refreshToken,
		expiresAt: requestedAt + expiresIn * 1000,
		scopes: typeof scope === 'string' ? scope.split(' ').filter((entry) => entry !== '') : [],
	};
}
