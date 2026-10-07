/**
 * Client for a running node's loopback admin channel (`src/server/admin-server.ts`).
 *
 * NOTE: cadre-host's `OwnerNodeClient` speaks the same envelope over the same routes. Two thin
 * clients of one small contract are cheaper than a shared package; if a third client appears,
 * one of them should become the shared one.
 */

import fs from 'node:fs';
import debug from 'debug';
import { commandEnv } from '../config/env.js';

const log = debug('cadre:cli:admin-client');

/** The admin channel binds loopback only, so there is no host to choose. */
export const ADMIN_HOST = '127.0.0.1';

export const DEFAULT_ADMIN_TIMEOUT_MS = '30000';

/** A refusal of a command-line option, with the message already written for the operator. */
export class AdminOptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AdminOptionError';
  }
}

/** The options every command that talks to the admin channel takes. */
export interface AdminConnectionOptions {
  adminPort?: string;
  tokenFile?: string;
  timeout: string;
}

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

/**
 * Resolve where the admin channel is and how to talk to it from the command's options and
 * environment, refusing with an {@link AdminOptionError} that names the fix. `port` is
 * returned beside the connection so a failure message can name it.
 */
export function resolveAdminConnection(
  options: AdminConnectionOptions,
  env: NodeJS.ProcessEnv,
  fetchImpl: AdminFetch
): { connection: AdminConnection; port: number } {
  const port = resolveAdminPort(options.adminPort, commandEnv('CADRE_ADMIN_PORT', env));
  return {
    port,
    connection: {
      baseUrl: `http://${ADMIN_HOST}:${port}`,
      token: resolveAdminToken(options.tokenFile, commandEnv('CADRE_STARTUP_TOKEN', env)),
      fetch: fetchImpl,
      timeoutMs: resolveTimeout(options.timeout),
    },
  };
}

function resolveAdminPort(flag: string | undefined, env: string | undefined): number {
  const raw = flag ?? (env && env.trim().length > 0 ? env : undefined);
  if (raw === undefined) {
    throw new AdminOptionError('The owner node\'s admin port is required: pass --admin-port <port> or set CADRE_ADMIN_PORT');
  }
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new AdminOptionError(`Invalid admin port: ${raw}`);
  }
  return port;
}

/**
 * The bearer token, from `--token-file` or else `CADRE_STARTUP_TOKEN`. Never a flag value: it
 * would show in the process list. The file is what `cadre start --startup-token-file` writes,
 * verbatim; only a trailing line ending is dropped, for a file written by hand.
 */
function resolveAdminToken(tokenFile: string | undefined, env: string | undefined): string {
  const token = tokenFile !== undefined ? readTokenFile(tokenFile) : env ?? '';
  if (token.length === 0) {
    throw new AdminOptionError(tokenFile !== undefined
      ? `--token-file ${tokenFile} is empty`
      : 'The admin token is required: pass --token-file <path> or set CADRE_STARTUP_TOKEN to the token the owner node was started with');
  }
  return token;
}

function readTokenFile(path: string): string {
  try {
    return fs.readFileSync(path, 'utf8').replace(/\r?\n$/, '');
  } catch (err) {
    throw new AdminOptionError(`Cannot read --token-file ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function resolveTimeout(raw: string): number {
  const timeoutMs = Number(raw);
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new AdminOptionError(`Invalid --timeout: ${raw} (a positive number of milliseconds)`);
  }
  return timeoutMs;
}

/**
 * The operator-facing reason an admin request failed, naming the fix where there is one.
 * `ownerFlag` names what the node must be started with for this request to be served.
 */
export function describeAdminFailure(err: unknown, port: number): string {
  if (!(err instanceof AdminRequestError)) {
    return err instanceof Error ? err.message : String(err);
  }
  if (err.kind === 'unreachable') {
    return `No admin channel answered on ${ADMIN_HOST}:${port} (${err.message}). `
      + `Start the owner node with --owner --admin-port ${port} and CADRE_STARTUP_TOKEN set.`;
  }
  switch (err.code) {
    case 'not_authorized':
      return 'The owner node refused the admin token: it does not match the CADRE_STARTUP_TOKEN the node was started with.';
    case 'not_ready':
      return `The node on ${ADMIN_HOST}:${port} is not running as the cadre's owner (${err.message}). Restart it with --owner.`;
    default:
      return `The owner node refused the request [${err.code ?? `HTTP ${err.status}`}]: ${err.message}`;
  }
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
