/**
 * HostProcessOrchestrator push-credential injection tests.
 *
 * Verifies the orchestrator writes `config.push` into the spawned node's
 * cadre.json when the pushResolver yields credentials, omits it otherwise,
 * re-resolves on every (re-)spawn, and never persists a raw private key in
 * state.json. Uses a fake CLI entrypoint that just writes its startup token.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { PushCredentials } from '@serfab/cadre-core';
import { HostProcessOrchestrator, OWNER_CONTAINER_ID } from '../orchestrator/host-process-orchestrator.js';

const FAKE_CLI = `
import fs from 'node:fs';
const args = process.argv.slice(2);
const get = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
const tokenPath = get('--startup-token-file');
const token = process.env.CADRE_STARTUP_TOKEN ?? '';
if (tokenPath && token) { try { fs.writeFileSync(tokenPath, token, 'utf8'); } catch (e) { console.error(e); } }
process.on('SIGTERM', () => process.exit(0));
setInterval(() => {}, 1 << 30);
`;

const FCM = { projectId: 'proj', clientEmail: 'svc@proj.iam', privateKey: 'FCM-SECRET-PEM' };
const APNS = { keyId: 'KID', teamId: 'TEAM', bundleId: 'com.example.app', privateKey: 'APNS-SECRET-P8', production: false };
const CFG = { identityPath: 'C:/fake/identity.key', partyId: 'install-id-123', libp2pPort: 4655 };

let tmpRoot: string;
let scriptPath: string;
const orchestrators: HostProcessOrchestrator[] = [];

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'cadre-host-push-'));
  scriptPath = join(tmpRoot, 'fake-cli.mjs');
  writeFileSync(scriptPath, FAKE_CLI, 'utf8');
});

afterEach(async () => {
  for (const orch of orchestrators) {
    try { await orch.stopOwnerNode(); } catch { /* ignore */ }
  }
  orchestrators.length = 0;
  await sleep(50);
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

function makeOrchestrator(rootDir: string, pushResolver?: () => Promise<PushCredentials | undefined>): HostProcessOrchestrator {
  mkdirSync(rootDir, { recursive: true });
  const orch = new HostProcessOrchestrator({
    rootDir,
    portRange: { start: 18000, end: 18499 },
    stopTimeoutMs: 1500,
    spawn: { entrypoint: scriptPath },
    ...(pushResolver ? { pushResolver } : {}),
  });
  orchestrators.push(orch);
  return orch;
}

function readChildConfig(rootDir: string, containerId = OWNER_CONTAINER_ID): Record<string, unknown> {
  const raw = readFileSync(join(rootDir, containerId, 'cadre.json'), 'utf8');
  return JSON.parse(raw) as Record<string, unknown>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

describe('HostProcessOrchestrator push injection', () => {
  it('writes config.push into cadre.json when the resolver yields credentials', async () => {
    const rootDir = join(tmpRoot, 'a');
    const orch = makeOrchestrator(rootDir, async () => ({ fcm: FCM, apns: APNS, cooldownMs: 1000 }));
    await orch.init();
    await orch.ensureOwnerNode(CFG);

    const cfg = readChildConfig(rootDir);
    expect(cfg.push).toEqual({ fcm: FCM, apns: APNS, cooldownMs: 1000 });
  });

  it('omits config.push when no resolver is configured', async () => {
    const rootDir = join(tmpRoot, 'b');
    const orch = makeOrchestrator(rootDir);
    await orch.init();
    await orch.ensureOwnerNode(CFG);

    const cfg = readChildConfig(rootDir);
    expect(cfg.push).toBeUndefined();
  });

  it('omits config.push when the resolver returns undefined (push opt-in)', async () => {
    const rootDir = join(tmpRoot, 'c');
    const orch = makeOrchestrator(rootDir, async () => undefined);
    await orch.init();
    await orch.ensureOwnerNode(CFG);

    expect(readChildConfig(rootDir).push).toBeUndefined();
  });

  it('degrades to no push (does not fail the spawn) when the resolver throws', async () => {
    const rootDir = join(tmpRoot, 'd');
    const orch = makeOrchestrator(rootDir, async () => { throw new Error('partial creds'); });
    await orch.init();
    // Spawn still succeeds.
    const node = await orch.ensureOwnerNode(CFG);
    expect(node.id).toBe(OWNER_CONTAINER_ID);
    expect(readChildConfig(rootDir).push).toBeUndefined();
  });

  it('re-resolves on re-spawn and never persists a raw private key in state.json', async () => {
    const rootDir = join(tmpRoot, 'e');
    let current: PushCredentials | undefined = { fcm: FCM };
    const orch = makeOrchestrator(rootDir, async () => current);
    await orch.init();
    await orch.ensureOwnerNode(CFG);
    expect(readChildConfig(rootDir).push).toEqual({ fcm: FCM });

    // state.json must not carry the raw key — only re-resolvable references.
    const stateRaw = readFileSync(join(rootDir, 'state.json'), 'utf8');
    expect(stateRaw).not.toContain('FCM-SECRET-PEM');

    // Rotate the resolver's answer, then restart — the new spawn must pick it up.
    current = { apns: APNS };
    await orch.restartOwnerNode();
    const cfg2 = readChildConfig(rootDir);
    expect(cfg2.push).toEqual({ apns: APNS });
    expect((cfg2.push as PushCredentials).fcm).toBeUndefined();
  });

  it('injects push for a storage-profile managed node but not a transaction node', async () => {
    const rootDir = join(tmpRoot, 'f');
    const orch = makeOrchestrator(rootDir, async () => ({ fcm: FCM }));
    await orch.init();

    await orch.createContainer({ containerId: 'storage-1', partyId: 'p', bootstrapNodes: [], profile: 'storage' });
    expect(readChildConfig(rootDir, 'storage-1').push).toEqual({ fcm: FCM });

    await orch.createContainer({ containerId: 'txn-1', partyId: 'p', bootstrapNodes: [], profile: 'transaction' });
    expect(readChildConfig(rootDir, 'txn-1').push).toBeUndefined();
  });
});
