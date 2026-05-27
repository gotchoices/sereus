/**
 * Server-level smoke: the /auth/* HTTP contract over the authority-node
 * channel adapter. Validates the two behaviours the realignment must
 * preserve:
 *   1. With the node up, POST /auth/invites returns an encodedInvite (no 500).
 *   2. With the node refusing connections, GET /auth/trust-circle still lists
 *      local labels, and POST /auth/invites returns 503 (not a raw 500).
 *
 * The authority node is represented by a stub HTTP server matching the 6.6
 * admin contract (the spawn path itself is covered by
 * orchestrator-authority.test.ts).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TrustCircleService, TrustCircleStore, createTrustCircleHandlers } from '../auth/index.js';
import { AuthorityNodeClient } from '../authority/index.js';
import { registerErrorHandler } from '../server/error-handler.js';
import { registerTrustCircleRoutes } from '../server/routes/trust-circle.js';
import { EventBus } from '../server/events/bus.js';

const TOKEN = 'tok';

let tmpRoot: string;
beforeEach(() => { tmpRoot = mkdtempSync(join(tmpdir(), 'cadre-host-smoke-')); });
afterEach(() => { try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ } });

function buildApp(service: TrustCircleService) {
  const app = Fastify();
  registerErrorHandler(app);
  registerTrustCircleRoutes(app, { handlers: createTrustCircleHandlers(service), events: new EventBus() });
  return app;
}

describe('host /auth delegation — node up', () => {
  let server: http.Server;
  let baseUrl: string;

  beforeEach(async () => {
    server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c as Buffer));
      req.on('end', () => {
        if (req.headers['authorization'] !== `Bearer ${TOKEN}`) {
          res.writeHead(401); res.end(JSON.stringify({ ok: false, error: { code: 'not_authorized', message: 'x' } })); return;
        }
        if (req.url === '/admin/invites' && req.method === 'POST') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true, data: { invite: { partyId: 'p', authorityAddrs: [], token: 't', createdAt: 1 }, encodedInvite: 'ENC' } }));
          return;
        }
        if (req.url === '/admin/members' && req.method === 'GET') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true, data: { members: [] } }));
          return;
        }
        res.writeHead(400); res.end(JSON.stringify({ ok: false, error: { code: 'bad_request', message: req.url } }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const a = server.address();
    baseUrl = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
  });

  afterEach(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); });

  it('POST /auth/invites returns an encodedInvite (no 500)', async () => {
    const client = new AuthorityNodeClient({ baseUrl, token: TOKEN });
    const service = new TrustCircleService({ cadreNode: client, store: new TrustCircleStore(tmpRoot) });
    const app = buildApp(service);
    try {
      const res = await app.inject({ method: 'POST', url: '/auth/invites', payload: { label: 'Mom' } });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { encodedInvite: string };
      expect(body.encodedInvite).toBe('ENC');
    } finally {
      await app.close();
    }
  });
});

describe('host /auth delegation — node refusing connections', () => {
  let closedBaseUrl: string;

  beforeEach(async () => {
    const tmp = http.createServer();
    const port = await new Promise<number>((resolve) => {
      tmp.listen(0, '127.0.0.1', () => {
        const a = tmp.address();
        resolve(typeof a === 'object' && a ? a.port : 0);
      });
    });
    await new Promise<void>((resolve) => tmp.close(() => resolve()));
    closedBaseUrl = `http://127.0.0.1:${port}`;
  });

  it('GET /auth/trust-circle lists local labels and POST /auth/invites returns 503', async () => {
    const store = new TrustCircleStore(tmpRoot);
    store.addMember({ peerId: '12D3KooWLocal', label: 'My laptop', addedAt: '2025-01-01T00:00:00Z' });

    const client = new AuthorityNodeClient({ baseUrl: closedBaseUrl, token: TOKEN });
    const service = new TrustCircleService({ cadreNode: client, store });
    const app = buildApp(service);
    try {
      const list = await app.inject({ method: 'GET', url: '/auth/trust-circle' });
      expect(list.statusCode).toBe(200);
      const snap = list.json() as { members: Array<{ peerId: string; label: string }> };
      expect(snap.members.some((m) => m.peerId === '12D3KooWLocal' && m.label === 'My laptop')).toBe(true);

      const invite = await app.inject({ method: 'POST', url: '/auth/invites', payload: { label: 'Dad' } });
      expect(invite.statusCode).toBe(503);
      const body = invite.json() as { error: { code: string } };
      expect(body.error.code).toBe('node_unavailable');
    } finally {
      await app.close();
    }
  });
});
