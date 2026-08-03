/**
 * `/api/strands` route tests — a real Fastify built by `createLocalUiServer`
 * (so the error handler, the mount gate, and the static not-found fallback are
 * all the production ones) over a fake StrandService.
 *
 * What the service does is covered by `strands/__tests__/strand-service.test.ts`;
 * this file is about the HTTP contract: envelope shape, status mapping, the
 * `confirm` query param, and exactly-once bus publication.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { createLocalUiServer } from '../index.js';
import type { LocalUiEvent } from '../events/types.js';
import type { HostProcessOrchestrator } from '../../orchestrator/index.js';
import type { StrandService } from '../../strands/index.js';
import { StrandError } from '../../strands/index.js';
import type { StrandListSnapshot, StrandRemovalResult } from '../../strands/index.js';

function fakeOrchestrator(): HostProcessOrchestrator {
  return {
    listNodes: () => [],
    getNode: () => undefined,
    resolveDockerId: () => undefined,
    onStateChange: () => () => undefined,
  } as unknown as HostProcessOrchestrator;
}

const SNAPSHOT: StrandListSnapshot = {
  strands: [
    { id: 'open-one', type: 'o', running: true, status: 'active' },
    { id: 'closed-one', type: 'c', running: false, status: null },
  ],
  controlConnections: 3,
};

interface FakeStrands {
  service: StrandService;
  /** Every (id, confirm) the route forwarded. */
  calls: Array<{ strandId: string; confirm: boolean }>;
  /** Set to make `list` and `remove` throw. */
  failWith?: unknown;
  /** Set to make `remove` report a strand that was never published. */
  absent?: boolean;
}

function fakeStrandService(): FakeStrands {
  const state: FakeStrands = {
    calls: [],
    service: undefined as unknown as StrandService,
  };
  state.service = {
    async list(): Promise<StrandListSnapshot> {
      if (state.failWith) throw state.failWith;
      return SNAPSHOT;
    },
    async remove(strandId: string, opts: { confirm: boolean }): Promise<StrandRemovalResult> {
      state.calls.push({ strandId, confirm: opts.confirm });
      if (state.failWith) throw state.failWith;
      return state.absent
        ? { strandId, published: false, type: null, removed: false, alone: false }
        : { strandId, published: true, type: 'o', removed: true, alone: false };
    },
  } as unknown as StrandService;
  return state;
}

let dataDir: string;
let server: ReturnType<typeof createLocalUiServer>;
let strands: FakeStrands;
let events: LocalUiEvent[];

function buildServer(opts: { withStrands: boolean }): void {
  server = createLocalUiServer({
    uiPort: 8765,
    dataDir,
    orchestrator: fakeOrchestrator(),
    ...(opts.withStrands ? { strands: strands.service } : {}),
    forcePort: 0,
  });
  events = [];
  server.events.subscribe((e) => events.push(e));
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'cadre-host-strands-route-'));
  strands = fakeStrandService();
  buildServer({ withStrands: true });
});

afterEach(async () => {
  await server.app.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('GET /api/strands', () => {
  it('returns the snapshot in the /api/* envelope', async () => {
    const res = await server.app.inject({ method: 'GET', url: '/api/strands' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { ok: boolean; data: StrandListSnapshot };
    expect(body.ok).toBe(true);
    expect(body.data.strands).toHaveLength(2);
    expect(body.data.strands[0]?.id).toBe('open-one');
    expect(body.data.controlConnections).toBe(3);
  });

  it('maps a service failure through the same error handler as the DELETE arm', async () => {
    strands.failWith = new StrandError('node_unavailable', 'Owner node unavailable: refused');
    const res = await server.app.inject({ method: 'GET', url: '/api/strands' });
    expect(res.statusCode).toBe(503);
    expect((res.json() as { error: { code: string } }).error.code).toBe('node_unavailable');
  });
});

describe('DELETE /api/strands/:id', () => {
  it('removes a published strand → 200 and exactly one strands-changed event', async () => {
    const res = await server.app.inject({ method: 'DELETE', url: '/api/strands/open-one' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { ok: boolean; data: StrandRemovalResult };
    expect(body.ok).toBe(true);
    expect(body.data).toMatchObject({ strandId: 'open-one', published: true, removed: true });
    expect(events).toEqual([{ type: 'strands-changed', kind: 'removed' }]);
  });

  it('an absent strand → 200, published: false, and NO event', async () => {
    strands.absent = true;
    const res = await server.app.inject({ method: 'DELETE', url: '/api/strands/never-published' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: StrandRemovalResult };
    expect(body.data.published).toBe(false);
    expect(body.data.removed).toBe(false);
    expect(events).toEqual([]);
  });

  it('forwards confirm=1 as true and its absence as false', async () => {
    await server.app.inject({ method: 'DELETE', url: '/api/strands/a' });
    await server.app.inject({ method: 'DELETE', url: '/api/strands/b?confirm=1' });
    await server.app.inject({ method: 'DELETE', url: '/api/strands/c?confirm=true' });
    expect(strands.calls).toEqual([
      { strandId: 'a', confirm: false },
      { strandId: 'b', confirm: true },
      { strandId: 'c', confirm: true },
    ]);
  });

  it('treats a guessy confirm value as NOT confirmed', async () => {
    // `yes`/`on`/empty are refused deliberately — a typo must not destroy a
    // closed strand's membership key.
    await server.app.inject({ method: 'DELETE', url: '/api/strands/a?confirm=yes' });
    await server.app.inject({ method: 'DELETE', url: '/api/strands/b?confirm=' });
    expect(strands.calls).toEqual([
      { strandId: 'a', confirm: false },
      { strandId: 'b', confirm: false },
    ]);
  });

  it('ignores query params other than confirm rather than proxying them', async () => {
    await server.app.inject({ method: 'DELETE', url: '/api/strands/a?force=1&confirm=1' });
    expect(strands.calls).toEqual([{ strandId: 'a', confirm: true }]);
  });

  // The route is one path segment, so an id holding a `/` has to arrive
  // percent-encoded. Fastify decodes `params`, so the service sees the literal id
  // and forwards it — nothing in this chain needs to refuse such an id.
  it('carries a percent-encoded "/" through to the service as a literal', async () => {
    const res = await server.app.inject({ method: 'DELETE', url: '/api/strands/ns%2Fstrand' });
    expect(res.statusCode).toBe(200);
    expect(strands.calls).toEqual([{ strandId: 'ns/strand', confirm: false }]);
  });

  it('404s an UNencoded "/" at the router, before any handler runs', async () => {
    const res = await server.app.inject({ method: 'DELETE', url: '/api/strands/ns/strand' });
    expect(res.statusCode).toBe(404);
    expect(strands.calls).toEqual([]);
  });
});

describe('DELETE /api/strands/:id — error mapping', () => {
  it('confirmation_required → 428 with the node message intact', async () => {
    const message = 'Refusing to remove closed strand closed-one without confirmation: …';
    strands.failWith = new StrandError('confirmation_required', message);
    const res = await server.app.inject({ method: 'DELETE', url: '/api/strands/closed-one' });
    expect(res.statusCode).toBe(428);
    const body = res.json() as { ok: boolean; error: { code: string; message: string } };
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('confirmation_required');
    expect(body.error.message).toBe(message);
    expect(events).toEqual([]);
  });

  it('node_unavailable → 503', async () => {
    strands.failWith = new StrandError('node_unavailable', 'Owner node unavailable: refused');
    const res = await server.app.inject({ method: 'DELETE', url: '/api/strands/open-one' });
    expect(res.statusCode).toBe(503);
    expect((res.json() as { error: { code: string } }).error.code).toBe('node_unavailable');
  });

  it('invalid_id → 400', async () => {
    strands.failWith = new StrandError('invalid_id', 'A strand id is required');
    const res = await server.app.inject({ method: 'DELETE', url: '/api/strands/%20' });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: { code: string } }).error.code).toBe('invalid_id');
  });

  it('internal → 500', async () => {
    strands.failWith = new StrandError('internal', 'node said something new');
    const res = await server.app.inject({ method: 'DELETE', url: '/api/strands/open-one' });
    expect(res.statusCode).toBe(500);
    expect((res.json() as { error: { code: string } }).error.code).toBe('internal');
  });
});

describe('donor-only mode (no strands option)', () => {
  beforeEach(async () => {
    await server.app.close();
    buildServer({ withStrands: false });
  });

  it('404s GET /api/strands through the static not-found handler', async () => {
    const res = await server.app.inject({ method: 'GET', url: '/api/strands' });
    expect(res.statusCode).toBe(404);
    expect((res.json() as { error: { code: string } }).error.code).toBe('not_found');
  });

  it('404s DELETE /api/strands/:id', async () => {
    const res = await server.app.inject({ method: 'DELETE', url: '/api/strands/open-one' });
    expect(res.statusCode).toBe(404);
  });
});
