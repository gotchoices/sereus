import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Fastify from 'fastify';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { EventBus } from '../events/bus.js';
import { registerErrorHandler } from '../error-handler.js';
import { registerNodesRoutes, tailLogFile } from '../routes/nodes.js';
import type { HostProcessOrchestrator } from '../../orchestrator/index.js';
import type { ManagedNodeInfo, NodeStateListener } from '../../orchestrator/types.js';

interface FakeOrchestrator extends HostProcessOrchestrator {
  __nodes: Map<string, ManagedNodeInfo>;
  __listeners: Set<NodeStateListener>;
  __stoppedDockerIds: string[];
  __ensured: number;
  __restarted: number;
}

function fakeOrchestrator(
  initial: ManagedNodeInfo[] = [],
  opts: { ownerId?: string; hasOwnerConfig?: boolean } = {},
): FakeOrchestrator {
  const nodes = new Map(initial.map((n) => [n.dockerId, n]));
  const listeners = new Set<NodeStateListener>();
  const stopped: string[] = [];
  const counters = { ensured: 0, restarted: 0 };
  const findById = (id: string): ManagedNodeInfo | undefined => {
    const direct = nodes.get(id);
    if (direct) return direct;
    for (const n of nodes.values()) if (n.id === id) return n;
    return undefined;
  };
  const inst = {
    listNodes: () => [...nodes.values()],
    getNode: (id: string) => findById(id),
    resolveDockerId: (id: string) => {
      if (nodes.has(id)) return id;
      for (const n of nodes.values()) if (n.id === id) return n.dockerId;
      return undefined;
    },
    isOwnerNode: (id: string) => {
      if (!opts.ownerId) return false;
      const node = findById(id);
      return id === opts.ownerId || node?.id === opts.ownerId;
    },
    hasOwnerConfig: () => opts.hasOwnerConfig ?? false,
    ensureOwnerNode: async () => {
      counters.ensured++;
      const node = opts.ownerId ? findById(opts.ownerId) : undefined;
      return node ?? { id: opts.ownerId, status: 'running' } as unknown as ManagedNodeInfo;
    },
    restartOwnerNode: async () => {
      counters.restarted++;
      const node = opts.ownerId ? findById(opts.ownerId) : undefined;
      return node ?? { id: opts.ownerId, status: 'running' } as unknown as ManagedNodeInfo;
    },
    onStateChange: (l: NodeStateListener) => { listeners.add(l); return () => { listeners.delete(l); }; },
    stopContainer: async (dockerId: string) => {
      stopped.push(dockerId);
      const node = nodes.get(dockerId);
      if (node) {
        const next: ManagedNodeInfo = { ...node, status: 'stopped' };
        nodes.set(dockerId, next);
        for (const l of listeners) l(next);
      }
    },
    getStats: async () => ({ cpuPercent: 1, memoryBytes: 2, networkRxBytes: 3, networkTxBytes: 4 }),
    __nodes: nodes,
    __listeners: listeners,
    __stoppedDockerIds: stopped,
    get __ensured() { return counters.ensured; },
    get __restarted() { return counters.restarted; },
  } as unknown as FakeOrchestrator;
  return inst;
}

const SAMPLE_NODE: ManagedNodeInfo = {
  id: 'alice',
  dockerId: '12345:abcdef',
  partyId: 'party-alice',
  profile: 'storage',
  status: 'running',
  spawnedAt: '2025-01-01T00:00:00Z',
  workdir: '',
  ports: { health: 11, metrics: 12, p2p: 13, admin: 14 },
};

describe('/api/nodes routes', () => {
  let app: ReturnType<typeof Fastify>;
  let bus: EventBus;
  let orchestrator: FakeOrchestrator;
  let workdir: string;

  beforeEach(async () => {
    workdir = mkdtempSync(join(tmpdir(), 'cadre-host-nodes-'));
    bus = new EventBus();
    app = Fastify();
    registerErrorHandler(app);
    orchestrator = fakeOrchestrator([{ ...SAMPLE_NODE, workdir }]);
    registerNodesRoutes(app, { orchestrator });
    // Mirror what createLocalUiServer.start() does — forward orchestrator
    // state changes onto the bus. The route itself doesn't publish; the
    // listener is the single publication point.
    orchestrator.onStateChange((info) => {
      bus.publish({
        type: 'node-state-changed',
        nodeId: info.id,
        status: info.status === 'running' ? 'running' : 'stopped',
      });
    });
  });

  afterEach(async () => {
    await app.close();
    rmSync(workdir, { recursive: true, force: true });
  });

  it('GET /api/nodes lists known nodes', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/nodes' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { ok: boolean; data: { nodes: Array<{ id: string }> } };
    expect(body.ok).toBe(true);
    expect(body.data.nodes).toHaveLength(1);
    expect(body.data.nodes[0]?.id).toBe('alice');
  });

  it('GET /api/nodes/:id returns details with stats', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/nodes/alice' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: { node: { id: string }; stats: { cpuPercent: number } } };
    expect(body.data.node.id).toBe('alice');
    expect(body.data.stats.cpuPercent).toBe(1);
  });

  it('GET /api/nodes/:id 404 for unknown', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/nodes/nobody' });
    expect(res.statusCode).toBe(404);
    const body = res.json() as { ok: boolean; error: { code: string } };
    expect(body.error.code).toBe('not_found');
  });

  it('GET /api/nodes/:id/logs returns tail of node.log', async () => {
    // Mirror the orchestrator's defaultLogPath layout: <workdir>/node.log
    writeFileSync(join(workdir, 'node.log'), 'one\ntwo\nthree\nfour\nfive\n', 'utf8');
    const res = await app.inject({ method: 'GET', url: '/api/nodes/alice/logs?lines=2' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: { lines: string[] } };
    expect(body.data.lines).toEqual(['four', 'five']);
  });

  it('GET /api/nodes/:id/logs returns [] when log file missing', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/nodes/alice/logs' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: { lines: string[] } };
    expect(body.data.lines).toEqual([]);
  });

  it('POST /api/nodes/:id/stop calls orchestrator and publishes exactly one event via the listener', async () => {
    const events: unknown[] = [];
    bus.subscribe((e) => events.push(e));
    const res = await app.inject({ method: 'POST', url: '/api/nodes/alice/stop' });
    expect(res.statusCode).toBe(200);
    expect(orchestrator.__stoppedDockerIds).toContain(SAMPLE_NODE.dockerId);
    // Exactly one event — the orchestrator listener publishes; the route
    // does not re-publish (regression guard).
    expect(events).toEqual([
      { type: 'node-state-changed', nodeId: 'alice', status: 'stopped' },
    ]);
  });

  it('POST /api/nodes/:id/start on a non-owner node returns 501 not_implemented', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/nodes/alice/start' });
    expect(res.statusCode).toBe(501);
    const body = res.json() as { error: { code: string } };
    expect(body.error.code).toBe('not_implemented');
  });

  it('POST /api/nodes/:id/restart on a non-owner node returns 501 not_implemented', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/nodes/alice/restart' });
    expect(res.statusCode).toBe(501);
  });

  it('POST /api/nodes/:id/start on an unknown node returns 404', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/nodes/nobody/start' });
    expect(res.statusCode).toBe(404);
    const body = res.json() as { error: { code: string } };
    expect(body.error.code).toBe('not_found');
  });
});

describe('/api/nodes — owner node start/restart', () => {
  const OWNER_NODE: ManagedNodeInfo = {
    id: 'owner',
    dockerId: '999:tok',
    partyId: 'install-id',
    profile: 'storage',
    status: 'running',
    spawnedAt: '2025-01-01T00:00:00Z',
    workdir: '',
    ports: { health: 1, metrics: 2, p2p: 4555, admin: 3 },
    owner: true,
  };

  let app: ReturnType<typeof Fastify>;
  let orchestrator: FakeOrchestrator;

  beforeEach(() => {
    app = Fastify();
    registerErrorHandler(app);
    orchestrator = fakeOrchestrator([OWNER_NODE], { ownerId: 'owner', hasOwnerConfig: true });
    registerNodesRoutes(app, { orchestrator });
  });

  afterEach(async () => { await app.close(); });

  it('start ensures the owner node', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/nodes/owner/start' });
    expect(res.statusCode).toBe(200);
    expect(orchestrator.__ensured).toBe(1);
  });

  it('restart re-spawns the owner node', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/nodes/owner/restart' });
    expect(res.statusCode).toBe(200);
    expect(orchestrator.__restarted).toBe(1);
  });

  it('start returns 501 when there is no saved owner config', async () => {
    const app2 = Fastify();
    registerErrorHandler(app2);
    const orch2 = fakeOrchestrator([OWNER_NODE], { ownerId: 'owner', hasOwnerConfig: false });
    registerNodesRoutes(app2, { orchestrator: orch2 });
    const res = await app2.inject({ method: 'POST', url: '/api/nodes/owner/start' });
    expect(res.statusCode).toBe(501);
    await app2.close();
  });
});

describe('tailLogFile', () => {
  it('returns [] for missing file', () => {
    expect(tailLogFile(join(tmpdir(), 'definitely-not-here-' + Date.now()), 10)).toEqual([]);
  });

  it('returns the last N lines from a multi-line file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cadre-host-tail-'));
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'sample.log');
    writeFileSync(path, Array.from({ length: 50 }, (_, i) => `line-${i + 1}`).join('\n') + '\n', 'utf8');
    try {
      const last3 = tailLogFile(path, 3);
      expect(last3).toEqual(['line-48', 'line-49', 'line-50']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
