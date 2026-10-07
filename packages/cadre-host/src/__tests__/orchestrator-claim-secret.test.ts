/**
 * HostProcessOrchestrator claim-secret test — the one piece of a hosted node's
 * spawn that is secret.
 *
 * A node started waiting to be claimed takes its secret from `CADRE_CLAIM_SECRET`
 * (`cadre-cli start`). The orchestrator must hand it to the child through the
 * environment and nowhere else: not as an argument (the process list shows
 * those) and not in `state.json` (which outlives the child and is readable by
 * anything on the machine). A fake CLI records its environment and arguments to a
 * file so both are observable without a real cadre node.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { HostProcessOrchestrator } from '../orchestrator/host-process-orchestrator.js';
import { removeAllNodes } from './orchestrator-teardown.js';

// Writes CADRE_CLAIM_SECRET (as seen in the child env) and the argv next to the
// startup token, then behaves like a minimal long-lived node.
const FAKE_CLI = `
import fs from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
const get = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
const tokenPath = get('--startup-token-file');
const token = process.env.CADRE_STARTUP_TOKEN ?? '';
if (tokenPath) {
  const dir = path.dirname(tokenPath);
  const record = { secret: process.env.CADRE_CLAIM_SECRET ?? null, args };
  const seenPath = path.join(dir, 'spawn-seen.json');
  try { fs.writeFileSync(seenPath + '.tmp', JSON.stringify(record), 'utf8'); fs.renameSync(seenPath + '.tmp', seenPath); } catch (e) { console.error(e); }
  if (token) { try { fs.writeFileSync(tokenPath, token, 'utf8'); } catch (e) { console.error(e); } }
}
process.on('SIGTERM', () => process.exit(0));
setInterval(() => {}, 1 << 30);
`;

const SECRET = 'claim-secret-' + 'x'.repeat(30);

let tmpRoot: string;
let scriptPath: string;
const orchestrators: HostProcessOrchestrator[] = [];

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'cadre-host-claim-'));
  scriptPath = join(tmpRoot, 'fake-cli.mjs');
  writeFileSync(scriptPath, FAKE_CLI, 'utf8');
});

afterEach(async () => {
  try {
    await removeAllNodes(orchestrators);
  } finally {
    await sleep(50);
    try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  }
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

describe('HostProcessOrchestrator claim secret', () => {
  it('reaches the child as CADRE_CLAIM_SECRET only: not an argument, not state.json', async () => {
    const rootDir = join(tmpRoot, 'a');
    const orch = makeOrchestrator(rootDir);
    await orch.init();

    await orch.createContainer({
      containerId: 'hn_claim',
      partyId: 'unclaimed',
      bootstrapNodes: [],
      profile: 'storage',
      claimSecret: SECRET,
    });

    const seen = JSON.parse(await waitForFile(join(rootDir, 'hn_claim', 'spawn-seen.json'))) as { secret: string | null; args: string[] };
    expect(seen.secret).toBe(SECRET);
    expect(seen.args.join(' ')).not.toContain(SECRET);
    expect(readFileSync(join(rootDir, 'state.json'), 'utf8')).not.toContain(SECRET);

    // No secret, no variable: `cadre-cli start` treats a set-but-empty value as unset,
    // but the child must not even see the name.
    await orch.createContainer({ containerId: 'hn_plain', partyId: 'p', bootstrapNodes: [], profile: 'storage' });
    const plain = JSON.parse(await waitForFile(join(rootDir, 'hn_plain', 'spawn-seen.json'))) as { secret: string | null };
    expect(plain.secret).toBeNull();
  });
});
