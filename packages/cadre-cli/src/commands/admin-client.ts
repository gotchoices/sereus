/**
 * Client for a running node's loopback admin channel (`src/server/admin-server.ts`).
 *
 * NOTE: cadre-host's `OwnerNodeClient` speaks the same envelope over the same routes. Two thin
 * clients of one small contract are cheaper than a shared package; if a third client appears,
 * one of them should become the shared one.
 */

import debug from 'debug';

const log = debug('cadre:cli:admin-client');

/**
 * The subset of the global `fetch` this client depends on — the same seam as
 * `status-query.ts`'s `FetchLike`, widened by the method, headers and body a write needs.
 */
export type AdminFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

/** Where the admin channel is and how to talk to it. */
export interface AdminConnection {
  /** `http://127.0.0.1:<port>` — the channel binds loopback only. */
  baseUrl: string;
  /** The bearer token: the `CADRE_STARTUP_TOKEN` the node was started with. */
  token: string;
  fetch: AdminFetch;
  /** Per-request limit; an expiry reads as `unreachable`. */
  timeoutMs: number;
}

/**
 * A failed admin request. `unreachable` means no answer arrived (refused, reset, timed out);
 * `rejected` means the node answered with an error envelope or a non-2xx status.
 */
export class AdminRequestError extends Error {
  constructor(
    readonly kind: 'unreachable' | 'rejected',
    message: string,
    /** The HTTP status, when the node answered. */
    readonly status?: number,
    /** The envelope's stable error code (`AdminErrorCode`), when the body carried one. */
    readonly code?: string
  ) {
    super(message);
    this.name = 'AdminRequestError';
  }
}

interface AdminEnvelope {
  ok?: boolean;
  data?: unknown;
  error?: { code?: string; message?: string };
}

/** Send one request and unwrap the `{ ok, data }` envelope, or throw {@link AdminRequestError}. */
export async function adminRequest<T>(
  connection: AdminConnection,
  method: string,
  path: string,
  body?: unknown
): Promise<T> {
  const res = await send(connection, method, path, body);
  const envelope = await readEnvelope(res);
  if (!res.ok || envelope.ok !== true) {
    throw new AdminRequestError(
      'rejected',
      envelope.error?.message ?? `admin ${method} ${path} answered HTTP ${res.status}`,
      res.status,
      envelope.error?.code
    );
  }
  return envelope.data as T;
}

async function send(
  connection: AdminConnection,
  method: string,
  path: string,
  body: unknown
): Promise<Awaited<ReturnType<AdminFetch>>> {
  const headers: Record<string, string> = { authorization: `Bearer ${connection.token}` };
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), connection.timeoutMs);
  try {
    return await connection.fetch(`${connection.baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    const reason = controller.signal.aborted
      ? `timed out after ${connection.timeoutMs}ms`
      : describeTransportError(err);
    throw new AdminRequestError('unreachable', reason);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Node's fetch reports every transport failure as `TypeError: fetch failed` and puts the
 * useful part (`ECONNREFUSED 127.0.0.1:7070`) on `cause`.
 */
function describeTransportError(err: unknown): string {
  if (!(err instanceof Error)) {
    return String(err);
  }
  return err.cause instanceof Error ? `${err.message}: ${err.cause.message}` : err.message;
}

/** The parsed envelope, or an empty one for a body that is not JSON — the status then decides. */
async function readEnvelope(res: { json: () => Promise<unknown> }): Promise<AdminEnvelope> {
  try {
    const parsed = await res.json();
    return parsed !== null && typeof parsed === 'object' ? (parsed as AdminEnvelope) : {};
  } catch (err) {
    log('admin response body is not JSON: %o', err);
    return {};
  }
}
