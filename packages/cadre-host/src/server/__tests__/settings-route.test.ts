import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Fastify from 'fastify';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { registerErrorHandler } from '../error-handler.js';
import { registerSettingsRoutes } from '../routes/settings.js';
import { HostSettingsStore } from '../settings-store.js';
import type { NatService } from '../../nat/index.js';
import type { NatStatusSnapshot } from '../../nat/types.js';
import type { UpdateService } from '../../update/index.js';
import type { UpdateSettings } from '../../update/types.js';

function fakeNat(): { svc: NatService; calls: Array<unknown> } {
  const calls: unknown[] = [];
  const stub = {
    putSettings: async (patch: unknown) => { calls.push(patch); return {} as NatStatusSnapshot; },
  } as unknown as NatService;
  return { svc: stub, calls };
}

function fakeUpdate(): { svc: UpdateService; calls: UpdateSettings[] } {
  const calls: UpdateSettings[] = [];
  const stub = {
    putSettings: async (patch: { autoApply?: boolean; manifestUrl?: string }) => {
      calls.push({ autoApply: patch.autoApply ?? false, ...(patch.manifestUrl ? { manifestUrl: patch.manifestUrl } : {}) });
      return { autoApply: patch.autoApply ?? false } as UpdateSettings;
    },
  } as unknown as UpdateService;
  return { svc: stub, calls };
}

function writeV2Config(dir: string): string {
  const cfg = {
    version: 2,
    installId: 'inst-x',
    uiPort: 8765,
    libp2pPort: 4001,
    dataDir: dir,
    identityPath: join(dir, 'identity.key'),
    upnpEnabled: true,
    installedAt: '2025-01-01T00:00:00Z',
    installerVersion: '0.6.0',
    updates: { autoApply: false },
  };
  const path = join(dir, 'host.config.json');
  writeFileSync(path, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
  return path;
}

function writeV1Config(dir: string): string {
  const cfg = {
    version: 1,
    installId: 'inst-x',
    uiPort: 8765,
    libp2pPort: 4001,
    dataDir: dir,
    identityPath: join(dir, 'identity.key'),
    upnpEnabled: true,
    installedAt: '2025-01-01T00:00:00Z',
    installerVersion: '0.6.0',
  };
  const path = join(dir, 'host.config.json');
  writeFileSync(path, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
  return path;
}

describe('/api/settings routes', () => {
  let app: ReturnType<typeof Fastify>;
  let dataDir: string;

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'cadre-host-settings-'));
  });

  afterEach(async () => {
    if (app) await app.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('GET returns the persisted config', async () => {
    writeV2Config(dataDir);
    app = Fastify();
    registerErrorHandler(app);
    registerSettingsRoutes(app, {
      settingsStore: new HostSettingsStore({ dataDir }),
      nat: fakeNat().svc,
    });
    const res = await app.inject({ method: 'GET', url: '/api/settings' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: { uiPort: number; updates: { autoApply: boolean } } };
    expect(body.data.uiPort).toBe(8765);
    expect(body.data.updates.autoApply).toBe(false);
  });

  it('PUT propagates upnpEnabled to nat service and host.config.json', async () => {
    writeV2Config(dataDir);
    const nat = fakeNat();
    app = Fastify();
    registerErrorHandler(app);
    registerSettingsRoutes(app, { settingsStore: new HostSettingsStore({ dataDir }), nat: nat.svc });
    const res = await app.inject({
      method: 'PUT',
      url: '/api/settings',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ upnpEnabled: false }),
    });
    expect(res.statusCode).toBe(200);
    expect(nat.calls).toEqual([{ upnpEnabled: false }]);
    const body = res.json() as { data: { upnpEnabled: boolean } };
    expect(body.data.upnpEnabled).toBe(false);
  });

  it('PUT updates.autoApply propagates to update service', async () => {
    writeV2Config(dataDir);
    const nat = fakeNat();
    const update = fakeUpdate();
    app = Fastify();
    registerErrorHandler(app);
    registerSettingsRoutes(app, { settingsStore: new HostSettingsStore({ dataDir }), nat: nat.svc, update: update.svc });
    const res = await app.inject({
      method: 'PUT',
      url: '/api/settings',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ updates: { autoApply: true } }),
    });
    expect(res.statusCode).toBe(200);
    expect(update.calls).toEqual([{ autoApply: true }]);
    const body = res.json() as { data: { updates: { autoApply: boolean } } };
    expect(body.data.updates.autoApply).toBe(true);
  });

  it('PUT uiPort returns 400 invalid_setting', async () => {
    writeV2Config(dataDir);
    app = Fastify();
    registerErrorHandler(app);
    registerSettingsRoutes(app, { settingsStore: new HostSettingsStore({ dataDir }), nat: fakeNat().svc });
    const res = await app.inject({
      method: 'PUT',
      url: '/api/settings',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ uiPort: 9999 }),
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { error: { code: string; message: string } };
    expect(body.error.code).toBe('invalid_setting');
    expect(body.error.message).toMatch(/uiPort/);
  });

  it('PUT ownCadre returns 400 invalid_setting (install-time only)', async () => {
    writeV2Config(dataDir);
    app = Fastify();
    registerErrorHandler(app);
    registerSettingsRoutes(app, { settingsStore: new HostSettingsStore({ dataDir }), nat: fakeNat().svc });
    const res = await app.inject({
      method: 'PUT',
      url: '/api/settings',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ ownCadre: { enabled: true } }),
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { error: { code: string; message: string } };
    expect(body.error.code).toBe('invalid_setting');
    expect(body.error.message).toMatch(/ownCadre/);
  });

  it('PUT unknown setting returns 400', async () => {
    writeV2Config(dataDir);
    app = Fastify();
    registerErrorHandler(app);
    registerSettingsRoutes(app, { settingsStore: new HostSettingsStore({ dataDir }), nat: fakeNat().svc });
    const res = await app.inject({
      method: 'PUT',
      url: '/api/settings',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ totallyMadeUp: 'value' }),
    });
    expect(res.statusCode).toBe(400);
  });

  it('reads v1 host.config.json and migrates to v2 on first read', async () => {
    writeV1Config(dataDir);
    app = Fastify();
    registerErrorHandler(app);
    registerSettingsRoutes(app, { settingsStore: new HostSettingsStore({ dataDir }), nat: fakeNat().svc });
    const res = await app.inject({ method: 'GET', url: '/api/settings' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: { version: number; updates: { autoApply: boolean } } };
    expect(body.data.version).toBe(2);
    expect(body.data.updates.autoApply).toBe(false);
  });
});
