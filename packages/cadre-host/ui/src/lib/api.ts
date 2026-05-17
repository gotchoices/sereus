/**
 * Thin fetch wrapper that understands cadre-host's mixed response shapes.
 *
 * Many routes (status, nat, auth/trust-circle, update) return the bare object.
 * Newer routes (nodes, settings) wrap responses in `{ ok, data, error }`.
 * Error responses always use the wrapped form. `apiFetch` unwraps when it
 * sees the envelope, throws `ApiError` on `ok:false`, and returns the bare
 * body otherwise.
 *
 * Same-origin only — the SPA is hosted by the same Fastify that serves the
 * API. Vite dev-server users get the same effect via the dev proxy in
 * `vite.config.ts`.
 */

export class ApiError extends Error {
	readonly code: string;
	readonly status: number;
	constructor(code: string, message: string, status = 0) {
		super(message);
		this.name = 'ApiError';
		this.code = code;
		this.status = status;
	}
}

type Envelope = { ok?: boolean; data?: unknown; error?: { code: string; message: string } };

export async function apiFetch<T = unknown>(
	path: string,
	init: RequestInit = {},
): Promise<T> {
	let response: Response;
	try {
		response = await fetch(path, {
			...init,
			headers: {
				accept: 'application/json',
				...(init.body !== undefined && init.body !== null
					? { 'content-type': 'application/json' }
					: {}),
				...(init.headers ?? {}),
			},
		});
	} catch (err) {
		throw new ApiError('network', (err as Error).message || 'Network request failed', 0);
	}

	const contentType = response.headers.get('content-type') ?? '';
	const isJson = contentType.includes('application/json');
	const body: unknown = isJson ? await response.json().catch(() => null) : null;

	if (!response.ok) {
		const envelope = body as Envelope | null;
		if (envelope && envelope.ok === false && envelope.error) {
			throw new ApiError(envelope.error.code, envelope.error.message, response.status);
		}
		throw new ApiError(`http_${response.status}`, response.statusText || 'Request failed', response.status);
	}

	if (body && typeof body === 'object') {
		const envelope = body as Envelope;
		if (envelope.ok === false && envelope.error) {
			throw new ApiError(envelope.error.code, envelope.error.message, response.status);
		}
		if (envelope.ok === true && 'data' in envelope) {
			return envelope.data as T;
		}
		// ok: true without data → return body as-is (e.g. `{ ok: true }` from stop endpoint).
	}
	return body as T;
}

export function apiPost<T = unknown>(path: string, body?: unknown): Promise<T> {
	const init: RequestInit = body === undefined
		? { method: 'POST' }
		: { method: 'POST', body: JSON.stringify(body) };
	return apiFetch<T>(path, init);
}

export function apiPut<T = unknown>(path: string, body?: unknown): Promise<T> {
	const init: RequestInit = body === undefined
		? { method: 'PUT' }
		: { method: 'PUT', body: JSON.stringify(body) };
	return apiFetch<T>(path, init);
}

export function apiDelete<T = unknown>(path: string): Promise<T> {
	return apiFetch<T>(path, { method: 'DELETE' });
}
