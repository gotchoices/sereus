import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { NatService, createNatHandlers } from '../nat-service.js';
import { ExternalIpDetector } from '../external-ip.js';
import type { PortMapper, PortMappingResult } from '../port-mapper.js';
import type { SecretsStore } from '../secrets/index.js';
import { ddnsAccount } from '../secrets/index.js';
import type { CadreNodeLike } from '../nat-service.js';
import { AuthorityNodeUnavailableError } from '../../authority/authority-node-client.js';

class StubMapper implements PortMapper {
  mapCalls = 0;
  unmapCalls = 0;
  stopCalls = 0;
  externalIpValue: string | null = '203.0.113.10';
  mapFails = false;
  async map(o: { externalPort: number; internalPort: number; protocol?: 'tcp' | 'udp'; ttlMs?: number }): Promise<PortMappingResult> {
    this.mapCalls++;
    if (this.mapFails) throw new Error('router refused');
    return {
      mode: 'auto-upnp',
      externalIp: this.externalIpValue,
      externalPort: o.externalPort,
      internalPort: o.internalPort,
      protocol: o.protocol ?? 'tcp',
      leaseExpiresAt: new Date(Date.now() + (o.ttlMs ?? 60_000)),
    };
  }
  async verify() { return true; }
  async externalIp() { return this.externalIpValue; }
  async unmap() { this.unmapCalls++; }
  async stop() { this.stopCalls++; }
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

function makeNode(peerId = '12D3KooWHost', addrs: string[] = ['/ip4/192.168.1.10/tcp/4001']): CadreNodeLike {
  return {
    getPeerId: () => peerId,
    getMultiaddrs: () => addrs,
  };
}

/**
 * A node that mimics a freshly spawned authority child: `getPeerId` throws
 * `AuthorityNodeUnavailableError` for the first `failTimes` calls (admin channel
 * not bound yet), then returns a real peer ID. Exposes the call count so tests
 * can assert how many attempts the retry loop made.
 */
function makeFlakyNode(
  failTimes: number,
  peerId = '12D3KooWFlaky',
  addrs: string[] = ['/ip4/192.168.1.10/tcp/4001'],
): { node: CadreNodeLike; peerIdCalls: () => number } {
  let calls = 0;
  const node: CadreNodeLike = {
    getPeerId: async () => {
      calls += 1;
      if (calls <= failTimes) throw new AuthorityNodeUnavailableError('admin channel not bound yet');
      return peerId;
    },
    getMultiaddrs: async () => addrs,
  };
  return { node, peerIdCalls: () => calls };
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

let tmpRoot: string;
beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'cadre-host-nat-svc-'));
});
afterEach(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('NatService', () => {
  it('start() runs port mapping, detects IP, status reflects auto-upnp', async () => {
    const mapper = new StubMapper();
    const svc = new NatService({
      rootDir: tmpRoot,
      cadreNode: makeNode(),
      secretsStore: makeSecrets(),
      portMapper: mapper,
      externalIpDetector: makeDetector({ router: '203.0.113.10', pub: '203.0.113.10' }),
    });
    await svc.start();
    const s = svc.getStatus();
    expect(s.portMode).toBe('auto-upnp');
    expect(s.externalPort).toBe(4001);
    expect(s.externalIp).toBe('203.0.113.10');
    expect(s.directReachability).toBe('reachable');
    expect(mapper.mapCalls).toBe(1);
  });

  it('detects CGNAT and flags directReachability=cgnat', async () => {
    const mapper = new StubMapper();
    const svc = new NatService({
      rootDir: tmpRoot,
      cadreNode: makeNode(),
      secretsStore: makeSecrets(),
      portMapper: mapper,
      externalIpDetector: makeDetector({ router: '100.64.0.5', pub: '203.0.113.10' }),
    });
    await svc.start();
    const s = svc.getStatus();
    expect(s.cgnatDetected).toBe(true);
    expect(s.directReachability).toBe('cgnat');
  });

  it('flips portMode to failed when mapper throws', async () => {
    const mapper = new StubMapper();
    mapper.mapFails = true;
    const svc = new NatService({
      rootDir: tmpRoot,
      cadreNode: makeNode(),
      secretsStore: makeSecrets(),
      portMapper: mapper,
      externalIpDetector: makeDetector({ pub: '1.2.3.4' }),
    });
    await svc.start();
    expect(svc.getStatus().portMode).toBe('failed');
    expect(svc.getStatus().directReachability).toBe('unreachable');
  });

  it('stop() unmaps and is idempotent', async () => {
    const mapper = new StubMapper();
    const svc = new NatService({
      rootDir: tmpRoot,
      cadreNode: makeNode(),
      secretsStore: makeSecrets(),
      portMapper: mapper,
      externalIpDetector: makeDetector({ pub: '1.2.3.4' }),
    });
    await svc.start();
    await svc.stop();
    await svc.stop();
    expect(mapper.unmapCalls).toBe(1);
    expect(mapper.stopCalls).toBe(1);
  });

  it('getInviteAddresses → dns4 when DDNS configured + reachable', async () => {
    const mapper = new StubMapper();
    const secrets = makeSecrets({ [ddnsAccount('duckdns', 'token')]: 'T' });
    const svc = new NatService({
      rootDir: tmpRoot,
      cadreNode: makeNode('12D3KooWHost'),
      secretsStore: secrets,
      portMapper: mapper,
      externalIpDetector: makeDetector({ pub: '1.2.3.4' }),
    });
    await svc.start();
    await svc.putDdns({
      providerId: 'duckdns',
      hostname: 'foo.duckdns.org',
      config: { token: 'T' },
    });
    const addrs = await svc.getInviteAddresses();
    expect(addrs).toEqual(['/dns4/foo.duckdns.org/tcp/4001/p2p/12D3KooWHost']);
  });

  it('getInviteAddresses → ip4 when reachable but no DDNS', async () => {
    const mapper = new StubMapper();
    const svc = new NatService({
      rootDir: tmpRoot,
      cadreNode: makeNode('12D3KooWHost'),
      secretsStore: makeSecrets(),
      portMapper: mapper,
      externalIpDetector: makeDetector({ pub: '203.0.113.42' }),
    });
    await svc.start();
    const addrs = await svc.getInviteAddresses();
    expect(addrs).toEqual(['/ip4/203.0.113.42/tcp/4001/p2p/12D3KooWHost']);
  });

  it('getInviteAddresses → libp2p fallback when unreachable', async () => {
    const mapper = new StubMapper();
    mapper.mapFails = true;
    const svc = new NatService({
      rootDir: tmpRoot,
      cadreNode: makeNode('12D3KooWHost', ['/ip4/10.0.0.5/tcp/4001']),
      secretsStore: makeSecrets(),
      portMapper: mapper,
      externalIpDetector: makeDetector({ pub: null }),
    });
    await svc.start();
    const addrs = await svc.getInviteAddresses();
    expect(addrs).toEqual(['/ip4/10.0.0.5/tcp/4001/p2p/12D3KooWHost']);
  });

  it('putDdns persists secrets and updates status', async () => {
    const secrets = makeSecrets();
    const mapper = new StubMapper();
    const svc = new NatService({
      rootDir: tmpRoot,
      cadreNode: makeNode(),
      secretsStore: secrets,
      portMapper: mapper,
      externalIpDetector: makeDetector({ pub: '1.2.3.4' }),
    });
    await svc.start();
    const status = await svc.putDdns({
      providerId: 'duckdns',
      hostname: 'h.duckdns.org',
      config: { token: 'TOK' },
    });
    expect(status.ddns.providerId).toBe('duckdns');
    expect(status.ddns.hostname).toBe('h.duckdns.org');
    expect(await secrets.get(ddnsAccount('duckdns', 'token'))).toBe('TOK');
  });

  it('putDdns with unknown provider → ddns_provider_unknown', async () => {
    const mapper = new StubMapper();
    const svc = new NatService({
      rootDir: tmpRoot,
      cadreNode: makeNode(),
      secretsStore: makeSecrets(),
      portMapper: mapper,
      externalIpDetector: makeDetector({ pub: '1.2.3.4' }),
    });
    await svc.start();
    await expect(svc.putDdns({
      providerId: 'no-such-provider',
      hostname: 'x',
      config: {},
    })).rejects.toMatchObject({ code: 'ddns_provider_unknown' });
  });

  it('putSettings can disable UPnP and re-enable it', async () => {
    const mapper = new StubMapper();
    const svc = new NatService({
      rootDir: tmpRoot,
      cadreNode: makeNode(),
      secretsStore: makeSecrets(),
      portMapper: mapper,
      externalIpDetector: makeDetector({ pub: '1.2.3.4' }),
    });
    await svc.start();
    expect(mapper.mapCalls).toBe(1);

    let s = await svc.putSettings({ upnpEnabled: false });
    expect(s.portMode).toBe('disabled');

    s = await svc.putSettings({ upnpEnabled: true });
    expect(s.portMode).toBe('auto-upnp');
    expect(mapper.mapCalls).toBeGreaterThanOrEqual(2);
  });

  it('testReachability re-runs IP detect and updates lastTestedAt', async () => {
    const mapper = new StubMapper();
    const svc = new NatService({
      rootDir: tmpRoot,
      cadreNode: makeNode(),
      secretsStore: makeSecrets(),
      portMapper: mapper,
      externalIpDetector: makeDetector({ pub: '1.2.3.4' }),
    });
    await svc.start();
    expect(svc.getStatus().lastTestedAt).toBeNull();
    await svc.testReachability();
    expect(svc.getStatus().lastTestedAt).not.toBeNull();
  });

  it('listDdnsProviders returns at least DuckDNS', () => {
    const svc = new NatService({
      rootDir: tmpRoot,
      cadreNode: makeNode(),
      secretsStore: makeSecrets(),
      portMapper: new StubMapper(),
      externalIpDetector: makeDetector({ pub: '1.2.3.4' }),
    });
    const providers = svc.listDdnsProviders();
    const duck = providers.find((p) => p.id === 'duckdns');
    expect(duck).toBeDefined();
    expect(duck!.configFields[0]).toMatchObject({ key: 'token', secret: true });
  });
});

describe('NatService — async channel node + onAddressesChanged', () => {
  it('getInviteAddresses awaits async getPeerId/getMultiaddrs from the channel', async () => {
    const asyncNode: CadreNodeLike = {
      getPeerId: async () => '12D3KooWAsync',
      getMultiaddrs: async () => ['/ip4/10.0.0.9/tcp/4001'],
    };
    const svc = new NatService({
      rootDir: tmpRoot,
      cadreNode: asyncNode,
      secretsStore: makeSecrets(),
      portMapper: new StubMapper(),
      externalIpDetector: makeDetector({ pub: '203.0.113.50' }),
    });
    await svc.start();
    const addrs = await svc.getInviteAddresses();
    expect(addrs).toEqual(['/ip4/203.0.113.50/tcp/4001/p2p/12D3KooWAsync']);
  });

  it('throws node_unavailable when the node reports an empty peer ID (not ready)', async () => {
    const notReadyNode: CadreNodeLike = {
      getPeerId: async () => '',
      getMultiaddrs: async () => [],
    };
    const svc = new NatService({
      rootDir: tmpRoot,
      cadreNode: notReadyNode,
      secretsStore: makeSecrets(),
      portMapper: new StubMapper(),
      externalIpDetector: makeDetector({ pub: '203.0.113.50' }),
    });
    await svc.start();
    await expect(svc.getInviteAddresses()).rejects.toMatchObject({ code: 'node_unavailable' });
  });

  it('fires onAddressesChanged on putSettings and testReachability', async () => {
    const svc = new NatService({
      rootDir: tmpRoot,
      cadreNode: makeNode('12D3KooWHook'),
      secretsStore: makeSecrets(),
      portMapper: new StubMapper(),
      externalIpDetector: makeDetector({ pub: '203.0.113.7' }),
    });
    await svc.start();

    const fired: string[][] = [];
    svc.onAddressesChanged((addrs) => { fired.push(addrs); });

    await svc.putSettings({ externalPort: 4002 });
    await svc.testReachability();

    expect(fired.length).toBeGreaterThanOrEqual(2);
    // The pushed addresses carry the node's peer ID.
    expect(fired.at(-1)!.every((a) => a.includes('12D3KooWHook'))).toBe(true);
  });

  it('onAddressesChanged unsubscribe stops further notifications', async () => {
    const svc = new NatService({
      rootDir: tmpRoot,
      cadreNode: makeNode(),
      secretsStore: makeSecrets(),
      portMapper: new StubMapper(),
      externalIpDetector: makeDetector({ pub: '1.2.3.4' }),
    });
    await svc.start();
    let count = 0;
    const off = svc.onAddressesChanged(() => { count++; });
    await svc.testReachability();
    off();
    await svc.testReachability();
    expect(count).toBe(1);
  });
});

describe('NatService — initial invite-address push retry', () => {
  it('retries past a not-yet-ready node and delivers the push exactly once', async () => {
    const { node, peerIdCalls } = makeFlakyNode(3, '12D3KooWFlaky');
    const svc = new NatService({
      rootDir: tmpRoot,
      cadreNode: node,
      secretsStore: makeSecrets(),
      portMapper: new StubMapper(),
      externalIpDetector: makeDetector({ pub: '203.0.113.42' }),
      initialPushRetryMs: 1,
      initialPushTimeoutMs: 2_000,
    });

    // Listener registered BEFORE start() — this is the race the fix closes.
    const fired: string[][] = [];
    svc.onAddressesChanged((addrs) => { fired.push(addrs); });

    await svc.start();

    // Delivered exactly once, with the NAT-resolved address carrying the peer ID.
    expect(fired).toEqual([['/ip4/203.0.113.42/tcp/4001/p2p/12D3KooWFlaky']]);
    // It took the failing attempts plus the successful one (proves it retried).
    expect(peerIdCalls()).toBe(4);
  });

  it('gives up after the bounded timeout but still resolves start() (best-effort)', async () => {
    // Always unavailable — the retry budget elapses without a successful push.
    const node: CadreNodeLike = {
      getPeerId: async () => { throw new AuthorityNodeUnavailableError('never ready'); },
      getMultiaddrs: async () => [],
    };
    const svc = new NatService({
      rootDir: tmpRoot,
      cadreNode: node,
      secretsStore: makeSecrets(),
      portMapper: new StubMapper(),
      externalIpDetector: makeDetector({ pub: '203.0.113.42' }),
      initialPushRetryMs: 2,
      initialPushTimeoutMs: 20,
    });

    const fired: string[][] = [];
    svc.onAddressesChanged((addrs) => { fired.push(addrs); });

    await svc.start(); // resolves despite the node never coming up
    expect(fired).toEqual([]); // best-effort: nothing delivered
    // The process is otherwise healthy — status still builds.
    expect(svc.getStatus().portMode).toBe('auto-upnp');
  });

  it('does not retry on a non-node_unavailable error', async () => {
    let calls = 0;
    const node: CadreNodeLike = {
      getPeerId: async () => { calls += 1; throw new Error('boom'); },
      getMultiaddrs: async () => [],
    };
    const svc = new NatService({
      rootDir: tmpRoot,
      cadreNode: node,
      secretsStore: makeSecrets(),
      portMapper: new StubMapper(),
      externalIpDetector: makeDetector({ pub: '203.0.113.42' }),
      initialPushRetryMs: 1,
      initialPushTimeoutMs: 2_000,
    });
    svc.onAddressesChanged(() => { /* registered before start */ });

    await svc.start(); // does not hang retrying a non-transient failure
    expect(calls).toBe(1);
  });
});

describe('createNatHandlers', () => {
  it('every handler delegates to the service', async () => {
    const mapper = new StubMapper();
    const svc = new NatService({
      rootDir: tmpRoot,
      cadreNode: makeNode(),
      secretsStore: makeSecrets(),
      portMapper: mapper,
      externalIpDetector: makeDetector({ pub: '1.2.3.4' }),
    });
    await svc.start();
    const h = createNatHandlers(svc);

    expect((await h.getStatus()).portMode).toBe('auto-upnp');
    expect((await h.listDdnsProviders()).find((p) => p.id === 'duckdns')).toBeDefined();

    const status = await h.testReachability();
    expect(status.lastTestedAt).not.toBeNull();

    const after = await h.putSettings({ externalPort: 4002 });
    expect(after.externalPort).toBe(4002);

    const ddnsStatus = await h.putDdns({
      providerId: 'duckdns',
      hostname: 'a.duckdns.org',
      config: { token: 'T' },
    });
    expect(ddnsStatus.ddns.hostname).toBe('a.duckdns.org');
  });
});
