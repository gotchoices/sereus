import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { NatService, NAT_UNMAP_GRACE_MS, createNatHandlers, type NatNodeSource } from '../nat-service.js';
import { ExternalIpDetector } from '../external-ip.js';
import { NatError } from '../types.js';
import type { GatewayInfo, PortMapper, PortMapRequest, PortMapResult } from '../port-mapper.js';
import type { SecretsStore } from '../secrets/index.js';
import { ddnsAccount } from '../secrets/index.js';
import type { ManagedNodeInfo, NodeStateListener } from '../../orchestrator/types.js';

/** A router: maps `internal + offset`, refuses once `cap` ports are mapped. */
class FakeMapper implements PortMapper {
  gateway: GatewayInfo | null = { lanAddress: '192.168.1.20', routerHost: '192.168.1.1' };
  cap = Number.POSITIVE_INFINITY;
  offset = 0;
  routerIp: string | null = '203.0.113.10';
  readonly mapped = new Map<number, number>();
  readonly mapCalls: number[] = [];
  readonly unmapCalls: number[] = [];
  async discover(): Promise<GatewayInfo | null> { return this.gateway; }
  async map(req: PortMapRequest): Promise<PortMapResult> {
    this.mapCalls.push(req.internalPort);
    if (!this.mapped.has(req.internalPort) && this.mapped.size >= this.cap) {
      throw new NatError('mapping_failed', 'router: mapping table is full');
    }
    const externalPort = req.internalPort + this.offset;
    this.mapped.set(req.internalPort, externalPort);
    return { externalPort, leaseExpiresAt: new Date(Date.now() + req.ttlMs) };
  }
  async unmap(internalPort: number): Promise<void> {
    this.unmapCalls.push(internalPort);
    this.mapped.delete(internalPort);
  }
  async externalIp(): Promise<string | null> { return this.routerIp; }
  async stop(): Promise<void> { /* nothing to release */ }
}

/** The orchestrator slice the service reads: a node list plus state-change events. */
class FakeNodes implements NatNodeSource {
  private readonly nodes = new Map<string, ManagedNodeInfo>();
  private readonly listeners = new Set<NodeStateListener>();
  listNodes(): ManagedNodeInfo[] { return [...this.nodes.values()]; }
  onStateChange(listener: NodeStateListener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  add(id: string, ports: { p2p: number; ws?: number }, status: ManagedNodeInfo['status'] = 'running'): void {
    const info: ManagedNodeInfo = {
      id,
      dockerId: `1:${id}`,
      partyId: 'party',
      profile: 'storage',
      status,
      spawnedAt: '2026-01-01T00:00:00Z',
      workdir: `/w/${id}`,
      ports: { health: 1, metrics: 2, p2p: ports.p2p, admin: 3, ws: ports.ws as number },
    };
    this.nodes.set(id, info);
    this.emit(info);
  }
  setStatus(id: string, status: ManagedNodeInfo['status']): void {
    const info = { ...this.nodes.get(id)!, status };
    this.nodes.set(id, info);
    this.emit(info);
  }
  /** `removeContainer`: the handle is gone from the list by the time the event fires. */
  remove(id: string): void {
    const info = { ...this.nodes.get(id)!, status: 'stopped' as const };
    this.nodes.delete(id);
    this.emit(info);
  }
  private emit(info: ManagedNodeInfo): void {
    for (const l of this.listeners) l(info);
  }
}

function makeSecrets(seed: Record<string, string> = {}): SecretsStore {
  const m = new Map(Object.entries(seed));
  return {
    async set(a, v) { m.set(a, v); },
    async get(a) { return m.has(a) ? m.get(a)! : null; },
    async delete(a) { return m.delete(a); },
    async list() { return [...m.keys()]; },
  };
}

function makeDetector(opts: { router?: string | null; pub?: string | null }): ExternalIpDetector {
  return new ExternalIpDetector({
    routerProbe: opts.router === undefined ? undefined : async () => opts.router ?? null,
    fetch: (async () => ({
      ok: opts.pub != null,
      status: opts.pub != null ? 200 : 500,
      async text() { return opts.pub ?? ''; },
    })) as unknown as typeof fetch,
    publicIpUrls: ['https://stub.test'],
  });
}

/** The DuckDNS call a `putDdns` lands on; no case here reaches www.duckdns.org. */
function okFetch(): typeof fetch {
  return (async () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    async text() { return 'OK'; },
  })) as unknown as typeof fetch;
}

let tmpRoot: string;
let clock: number;
const now = (): Date => new Date(clock);

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'cadre-host-nat-svc-'));
  clock = Date.parse('2026-01-01T00:00:00Z');
});
afterEach(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

interface Rig {
  svc: NatService;
  mapper: FakeMapper;
  nodes: FakeNodes;
}

function rig(opts: {
  mapper?: FakeMapper;
  nodes?: FakeNodes;
  detector?: ExternalIpDetector;
  fetch?: typeof fetch;
  secrets?: SecretsStore;
} = {}): Rig {
  const mapper = opts.mapper ?? new FakeMapper();
  const nodes = opts.nodes ?? new FakeNodes();
  const svc = new NatService({
    rootDir: tmpRoot,
    nodeSource: nodes,
    now,
    secretsStore: opts.secrets ?? makeSecrets(),
    portMapper: mapper,
    externalIpDetector: opts.detector ?? makeDetector({ pub: '203.0.113.10' }),
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
  });
  return { svc, mapper, nodes };
}

/** `start()` maps in the background; a second pass is sequenced after it. */
async function startAndSettle(svc: NatService): Promise<void> {
  await svc.start();
  await svc.reconcile();
}

function node(svc: NatService, id: string) {
  const found = svc.getStatus().nodes.find((n) => n.nodeId === id);
  if (!found) throw new Error(`node ${id} not in status`);
  return found;
}

describe('NatService — mapping table', () => {
  it('maps both ports of every running node, and stop() unmaps nothing', async () => {
    const { svc, mapper, nodes } = rig({ detector: makeDetector({ router: '203.0.113.10', pub: '203.0.113.10' }) });
    nodes.add('owner', { p2p: 4001, ws: 10001 });
    nodes.add('grn_a', { p2p: 10003, ws: 10004 });
    await startAndSettle(svc);

    const status = svc.getStatus();
    expect(status.gateway).toMatchObject({ found: true, lanAddress: '192.168.1.20', routerExternalIp: '203.0.113.10' });
    expect(status.directReachability).toBe('reachable');
    expect(node(svc, 'grn_a')).toMatchObject({
      verdict: 'mapped',
      tcp: { internalPort: 10003, externalPort: 10003, source: 'upnp' },
      ws: { internalPort: 10004, externalPort: 10004, source: 'upnp' },
      publicAddrs: ['/ip4/203.0.113.10/tcp/10003', '/ip4/203.0.113.10/tcp/10004/ws'],
    });
    expect(node(svc, 'owner').tcp.externalPort).toBe(4001);
    expect(mapper.mapped.size).toBe(4);

    await svc.stop();
    expect(mapper.unmapCalls).toEqual([]);
  });

  it('a router that caps its mappings fails per port; the other node keeps its routes across a renewal', async () => {
    const mapper = new FakeMapper();
    mapper.cap = 3;
    const { svc, nodes } = rig({ mapper });
    nodes.add('a', { p2p: 10003, ws: 10004 });
    nodes.add('b', { p2p: 10005, ws: 10006 });
    await startAndSettle(svc);

    expect(node(svc, 'a').verdict).toBe('mapped');
    const b = node(svc, 'b');
    expect(b.verdict).toBe('unreachable');
    expect(b.tcp.externalPort).toBe(10005);
    expect(b.ws).toMatchObject({ externalPort: null, error: expect.stringContaining('full') });
    expect(b.reason).toContain('WebSocket port 10006');
    expect(b.reason).toContain('192.168.1.20');
    expect(b.publicAddrs).toEqual(['/ip4/203.0.113.10/tcp/10005']);
    expect(svc.getStatus().directReachability).toBe('unreachable');

    await svc.renewMappings();
    expect(node(svc, 'a')).toMatchObject({
      verdict: 'mapped',
      tcp: { externalPort: 10003, source: 'upnp' },
      ws: { externalPort: 10004, source: 'upnp' },
    });
    expect(node(svc, 'b').ws?.externalPort).toBeNull();
  });

  it('the route and the public addresses carry the external port the router assigned', async () => {
    const mapper = new FakeMapper();
    mapper.offset = 1;
    const { svc, nodes } = rig({ mapper });
    nodes.add('a', { p2p: 10003, ws: 10004 });
    await startAndSettle(svc);

    expect(node(svc, 'a')).toMatchObject({
      tcp: { internalPort: 10003, externalPort: 10004 },
      ws: { internalPort: 10004, externalPort: 10005 },
      publicAddrs: ['/ip4/203.0.113.10/tcp/10004', '/ip4/203.0.113.10/tcp/10005/ws'],
    });
  });

  it('a handle without a WebSocket port maps only its TCP port', async () => {
    const { svc, nodes } = rig();
    nodes.add('old', { p2p: 10003 });
    await startAndSettle(svc);

    expect(node(svc, 'old')).toMatchObject({ verdict: 'mapped', ws: null, publicAddrs: ['/ip4/203.0.113.10/tcp/10003'] });
  });

  it('a terminated node is unmapped at once and its manual forward is dropped', async () => {
    const { svc, mapper, nodes } = rig();
    nodes.add('a', { p2p: 10003, ws: 10004 });
    await startAndSettle(svc);
    await svc.putForward('a', { tcp: 40000 });
    expect(readFileSync(join(tmpRoot, 'nat.json'), 'utf8')).toContain('"a"');

    nodes.remove('a');
    await svc.reconcile(); // sequenced after the pass the removal event queued

    expect(mapper.unmapCalls).toContain(10004);
    expect(mapper.mapped.size).toBe(0);
    expect(svc.getStatus().nodes).toEqual([]);
    expect(svc.getSettings().forwards).toEqual({});
    expect(readFileSync(join(tmpRoot, 'nat.json'), 'utf8')).not.toContain('"a"');
  });

  it('a node stopped inside the grace keeps its mapping; past it the mapping is released and a respawn re-maps', async () => {
    const { svc, mapper, nodes } = rig();
    nodes.add('a', { p2p: 10003, ws: 10004 });
    await startAndSettle(svc);

    nodes.setStatus('a', 'stopped');
    await svc.reconcile(); // the stop event's own pass records when the node was first seen stopped
    clock += NAT_UNMAP_GRACE_MS - 1_000;
    await svc.reconcile();
    expect(mapper.unmapCalls).toEqual([]);
    expect(node(svc, 'a')).toMatchObject({ running: false, tcp: { externalPort: 10003 } });

    clock += 1_000;
    await svc.reconcile();
    expect(mapper.unmapCalls).toEqual([10003, 10004]);
    expect(node(svc, 'a').tcp.externalPort).toBeNull();

    nodes.setStatus('a', 'running');
    await svc.reconcile();
    expect(node(svc, 'a')).toMatchObject({ running: true, verdict: 'mapped', tcp: { externalPort: 10003 } });
  });
});

describe('NatService — manual forwards and the UPnP toggle', () => {
  it('a manual forward wins over UPnP and is re-requested when cleared', async () => {
    const { svc, mapper, nodes } = rig();
    nodes.add('a', { p2p: 10003, ws: 10004 });
    await startAndSettle(svc);

    let status = await svc.putForward('a', { tcp: 40000 });
    expect(mapper.unmapCalls).toEqual([10003]);
    expect(status.nodes[0]).toMatchObject({
      verdict: 'manual',
      tcp: { externalPort: 40000, source: 'manual' },
      ws: { externalPort: 10004, source: 'upnp' },
      publicAddrs: ['/ip4/203.0.113.10/tcp/40000', '/ip4/203.0.113.10/tcp/10004/ws'],
    });
    expect(JSON.parse(readFileSync(join(tmpRoot, 'nat.json'), 'utf8')).forwards).toEqual({ a: { tcp: 40000 } });

    status = await svc.putForward('a', { tcp: null });
    expect(status.nodes[0]).toMatchObject({ verdict: 'mapped', tcp: { externalPort: 10003, source: 'upnp' } });
    expect(svc.getSettings().forwards).toEqual({});
  });

  it('putForward refuses an unknown node and an out-of-range port', async () => {
    const { svc, nodes } = rig();
    nodes.add('a', { p2p: 10003, ws: 10004 });
    await startAndSettle(svc);

    await expect(svc.putForward('nope', { tcp: 1 })).rejects.toMatchObject({ code: 'unknown_node' });
    await expect(svc.putForward('a', { ws: 70000 })).rejects.toMatchObject({ code: 'invalid_config' });
  });

  it('turning UPnP off releases upnp routes and keeps manual ones', async () => {
    const { svc, mapper, nodes } = rig();
    nodes.add('a', { p2p: 10003, ws: 10004 });
    await startAndSettle(svc);
    await svc.putForward('a', { ws: 40004 });

    const status = await svc.putSettings({ upnpEnabled: false });
    expect(mapper.unmapCalls).toEqual([10004, 10003]);
    const a = status.nodes[0]!;
    expect(a.ws).toMatchObject({ externalPort: 40004, source: 'manual' });
    expect(a.tcp).toMatchObject({ externalPort: null, source: null });
    expect(a.verdict).toBe('unreachable');
    expect(a.reason).toContain('UPnP is off');
    expect(a.reason).toContain('TCP port 10003');

    await svc.putSettings({ upnpEnabled: true });
    expect(node(svc, 'a')).toMatchObject({ verdict: 'manual', tcp: { externalPort: 10003, source: 'upnp' } });
  });
});

describe('NatService — public addresses', () => {
  it('predicts the identity mapping for a port with no route yet, but not after a failed attempt', async () => {
    const mapper = new FakeMapper();
    mapper.cap = 1;
    const { svc, nodes } = rig({ mapper });
    await startAndSettle(svc);

    expect(svc.publicAddressesFor('new', { p2p: 20000, ws: 20001 })).toEqual([
      '/ip4/203.0.113.10/tcp/20000',
      '/ip4/203.0.113.10/tcp/20001/ws',
    ]);

    nodes.add('new', { p2p: 20000, ws: 20001 });
    await svc.reconcile();
    expect(svc.publicAddressesFor('new', { p2p: 20000, ws: 20001 })).toEqual(['/ip4/203.0.113.10/tcp/20000']);
  });

  it('predicts nothing without a gateway, and a manual forward regardless', async () => {
    const mapper = new FakeMapper();
    mapper.gateway = null;
    const { svc, nodes } = rig({ mapper });
    nodes.add('a', { p2p: 10003, ws: 10004 });
    await startAndSettle(svc);

    expect(svc.getStatus().gateway).toMatchObject({ found: false, lastError: expect.stringContaining('no UPnP gateway') });
    expect(svc.publicAddressesFor('a', { p2p: 10003, ws: 10004 })).toEqual([]);
    expect(node(svc, 'a').reason).toContain('No UPnP router answered');

    await svc.putForward('a', { tcp: 40000, ws: 40001 });
    expect(svc.publicAddressesFor('a', { p2p: 10003, ws: 10004 })).toEqual([
      '/ip4/203.0.113.10/tcp/40000',
      '/ip4/203.0.113.10/tcp/40001/ws',
    ]);
    expect(node(svc, 'a').verdict).toBe('manual');
  });

  it('uses the DDNS hostname as the host part once one is configured', async () => {
    const { svc, nodes } = rig({
      secrets: makeSecrets({ [ddnsAccount('duckdns', 'token')]: 'T' }),
      fetch: okFetch(),
    });
    nodes.add('a', { p2p: 10003, ws: 10004 });
    await startAndSettle(svc);

    const status = await svc.putDdns({ providerId: 'duckdns', hostname: 'foo.duckdns.org', config: { token: 'T' } });
    expect(status.ddns).toMatchObject({ providerId: 'duckdns', hostname: 'foo.duckdns.org' });
    expect(status.nodes[0]!.publicAddrs).toEqual(['/dns4/foo.duckdns.org/tcp/10003', '/dns4/foo.duckdns.org/tcp/10004/ws']);
  });

  it('under CGNAT a upnp route yields no address and the host rolls up to cgnat; a manual route still counts', async () => {
    const { svc, nodes } = rig({ detector: makeDetector({ router: '100.64.0.5', pub: '203.0.113.10' }) });
    nodes.add('a', { p2p: 10003, ws: 10004 });
    await startAndSettle(svc);

    const status = svc.getStatus();
    expect(status.cgnatDetected).toBe(true);
    expect(status.directReachability).toBe('cgnat');
    expect(status.nodes[0]).toMatchObject({ verdict: 'unreachable', publicAddrs: [] });
    expect(status.nodes[0]!.reason).toContain('carrier-grade NAT');

    const after = await svc.putForward('a', { tcp: 40000, ws: 40001 });
    expect(after.nodes[0]).toMatchObject({
      verdict: 'manual',
      publicAddrs: ['/ip4/203.0.113.10/tcp/40000', '/ip4/203.0.113.10/tcp/40001/ws'],
    });
    expect(after.directReachability).toBe('reachable');
  });
});

describe('NatService — external IP and change notification', () => {
  it('a failed re-detection keeps the previous external IP', async () => {
    let offline = false;
    const detector = new ExternalIpDetector({
      fetch: (async () => {
        if (offline) throw new Error('offline');
        return { ok: true, status: 200, async text() { return '203.0.113.10'; } };
      }) as unknown as typeof fetch,
      publicIpUrls: ['https://stub.test'],
    });
    const { svc } = rig({ detector });
    await startAndSettle(svc);
    expect(svc.getStatus().externalIp).toBe('203.0.113.10');

    offline = true;
    const status = await svc.testReachability();
    expect(status.externalIp).toBe('203.0.113.10');
    expect(status.lastTestedAt).not.toBeNull();
  });

  it('onChange fires when the snapshot changes and stays quiet across an idle pass', async () => {
    const { svc, nodes } = rig();
    const seen: string[] = [];
    svc.onChange((snap) => { seen.push(snap.directReachability); });
    await startAndSettle(svc);
    const afterStart = seen.length;
    expect(afterStart).toBeGreaterThan(0);

    await svc.reconcile();
    expect(seen.length).toBe(afterStart);

    nodes.add('a', { p2p: 10003, ws: 10004 });
    await svc.reconcile();
    expect(seen.length).toBeGreaterThan(afterStart);
    expect(seen[seen.length - 1]).toBe('reachable');
  });

  it('putDdns with an unknown provider → ddns_provider_unknown', async () => {
    const { svc } = rig();
    await startAndSettle(svc);
    await expect(svc.putDdns({ providerId: 'no-such-provider', hostname: 'x', config: {} }))
      .rejects.toMatchObject({ code: 'ddns_provider_unknown' });
  });
});

describe('createNatHandlers', () => {
  it('every handler delegates to the service', async () => {
    const { svc, nodes } = rig({ fetch: okFetch(), secrets: makeSecrets() });
    nodes.add('a', { p2p: 10003, ws: 10004 });
    await startAndSettle(svc);
    const h = createNatHandlers(svc);

    expect((await h.getStatus()).directReachability).toBe('reachable');
    expect((await h.listDdnsProviders()).find((p) => p.id === 'duckdns')).toBeDefined();
    expect((await h.testReachability()).lastTestedAt).not.toBeNull();
    expect((await h.putSettings({ upnpEnabled: false })).upnpEnabled).toBe(false);
    expect((await h.putForward('a', { tcp: 40000 })).nodes[0]!.tcp.externalPort).toBe(40000);
    expect((await h.putDdns({ providerId: 'duckdns', hostname: 'a.duckdns.org', config: { token: 'T' } })).ddns.hostname)
      .toBe('a.duckdns.org');
  });
});
