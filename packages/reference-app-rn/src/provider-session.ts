/**
 * provider-session.ts — one provider as the store section holds it: its descriptor, the tokens
 * this app keeps for it, and the client over them. Sign-in opens the system browser through the
 * kit's `signInWithProvider`; a token the provider refuses to refresh (`reauthorize`) is dropped
 * and the user signs in again before the step they asked for is retried, once.
 *
 * The browser, the secure store and `fetch` are passed in, so this module imports nothing native
 * and `provider-store-section.tsx` supplies `expo-web-browser` and `expo-secure-store`.
 */

import {
	createProviderClient,
	createTokenSource,
	fetchProviderDescriptor,
	ProviderAuthError,
	type ProviderClient,
	type ProviderDescriptor,
	type ProviderTokens,
} from '@serfab/cadre-core';
import { signInWithProvider, type OpenAuthSession, type ProviderTokensSlot } from '@serfab/cadre-rn/provider';
import type { ConfiguredProvider } from './providers';

export interface ProviderSessionPlatform {
	openAuthSession: OpenAuthSession;
	/** Where the tokens for the provider with this descriptor `id` are kept (the kit's `providerTokensSlot`). */
	tokensFor: (providerId: string) => ProviderTokensSlot;
	fetch?: typeof fetch;
}

export interface ProviderSession {
	readonly descriptor: ProviderDescriptor;
	/** Whether a token pair is held. */
	signedIn(): boolean;
	/** The client over the held pair, or null when signed out. For polls: it never opens the browser. */
	client(): ProviderClient | null;
	/** Sign in through the system browser and keep the pair; `'cancelled'` when the user closed the browser. */
	signIn(): Promise<'signed-in' | 'cancelled'>;
	/** Drop the pair. The rentals stay. */
	signOut(): Promise<void>;
	/**
	 * Run `action` with a signed-in client: sign in first when signed out, and when the provider
	 * refuses the held pair (`reauthorize`) drop it, sign in again and run `action` once more.
	 * `'cancelled'` when the user closed the browser; any other failure is `action`'s.
	 */
	withClient<T>(action: (client: ProviderClient) => Promise<T>): Promise<T | 'cancelled'>;
	/**
	 * Whether `error` is the provider refusing the held pair; if so the pair is dropped, so
	 * {@link signedIn} reads false and the rows say to sign in. For a poll, which must not open the browser.
	 */
	tokensRefused(error: unknown): Promise<boolean>;
}

/** Fetch the provider's descriptor and load the pair this app keeps for it. */
export async function openProviderSession(provider: ConfiguredProvider, redirectUri: string, platform: ProviderSessionPlatform): Promise<ProviderSession> {
	const descriptor = await fetchProviderDescriptor(provider.descriptorUrl, platform.fetch);
	const slot = platform.tokensFor(descriptor.id);
	return new Session(descriptor, provider.clientId, redirectUri, platform, slot, await slot.load());
}

class Session implements ProviderSession {
	private current: ProviderClient | null;

	constructor(
		readonly descriptor: ProviderDescriptor,
		private readonly clientId: string,
		private readonly redirectUri: string,
		private readonly platform: ProviderSessionPlatform,
		private readonly tokens: ProviderTokensSlot,
		stored: ProviderTokens | undefined,
	) {
		this.current = stored ? this.clientOver(stored) : null;
	}

	signedIn(): boolean {
		return this.current !== null;
	}

	client(): ProviderClient | null {
		return this.current;
	}

	async signIn(): Promise<'signed-in' | 'cancelled'> {
		const { descriptor, clientId, redirectUri, platform } = this;
		const pair = await signInWithProvider({ descriptor, clientId, redirectUri, openAuthSession: platform.openAuthSession, fetch: platform.fetch });
		if (pair === 'cancelled') return 'cancelled';
		await this.tokens.save(pair);
		this.current = this.clientOver(pair);
		return 'signed-in';
	}

	async signOut(): Promise<void> {
		this.current = null;
		await this.tokens.clear();
	}

	async withClient<T>(action: (client: ProviderClient) => Promise<T>): Promise<T | 'cancelled'> {
		const client = this.current ?? await this.signInForClient();
		if (client === 'cancelled') return 'cancelled';
		try {
			return await action(client);
		} catch (error) {
			if (!await this.tokensRefused(error)) throw error;
			// The pair is spent; the user signs in again and the step runs once more. A second
			// refusal is the caller's error: no silent loop.
			const again = await this.signInForClient();
			return again === 'cancelled' ? 'cancelled' : await action(again);
		}
	}

	async tokensRefused(error: unknown): Promise<boolean> {
		if (!(error instanceof ProviderAuthError) || error.code !== 'reauthorize') return false;
		await this.signOut();
		return true;
	}

	private async signInForClient(): Promise<ProviderClient | 'cancelled'> {
		if (await this.signIn() === 'cancelled') return 'cancelled';
		// Set by `signIn`; read back rather than kept, so a second sign-in replaces it too.
		return this.current ?? 'cancelled';
	}

	/** A client whose token source keeps the stored pair current: each refresh overwrites the secure-store entry. */
	private clientOver(pair: ProviderTokens): ProviderClient {
		const { descriptor, clientId, platform } = this;
		const source = createTokenSource({ descriptor, clientId, tokens: pair, persist: (next) => this.tokens.save(next), fetch: platform.fetch });
		return createProviderClient({ apiBaseUrl: descriptor.apiBaseUrl, tokens: source, fetch: platform.fetch });
	}
}
