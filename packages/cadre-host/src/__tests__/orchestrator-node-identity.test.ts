/**
 * HostProcessOrchestrator per-node identity tests.
 *
 * A donated node must keep the peer id its host cadre approved across restarts,
 * and needs a durable on-disk home for its node-local stores (`cadre-cli start`
 * opens the file-backed bootstrap-peer / trusted-owner stores only when a
 * protobuf identity key file is configured). The orchestrator therefore writes
 * `<workdir>/identity.key` once per container and passes it as
 * `--identity-protobuf`.
 *
 * A fake CLI records the `--identity-protobuf` argument it was launched with, so
 * the spawn wiring is observable without a real cadre node.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { HostProcessOrchestrator, OWNER_CONTAINER_ID } from '../orchestrator/host-process-orchestrator.js';
import { loadIdentity } from '../installer/identity.js';

// Writes the --identity-protobuf argument (as seen on its own command line) next
// to the startup token, then behaves like a minimal long-lived node.
const FAKE_CLI = `
import fs from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
const get = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
const tokenPath = get('--startup-token-file');
const token = process.env.CADRE_STARTUP_TOKEN ?? '';
if (tokenPath) {
  const dir = path.dirname(tokenPath);
  try { fs.writeFileSync(path.join(dir, 'identity-arg.txt'), get('--identity-protobuf') ?? '', 'utf8'); } catch (e) { console.error(e); }
  if (token) { try { fs.writeFileSync(tokenPath, token, 'utf8'); } catch (e) { console.error(e); } }
}
process.on('SIGTERM', () => process.exit(0));
setInterval(() => {}, 1 << 30);
`;

let tmpRoot: string;
let scriptPath: string;
const orchestrators: HostProcessOrchestrator[] = [];

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'cadre-host-nodeid-'));
  scriptPath = join(tmpRoot, 'fake-cli.mjs');
  writeFileSync(scriptPath, FAKE_CLI, 'utf8');
});

afterEach(async () => {
  for (const orch of orchestrators) {
    for (const n of orch.listNodes()) {
      try { await orch.removeContainer(n.dockerId); } catch { /* ignore */ }
    }
  }
  orchestrators.length = 0;
  await sleep(50);
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

function makeOrchestrator(
  rootDir: string,
  portRange: { start: number; end: number } = { start: 17500, end: 17999 },
): HostProcessOrchestrator {
  mkdirSync(rootDir, { recursive: true });
  const orch = new HostProcessOrchestrator({
    rootDir,
    portRange,
    stopTimeoutMs: 1500,
    spawn: { entrypoint: scriptPath },
  });
  orchestrators.push(orch);
  return orch;
}

async function waitForFile(path: string, timeoutMs = 5000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return readFileSync(path, 'utf8');
    await sleep(50);
  }
  throw new Error(`file never appeared: ${path}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

describe('HostProcessOrchestrator node identity', () => {
  it('passes --identity-protobuf pointing at a real key inside the node workdir', async () => {
    const rootDir = join(tmpRoot, 'a');
    const orch = makeOrchestrator(rootDir);
    await orch.init();

    await orch.createContainer({
      containerId: 'donated-1',
      partyId: 'foreign-P',
      bootstrapNodes: [],
      profile: 'storage',
      pinnedOwnerKeys: ['key-a'],
    });

    const workdir = join(rootDir, 'donated-1');
    const arg = await waitForFile(join(workdir, 'identity-arg.txt'));
    expect(arg).toBe(join(workdir, 'identity.key'));
    // Decodes as a libp2p protobuf private key → the child gets a usable identity.
    expect(loadIdentity(arg).peerId).toMatch(/^12D3Koo/);
  });

  it('reuses the same identity when the same containerId is spawned again', async () => {
    const rootDir = join(tmpRoot, 'b');
    const orch = makeOrchestrator(rootDir);
    await orch.init();

    const first = await orch.createContainer({
      containerId: 'donated-2',
      partyId: 'foreign-P',
      bootstrapNodes: [],
      profile: 'storage',
      pinnedOwnerKeys: ['key-a'],
    });
    const workdir = join(rootDir, 'donated-2');
    await waitForFile(join(workdir, 'identity-arg.txt'));
    const before = loadIdentity(join(workdir, 'identity.key')).peerId;

    // Stop (not remove — removal deletes the workdir) and re-spawn, as a restart
    // of a live loan would.
    await orch.stopContainer(first.dockerId);
    await orch.createContainer({
      containerId: 'donated-2',
      partyId: 'foreign-P',
      bootstrapNodes: [],
      profile: 'storage',
      pinnedOwnerKeys: ['key-a'],
    });

    const after = loadIdentity(join(workdir, 'identity.key')).peerId;
    expect(after).toBe(before);
  });

  it('destroys the identity with the workdir when the loan is terminated', async () => {
    const rootDir = join(tmpRoot, 'c');
    const orch = makeOrchestrator(rootDir);
    await orch.init();

    const created = await orch.createContainer({
      containerId: 'donated-3',
      partyId: 'foreign-P',
      bootstrapNodes: [],
      profile: 'storage',
      pinnedOwnerKeys: ['key-a'],
    });
    const identityPath = join(rootDir, 'donated-3', 'identity.key');
    await waitForFile(identityPath);

    await orch.removeContainer(created.dockerId);
    expect(existsSync(identityPath)).toBe(false);
    expect(existsSync(join(rootDir, 'donated-3'))).toBe(false);
  });

  // The failure the identity step can actually produce is a damaged key file,
  // and `DonationService.provision` turns every such throw into an `error`
  // record and lets the grantee retry. If the spawn path reserved its ports
  // before the step that throws, each retry would burn four more ports out of a
  // bounded range until provisioning stopped working altogether.
  it('reserves no ports when the identity step fails', async () => {
    const rootDir = join(tmpRoot, 'd');
    // Exactly one node's worth of ports (health, metrics, p2p, admin).
    const orch = makeOrchestrator(rootDir, { start: 18100, end: 18103 });
    await orch.init();

    mkdirSync(join(rootDir, 'donated-bad'), { recursive: true });
    writeFileSync(join(rootDir, 'donated-bad', 'identity.key'), 'not a protobuf private key', 'utf8');

    const request = {
      partyId: 'foreign-P',
      bootstrapNodes: [],
      profile: 'storage' as const,
      pinnedOwnerKeys: ['key-a'],
    };
    await expect(orch.createContainer({ ...request, containerId: 'donated-bad' })).rejects.toThrow();

    // The whole range is still free, so a healthy container still gets its four.
    const ok = await orch.createContainer({ ...request, containerId: 'donated-good' });
    expect(ok.p2pPort).toBeGreaterThanOrEqual(18100);
  });

  // The owner node carries the HOST's installer identity from <dataDir>, not a
  // per-workdir key — a second key in its workdir would mean the host's own
  // cadre node quietly changed peer id.
  it('leaves the owner node on its own installer identity', async () => {
    const rootDir = join(tmpRoot, 'e');
    const orch = makeOrchestrator(rootDir);
    await orch.init();

    const hostIdentity = join(tmpRoot, 'host-identity.key');
    await orch.ensureOwnerNode({ identityPath: hostIdentity, partyId: 'host-P', libp2pPort: 4101 });

    const ownerWorkdir = join(rootDir, OWNER_CONTAINER_ID);
    expect(await waitForFile(join(ownerWorkdir, 'identity-arg.txt'))).toBe(hostIdentity);
    expect(existsSync(join(ownerWorkdir, 'identity.key'))).toBe(false);
  });
});
