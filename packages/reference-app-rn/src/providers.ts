/**
 * providers.ts — the hosting providers this build offers under Settings → Rent an always-on
 * node, and the public plan list a provider publishes. One configured provider, from the
 * build-time env, until `tickets/blocked/decide-provider-directory.md` says where a list comes
 * from. No React and no native imports, so `test/rentals.spec.ts` can run the plan parser.
 */

/** One provider the store screen offers: where its descriptor is, and the client id this app registered with it. */
export interface ConfiguredProvider {
	/** The descriptor URL (`http://<dev machine>:3000/api/v1/descriptor` for a local cadre-provider). */
	descriptorUrl: string;
	/** The client id registered with the provider; the redirect URI is {@link providerRedirectUri}. */
	clientId: string;
}

/** The client id both installs use unless the build names another: the one cadre-provider's README registers, with both installs' redirect URIs. */
const DEFAULT_CLIENT_ID = 'sereus-chat';

/**
 * The providers this build knows: the one `EXPO_PUBLIC_PROVIDER_DESCRIPTOR_URL` names (Expo inlines
 * `EXPO_PUBLIC_`-prefixed vars into the bundle at build time), with `EXPO_PUBLIC_PROVIDER_CLIENT_ID`
 * as its client id, else `sereus-chat`. Blank or unset means no provider, and the section does not show.
 */
export function configuredProviders(): ConfiguredProvider[] {
	const descriptorUrl = process.env.EXPO_PUBLIC_PROVIDER_DESCRIPTOR_URL?.trim();
	if (!descriptorUrl) return [];
	return [{ descriptorUrl, clientId: process.env.EXPO_PUBLIC_PROVIDER_CLIENT_ID?.trim() || DEFAULT_CLIENT_ID }];
}

/** The path of the redirect URI, after the scheme. */
const REDIRECT_PATH = 'provider-auth';

/**
 * The redirect URI this build registers with a provider: `<own scheme>://provider-auth`, so
 * `sereus-chat://provider-auth` for the main install and `sereus-chat-second://provider-auth` for
 * the second. Built from the scheme rather than `Linking.createURL`, because the provider compares
 * it with the registered one by exact string equality and this spelling is the registered one.
 */
export function providerRedirectUri(scheme: string): string {
	return `${scheme}://${REDIRECT_PATH}`;
}

/** Whether an incoming URL is the provider's redirect, whatever this install's scheme. */
export function isProviderAuthRedirect(url: string): boolean {
	return /^[a-z][a-z0-9+.-]*:\/\/provider-auth(?:[/?#]|$)/i.test(url.trim());
}

/** A plan as the store screen lists it, from the provider's `plansUrl`. */
export interface ProviderPlan {
	id: string;
	name: string;
	pricePerHourCents: number;
}

/**
 * The plans in a `GET plansUrl` answer (`{ ok, data: { plans } }`, cadre-provider's envelope), each
 * with an id, a name and a price per hour in cents. Throws when the document is not that, so the
 * section shows the error rather than an empty plan list.
 */
export function parsePlans(json: unknown): ProviderPlan[] {
	const data = (typeof json === 'object' && json !== null ? json : {}) as { data?: unknown };
	const plans = (typeof data.data === 'object' && data.data !== null ? data.data : {}) as { plans?: unknown };
	if (!Array.isArray(plans.plans)) throw new Error('The provider\'s plan list is not the JSON object its API documents');
	return plans.plans.map(parsePlan);
}

function parsePlan(value: unknown): ProviderPlan {
	const { id, name, pricePerHourCents } = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
	if (typeof id !== 'string' || typeof name !== 'string' || typeof pricePerHourCents !== 'number' || !Number.isFinite(pricePerHourCents)) {
		throw new Error('A plan in the provider\'s list lacks its id, name or price per hour');
	}
	return { id, name, pricePerHourCents };
}

/** "$0.05 per hour", from a price in cents. */
export function planPriceText(plan: ProviderPlan): string {
	return `$${(plan.pricePerHourCents / 100).toFixed(2)} per hour`;
}

/** `GET url` through `fetchImpl` (global `fetch` by default), parsed with {@link parsePlans}. */
export async function fetchPlans(url: string, fetchImpl: typeof fetch = fetch): Promise<ProviderPlan[]> {
	const response = await fetchImpl(url, { headers: { accept: 'application/json' } });
	if (!response.ok) throw new Error(`The provider's plan list at ${url} answered ${response.status}`);
	return parsePlans(await response.json());
}
