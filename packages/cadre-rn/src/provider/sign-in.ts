/**
 * Signing in to a hosting provider from a phone, and keeping what it yields: the OAuth 2 +
 * PKCE handshake cadre-core's `provider/oauth.ts` defines, with the system browser opened
 * through a function the app passes in, and the tokens filed in the platform secure store.
 *
 * Nothing native is imported. `openAuthSession` has the signature of `expo-web-browser`'s
 * `openAuthSessionAsync`, so an Expo app passes that function itself; a bare React Native app
 * passes an adapter over its own in-app browser. The secure store comes in through the same
 * {@link SecureStoreApi} seam `/key-store` and `/node-local` use.
 *
 * Codes and tokens are credentials: none is ever logged.
 */

import {
	authorizationUrl,
	createAuthorizationState,
	createPkce,
	exchangeAuthorizationCode,
	ProviderAuthError,
	readAuthorizationRedirect,
	type ProviderDescriptor,
	type ProviderTokens,
} from '@serfab/cadre-core';
import {
	forwardedSecureStoreOptions,
	secureStoreKeySegment,
	type SecureStoreApi,
	type SecureStoreKeyStoreOptions,
} from '../key-store.js';

/**
 * What the system browser came back with, as `expo-web-browser`'s `openAuthSessionAsync`
 * reports it: the redirect URL on success, otherwise only why the session ended without one
 * (cancelled, dismissed, locked, or on Android merely opened). The second arm's `type` is any
 * string, since expo-web-browser spells its values as a string enum, which does not assign to a
 * literal union; a result without a URL is a cancellation whatever it says.
 */
export type AuthSessionResult =
	| { type: 'success'; url: string }
	| { type: string; url?: undefined };

/**
 * Open `url` in the system browser and resolve when the browser is sent to a URL starting with
 * `redirectUri`, or when the user closes it. `expo-web-browser`'s `openAuthSessionAsync` is one.
 */
export type OpenAuthSession = (url: string, redirectUri: string) => Promise<AuthSessionResult>;

export interface SignInWithProviderOptions {
	descriptor: ProviderDescriptor;
	/** The client id the app registered with the provider. */
	clientId: string;
	/** One of that client's registered redirect URIs, exactly as registered (`sereus-chat://provider-auth`). */
	redirectUri: string;
	openAuthSession: OpenAuthSession;
	/** Scopes to ask for; defaults to every scope the descriptor lists. */
	scopes?: readonly string[];
	fetch?: typeof fetch;
}

/**
 * Sign in: mint a PKCE pair and a state, open the provider's authorize URL in the system
 * browser, read the redirect it comes back with and exchange the code for tokens.
 *
 * `'cancelled'` when the browser closed without a redirect (the user cancelled or dismissed it,
 * or the device locked): nothing was created and nothing is stored. Throws `ProviderAuthError`
 * when the redirect carries the provider's refusal (`access_denied`, `invalid_scope`, ...), when
 * its state is not this sign-in's, or when the token exchange is refused; the provider's own
 * page handles an unknown client or redirect URI and never comes back.
 */
export async function signInWithProvider(options: SignInWithProviderOptions): Promise<ProviderTokens | 'cancelled'> {
	const { descriptor, clientId, redirectUri } = options;
	const pkce = createPkce();
	const state = createAuthorizationState();
	const url = authorizationUrl(descriptor, { clientId, redirectUri, state, challenge: pkce.challenge, scopes: options.scopes });
	const result = await options.openAuthSession(url, redirectUri);
	if (result.type !== 'success' || result.url === undefined) return 'cancelled';
	const redirect = readAuthorizationRedirect(result.url, { expectedState: state });
	if ('error' in redirect) throw new ProviderAuthError(redirect.error, redirect.description);
	return await exchangeAuthorizationCode(descriptor, { clientId, redirectUri, code: redirect.code, verifier: pkce.verifier, fetch: options.fetch });
}

/**
 * Secure-store key prefix for a provider's tokens. Its own prefix, outside the `sereus.ks.`
 * namespace `SecureStoreKeyStore` owns (whose `__index` must never see a foreign entry) and
 * the anchor's `sereus.anchor.`.
 */
const TOKENS_KEY_PREFIX = 'sereus.provider-tokens.';

/** Secure-store key for a provider's tokens; the provider id is base64url-encoded, as a secure-store key allows only `[A-Za-z0-9._-]`. */
export function providerTokensKey(providerId: string): string {
	return TOKENS_KEY_PREFIX + secureStoreKeySegment(providerId);
}

/** Where an app keeps one provider's tokens; see {@link providerTokensSlot}. */
export interface ProviderTokensSlot {
	/** The stored pair, or `undefined` when none is stored or the record is unreadable as one. A denied or failed read throws. */
	load(): Promise<ProviderTokens | undefined>;
	/** Store a pair: the one the sign-in yielded, and each one a refresh rotates to (`createTokenSource`'s `persist`). */
	save(tokens: ProviderTokens): Promise<void>;
	/** Sign out: delete the pair. */
	clear(): Promise<void>;
}

/**
 * One provider's tokens in the platform secure store, under {@link providerTokensKey}. They
 * are credentials for the customer's account at the provider, so they go where the identity
 * key goes. A pair is two opaque strings and two small fields, far under the secure store's
 * ~2048-byte value limit. `options` as for the key store; the slot must be ungated.
 */
export function providerTokensSlot(secureStore: SecureStoreApi, providerId: string, options: SecureStoreKeyStoreOptions = {}): ProviderTokensSlot {
	if (options.requireAuthentication === true) {
		// A gated entry reads `null` when its biometric set changed, which `load` would take as signed out
		// and the next save would then overwrite. Refuse up front, as `secureStoreSlot` does.
		throw new Error('providerTokensSlot: a gated (requireAuthentication) slot cannot treat a null read as signed out');
	}
	const forwarded = forwardedSecureStoreOptions(options);
	const key = providerTokensKey(providerId);
	return {
		async load() {
			const text = await secureStore.getItemAsync(key, forwarded);
			return text === null ? undefined : parseTokens(text, providerId);
		},
		save: (tokens) => secureStore.setItemAsync(key, JSON.stringify(tokens), forwarded),
		clear: () => secureStore.deleteItemAsync(key, forwarded),
	};
}

/** The stored pair, or `undefined`, logged, when the record is not one: the app then signs in again. The text itself is never logged. */
function parseTokens(text: string, providerId: string): ProviderTokens | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (err) {
		console.warn(`[cadre-rn/provider] the stored tokens for provider ${providerId} are not JSON; reading them as signed out:`, err);
		return undefined;
	}
	const { accessToken, refreshToken, expiresAt, scopes } = (typeof parsed === 'object' && parsed !== null ? parsed : {}) as Record<string, unknown>;
	if (typeof accessToken !== 'string' || typeof refreshToken !== 'string' || typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)
		|| !Array.isArray(scopes) || !scopes.every((scope): scope is string => typeof scope === 'string')) {
		console.warn(`[cadre-rn/provider] the stored tokens for provider ${providerId} have the wrong shape; reading them as signed out`);
		return undefined;
	}
	return { accessToken, refreshToken, expiresAt, scopes };
}
