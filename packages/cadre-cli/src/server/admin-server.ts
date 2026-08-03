import http from 'node:http';
import debug from 'debug';
import type {
  CadreNode,
  CadreInvite,
  ControlDatabase,
  StrandInstance,
  StrandRow,
  StrandStatus,
} from '@serfab/cadre-core';
import { checkBearer } from './bearer.js';

const log = debug('cadre:cli:admin');

/** Stable error codes mapped to HTTP status by the admin server. */
export type AdminErrorCode =
  | 'not_authorized'
  | 'not_ready'
  | 'bad_request'
  | 'confirmation_required'
  | 'internal';

const STATUS_BY_CODE: Record<AdminErrorCode, number> = {
  not_authorized: 401,
  not_ready: 503,
  bad_request: 400,
  // 428 rather than 400: "you must say out loud that you mean this" is a different
  // thing from "you sent something malformed", and the manager has to tell them
  // apart to show a confirmation screen instead of an error.
  confirmation_required: 428,
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
 * One row of `GET /admin/strands`. A deliberately narrow projection of `StrandRow`:
 * that row also carries `MemberPrivateKey`, this party's membership secret for a
 * closed strand, stored nowhere else. It must never leave the node.
 */
export interface AdminStrandSummary {
  /** The `CadreControl.Strand` row id — what `DELETE /admin/strands/:id` takes. */
  id: string;
  /** `'o'` = open, `'c'` = closed (the row carries this party's membership secret). */
  type: 'o' | 'c';
  /** Whether this node currently has a running instance for the id. */
  running: boolean;
  /** The instance's status when running, else `null`. */
  status: StrandStatus | null;
}

/** The body of `GET /admin/strands`. */
export interface AdminStrandList {
  strands: AdminStrandSummary[];
  /** Open control-network connections right now — 0 means a write commits local-only. */
  controlConnections: number;
}

/** The body of `DELETE /admin/strands/:id`. */
export interface AdminStrandRemoval {
  /** The trimmed id the call was about. */
  strandId: string;
  /** Whether a row was found before the write. */
  published: boolean;
  /** The found row's type; `null` when no row was found. */
  type: 'o' | 'c' | null;
  /**
   * Whether THIS call issued the delete — not that the row was observed to vanish.
   * `unpublishStrand` returns void and the read and the write are not atomic, so a
   * concurrent removal landing in between makes this call a no-op that still reports
   * `true`. Same window the CLI documents, harmless for the same reason: the caller
   * gets the outcome they asked for.
   */
  removed: boolean;
  /** Whether 0 control connections were sampled right after the write. */
  alone: boolean;
}

/**
 * Loopback admin channel for an owner cadre node.
 *
 * Binds `127.0.0.1:<port>` and exposes owner/membership operations to a
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
 * - `GET    /admin/strands`           → `{ strands: AdminStrandSummary[], controlConnections }`
 * - `POST   /admin/invites`           → `{ invite, encodedInvite }`
 * - `POST   /admin/accept-phone`      → `{ ok: true }`
 * - `POST   /admin/add-drone`         → `{ seed, encodedSeed }` (mint a seed authorizing a drone/donated node)
 * - `DELETE /admin/members/:peerId`   → `{ ok: true }`
 * - `DELETE /admin/strands/:id?confirm=1` → {@link AdminStrandRemoval} (closed strands need `confirm`)
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

    // The strands this party belongs to. Both arms read `CadreControl.Strand` — NOT the
    // running instances — because a strand this node's `strandFilter` excluded, or one
    // whose launch failed, is still this party's participation and is still removable.
    if (resource === 'strands') {
      // `route()` splits on `/`, so an id containing one arrives as a fourth segment.
      // Refuse rather than reassemble: a half-reconstructed id would remove the wrong row.
      if (segments.length > 3) {
        throw new AdminError(
          'bad_request',
          'Strand ids containing "/" are not addressable over this channel; use `cadre strand remove`'
        );
      }
      if (method === 'GET' && id === undefined) {
        return await listStrands(node);
      }
      if (method === 'DELETE' && id !== undefined) {
        return await removeStrand(node, id, url.searchParams.get('confirm'));
      }
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

    // Mint a seed authorizing a drone (a provider-hosted / donated node) to join
    // this node's cadre. The node signs the seed with its own authority key; only
    // the signed, public form (`encodedSeed`) transits. This is the requester
    // ("phone") side of the node-donation flow: the donor host presents the
    // returned seed to the donated node's `POST /seed`.
    if (resource === 'add-drone' && method === 'POST') {
      const body = await this.readJson(req);
      if (typeof body.dronePeerId !== 'string' || body.dronePeerId.length === 0) {
        throw new AdminError('bad_request', 'dronePeerId is required');
      }
      if (!Array.isArray(body.droneMultiaddrs) || !body.droneMultiaddrs.every((a) => typeof a === 'string')) {
        throw new AdminError('bad_request', 'droneMultiaddrs must be an array of strings');
      }
      const { seed, encodedSeed } = await node.addDrone({
        dronePeerId: body.dronePeerId,
        droneMultiaddrs: body.droneMultiaddrs as string[],
      });
      return { seed, encodedSeed };
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
 * The control database, or a `not_ready` refusal. A node that never started has none;
 * that is a "come back later", not an internal fault, so it must not fall through to
 * a null property access classified as `internal`.
 */
function requireControlDatabase(node: CadreNode): ControlDatabase {
  const db = node.getControlDatabase();
  if (!db) {
    throw new AdminError('not_ready', 'Node has no control database — it is not started');
  }
  return db;
}

/**
 * Project control rows to the public summary, overlaying the running instances for
 * `running`/`status`. The four fields below are the WHOLE projection: `StrandRow` also
 * carries `MemberPrivateKey` and spreading the row would leak it.
 *
 * NOTE: the rows drive the list, so a RUNNING instance with no control row (a removal the
 * watcher observed but whose local stop failed) is invisible here. Removal is not the
 * operation that would fix it — the row is already gone — so if such orphans ever show up
 * in the field, the answer is a separate "stop a local instance" route, not widening this
 * projection with unremovable entries.
 */
function projectStrands(rows: StrandRow[], instances: Map<string, StrandInstance>): AdminStrandSummary[] {
  return rows.map((row) => {
    const instance = instances.get(row.Id);
    return {
      id: row.Id,
      type: row.Type,
      running: instance !== undefined,
      status: instance?.status ?? null,
    };
  });
}

/**
 * List this party's strands from the control database.
 *
 * Side-effect free: unlike `cadre strand list`, which forces a watcher poll because a
 * one-shot node has only just connected, the owner node behind this channel is
 * long-lived with a watcher already polling.
 */
async function listStrands(node: CadreNode): Promise<AdminStrandList> {
  const rows = await requireControlDatabase(node).queryStrands();
  return {
    strands: projectStrands(rows, node.getStrands()),
    controlConnections: node.getControlConnectionCount(),
  };
}

/**
 * The only accepted `confirm` values. Not a general truthiness parser: `yes`, `on` and
 * an empty value all count as NOT confirmed, because a guessy parser here would turn a
 * typo into a destroyed membership secret.
 */
const CONFIRM_VALUES = new Set(['1', 'true']);

function isConfirmed(raw: string | null): boolean {
  return raw !== null && CONFIRM_VALUES.has(raw);
}

/**
 * Read the row, decide, then write — the same read→decide→write as the CLI's
 * `applyRemove`, and for the same reason: `unpublishStrand` is a silent no-op on an
 * absent row, so "was not published" and "removed" are indistinguishable after the fact.
 *
 * The id is trimmed and rejected when blank BEFORE the read: a blank id would otherwise
 * find no row and report the reassuring `published: false`, when what happened is that
 * the caller sent nothing.
 *
 * An absent row answers 200 rather than 404, mirroring the CLI's exit 0 — the caller
 * asked for the row to be gone and it is gone; `published: false` says so for a caller
 * that cares. A CLOSED row without `confirm` writes nothing and throws
 * `confirmation_required`: that row carries this party's membership key for the strand
 * and it is stored nowhere else. `confirm` on an open strand is accepted and ignored.
 */
async function removeStrand(node: CadreNode, rawId: string, confirm: string | null): Promise<AdminStrandRemoval> {
  const strandId = rawId.trim();
  if (!strandId) {
    throw new AdminError('bad_request', 'A strand id is required');
  }
  const row = await requireControlDatabase(node).queryStrand(strandId);
  if (row?.Type === 'c' && !isConfirmed(confirm)) {
    throw new AdminError(
      'confirmation_required',
      `Refusing to remove closed strand ${strandId} without confirmation: its row carries this ` +
        "party's membership key for that closed network, stored nowhere else. Removing the row " +
        'destroys it, and this party could never admit another member to that strand. ' +
        'Re-send with ?confirm=1 if that is the intent.'
    );
  }
  if (row) {
    await node.unpublishStrand(strandId);
  }
  return {
    strandId,
    published: row !== null,
    type: row?.Type ?? null,
    removed: row !== null,
    alone: node.getControlConnectionCount() === 0,
  };
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
