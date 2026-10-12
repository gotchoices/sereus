/**
 * The provider's HTTP API driven in-process: `createProviderServer`'s Fastify instance through
 * `inject`, so no port is bound and the routes, their validator and their redaction are the
 * production ones over the same `ContainerService` a scenario can also reach directly.
 *
 * Every response body is kept (`answered`) for the leak check the join scenarios end on: the
 * claim secret leaves the provider in the node code alone, and the invitation bundle never
 * leaves it, so neither may appear in any other body. A caller that reads the code route passes
 * `record: false` and records the refusals itself.
 */

import type { ContainerHealthStatus, NodeCode, ProviderServer, RedactedContainer } from '@serfab/cadre-provider';

/** The provider's `{ ok: false, error }` envelope. */
export interface ProviderApiRefusal {
	ok: false;
	error: { code: string; message: string };
}
/** `GET /containers/:id`'s data: the redacted record after the fold, and the live `/status` when running. */
export interface ProviderContainerRead {
	container: RedactedContainer;
	health?: ContainerHealthStatus;
}
export type ProviderContainerResponse = { ok: true; data: ProviderContainerRead } | ProviderApiRefusal;
export type ProviderListResponse = { ok: true; data: { containers: RedactedContainer[] } };
export type ProviderCodeResponse = { ok: true; data: NodeCode } | ProviderApiRefusal;
export type ProviderDeleteResponse = { ok: boolean; message: string };

export interface ProviderApi {
	/** One request against the routes; its body is recorded unless `record: false`. */
	request<T>(
		method: 'GET' | 'POST' | 'DELETE',
		path: string,
		payload?: Record<string, unknown>,
		options?: { record?: boolean },
	): Promise<{ status: number; body: T }>;
	/** `GET /containers/:id`, throwing on a refusal. */
	readContainer(id: string): Promise<ProviderContainerRead>;
	/** Every response body answered so far, in order. */
	readonly answered: string[];
}

const DEFAULT_BASE_PATH = '/api/v1';

/** A client over `server.app.inject`, paths given relative to the API's base path. */
export function providerApi(server: ProviderServer, basePath = DEFAULT_BASE_PATH): ProviderApi {
	const answered: string[] = [];
	const request: ProviderApi['request'] = async (method, path, payload, options = {}) => {
		const res = await server.app.inject({ method, url: `${basePath}${path}`, ...(payload ? { payload } : {}) });
		if (options.record !== false) answered.push(res.body);
		return { status: res.statusCode, body: res.json() };
	};
	return {
		request,
		readContainer: async (id) => {
			const { status, body } = await request<ProviderContainerResponse>('GET', `/containers/${id}`);
			if (!body.ok) throw new Error(`GET /containers/${id} answered ${status}: ${body.error.code}`);
			return body.data;
		},
		answered,
	};
}
