// Bring up cadre-host against a fresh temp data dir for a manual browser smoke.
// Uses the published `Installer` with a no-op service host so nothing is
// registered on the developer's machine. Logs the URL to stdout.

import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  Installer,
  HostProcessOrchestrator,
  TrustCircleService,
  TrustCircleStore,
  NatService,
  UpdateService,
  createLocalUiServer,
  HostSettingsStore,
} from '@serfab/cadre-host';

class NoopServiceHost {
  name = 'cadre-host';
  async install() {}
  async uninstall() {}
  async restart() {}
  async status() { return { installed: true, running: true }; }
  renderUnit() { return null; }
}

function missingTrustCircleNodeStub(label) {
  const err = () => { throw new Error(`smoke: ${label} requires a real cadre node`); };
  return {
    createInvite: err,
    acceptPhone: err,
    removePeer: err,
    encodeInvite: () => { throw new Error(`smoke: ${label} encodeInvite unavailable`); },
    getControlDatabase: () => null,
  };
}

function missingNatNodeStub() {
  return { getPeerId: () => '', getMultiaddrs: () => [] };
}

const dataDir = mkdtempSync(join(tmpdir(), 'cadre-host-smoke-'));
const uiPort = Number(process.env.SMOKE_UI_PORT ?? 18765);
console.log(`[smoke] data dir: ${dataDir}`);
console.log(`[smoke] ui port: ${uiPort}`);

const installer = new Installer({ installerVersion: 'smoke-1.0.0' });
const installResult = await installer.install({
  nonInteractive: true,
  dataDir,
  uiPort,
  libp2pPort: 14001,
  openBrowser: false,
  noInvite: true,
  serviceHost: new NoopServiceHost(),
});
console.log(`[smoke] installed: ${installResult.configPath}`);

const cfg = JSON.parse(readFileSync(installResult.configPath, 'utf8'));

const orchestrator = new HostProcessOrchestrator({ rootDir: join(cfg.dataDir, 'orchestrator') });
await orchestrator.init();

const trustCircle = new TrustCircleService({
  cadreNode: missingTrustCircleNodeStub('trust-circle'),
  store: new TrustCircleStore(cfg.dataDir),
});

const natService = new NatService({
  rootDir: cfg.dataDir,
  cadreNode: missingNatNodeStub(),
});
try { await natService.start(); } catch (err) { console.error(`[smoke] NAT start failed: ${err.message}`); }

const updateService = new UpdateService({
  dataDir: cfg.dataDir,
  currentVersion: '0.6.0-smoke',
  settings: cfg.updates,
  restart: async () => undefined,
  // Block the network call: smoke must not hit releases.serfab.io.
  fetcher: async () => new Response('not found', { status: 404 }),
  checkIntervalMs: 24 * 60 * 60 * 1000,
});
// Intentionally do not call updateService.check() — smoke avoids network.
updateService.start();

const settingsStore = new HostSettingsStore({ dataDir: cfg.dataDir });
const server = createLocalUiServer({
  uiPort: cfg.uiPort,
  dataDir: cfg.dataDir,
  orchestrator,
  trustCircle,
  nat: natService,
  update: updateService,
  settingsStore,
});

const { url, port } = await server.start();
console.log(`[smoke] cadre-host local UI: ${url}`);
console.log(`[smoke] bound port: ${port}`);
console.log('[smoke] ready');

const shutdown = async () => {
  try { await server.stop(); } catch {}
  try { await natService.stop(); } catch {}
  updateService.stop();
  console.log('[smoke] stopped');
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
