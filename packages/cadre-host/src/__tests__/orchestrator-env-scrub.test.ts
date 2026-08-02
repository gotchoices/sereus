/**
 * HostProcessOrchestrator env-scrub test — the manager's own `process.env` must
 * not leak `CADRE_*` config-override vars into spawned children.
 *
 * `launchChild` used to build each child's environment as
 * `{ ...process.env, ...extraEnv, <fixed per-child vars> }`, so ANY `CADRE_*`
 * var set on the manager (not just the ones the orchestrator deliberately
 * sets) reached every child. Because `@serfab/cadre-cli` treats an inherited
 * `CADRE_*` var as a config override that beats the per-child config file, a
 * `CADRE_PARTY_ID` set on the manager could silently pull every child into
 * that party.
 *
 * A fake CLI records the vars under test from its environment to a file so
 * the scrub is observable without a real cadre node.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { HostProcessOrchestrator } from '../orchestrator/host-process-orchestrator.js';

// Writes the vars under test (as seen in the child env) next to the startup token.
const FAKE_CLI = `
import fs from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
const get = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
const tokenPath = get('--startup-token-file');
const token = process.env.CADRE_STARTUP_TOKEN ?? '';
if (tokenPath) {
  const dir = path.dirname(tokenPath);
  const record = {
    CADRE_PARTY_ID: process.env.CADRE_PARTY_ID ?? null,
    CADRE_STORAGE_PATH: process.env.CADRE_STORAGE_PATH ?? null,
    CADRE_ADMIN_PORT: process.env.CADRE_ADMIN_PORT ?? null,
    DEBUG: process.env.DEBUG ?? null,
  };
  try { fs.writeFileSync(path.join(dir, 'env-seen.json'), JSON.stringify(record), 'utf8'); } catch (e) { console.error(e); }
  if (token) { try { fs.writeFileSync(tokenPath, token, 'utf8'); } catch (e) { console.error(e); } }
}
process.on('SIGTERM', () => process.exit(0));
setInterval(() => {}, 1 << 30);
`;

let tmpRoot: string;
let scriptPath: string;
const orchestrators: HostProcessOrchestrator[] = [];
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'cadre-host-env-scrub-'));
  scriptPath = join(tmpRoot, 'fake-cli.mjs');
  writeFileSync(scriptPath, FAKE_CLI, 'utf8');
  savedEnv = {
    CADRE_PARTY_ID: process.env.CADRE_PARTY_ID,
    CADRE_STORAGE_PATH: process.env.CADRE_STORAGE_PATH,
    CADRE_ADMIN_PORT: process.env.CADRE_ADMIN_PORT,
    DEBUG: process.env.DEBUG,
  };
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
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function makeOrchestrator(rootDir: string): HostProcessOrchestrator {
  mkdirSync(rootDir, { recursive: true });
  const orch = new HostProcessOrchestrator({
    rootDir,
    portRange: { start: 18000, end: 18499 },
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

describe('HostProcessOrchestrator child env scrub', () => {
  it('does not leak manager CADRE_* config-override vars into children, but passes through non-CADRE vars', async () => {
    process.env.CADRE_PARTY_ID = 'conflicting-party';
    process.env.CADRE_STORAGE_PATH = '/tmp/should-not-leak';
    // Not an ENV_MAPPINGS config override — read directly by the cli's `start`
    // command — so it only stays scrubbed if the scrub is prefix-wide.
    process.env.CADRE_ADMIN_PORT = '19999';
    process.env.DEBUG = 'some:value';

    const rootDir = join(tmpRoot, 'a');
    const orch = makeOrchestrator(rootDir);
    await orch.init();

    await orch.createContainer({
      containerId: 'child-1',
      partyId: 'party-1',
      bootstrapNodes: [],
      profile: 'storage',
    });
    await orch.createContainer({
      containerId: 'child-2',
      partyId: 'party-2',
      bootstrapNodes: [],
      profile: 'storage',
    });

    const seen1 = JSON.parse(await waitForFile(join(rootDir, 'child-1', 'env-seen.json')));
    const seen2 = JSON.parse(await waitForFile(join(rootDir, 'child-2', 'env-seen.json')));

    for (const seen of [seen1, seen2]) {
      expect(seen.CADRE_PARTY_ID).toBeNull();
      expect(seen.CADRE_STORAGE_PATH).toBeNull();
      expect(seen.CADRE_ADMIN_PORT).toBeNull();
      expect(seen.DEBUG).toBe('some:value');
    }
  });
});
