/**
 * HostProcessOrchestrator authority-node lifecycle tests.
 *
 * Uses the `spawn.entrypoint` hook with a fake CLI that writes its startup
 * token and binds a minimal `/admin/identity` endpoint on the admin port —
 * enough to validate spawn, idempotency, admin-port allocation/persistence,
 * the end-to-end AuthorityNodeClient round-trip, and init() re-attach.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { HostProcessOrchestrator, AUTHORITY_CONTAINER_ID } from '../orchestrator/host-process-orchestrator.js';
import { StateStore } from '../orchestrator/state-store.js';
import { isPidAlive } from '../orchestrator/pid-liveness.js';
import { decodeDockerId } from '../orchestrator/types.js';
import { AuthorityNodeClient } from '../authority/authority-node-client.js';

const FAKE_AUTHORITY_CLI = `
import fs from 'node:fs';
import http from 'node:http';

const args = process.argv.slice(2);
const get = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };

const tokenPath = get('--startup-token-file');
const adminPort = get('--admin-port');
const token = process.env.CADRE_STARTUP_TOKEN ?? '';

if (tokenPath && token) {
  try { fs.writeFileSync(tokenPath, token, 'utf8'); } catch (err) { console.error('token write failed', err); }
}

if (adminPort && token) {
  const server = http.createServer((req, res) => {
    const auth = req.headers['authorization'];
    if (auth !== 'Bearer ' + token) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: { code: 'not_authorized', message: 'bad token' } }));
      return;
    }
    if (req.url === '/admin/identity' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, data: { peerId: 'FAKEPEER', partyId: 'fake-party' } }));
      return;
    }
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: { code: 'bad_request', message: req.url } }));
  });
  server.listen(parseInt(adminPort, 10), '127.0.0.1', () => {
    console.log('admin listening on ' + adminPort);
  });
}

process.on('SIGTERM', () => process.exit(0));
console.log('fake authority up');
setInterval(() => {}, 1 << 30);
`;

let tmpRoot: string;
let scriptPath: string;
const orchestrators: HostProcessOrchestrator[] = [];

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'cadre-host-auth-'));
  scriptPath = join(tmpRoot, 'fake-authority.mjs');
  writeFileSync(scriptPath, FAKE_AUTHORITY_CLI, 'utf8');
});

afterEach(async () => {
  for (const orch of orchestrators) {
    try { await orch.stopAuthorityNode(); } catch { /* ignore */ }
    for (const dockerId of listDockerIds(orch)) {
      try { await orch.removeContainer(dockerId); } catch { /* ignore */ }
    }
  }
  orchestrators.length = 0;
  await sleep(50);
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

function makeOrchestrator(rootDir: string): HostProcessOrchestrator {
  mkdirSync(rootDir, { recursive: true });
  const orch = new HostProcessOrchestrator({
    rootDir,
    portRange: { start: 18500, end: 18999 },
    stopTimeoutMs: 1500,
    spawn: { entrypoint: scriptPath },
  });
  orchestrators.push(orch);
  return orch;
}

function listDockerIds(orch: HostProcessOrchestrator): string[] {
  const state = new StateStore((orch as unknown as { rootDir: string }).rootDir);
  return state.load().handles.map((h) => h.dockerId);
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 4000, intervalMs = 50): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(intervalMs);
  }
  throw new Error('waitFor: timed out');
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

const CFG = { identityPath: 'C:/fake/identity.key', partyId: 'install-id-123', libp2pPort: 4555 };

describe('HostProcessOrchestrator.ensureAuthorityNode', () => {
  it('spawns the authority node, allocates+persists an admin port', async () => {
    const orch = makeOrchestrator(join(tmpRoot, 'a'));
    await orch.init();
    const node = await orch.ensureAuthorityNode(CFG);

    expect(node.id).toBe(AUTHORITY_CONTAINER_ID);
    expect(node.authority).toBe(true);
    expect(node.ports.admin).toBeGreaterThanOrEqual(18500);
    expect(node.ports.p2p).toBe(4555);

    const endpoint = orch.getAuthorityAdminEndpoint();
    expect(endpoint).toBeDefined();
    expect(endpoint!.baseUrl).toBe(`http://127.0.0.1:${node.ports.admin}`);

    // Persisted with admin port + authority flag + authorityConfig.
    const persisted = new StateStore(join(tmpRoot, 'a')).load();
    expect(persisted.authorityConfig).toMatchObject({ partyId: 'install-id-123', libp2pPort: 4555 });
    const ph = persisted.handles.find((h) => h.containerId === AUTHORITY_CONTAINER_ID);
    expect(ph?.authority).toBe(true);
    expect(typeof ph?.ports.admin).toBe('number');
  });

  it('is idempotent — a second call does not spawn a second child', async () => {
    const orch = makeOrchestrator(join(tmpRoot, 'b'));
    await orch.init();
    const first = await orch.ensureAuthorityNode(CFG);
    await waitFor(() => orch.isRunning(first.dockerId));

    const second = await orch.ensureAuthorityNode(CFG);
    expect(second.dockerId).toBe(first.dockerId);
    expect(orch.listNodes()).toHaveLength(1);
  });

  it('the AuthorityNodeClient reaches the spawned admin channel', async () => {
    const orch = makeOrchestrator(join(tmpRoot, 'c'));
    await orch.init();
    const node = await orch.ensureAuthorityNode(CFG);
    await waitFor(() => orch.isRunning(node.dockerId));

    const client = new AuthorityNodeClient(() => orch.getAuthorityAdminEndpoint());
    await waitFor(async () => {
      try { return (await client.getPeerId()) === 'FAKEPEER'; } catch { return false; }
    });
    expect(await client.getPeerId()).toBe('FAKEPEER');
  });

  it('getAuthorityAdminEndpoint() survives an init() re-attach', async () => {
    const rootDir = join(tmpRoot, 'd');
    const a = makeOrchestrator(rootDir);
    await a.init();
    const node = await a.ensureAuthorityNode(CFG);
    await waitFor(() => a.isRunning(node.dockerId));
    const before = a.getAuthorityAdminEndpoint();

    const b = makeOrchestrator(rootDir);
    await b.init();
    expect(b.isAuthorityNode(AUTHORITY_CONTAINER_ID)).toBe(true);
    expect(b.hasAuthorityConfig()).toBe(true);
    const after = b.getAuthorityAdminEndpoint();
    expect(after).toEqual(before);
    expect(await b.isRunning(node.dockerId)).toBe(true);

    const { pid } = decodeDockerId(node.dockerId);
    expect(isPidAlive(pid)).toBe(true);
  });

  it('restartAuthorityNode preserves the workdir and re-spawns', async () => {
    const orch = makeOrchestrator(join(tmpRoot, 'e'));
    await orch.init();
    const first = await orch.ensureAuthorityNode(CFG);
    await waitFor(() => orch.isRunning(first.dockerId));
    const { pid: firstPid } = decodeDockerId(first.dockerId);

    const restarted = await orch.restartAuthorityNode();
    await waitFor(() => orch.isRunning(restarted.dockerId));

    // New child (different pid/token), still exactly one node, workdir reused.
    expect(restarted.dockerId).not.toBe(first.dockerId);
    expect(orch.listNodes()).toHaveLength(1);
    await waitFor(() => !isPidAlive(firstPid));
  });
});
