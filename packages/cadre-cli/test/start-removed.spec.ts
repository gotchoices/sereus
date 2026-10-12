/**
 * `cadre start` on a node an owner removed from its cadre: the removal marker on record keeps the
 * node from starting, and the health server reports the removal. cadre-core reports a removal only
 * to the process that saw it happen, so this marker check is all that keeps a restarted node from
 * running against a cadre that refuses it.
 *
 * The real bin is spawned, as in `one-shot-node.spec.ts`, so the branch in `start.ts` is the one
 * under test. Both servers are asked for port 0 and the child prints the ports it bound, so this
 * file binds nothing fixed and stays safe to run in parallel with the rest of the suite.
 */

import { describe, it, expect, vi } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { HealthStatus } from '../src/server/health.js';
import { writeRemovalMarker } from '../src/commands/removal-marker.js';

const CLI_ENTRY = fileURLToPath(new URL('../dist/bin/cadre.js', import.meta.url));

/** The child has to load cadre-core before it prints anything; vitest's 5 s default is too tight. */
const TEST_TIMEOUT_MS = 60_000;

const PARTY_ID = 'cli-removed-party';
const SIGNER_KEY = Buffer.alloc(32, 9).toString('base64url');

/** Resolve with the health port once the child prints it; reject if it exits first. */
function healthPortOf(child: ChildProcess, output: { stdout: string; stderr: string }): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    child.stdout?.on('data', () => {
      const match = /Health server on port (\d+)/.exec(output.stdout);
      if (match) resolve(Number(match[1]));
    });
    child.on('close', (code) => {
      reject(new Error(`cadre start exited (${code}) before its health server came up\nstdout: ${output.stdout}\nstderr: ${output.stderr}`));
    });
  });
}

describe('cadre start with a removal marker on record', () => {
  it('starts no node, and /status reports the removal', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cadre-removed-'));
    const configPath = join(dir, 'cadre.json');
    writeFileSync(configPath, JSON.stringify({
      controlNetwork: { partyId: PARTY_ID, bootstrapNodes: [] },
      profile: 'storage',
      network: { listenAddrs: [] },
    }));
    const removal = { partyId: PARTY_ID, stampId: 'stamp-1', signerKey: SIGNER_KEY, at: Date.parse('2026-10-01T00:00:00Z') };
    writeRemovalMarker(dir, removal);

    const child = spawn(process.execPath, [CLI_ENTRY, 'start', '-c', configPath, '--health-port', '0', '--metrics-port', '0'], {
      cwd: dir,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const output = { stdout: '', stderr: '' };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { output.stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { output.stderr += chunk; });

    try {
      const port = await healthPortOf(child, output);
      const status = await (await fetch(`http://127.0.0.1:${port}/status`)).json() as HealthStatus;

      expect(status.status).toBe('unhealthy');
      expect(status.peerId).toBeNull();
      expect(status.node).toMatchObject({
        running: false,
        partyId: PARTY_ID,
        removed: { stampId: 'stamp-1', signerKey: SIGNER_KEY, at: removal.at },
      });
      // stderr is its own pipe, so the warning may land after the port line on stdout.
      await vi.waitFor(() => { expect(output.stderr).toContain(`removed from cadre ${PARTY_ID} by owner ${SIGNER_KEY.slice(0, 8)}`); });
      expect(output.stdout).not.toContain('Connected to control network');
    } finally {
      child.kill();
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* a handle the child held a moment ago; see one-shot-node.spec.ts */ }
    }
  }, TEST_TIMEOUT_MS);
});
