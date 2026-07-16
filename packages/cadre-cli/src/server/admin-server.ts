import http from 'node:http';
import debug from 'debug';
import type { CadreNode, CadreInvite } from '@serfab/cadre-core';
import { checkBearer } from './bearer.js';

const log = debug('cadre:cli:admin');

/** Stable error codes mapped to HTTP status by the admin server. */
export type AdminErrorCode = 'not_authorized' | 'not_ready' | 'bad_request' | 'internal';

const STATUS_BY_CODE: Record<AdminErrorCode, number> = {
  not_authorized: 401,
  not_ready: 503,
  bad_request: 400,
  internal: 500,
};

/** Maximum admin request body size (256 KiB) — invites/seeds are small. */
const MAX_BODY_BYTES = 256 * 1024;

/**
 * An error carrying a stable {@link AdminErrorCode}. Route handlers throw this
 * for client-visible failures; everything else is classified into `not_ready`
 * (node/seed-bootstrap not up yet) or `internal`.
 */
export class AdminError extends Error {
  constructor(public readonly code: AdminErrorCode, message: string) {
    super(message);
    this.name = 'AdminError';
  }
}

export interface AdminServerOptions {
  /** Port to bind on the loopback interface. Use 0 for an ephemeral port. */
  port: number;
  /** Bearer token required on every request (the `CADRE_STARTUP_TOKEN`). */
  token: string;
  /** Bind host — defaults to `127.0.0.1`; never bind to a routable address. */
  host?: string;
}

/**
 * Loopback admin channel for an authority cadre node.
 *
 * Binds `127.0.0.1:<port>` and exposes authority/membership operations to a
 * same-machine orchestrator (cadre-host). Every request must present
 * `Authorization: Bearer <token>` (constant-time compared). Responses use the
 * cadre-provider envelope: `{ ok: true, data }` or
 * `{ ok: false, error: { code, message } }`.
 *
 * Routes (all under `/admin`):
 * - `GET    /admin/identity`          → `{ peerId, partyId }`
 * - `GET    /admin/multiaddrs`        → `{ multiaddrs: string[] }`
 * - `GET    /admin/members`           → `{ members: { peerId, multiaddr }[] }` (ADDRESSABLE: includes self)
 * - `GET    /admin/members/:peerId`   → `{ member: boolean }` (ADDRESSABLE)
 * - `GET    /admin/authorized-members`         → `{ members: { peerId, multiaddr }[] }` (AUTHORIZED: excludes self)
 * - `GET    /admin/authorized-members/:peerId` → `{ member: boolean }` (AUTHORIZED)
 * - `POST   /admin/invites`           → `{ invite, encodedInvite }`
 * - `POST   /admin/accept-phone`      → `{ ok: true }`
 * - `DELETE /admin/members/:peerId`   → `{ ok: true }`
 * - `PUT    /admin/invite-addresses`  → `{ ok: true }`
 */
export class AdminServer {
  private node: CadreNode | null = null;
  private server: http.Server | null = null;
  private readonly token: string;
  private readonly host: string;
  private readonly requestedPort: number;

  constructor(options: AdminServerOptions) {
    if (!options.token || options.token.length === 0) {
      throw new Error('AdminServer requires a non-empty bearer token');
    }
    this.token = options.token;
    this.host = options.host ?? '127.0.0.1';
    this.requestedPort = options.port;
  }

  /** Attach to a CadreNode instance — delegation target for the routes. */
  attach(node: CadreNode): void {
    this.node = node;
    log('AdminServer attached to CadreNode');
  }

  /** The actually-bound port (useful when constructed with port 0). */
  get port(): number {
    const addr = this.server?.address();
    if (addr && typeof addr === 'object') return addr.port;
    return this.requestedPort;
  }

  /** Start the loopback listener. */
  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        void this.handle(req, res);
      });
      this.server.on('error', reject);
      this.server.listen(this.requestedPort, this.host, () => {
        log('AdminServer listening on %s:%d', this.host, this.port);
        resolve();
      });
    });
  }

  /** Stop the listener. */
  async stop(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve) => {
      this.server!.close(() => resolve());
    });
    this.server = null;
    log('AdminServer stopped');
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!this.isAuthorized(req)) {
      this.sendError(res, 'not_authorized', 'Missing or invalid bearer token');
      return;
    }

    try {
      const data = await this.route(req);
      this.sendOk(res, data);
    } catch (err) {
      if (err instanceof AdminError) {
        this.sendError(res, err.code, err.message);
      } else {
        const message = err instanceof Error ? err.message : String(err);
        this.sendError(res, classifyError(message), message);
      }
    }
  }

  private async route(req: http.IncomingMessage): Promise<unknown> {
    const node = this.node;
    if (!node) {
      throw new AdminError('not_ready', 'Node not attached');
    }

    const url = new URL(req.url ?? '/', `http://${this.host}`);
    const segments = url.pathname.split('/').filter(Boolean);
    const method = req.method ?? 'GET';

    if (segments[0] !== 'admin') {
      throw new AdminError('bad_request', `Unknown path: ${url.pathname}`);
    }

    const resource = segments[1];
    const id = segments[2] !== undefined ? decodeURIComponent(segments[2]) : undefined;

    if (resource === 'identity' && method === 'GET') {
      return { peerId: node.peerId?.toString() ?? null, partyId: node.partyId };
    }

    if (resource === 'multiaddrs' && method === 'GET') {
      return { multiaddrs: node.getMultiaddrs() };
    }

    if (resource === 'members') {
      if (method === 'GET' && id === undefined) {
        return { members: await node.listMembers() };
      }
      if (method === 'GET' && id !== undefined) {
        return { member: await node.isMember(id) };
      }
      if (method === 'DELETE' && id !== undefined) {
        await node.removePeer(id);
        return { ok: true };
      }
    }

    // Authorized-membership surface (trust-facing; excludes self): distinct from the
    // addressable `members` surface above, which includes the node's own row.
    if (resource === 'authorized-members' && method === 'GET') {
      if (id === undefined) {
        return { members: await node.listAuthorizedMembers() };
      }
      return { member: await node.isAuthorizedMember(id) };
    }

    if (resource === 'invites' && method === 'POST') {
      const body = await this.readJson(req);
      const token = typeof body.token === 'string' ? body.token : undefined;
      const expiresInMs = typeof body.expiresInMs === 'number' ? body.expiresInMs : undefined;
      const { invite, encodedInvite } = await node.createInvite(token, expiresInMs);
      return { invite, encodedInvite };
    }

    if (resource === 'accept-phone' && method === 'POST') {
      const body = await this.readJson(req);
      if (typeof body.phonePeerId !== 'string' || body.phonePeerId.length === 0) {
        throw new AdminError('bad_request', 'phonePeerId is required');
      }
      const token = typeof body.token === 'string' ? body.token : undefined;
      const issuedInvite = body.issuedInvite as CadreInvite | undefined;
      await node.acceptPhone({ phonePeerId: body.phonePeerId, token }, issuedInvite);
      return { ok: true };
    }

    if (resource === 'invite-addresses' && method === 'PUT') {
      const body = await this.readJson(req);
      if (!Array.isArray(body.addresses) || !body.addresses.every((a) => typeof a === 'string')) {
        throw new AdminError('bad_request', 'addresses must be an array of strings');
      }
      node.setInviteAddresses(body.addresses);
      return { ok: true };
    }

    throw new AdminError('bad_request', `Unsupported route: ${method} ${url.pathname}`);
  }

  /** Constant-time bearer-token check (see {@link checkBearer}). */
  private isAuthorized(req: http.IncomingMessage): boolean {
    return checkBearer(req, this.token);
  }

  private async readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of req) {
      const buf = chunk as Buffer;
      total += buf.length;
      if (total > MAX_BODY_BYTES) {
        throw new AdminError('bad_request', 'Request body too large');
      }
      chunks.push(buf);
    }
    const raw = Buffer.concat(chunks).toString('utf8').trim();
    if (raw.length === 0) return {};
    try {
      const parsed = JSON.parse(raw);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('body must be a JSON object');
      }
      return parsed as Record<string, unknown>;
    } catch (err) {
      throw new AdminError('bad_request', `Invalid JSON body: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private sendOk(res: http.ServerResponse, data: unknown): void {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, data }));
  }

  private sendError(res: http.ServerResponse, code: AdminErrorCode, message: string): void {
    res.writeHead(STATUS_BY_CODE[code], { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: { code, message } }));
  }
}

/**
 * Map an unexpected thrown error to a stable code. CadreNode surfaces
 * "...not initialized" / "...not running" / "must be started" before its
 * services are ready — those become `not_ready`; anything else is `internal`.
 */
function classifyError(message: string): AdminErrorCode {
  if (/not initialized|not running|must be started/i.test(message)) {
    return 'not_ready';
  }
  return 'internal';
}
