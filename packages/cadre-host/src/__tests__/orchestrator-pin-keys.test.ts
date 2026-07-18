/**
 * HostProcessOrchestrator pinned-owner-key tests — the load-bearing wiring for
 * the node-donation flow.
 *
 * A donated node joins a FOREIGN cadre and must accept a requester-signed seed,
 * so the orchestrator threads `request.pinnedOwnerKeys` into the child as the
 * comma-separated `CADRE_OWNER_KEYS` env var (which `cadre-cli start` turns into
 * a cold-start pinned-key trust policy). The same signal marks the node as
 * foreign-party, which suppresses the host's own push credentials (meaningless
 * to another cadre's app).
 *
 * A fake CLI records `CADRE_OWNER_KEYS` from its environment to a file so the
 * env threading is observable without a real cadre node.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { PushCredentials } from '@serfab/cadre-core';
import { HostProcessOrchestrator } from '../orchestrator/host-process-orchestrator.js';

// Writes CADRE_OWNER_KEYS (as seen in the child env) next to the startup token,
// then behaves like a minimal long-lived node.
const FAKE_CLI = `
import fs from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
const get = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
const tokenPath = get('--startup-token-file');
const token = process.env.CADRE_STARTUP_TOKEN ?? '';
if (tokenPath) {
  const dir = path.dirname(tokenPath);
  try { fs.writeFileSync(path.join(dir, 'owner-keys.txt'), process.env.CADRE_OWNER_KEYS ?? '', 'utf8'); } catch (e) { console.error(e); }
  if (token) { try { fs.writeFileSync(tokenPath, token, 'utf8'); } catch (e) { console.error(e); } }
}
process.on('SIGTERM', () => process.exit(0));
setInterval(() => {}, 1 << 30);
`;

const FCM = { projectId: 'proj', clientEmail: 'svc@proj.iam', privateKey: 'FCM-SECRET-PEM' };

let tmpRoot: string;
let scriptPath: string;
const orchestrators: HostProcessOrchestrator[] = [];

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'cadre-host-pin-'));
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

function makeOrchestrator(rootDir: string, pushResolver?: () => Promise<PushCredentials | undefined>): HostProcessOrchestrator {
  mkdirSync(rootDir, { recursive: true });
  const orch = new HostProcessOrchestrator({
    rootDir,
    portRange: { start: 18500, end: 18999 },
    stopTimeoutMs: 1500,
    spawn: { entrypoint: scriptPath },
    ...(pushResolver ? { pushResolver } : {}),
  });
  orchestrators.push(orch);
  return orch;
}

function readChildConfig(rootDir: string, containerId: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(rootDir, containerId, 'cadre.json'), 'utf8')) as Record<string, unknown>;
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

describe('HostProcessOrchestrator pinned owner keys', () => {
  it('threads pinnedOwnerKeys into the child as comma-separated CADRE_OWNER_KEYS', async () => {
    const rootDir = join(tmpRoot, 'a');
    const orch = makeOrchestrator(rootDir);
    await orch.init();

    await orch.createContainer({
      containerId: 'donated-1',
      partyId: 'foreign-P',
      bootstrapNodes: [],
      profile: 'storage',
      pinnedOwnerKeys: ['key-a', 'key-b'],
    });

    const keys = await waitForFile(join(rootDir, 'donated-1', 'owner-keys.txt'));
    expect(keys).toBe('key-a,key-b');
  });

  it('suppresses host push for a foreign-party (pinned-key) node even on storage profile', async () => {
    const rootDir = join(tmpRoot, 'b');
    const orch = makeOrchestrator(rootDir, async () => ({ fcm: FCM }));
    await orch.init();

    // Foreign-party donated node: pinned keys present → no host push injected.
    await orch.createContainer({
      containerId: 'donated-2',
      partyId: 'foreign-P',
      bootstrapNodes: [],
      profile: 'storage',
      pinnedOwnerKeys: ['key-a'],
    });
    expect(readChildConfig(rootDir, 'donated-2').push).toBeUndefined();

    // Control: a host-own storage node (no pinned keys) DOES get push.
    await orch.createContainer({
      containerId: 'own-1',
      partyId: 'host-P',
      bootstrapNodes: [],
      profile: 'storage',
    });
    expect(readChildConfig(rootDir, 'own-1').push).toEqual({ fcm: FCM });
  });

  it('omits CADRE_OWNER_KEYS when no pinned keys are supplied', async () => {
    const rootDir = join(tmpRoot, 'c');
    const orch = makeOrchestrator(rootDir);
    await orch.init();

    await orch.createContainer({
      containerId: 'own-2',
      partyId: 'host-P',
      bootstrapNodes: [],
      profile: 'storage',
    });

    const keys = await waitForFile(join(rootDir, 'own-2', 'owner-keys.txt'));
    expect(keys).toBe(''); // env var absent → child reads empty string
  });
});
