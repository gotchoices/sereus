/**
 * A typed client for a hosting provider's container API (`docs/architecture.md` → "Provider
 * Integration"; the wire shapes are cadre-provider's, `packages/cadre-provider/README.md`).
 * The interface is what `rentNode` and the apps depend on; a hand-written object implementing
 * it is how tests avoid HTTP.
 *
 * One request helper does the HTTP: the bearer from the token source, JSON in and out, a 401
 * answered once by `tokens.invalidate()` and a retry, every other non-2xx a
 * {@link ProviderApiError} from the provider's `{ ok: false, error }` envelope. Dates arrive
 * as ISO strings and are parsed into epoch milliseconds here, so nothing above the client
 * handles date strings. Global `fetch` only: loads on React Native and in the browser.
 */

import debug from 'debug';
import { requireFetch } from '../fetch-impl.js';
import type { TokenSource } from './oauth.js';

const log = debug('sereus:cadre:provider-client');

/** How a container was asked to join its cadre (`POST /containers` `join`). */
export type ContainerJoinRequest =
	| { kind: 'claim' }
	| { kind: 'invitation'; invitation: string };

/** The join as the node last reported it, folded onto the record by the provider's `/status` reads. */
export type ContainerJoinState =
	| { kind: 'claim'; state: 'awaiting' }
	| { kind: 'claim'; state: 'claimed'; ownerKey: string; partyId: string }
	| { kind: 'invitation'; state: 'pending' }
	| { kind: 'invitation'; state: 'accepted'; memberPeerId?: string }
	| { kind: 'invitation'; state: 'failed'; error: string; retryable: boolean };

export type RentedContainerStatus = 'pending' | 'creating' | 'enrolling' | 'running' | 'stopping' | 'stopped' | 'error';

/** Why a container was stopped: its customer asked, or the customer's subscription lapsed. */
export type ContainerStopReason = 'customer' | 'non-payment';

/** A container as the API returns it to its customer (the provider's `RedactedContainer`), dates in epoch ms. */
export interface RentedContainer {
	id: string;
	/** The cadre the container serves; a claim container's is the placeholder `unclaimed` until the claim is folded. */
	partyId: string;
	profile: 'storage' | 'transaction';
	status: RentedContainerStatus;
	createdAt: number;
	updatedAt: number;
	/** The failure, when `status` is `error`. */
	error?: string;
	/** The node's peer id once it first came up. */
	peerId?: string;
	/** How the container joins; the credential itself never leaves the provider this way. */
	join?: { kind: ContainerJoinRequest['kind'] };
	joinState?: ContainerJoinState;
	/** The owner key a claim named, once folded. */
	ownerKey?: string;
	stopReason?: ContainerStopReason;
	tags: Record<string, string>;
}

/** The node's live `/status`, as far as an app reads it. */
export interface RentedContainerHealth {
	status: 'healthy' | 'unhealthy' | 'starting';
	peerId?: string;
	multiaddrs?: string[];
}

/** `GET /containers/:id`: the record after a live read, the read itself, and the join state lifted out of the record. */
export interface RentedContainerStatusReport {
	container: RentedContainer;
	health?: RentedContainerHealth;
	join?: ContainerJoinState;
}

export interface CreateContainerBody {
	join: ContainerJoinRequest;
	/** Default `storage`. */
	profile?: 'storage' | 'transaction';
	tags?: Record<string, string>;
}

export type SubscriptionStatus = 'active' | 'past-due' | 'lapsed';

/** `GET /billing/status`, dates in epoch ms. */
export interface BillingStatus {
	planId: string;
	subscription: {
		status: SubscriptionStatus;
		/** When the current period renews; null once lapsed. */
		renewsAt: number | null;
		/** `past-due` only: when the grace period ends and the containers are stopped. */
		lapsesAt: number | null;
	};
}

/** `GET /containers/:id/code`: the code the owner claims the container with, or not yet. */
export type NodeCodeAnswer =
	| { code: string; peerId: string; multiaddrs: string[] }
	/** The node has not reported its peer id and an announced address yet (503); poll. */
	| { notReady: true };

/** A non-2xx answer the provider explained: its `error.code` (`NOT_FOUND`, `ALREADY_CLAIMED`, `QUOTA_EXCEEDED`, ...) and message. */
export class ProviderApiError extends Error {
	constructor(readonly status: number, readonly code: string, message: string) {
		super(`Provider answered ${status} ${code}: ${message}`);
		this.name = 'ProviderApiError';
	}
}

export interface ProviderClient {
	createContainer(body: CreateContainerBody): Promise<RentedContainer>;
	getContainer(id: string): Promise<RentedContainerStatusReport>;
	listContainers(): Promise<RentedContainer[]>;
	deleteContainer(id: string): Promise<void>;
	/** Undefined when the customer has no billing record yet. */
	getBillingStatus(): Promise<BillingStatus | undefined>;
	/** `notReady` on 503; a `ProviderApiError` for the 409s (`NOT_CLAIMABLE`, `ALREADY_CLAIMED`, `CONTAINER_GONE`). */
	getNodeCode(id: string): Promise<NodeCodeAnswer>;
}

export interface ProviderClientOptions {
	/** The descriptor's `apiBaseUrl`; the bearer is sent here and nowhere else. */
	apiBaseUrl: string;
	tokens: TokenSource;
	fetch?: typeof fetch;
}

export function createProviderClient(options: ProviderClientOptions): ProviderClient {
	const doFetch = requireFetch(options.fetch);
	const base = options.apiBaseUrl.replace(/\/+$/, '');
	const tokens = options.tokens;

	/** One authenticated JSON request; see the module doc for the 401 retry and the error envelope. */
	async function request(method: string, path: string, body?: unknown, allow: readonly number[] = []): Promise<{ status: number; data: unknown }> {
		const headers: Record<string, string> = { accept: 'application/json' };
		if (body !== undefined) headers['content-type'] = 'application/json';
		const encoded = body === undefined ? undefined : JSON.stringify(body);
		const send = async (bearer: string): Promise<Response> => doFetch(`${base}/${path}`, {
			method,
			headers: { ...headers, authorization: `Bearer ${bearer}` },
			body: encoded,
		});

		const first = await tokens.accessToken();
		let response = await send(first);
		if (response.status === 401) {
			log('%s %s answered 401; refreshing the token and retrying once', method, path);
			response = await send(await tokens.invalidate(first));
		}
		const parsed = await readEnvelope(response);
		if (allow.includes(response.status)) return { status: response.status, data: parsed.data };
		if (!response.ok || parsed.ok === false) {
			throw new ProviderApiError(response.status, parsed.code ?? `HTTP_${response.status}`, parsed.message ?? `${method} ${path} failed`);
		}
		return { status: response.status, data: parsed.data };
	}

	return {
		async createContainer(body) {
			const { data } = await request('POST', 'containers', body);
			return parseContainer(requireObject(data, 'POST containers').container);
		},
		async getContainer(id) {
			const { data } = await request('GET', `containers/${encodeURIComponent(id)}`);
			const report = requireObject(data, 'GET containers/:id');
			const container = parseContainer(report.container);
			const health = parseHealth(report.health);
			return { container, ...(health ? { health } : {}), ...(container.joinState ? { join: container.joinState } : {}) };
		},
		async listContainers() {
			const { data } = await request('GET', 'containers');
			const list = requireObject(data, 'GET containers').containers;
			if (!Array.isArray(list)) throw new Error('The provider\'s container list is not a list');
			return list.map(parseContainer);
		},
		async deleteContainer(id) {
			await request('DELETE', `containers/${encodeURIComponent(id)}`);
		},
		async getBillingStatus() {
			const { data } = await request('GET', 'billing/status');
			const billing = requireObject(data, 'GET billing/status').billing;
			return billing === null || billing === undefined ? undefined : parseBilling(billing);
		},
		async getNodeCode(id) {
			const { status, data } = await request('GET', `containers/${encodeURIComponent(id)}/code`, undefined, [503]);
			if (status === 503) return { notReady: true };
			const code = requireObject(data, 'GET containers/:id/code');
			return {
				code: requireString(code.code, 'code'),
				peerId: requireString(code.peerId, 'peerId'),
				multiaddrs: requireStrings(code.multiaddrs, 'multiaddrs'),
			};
		},
	};
}

/** The provider's `{ ok, data }` / `{ ok: false, error: { code, message } }` envelope, tolerating a body that is not one (a proxy's error page). */
async function readEnvelope(response: Response): Promise<{ ok?: boolean; data?: unknown; code?: string; message?: string }> {
	let body: unknown;
	try {
		body = await response.json();
	} catch (error) {
		log('answer %d carried a body that is not JSON: %o', response.status, error);
		return {};
	}
	if (typeof body !== 'object' || body === null) return {};
	const envelope = body as { ok?: unknown; data?: unknown; error?: unknown; message?: unknown };
	const error = typeof envelope.error === 'object' && envelope.error !== null ? envelope.error as { code?: unknown; message?: unknown } : undefined;
	return {
		ok: typeof envelope.ok === 'boolean' ? envelope.ok : undefined,
		data: envelope.data,
		code: typeof error?.code === 'string' ? error.code : undefined,
		// `DELETE` reports a failed termination as `{ ok: false, message }` with no `error`.
		message: typeof error?.message === 'string' ? error.message : typeof envelope.message === 'string' ? envelope.message : undefined,
	};
}

function parseContainer(value: unknown): RentedContainer {
	const record = requireObject(value, 'a container record');
	const container: RentedContainer = {
		id: requireString(record.id, 'id'),
		partyId: requireString(record.partyId, 'partyId'),
		profile: record.profile === 'transaction' ? 'transaction' : 'storage',
		status: requireStatus(record.status),
		createdAt: parseIsoMs(record.createdAt, 'createdAt'),
		updatedAt: parseIsoMs(record.updatedAt, 'updatedAt'),
		tags: typeof record.tags === 'object' && record.tags !== null ? record.tags as Record<string, string> : {},
	};
	if (typeof record.error === 'string') container.error = record.error;
	if (typeof record.peerId === 'string') container.peerId = record.peerId;
	if (typeof record.ownerKey === 'string') container.ownerKey = record.ownerKey;
	if (record.stopReason === 'customer' || record.stopReason === 'non-payment') container.stopReason = record.stopReason;
	const join = record.join;
	if (typeof join === 'object' && join !== null) {
		const kind = (join as { kind?: unknown }).kind;
		if (kind === 'claim' || kind === 'invitation') container.join = { kind };
	}
	if (record.joinState !== undefined) container.joinState = parseJoinState(record.joinState);
	return container;
}

function parseJoinState(value: unknown): ContainerJoinState {
	const state = requireObject(value, 'a join state');
	const key = `${String(state.kind)}/${String(state.state)}`;
	switch (key) {
		case 'claim/awaiting':
			return { kind: 'claim', state: 'awaiting' };
		case 'claim/claimed':
			return { kind: 'claim', state: 'claimed', ownerKey: requireString(state.ownerKey, 'joinState.ownerKey'), partyId: requireString(state.partyId, 'joinState.partyId') };
		case 'invitation/pending':
			return { kind: 'invitation', state: 'pending' };
		case 'invitation/accepted':
			return { kind: 'invitation', state: 'accepted', ...(typeof state.memberPeerId === 'string' ? { memberPeerId: state.memberPeerId } : {}) };
		case 'invitation/failed':
			return { kind: 'invitation', state: 'failed', error: requireString(state.error, 'joinState.error'), retryable: state.retryable === true };
		default:
			throw new Error(`The provider reported a join state this client does not know (${key})`);
	}
}

function parseHealth(value: unknown): RentedContainerHealth | undefined {
	if (typeof value !== 'object' || value === null) return undefined;
	const health = value as { status?: unknown; peerId?: unknown; multiaddrs?: unknown };
	const status = health.status === 'healthy' || health.status === 'unhealthy' || health.status === 'starting' ? health.status : undefined;
	if (!status) return undefined;
	return {
		status,
		...(typeof health.peerId === 'string' ? { peerId: health.peerId } : {}),
		...(Array.isArray(health.multiaddrs) ? { multiaddrs: health.multiaddrs.filter((addr): addr is string => typeof addr === 'string') } : {}),
	};
}

function parseBilling(value: unknown): BillingStatus {
	const billing = requireObject(value, 'a billing record');
	const subscription = requireObject(billing.subscription, 'a billing record\'s subscription');
	const status = subscription.status;
	if (status !== 'active' && status !== 'past-due' && status !== 'lapsed') {
		throw new Error(`The provider reported a subscription status this client does not know (${String(status)})`);
	}
	return {
		planId: requireString(billing.planId, 'planId'),
		subscription: {
			status,
			renewsAt: parseNullableIsoMs(subscription.renewsAt, 'subscription.renewsAt'),
			lapsesAt: parseNullableIsoMs(subscription.lapsesAt, 'subscription.lapsesAt'),
		},
	};
}

const CONTAINER_STATUSES: readonly RentedContainerStatus[] = ['pending', 'creating', 'enrolling', 'running', 'stopping', 'stopped', 'error'];

function requireStatus(value: unknown): RentedContainerStatus {
	if (!CONTAINER_STATUSES.includes(value as RentedContainerStatus)) {
		throw new Error(`The provider reported a container status this client does not know (${String(value)})`);
	}
	return value as RentedContainerStatus;
}

function requireObject(value: unknown, what: string): Record<string, unknown> {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		throw new Error(`The provider's answer to ${what} is not the JSON object the API documents`);
	}
	return value as Record<string, unknown>;
}

function requireString(value: unknown, field: string): string {
	if (typeof value !== 'string') throw new Error(`The provider's answer lacks the string field ${field}`);
	return value;
}

function requireStrings(value: unknown, field: string): string[] {
	if (!Array.isArray(value) || !value.every((entry): entry is string => typeof entry === 'string')) {
		throw new Error(`The provider's answer lacks the string list ${field}`);
	}
	return value;
}

/** An ISO 8601 date string as epoch ms; the client's boundary, so nothing above it handles date strings. */
function parseIsoMs(value: unknown, field: string): number {
	const ms = typeof value === 'string' ? Date.parse(value) : Number.NaN;
	if (Number.isNaN(ms)) throw new Error(`The provider's answer carries no ISO date in ${field}`);
	return ms;
}

function parseNullableIsoMs(value: unknown, field: string): number | null {
	return value === null || value === undefined ? null : parseIsoMs(value, field);
}
