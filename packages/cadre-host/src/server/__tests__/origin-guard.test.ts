import Fastify from 'fastify';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { registerOriginGuard } from '../origin-guard.js';

describe('origin guard', () => {
  let app: ReturnType<typeof Fastify>;

  beforeEach(async () => {
    app = Fastify();
    registerOriginGuard(app, { port: 8765 });
    app.get('/ping', async () => ({ ok: true, data: { pong: true } }));
  });

  afterEach(async () => {
    await app.close();
  });

  it('accepts 127.0.0.1:<port>', async () => {
    const res = await app.inject({ method: 'GET', url: '/ping', headers: { host: '127.0.0.1:8765' } });
    expect(res.statusCode).toBe(200);
  });

  it('accepts localhost:<port>', async () => {
    const res = await app.inject({ method: 'GET', url: '/ping', headers: { host: 'localhost:8765' } });
    expect(res.statusCode).toBe(200);
  });

  it('accepts case-insensitive localhost', async () => {
    const res = await app.inject({ method: 'GET', url: '/ping', headers: { host: 'LOCALHOST:8765' } });
    expect(res.statusCode).toBe(200);
  });

  it('rejects mismatched host', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/ping',
      headers: { host: 'evil.example.com' },
    });
    expect(res.statusCode).toBe(403);
    const body = res.json() as { ok: boolean; error: { code: string } };
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('forbidden_origin');
  });

  it('rejects host with wrong port', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/ping',
      headers: { host: '127.0.0.1:9999' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('accepts request with matching Origin', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/ping',
      headers: { host: '127.0.0.1:8765', origin: 'http://127.0.0.1:8765' },
    });
    expect(res.statusCode).toBe(200);
  });

  it('rejects request with mismatched Origin', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/ping',
      headers: { host: '127.0.0.1:8765', origin: 'http://evil.example.com' },
    });
    expect(res.statusCode).toBe(403);
  });
});
