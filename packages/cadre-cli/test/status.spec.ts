import { describe, it, expect } from 'vitest';
import {
  queryRuntime,
  buildStatusReport,
  formatStatusReport,
  type FetchLike,
  type ConfigSummary,
} from '../src/commands/status-query.js';
import type { HealthStatus } from '../src/server/health.js';

const URL = 'http://localhost:8080/status';

/** A representative live /status envelope from a running node. */
const HEALTH: HealthStatus = {
  status: 'healthy',
  timestamp: '2026-06-02T00:00:00.000Z',
  uptime: 123.5,
  peerId: '12D3KooWLivePeer',
  multiaddrs: ['/ip4/10.0.0.5/tcp/4001', '/ip4/10.0.0.5/tcp/4002/ws'],
  node: {
    running: true,
    peerId: '12D3KooWLivePeer',
    partyId: 'party-live',
    profile: 'transaction',
    strands: { total: 3, active: 1, idle: 1, hibernating: 1 },
    connectionPaths: {
      total: 0,
      relayed: 0,
      direct: 0,
      stuckOnRelay: 0,
      bytesOverRelay: null,
      settleWindowMs: 10000,
      byTransport: {
        'circuit-relay': 0,
        webrtc: 0,
        'webrtc-turn': 0,
        'webrtc-direct': 0,
        websocket: 0,
        tcp: 0,
        unknown: 0,
      },
    },
  },
};

const CONFIG: ConfigSummary = {
  config: 'cadre.yaml',
  partyId: 'party-live',
  profile: 'transaction',
  bootstrapNodes: 2,
  strandFilter: 'all',
  hibernation: false,
};

/** A FetchLike that returns a fixed envelope. */
function okFetch(body: unknown, status = 200): FetchLike {
  return async () => ({ ok: status >= 200 && status < 300, status, json: async () => body });
}

describe('queryRuntime', () => {
  it('returns reachable:true with the parsed HealthStatus when the node answers', async () => {
    const result = await queryRuntime(okFetch(HEALTH), URL, 2000);
    expect(result.reachable).toBe(true);
    if (result.reachable) {
      expect(result.status.node.running).toBe(true);
      expect(result.status.peerId).toBe('12D3KooWLivePeer');
    }
  });

  it('returns reachable:false on a transport failure (ECONNREFUSED)', async () => {
    const refuse: FetchLike = () => Promise.reject(new Error('connect ECONNREFUSED 127.0.0.1:8080'));
    const result = await queryRuntime(refuse, URL, 2000);
    expect(result.reachable).toBe(false);
    if (!result.reachable) {
      expect(result.reason).toMatch(/ECONNREFUSED/);
      expect(result.url).toBe(URL);
    }
  });

  it('returns reachable:false on a non-2xx response', async () => {
    const result = await queryRuntime(okFetch({}, 503), URL, 2000);
    expect(result.reachable).toBe(false);
    if (!result.reachable) {
      expect(result.reason).toMatch(/HTTP 503/);
    }
  });

  it('returns reachable:false when the fetch never resolves before the timeout fires', async () => {
    const hang: FetchLike = () => new Promise(() => { /* never settles */ });
    const result = await queryRuntime(hang, URL, 50);
    expect(result.reachable).toBe(false);
    if (!result.reachable) {
      expect(result.reason).toMatch(/timed out/);
    }
  });
});

describe('buildStatusReport', () => {
  it('surfaces live runtime fields (no hardcoded false/null/[]) when reachable', async () => {
    const runtime = await queryRuntime(okFetch(HEALTH), URL, 2000);
    const report = buildStatusReport(CONFIG, runtime);

    expect(report.config).toEqual(CONFIG);
    expect(report.runtime.reachable).toBe(true);
    if (report.runtime.reachable) {
      expect(report.runtime.running).toBe(true);
      expect(report.runtime.peerId).toBe('12D3KooWLivePeer');
      expect(report.runtime.multiaddrs).toEqual(HEALTH.multiaddrs);
      expect(report.runtime.strands).toEqual({ total: 3, active: 1, idle: 1, hibernating: 1 });
      expect(report.runtime.partyId).toBe('party-live');
      expect(report.runtime.profile).toBe('transaction');
    }
  });

  it('does not emit a bare running:false when unreachable', async () => {
    const refuse: FetchLike = () => Promise.reject(new Error('connect ECONNREFUSED 127.0.0.1:8080'));
    const runtime = await queryRuntime(refuse, URL, 2000);
    const report = buildStatusReport(CONFIG, runtime);

    expect(report.runtime.reachable).toBe(false);
    // The JSON must NOT carry a running field at all (would read as "verified stopped").
    expect(JSON.stringify(report)).not.toMatch(/"running"/);
    if (!report.runtime.reachable) {
      expect(report.runtime.url).toBe(URL);
      expect(report.runtime.reason).toMatch(/ECONNREFUSED/);
    }
  });

  it('carries a null config through when the config file was skipped', () => {
    const report = buildStatusReport(null, { reachable: false, url: URL, reason: 'x' });
    expect(report.config).toBeNull();
  });
});

describe('formatStatusReport', () => {
  it('labels Configuration and Runtime (live) and shows live fields when reachable', async () => {
    const runtime = await queryRuntime(okFetch(HEALTH), URL, 2000);
    const text = formatStatusReport(buildStatusReport(CONFIG, runtime));

    expect(text).toContain('Configuration:');
    expect(text).toContain('Runtime (live):');
    expect(text).toContain('Running:         true');
    expect(text).toContain('12D3KooWLivePeer');
    expect(text).toContain('/ip4/10.0.0.5/tcp/4001');
    expect(text).toContain('total=3 active=1 idle=1 hibernating=1');
  });

  it('renders a clearly-labeled "not reachable" line (never "Running: false") when unreachable', async () => {
    const refuse: FetchLike = () => Promise.reject(new Error('connect ECONNREFUSED 127.0.0.1:8080'));
    const runtime = await queryRuntime(refuse, URL, 2000);
    const text = formatStatusReport(buildStatusReport(CONFIG, runtime));

    expect(text).toContain('no running node reachable at http://localhost:8080/status');
    expect(text).not.toContain('Running:');
    expect(text).not.toMatch(/running.*false/i);
  });

  it('shows the config-skipped placeholder when there is no config summary', () => {
    const text = formatStatusReport(buildStatusReport(null, { reachable: false, url: URL, reason: 'x' }));
    expect(text).toContain('(no config file found; skipped)');
  });
});
