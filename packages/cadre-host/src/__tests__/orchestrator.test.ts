/**
 * HostProcessOrchestrator unit tests.
 *
 * These tests spawn a tiny fake child script — NOT the real cadre-cli — so
 * they stay fast and don't require cadre-cli to be built. The orchestrator
 * exposes a `spawn.entrypoint` override for exactly this purpose.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { HostProcessOrchestrator } from '../orchestrator/host-process-orchestrator.js';
import { PortAllocator } from '../orchestrator/port-allocator.js';
import { LogRotator } from '../orchestrator/log-rotator.js';
import { decodeDockerId, encodeDockerId } from '../orchestrator/types.js';
import { StateStore } from '../orchestrator/state-store.js';
import { isPidAlive } from '../orchestrator/pid-liveness.js';

const FAKE_CHILD = `
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const configIdx = args.indexOf('-c');
const tokenIdx = args.indexOf('--startup-token-file');
const tokenPath = tokenIdx >= 0 ? args[tokenIdx + 1] : null;
const ignoreSigterm = process.env.IGNORE_SIGTERM === '1';
const initialMessage = process.env.CHILD_INITIAL_MESSAGE ?? 'tick';
const tickIntervalMs = parseInt(process.env.CHILD_TICK_MS ?? '50', 10);
const tickPayload = process.env.CHILD_TICK_PAYLOAD ?? 'tick';

if (tokenPath && process.env.CADRE_STARTUP_TOKEN) {
  try {
    fs.writeFileSync(tokenPath, process.env.CADRE_STARTUP_TOKEN, 'utf8');
  } catch (err) {
    console.error('failed to write token:', err);
  }
}

let alive = true;
process.on('SIGTERM', () => {
  if (ignoreSigterm) {
    console.log('ignoring SIGTERM');
    return;
  }
  alive = false;
  console.log('exiting on SIGTERM');
  process.exit(0);
});

console.log(initialMessage);

const interval = setInterval(() => {
  if (alive) {
    process.stdout.write(tickPayload + '\\n');
  } else {
    clearInterval(interval);
  }
}, tickIntervalMs);

setInterval(() => {}, 1 << 30);
`;

let tmpRoot: string;
let scriptPath: string;
const orchestrators: HostProcessOrchestrator[] = [];

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'cadre-host-orch-'));
  scriptPath = join(tmpRoot, 'fake-child.mjs');
  writeFileSync(scriptPath, FAKE_CHILD, 'utf8');
});

afterEach(async () => {
  // Force-kill any leftover children before cleanup.
  for (const orch of orchestrators) {
    for (const dockerId of listDockerIds(orch)) {
      try { await orch.removeContainer(dockerId); } catch { /* ignore */ }
    }
  }
  orchestrators.length = 0;
  await sleep(50);
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

function makeOrchestrator(overrides: Partial<ConstructorParameters<typeof HostProcessOrchestrator>[0]> = {}): HostProcessOrchestrator {
  const rootDir = overrides.rootDir ?? join(tmpRoot, 'orch');
  mkdirSync(rootDir, { recursive: true });
  const orch = new HostProcessOrchestrator({
    rootDir,
    portRange: { start: 18000, end: 18999 },
    stopTimeoutMs: 1500,
    logMaxBytes: overrides.logMaxBytes ?? 10 * 1024 * 1024,
    logMaxFiles: overrides.logMaxFiles ?? 5,
    spawn: { entrypoint: overrides.spawn?.entrypoint ?? scriptPath },
    ...overrides,
  });
  orchestrators.push(orch);
  return orch;
}

function listDockerIds(orch: HostProcessOrchestrator): string[] {
  // Use the state file as the source of truth since handles map is private.
  const state = new StateStore((orch as unknown as { rootDir: string }).rootDir);
  return state.load().handles.map((h) => h.dockerId);
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 3000, intervalMs = 50): Promise<void> {
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

function makeRequest(containerId: string, opts: { profile?: 'storage' | 'transaction' } = {}) {
  return {
    containerId,
    partyId: 'party-' + containerId,
    bootstrapNodes: ['/ip4/127.0.0.1/tcp/4001'],
    profile: opts.profile ?? 'transaction' as 'storage' | 'transaction',
  };
}

describe('HostProcessOrchestrator.createContainer', () => {
  it('spawns a live child and persists handle, ports, and endpoints', async () => {
    const orch = makeOrchestrator();
    const result = await orch.createContainer(makeRequest('c1'));

    // Endpoints derive from allocated ports
    expect(result.healthEndpoint).toMatch(/^http:\/\/localhost:\d+\/health$/);
    expect(result.metricsEndpoint).toMatch(/^http:\/\/localhost:\d+\/metrics$/);
    expect(result.p2pPort).toBeGreaterThanOrEqual(18000);

    const { pid } = decodeDockerId(result.dockerId);
    await waitFor(() => isPidAlive(pid));
    expect(isPidAlive(pid)).toBe(true);

    // Wait until the child has written its startup token file
    await waitFor(() => orch.isRunning(result.dockerId));
    expect(await orch.isRunning(result.dockerId)).toBe(true);

    // Workdir scaffolded
    const workdir = join((orch as unknown as { rootDir: string }).rootDir, 'c1');
    expect(readFileSync(join(workdir, 'cadre.json'), 'utf8')).toContain('party-c1');

    // State persisted
    const persisted = new StateStore((orch as unknown as { rootDir: string }).rootDir).load();
    expect(persisted.handles).toHaveLength(1);
    expect(persisted.handles[0]!.dockerId).toBe(result.dockerId);
  });
});

describe('HostProcessOrchestrator.isRunning', () => {
  it('is true after spawn, false after kill, false on tampered token', async () => {
    const orch = makeOrchestrator();
    const { dockerId } = await orch.createContainer(makeRequest('c1'));
    const { pid } = decodeDockerId(dockerId);

    await waitFor(() => orch.isRunning(dockerId));
    expect(await orch.isRunning(dockerId)).toBe(true);

    // Tamper with the token file
    const workdir = join((orch as unknown as { rootDir: string }).rootDir, 'c1');
    writeFileSync(join(workdir, '.startup-token'), 'tampered', 'utf8');
    expect(await orch.isRunning(dockerId)).toBe(false);

    // Restore token, kill the process
    const persisted = new StateStore((orch as unknown as { rootDir: string }).rootDir).load();
    writeFileSync(join(workdir, '.startup-token'), persisted.handles[0]!.startupToken, 'utf8');
    expect(await orch.isRunning(dockerId)).toBe(true);

    process.kill(pid, 'SIGKILL');
    await waitFor(() => !isPidAlive(pid));
    expect(await orch.isRunning(dockerId)).toBe(false);
  });
});

describe('HostProcessOrchestrator.stopContainer', () => {
  it('SIGTERM stops a cooperative child without needing SIGKILL', async () => {
    const orch = makeOrchestrator();
    const { dockerId } = await orch.createContainer(makeRequest('c1'));
    const { pid } = decodeDockerId(dockerId);

    await waitFor(() => orch.isRunning(dockerId));
    await orch.stopContainer(dockerId);

    expect(isPidAlive(pid)).toBe(false);
    expect(await orch.isRunning(dockerId)).toBe(false);
  });

  // On Windows, process.kill ignores the signal name and always force-kills,
  // so a child cannot ignore SIGTERM at the Node level. Skip there.
  it.skipIf(process.platform === 'win32')(
    'escalates to SIGKILL when the child ignores SIGTERM',
    async () => {
      const orch = makeOrchestrator();
      process.env.IGNORE_SIGTERM = '1';
      let dockerId: string;
      try {
        ({ dockerId } = await orch.createContainer(makeRequest('c2')));
      } finally {
        delete process.env.IGNORE_SIGTERM;
      }
      const { pid } = decodeDockerId(dockerId);
      await waitFor(() => isPidAlive(pid));

      const start = Date.now();
      await orch.stopContainer(dockerId);
      const elapsed = Date.now() - start;

      // Should have waited the full stopTimeoutMs (1500) before SIGKILL.
      expect(elapsed).toBeGreaterThanOrEqual(1000);
      expect(isPidAlive(pid)).toBe(false);
    },
  );
});

describe('HostProcessOrchestrator.removeContainer', () => {
  it('releases ports, deletes workdir, drops state', async () => {
    const orch = makeOrchestrator();
    const { dockerId, healthEndpoint } = await orch.createContainer(makeRequest('c1'));
    const port = Number(healthEndpoint.match(/:(\d+)/)![1]);

    await waitFor(() => orch.isRunning(dockerId));
    await orch.removeContainer(dockerId);

    // Workdir is gone
    const workdir = join((orch as unknown as { rootDir: string }).rootDir, 'c1');
    expect(() => readFileSync(join(workdir, 'cadre.json'), 'utf8')).toThrow();

    // State no longer references it
    const persisted = new StateStore((orch as unknown as { rootDir: string }).rootDir).load();
    expect(persisted.handles).toHaveLength(0);

    // Subsequent getStats rejects
    await expect(orch.getStats(dockerId)).rejects.toThrow(/not found/i);

    // Port was released — reallocate it via a fresh container; pick the next id.
    const next = await orch.createContainer(makeRequest('c2'));
    // (we don't assert the same port — just that allocation works post-release)
    expect(next.healthEndpoint).toMatch(/:\d+\/health/);
    expect(port).toBeGreaterThan(0);
  });
});

describe('HostProcessOrchestrator.getStats', () => {
  it('returns plausible numbers with zero network counters', async () => {
    const orch = makeOrchestrator();
    const { dockerId } = await orch.createContainer(makeRequest('c1'));
    await waitFor(() => orch.isRunning(dockerId));
    // Give the child a moment to use some CPU/mem
    await sleep(200);

    const stats = await orch.getStats(dockerId);
    expect(stats.cpuPercent).toBeGreaterThanOrEqual(0);
    expect(stats.memoryBytes).toBeGreaterThan(0);
    expect(stats.networkRxBytes).toBe(0);
    expect(stats.networkTxBytes).toBe(0);
  });
});

describe('HostProcessOrchestrator.getLogs', () => {
  it('returns recent stdout lines from the child', async () => {
    const orch = makeOrchestrator();
    process.env.CHILD_INITIAL_MESSAGE = 'hello-from-fake';
    let dockerId: string;
    try {
      ({ dockerId } = await orch.createContainer(makeRequest('c1')));
    } finally {
      delete process.env.CHILD_INITIAL_MESSAGE;
    }

    await waitFor(async () => {
      const logs = await orch.getLogs(dockerId, 200);
      return logs.includes('hello-from-fake');
    });

    const logs = await orch.getLogs(dockerId, 200);
    expect(logs).toContain('hello-from-fake');
  });
});

describe('LogRotator', () => {
  it('rotates when threshold exceeded and respects maxFiles', async () => {
    const dir = join(tmpRoot, 'logs');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'node.log');
    const rotator = new LogRotator({ filePath: path, maxBytes: 64, maxFiles: 3 });
    // Each write is 32 bytes => rotates after 2 writes
    const chunk = 'A'.repeat(32);
    for (let i = 0; i < 12; i++) {
      rotator.write(chunk);
    }
    await rotator.close();

    // Should have node.log, node.log.1, node.log.2, node.log.3 — and no .4
    const fs = await import('node:fs');
    expect(fs.existsSync(path)).toBe(true);
    expect(fs.existsSync(`${path}.1`)).toBe(true);
    expect(fs.existsSync(`${path}.4`)).toBe(false);
  });
});

describe('PortAllocator', () => {
  it('allocates sequentially, releases, and reuses', () => {
    const a = new PortAllocator(100, 102);
    expect(a.allocate()).toBe(100);
    expect(a.allocate()).toBe(101);
    expect(a.allocate()).toBe(102);
    expect(() => a.allocate()).toThrow(/No available ports/);
    a.release(101);
    expect(a.allocate()).toBe(101);
  });

  it('markUsed reserves ports without allocating', () => {
    const a = new PortAllocator(100, 102);
    a.markUsed(101);
    expect(a.allocate()).toBe(100);
    expect(a.allocate()).toBe(102);
    expect(() => a.allocate()).toThrow();
  });
});

describe('Restart recovery (init)', () => {
  it('re-attaches to surviving children and reports dead ones', async () => {
    const rootDir = join(tmpRoot, 'restart');
    const a = makeOrchestrator({ rootDir });
    const r1 = await a.createContainer(makeRequest('c1'));
    const r2 = await a.createContainer(makeRequest('c2'));
    await waitFor(() => a.isRunning(r1.dockerId));
    await waitFor(() => a.isRunning(r2.dockerId));

    // Kill c2 externally
    const { pid: pid2 } = decodeDockerId(r2.dockerId);
    process.kill(pid2, 'SIGKILL');
    await waitFor(() => !isPidAlive(pid2));

    // New orchestrator over the same rootDir, init()
    const b = makeOrchestrator({ rootDir });
    await b.init();

    expect(await b.isRunning(r1.dockerId)).toBe(true);
    expect(await b.isRunning(r2.dockerId)).toBe(false);

    const dead = b.listDeadHandles();
    expect(dead.map((d) => d.dockerId)).toContain(r2.dockerId);
    expect(dead.map((d) => d.dockerId)).not.toContain(r1.dockerId);

    // Ports from both should be reserved (no overlapping allocations from `b`)
    // Allocate three more containers via `b` and confirm none collide with
    // c1/c2's existing ports.
    const reservedPorts = new Set([
      r1.p2pPort,
      r2.p2pPort,
      Number(r1.healthEndpoint.match(/:(\d+)/)![1]),
      Number(r1.metricsEndpoint.match(/:(\d+)/)![1]),
      Number(r2.healthEndpoint.match(/:(\d+)/)![1]),
      Number(r2.metricsEndpoint.match(/:(\d+)/)![1]),
    ]);
    const r3 = await b.createContainer(makeRequest('c3'));
    const r3Ports = new Set([
      r3.p2pPort,
      Number(r3.healthEndpoint.match(/:(\d+)/)![1]),
      Number(r3.metricsEndpoint.match(/:(\d+)/)![1]),
    ]);
    for (const p of r3Ports) {
      expect(reservedPorts.has(p)).toBe(false);
    }
  });
});

describe('dockerId encoding', () => {
  it('encode/decode round-trips pid and token', () => {
    const id = encodeDockerId(12345, 'abcdef');
    expect(decodeDockerId(id)).toEqual({ pid: 12345, token: 'abcdef' });
  });

  it('rejects malformed ids', () => {
    expect(() => decodeDockerId('notvalid')).toThrow();
    expect(() => decodeDockerId(':oops')).toThrow();
    expect(() => decodeDockerId('0:tok')).toThrow();
  });
});
