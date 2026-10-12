/**
 * The provider descriptor: what a hosting provider says about itself (`GET /descriptor`,
 * `docs/architecture.md` → "Provider descriptor and sign-in"), as an app's store screen
 * renders it and as the sign-in and the provider client read it. The parser refuses, with a
 * plain message, a document the rest of this directory could not work with.
 *
 * Imports only the package's `fetch` helper: it loads on React Native and in the browser as
 * well as Node.
 */

import { requireFetch } from '../fetch-impl.js';

/** Version 1 of the descriptor, the only one an app reads. */
export interface ProviderDescriptor {
	v: 1;
	/** Stable identifier an app keys its rental records by. */
	id: string;
	name: string;
	/** The root every API route hangs off (`https://nodes.acme.example/api/v1`); the bearer goes here and nowhere else. */
	apiBaseUrl: string;
	/** The sign-in endpoints, and the union of the scopes any registered app may be granted. */
	oauth: {
		authorizeUrl: string;
		tokenUrl: string;
		scopes: string[];
	};
	/** The public plan list, readable before sign-in. */
	plansUrl: string;
	termsUrl?: string;
	/** Regions in the provider's own words. */
	regions?: string[];
	icon?: string;
}

/**
 * Read a descriptor document. Refuses: any version but 1; a missing or blank `id` or `name`;
 * an `apiBaseUrl`, `oauth.authorizeUrl`, `oauth.tokenUrl` or `plansUrl` that is not an
 * absolute URL, or is `http` at a host other than loopback, since the node code and the tokens
 * travel over them; a `termsUrl` or `icon` that is not an absolute web URL; `regions` or
 * `oauth.scopes` that are not string lists. A descriptor without `oauth` is refused too:
 * no app could sign in to that provider.
 */
export function parseProviderDescriptor(json: unknown): ProviderDescriptor {
	const doc = requireObject(json, 'A provider descriptor');
	if (doc.v !== 1) throw new Error(`A provider descriptor must carry v: 1 (this one carries ${JSON.stringify(doc.v)})`);
	const id = requireText(doc.id, 'id');
	const name = requireText(doc.name, 'name');
	const apiBaseUrl = requireApiUrl(doc.apiBaseUrl, 'apiBaseUrl');
	const plansUrl = requireApiUrl(doc.plansUrl, 'plansUrl');
	const oauth = requireObject(doc.oauth, 'A provider descriptor\'s oauth block');
	const parsed: ProviderDescriptor = {
		v: 1,
		id,
		name,
		apiBaseUrl,
		oauth: {
			authorizeUrl: requireApiUrl(oauth.authorizeUrl, 'oauth.authorizeUrl'),
			tokenUrl: requireApiUrl(oauth.tokenUrl, 'oauth.tokenUrl'),
			scopes: requireStrings(oauth.scopes, 'oauth.scopes'),
		},
		plansUrl,
	};
	if (doc.termsUrl !== undefined) parsed.termsUrl = requireWebUrl(doc.termsUrl, 'termsUrl');
	if (doc.icon !== undefined) parsed.icon = requireWebUrl(doc.icon, 'icon');
	if (doc.regions !== undefined) parsed.regions = requireStrings(doc.regions, 'regions');
	return parsed;
}

/** `GET url`, parsed with {@link parseProviderDescriptor}, for an app that holds a URL rather than the document. */
export async function fetchProviderDescriptor(url: string, fetchImpl?: typeof fetch): Promise<ProviderDescriptor> {
	const doFetch = requireFetch(fetchImpl);
	const response = await doFetch(url, { headers: { accept: 'application/json' } });
	if (!response.ok) {
		throw new Error(`The provider descriptor at ${url} answered ${response.status}`);
	}
	return parseProviderDescriptor(await response.json());
}

/** Hosts at which an API URL may be plain `http`: a dev run on this machine. */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

function requireObject(value: unknown, what: string): Record<string, unknown> {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		throw new Error(`${what} must be a JSON object`);
	}
	return value as Record<string, unknown>;
}

function requireText(value: unknown, field: string): string {
	if (typeof value !== 'string' || value.trim() === '') {
		throw new Error(`A provider descriptor's ${field} must be a non-blank string`);
	}
	return value;
}

function requireStrings(value: unknown, field: string): string[] {
	if (!Array.isArray(value) || !value.every((entry): entry is string => typeof entry === 'string')) {
		throw new Error(`A provider descriptor's ${field} must be a list of strings`);
	}
	return [...value];
}

/** An absolute `http(s)` URL, as a link a store screen opens. */
function requireWebUrl(value: unknown, field: string): string {
	const text = requireText(value, field);
	const url = parseUrl(text, field);
	if (url.protocol !== 'https:' && url.protocol !== 'http:') {
		throw new Error(`A provider descriptor's ${field} must be an http or https URL (${text} is not)`);
	}
	return text;
}

/** {@link requireWebUrl}, and `https` unless the host is loopback: tokens and the node code travel over it. */
function requireApiUrl(value: unknown, field: string): string {
	const text = requireWebUrl(value, field);
	const url = new URL(text);
	if (url.protocol === 'http:' && !LOOPBACK_HOSTS.has(url.hostname)) {
		throw new Error(`A provider descriptor's ${field} must be https unless its host is loopback (${text} is plain http at ${url.hostname})`);
	}
	return text;
}

function parseUrl(text: string, field: string): URL {
	try {
		return new URL(text);
	} catch (error) {
		throw new Error(`A provider descriptor's ${field} must be an absolute URL (${text} is not)`, { cause: error });
	}
}
