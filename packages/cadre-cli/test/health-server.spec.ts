import { describe, it, expect, afterEach } from 'vitest';
import { toString as uint8ToString } from 'uint8arrays';
import { HealthServer } from '../src/server/health.js';
import type { CadreNode } from '@serfab/cadre-core';

/**
 * Minimal scriptable CadreNode stand-in for the health server. Records
 * applySeed calls so tests can assert the auth gate actually blocks delivery.
 */
class MockNode {
  applySeedCalls: unknown[] = [];
  readonly isRunning = true;
  readonly partyId = 'party-xyz';
  get peerId() { return { toString: () => '12D3KooWSelf' }; }

  getStrands() { return new Map(); }
  getMultiaddrs(): string[] { return ['/ip4/127.0.0.1/tcp/4001']; }
  getConnectionPaths() {
    return { total: 0, relayed: 0, direct: 0, stuckOnRelay: 0, byTransport: {}, paths: [] };
  }

  async applySeed(seed: unknown) {
    this.applySeedCalls.push(seed);
    return { success: true, peersAdded: 1 };
  }
}

/** base64url-encode a seed object the way the real CLI/provider does. */
function encodeSeed(seed: unknown): string {
  return uint8ToString(new TextEncoder().encode(JSON.stringify(seed)), 'base64url');
}

const TOKEN = 'super-secret-seed-token';
const SEED = encodeSeed({ partyId: 'party-xyz', peers: [] });

describe('HealthServer', () => {
  let server: HealthServer | null = null;
  let node: MockNode;

  async function startServer(seedToken?: string): Promise<{ base: string; metricsBase: string }> {
    node = new MockNode();
    // Port 0 + healthBoundPort/metricsBoundPort lets the suite run without a fixed port.
    server = new HealthServer({ healthPort: 0, metricsPort: 0, seedToken });
    server.attach(node as unknown as CadreNode);
    await server.start();
    return {
      base: `http://127.0.0.1:${server.healthBoundPort}`,
      metricsBase: `http://127.0.0.1:${server.metricsBoundPort}`,
    };
  }

  afterEach(async () => {
    if (server) await server.stop();
    server = null;
  });

  function postSeed(base: string, headers: Record<string, string> = {}, body = JSON.stringify({ seed: SEED })) {
    return fetch(`${base}/seed`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body });
  }

  describe('with no seed token (default)', () => {
    it('POST /seed is not registered → 404, applySeed never called', async () => {
      const { base } = await startServer();
      const res = await postSeed(base, { authorization: `Bearer ${TOKEN}` });
      expect(res.status).toBe(404);
      expect(node.applySeedCalls).toHaveLength(0);
    });

    it('liveness/readiness probes stay reachable unauthenticated', async () => {
      const { base } = await startServer();
      expect((await fetch(`${base}/health`)).status).toBe(200);
      expect((await fetch(`${base}/ready`)).status).toBe(200);
      expect((await fetch(`${base}/status`)).status).toBe(200);
    });

    it('GET /metrics reports cadre_connections_total and drops the retired cadre_peers_connected alias', async () => {
      const { metricsBase } = await startServer();
      const res = await fetch(`${metricsBase}/metrics`);
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toContain('cadre_connections_total ');
      expect(body).not.toContain('cadre_peers_connected');
      expect(body).not.toContain('\n\n\n');
    });
  });

  describe('with a seed token configured', () => {
    it('rejects a missing bearer (401) without calling applySeed', async () => {
      const { base } = await startServer(TOKEN);
      const res = await postSeed(base);
      expect(res.status).toBe(401);
      expect((await res.json()).error).toBe('unauthorized');
      expect(node.applySeedCalls).toHaveLength(0);
    });

    it('rejects a wrong bearer (401) without calling applySeed', async () => {
      const { base } = await startServer(TOKEN);
      const res = await postSeed(base, { authorization: 'Bearer wrong' });
      expect(res.status).toBe(401);
      expect(node.applySeedCalls).toHaveLength(0);
    });

    it('applies the seed once with the correct bearer (200)', async () => {
      const { base } = await startServer(TOKEN);
      const res = await postSeed(base, { authorization: `Bearer ${TOKEN}` });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ success: true, peersAdded: 1 });
      expect(node.applySeedCalls).toHaveLength(1);
    });

    it('rejects an over-large body (413) without calling applySeed', async () => {
      const { base } = await startServer(TOKEN);
      const huge = JSON.stringify({ seed: 'x'.repeat(300 * 1024) });
      const res = await postSeed(base, { authorization: `Bearer ${TOKEN}` }, huge);
      expect(res.status).toBe(413);
      expect(node.applySeedCalls).toHaveLength(0);
    });

    it('rejects a body missing the seed field (400) without calling applySeed', async () => {
      const { base } = await startServer(TOKEN);
      const res = await postSeed(base, { authorization: `Bearer ${TOKEN}` }, JSON.stringify({}));
      expect(res.status).toBe(400);
      expect(node.applySeedCalls).toHaveLength(0);
    });

    it('rejects a malformed JSON body (400) without calling applySeed', async () => {
      const { base } = await startServer(TOKEN);
      const res = await postSeed(base, { authorization: `Bearer ${TOKEN}` }, '{not json');
      expect(res.status).toBe(400);
      expect(node.applySeedCalls).toHaveLength(0);
    });

    it('does not expose /seed to non-POST methods (404) — the method guard is not auth', async () => {
      const { base } = await startServer(TOKEN);
      const res = await fetch(`${base}/seed`, { method: 'GET', headers: { authorization: `Bearer ${TOKEN}` } });
      expect(res.status).toBe(404);
      expect(node.applySeedCalls).toHaveLength(0);
    });

    it('still serves probes unauthenticated', async () => {
      const { base } = await startServer(TOKEN);
      expect((await fetch(`${base}/health`)).status).toBe(200);
      expect((await fetch(`${base}/status`)).status).toBe(200);
    });
  });
});
