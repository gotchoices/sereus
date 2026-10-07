import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Fastify from 'fastify';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { registerErrorHandler } from '../error-handler.js';
import { registerNodesRoutes, tailLogFile } from '../routes/nodes.js';
import type { HostProcessOrchestrator } from '../../orchestrator/index.js';
import type { ManagedNodeInfo } from '../../orchestrator/types.js';

function fakeOrchestrator(initial: ManagedNodeInfo[] = []): HostProcessOrchestrator {
  const nodes = new Map(initial.map((n) => [n.dockerId, n]));
  const findById = (id: string): ManagedNodeInfo | undefined => {
    const direct = nodes.get(id);
    if (direct) return direct;
    for (const n of nodes.values()) if (n.id === id) return n;
    return undefined;
  };
  return {
    listNodes: () => [...nodes.values()],
    getNode: (id: string) => findById(id),
    getStats: async () => ({ cpuPercent: 1, memoryBytes: 2, networkRxBytes: 3, networkTxBytes: 4 }),
  } as unknown as HostProcessOrchestrator;
}

const SAMPLE_NODE: ManagedNodeInfo = {
  id: 'alice',
  dockerId: '12345:abcdef',
  partyId: 'party-alice',
  profile: 'storage',
  status: 'running',
  spawnedAt: '2025-01-01T00:00:00Z',
  workdir: '',
  ports: { health: 11, metrics: 12, p2p: 13, ws: 15 },
  announcedAddrs: [],
};

describe('/api/nodes routes', () => {
  let app: ReturnType<typeof Fastify>;
  let workdir: string;

  beforeEach(async () => {
    workdir = mkdtempSync(join(tmpdir(), 'cadre-host-nodes-'));
    app = Fastify();
    registerErrorHandler(app);
    registerNodesRoutes(app, { orchestrator: fakeOrchestrator([{ ...SAMPLE_NODE, workdir }]) });
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
