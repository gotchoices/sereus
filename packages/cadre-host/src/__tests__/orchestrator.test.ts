/**
 * HostProcessOrchestrator unit tests.
 *
 * These tests spawn a tiny fake child script — NOT the real cadre-cli — so
 * they stay fast and don't require cadre-cli to be built. The orchestrator
 * exposes a `spawn.entrypoint` override for exactly this purpose.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { HostProcessOrchestrator } from '../orchestrator/host-process-orchestrator.js';
import { PortAllocator } from '../orchestrator/port-allocator.js';
import { rotateOnDisk } from '../orchestrator/log-rotator.js';
import { decodeDockerId, encodeDockerId } from '../orchestrator/types.js';
import { StateStore } from '../orchestrator/state-store.js';
import { isPidAlive } from '../orchestrator/pid-liveness.js';
import { loadIdentity } from '../installer/identity.js';

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

describe('HostProcessOrchestrator re-spawn of the same containerId', () => {
  // The donated-node respawn path calls createContainer again with the id of a
  // container the host still holds a (now dead) handle for. Handles are keyed by
  // the per-spawn dockerId, so without an explicit drop the old one would linger
  // forever and its four ports would never come back.
  it('drops the stale handle, releases its ports, and keeps the identity', async () => {
    const orch = makeOrchestrator();
    const rootDir = (orch as unknown as { rootDir: string }).rootDir;

    const first = await orch.createContainer(makeRequest('c1'));
    await waitFor(() => orch.isRunning(first.dockerId));
    const identityPath = join(rootDir, 'c1', 'identity.key');
    const peerBefore = loadIdentity(identityPath).peerId;

    // Kill the child the way a crash would — the handle survives, still marked
    // alive until something notices.
    const { pid: firstPid } = decodeDockerId(first.dockerId);
    process.kill(firstPid, 'SIGKILL');
    await waitFor(() => !isPidAlive(firstPid));

    const second = await orch.createContainer(makeRequest('c1'));

    // Exactly one handle for c1, and it is the new spawn.
    const handles = new StateStore(rootDir).load().handles.filter((h) => h.containerId === 'c1');
    expect(handles).toHaveLength(1);
    expect(handles[0]!.dockerId).toBe(second.dockerId);

    // The allocator hands back the lowest free port, so re-using the first
    // spawn's exact ports is what proves they were released.
    expect(second.p2pPort).toBe(first.p2pPort);
    expect(second.healthEndpoint).toBe(first.healthEndpoint);

    // Same workdir, same key → same peer id. This is what makes a respawn the
    // same node rather than a new one the borrower's cadre has never approved.
    expect(loadIdentity(identityPath).peerId).toBe(peerBefore);
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

/**
 * `getStats` goes through `pidusage`, which on Windows shells out: modern
 * builds no longer ship `wmic`, so it falls back to spawning `powershell.exe`
 * to run `gwmi win32_process` — and the first sample for a fresh pid costs
 * *two* such spawns, because CPU percent needs a prior baseline. Measured
 * ~2.8 s idle and ~4.9 s on a loaded machine, so the 5 s default test timeout
 * is not a real budget for this one. Give it explicit headroom.
 */
const STATS_TIMEOUT_MS = 30_000;

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
  }, STATS_TIMEOUT_MS);
});

describe('HostProcessOrchestrator log rotation at spawn', () => {
  it('rotates an oversized node.log before the new child opens it', async () => {
    const rootDir = join(tmpRoot, 'rot');
    mkdirSync(rootDir, { recursive: true });
    const containerWorkdir = join(rootDir, 'rotc1');
    mkdirSync(containerWorkdir, { recursive: true });
    // Pre-seed an oversized active log so maybeRotateAtSpawn fires.
    const seed = 'X'.repeat(2048);
    writeFileSync(join(containerWorkdir, 'node.log'), seed, 'utf8');

    const orch = makeOrchestrator({
      rootDir,
      logMaxBytes: 1024,
      logMaxFiles: 3,
    });
    const { dockerId } = await orch.createContainer(makeRequest('rotc1'));
    await waitFor(() => orch.isRunning(dockerId));

    // The rotation cascade should have moved the seeded contents to .1
    // and the fresh child should be writing to a brand-new node.log.
    expect(readFileSync(join(containerWorkdir, 'node.log.1'), 'utf8')).toBe(seed);
    expect(statSync(join(containerWorkdir, 'node.log')).size).toBeLessThan(seed.length);
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

describe('rotateOnDisk', () => {
  it('cascades base -> .1 -> ... and caps at maxFiles', async () => {
    const fs = await import('node:fs');
    const dir = join(tmpRoot, 'logs');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'node.log');

    // Seed: base + .1 + .2 + .3 each with distinguishable content.
    writeFileSync(path, 'base', 'utf8');
    writeFileSync(`${path}.1`, 'one', 'utf8');
    writeFileSync(`${path}.2`, 'two', 'utf8');
    writeFileSync(`${path}.3`, 'three', 'utf8');

    rotateOnDisk(path, 3);

    // Active path is gone (rotated away). .1 has former base, .2 has former
    // .1, .3 has former .2; former .3 is dropped because maxFiles=3.
    expect(fs.existsSync(path)).toBe(false);
    expect(fs.readFileSync(`${path}.1`, 'utf8')).toBe('base');
    expect(fs.readFileSync(`${path}.2`, 'utf8')).toBe('one');
    expect(fs.readFileSync(`${path}.3`, 'utf8')).toBe('two');
    expect(fs.existsSync(`${path}.4`)).toBe(false);
  });

  it('is a no-op when the active file does not exist', () => {
    const dir = join(tmpRoot, 'logs-empty');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'node.log');
    expect(() => rotateOnDisk(path, 3)).not.toThrow();
  });

  it('handles a partial cascade (only base present)', async () => {
    const fs = await import('node:fs');
    const dir = join(tmpRoot, 'logs-partial');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'node.log');
    writeFileSync(path, 'only', 'utf8');

    rotateOnDisk(path, 5);

    expect(fs.existsSync(path)).toBe(false);
    expect(fs.readFileSync(`${path}.1`, 'utf8')).toBe('only');
    expect(fs.existsSync(`${path}.2`)).toBe(false);
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

/**
 * The orchestrator must spawn children that survive the spawning process
 * itself exiting. The same-process restart test below does not exercise
 * this — both orchestrators live in the same vitest worker, so the
 * spawning process's pipe-read fds never close. This test genuinely exits
 * the spawning process and asserts that the grandchild (a) stays alive
 * past the parent's death and (b) keeps writing to its log file.
 *
 * Requires `yarn workspace @serfab/cadre-host build` to have been run —
 * the helper script imports the built dist so it can run as a plain Node
 * process without a TS loader.
 */
describe('child survives orchestrator exit', () => {
  const orchestratorDistUrl = (() => {
    const here = dirname(fileURLToPath(import.meta.url));
    const distDir = resolvePath(here, '..', '..', 'dist', 'orchestrator');
    const distPath = join(distDir, 'host-process-orchestrator.js');
    return {
      distPath,
      orchestratorUrl: pathToFileURL(distPath).href,
      logRotatorUrl: pathToFileURL(join(distDir, 'log-rotator.js')).href,
    };
  })();

  it.skipIf(!existsSync(orchestratorDistUrl.distPath))(
    'grandchild stays alive and keeps logging after spawner process exits',
    async () => {
      const { orchestratorUrl, logRotatorUrl } = orchestratorDistUrl;
      const rootDir = join(tmpRoot, 'cross');
      mkdirSync(rootDir, { recursive: true });

      const helperPath = join(tmpRoot, 'spawner.mjs');
      writeFileSync(helperPath, buildSpawnerScript(orchestratorUrl, logRotatorUrl), 'utf8');

      const request = {
        containerId: 'cross1',
        partyId: 'party-cross1',
        bootstrapNodes: ['/ip4/127.0.0.1/tcp/4001'],
        profile: 'transaction',
      };
      const payload = {
        rootDir,
        entrypoint: scriptPath,
        request,
        // Ensure the fake child keeps ticking quickly so logs grow visibly
        // in the ~300 ms observation window.
        childEnv: { CHILD_TICK_MS: '20', CHILD_TICK_PAYLOAD: 'cross-tick' },
      };

      // Run the helper as a normal (non-detached) Node child and wait for
      // it to exit. The orchestrator's grandchild should survive.
      const result = spawnSync(process.execPath, [helperPath, JSON.stringify(payload)], {
        encoding: 'utf8',
        timeout: 15000,
      });
      expect(result.status, `helper exited non-zero: stderr=${result.stderr}`).toBe(0);

      const jsonLine = result.stdout
        .split(/\r?\n/)
        .reverse()
        .find((line) => line.trim().startsWith('{'));
      expect(jsonLine, `helper produced no JSON line: stdout=${result.stdout}`).toBeTruthy();
      const handle = JSON.parse(jsonLine!) as {
        dockerId: string;
        pid: number;
        workdir: string;
        logPath: string;
      };

      try {
        // Immediate liveness
        expect(isPidAlive(handle.pid)).toBe(true);

        // POSIX delivers SIGPIPE on the child's NEXT write — give it time
        // to attempt one (the fake child ticks every 20 ms).
        await sleep(500);
        expect(isPidAlive(handle.pid), 'grandchild died after spawner exit (likely SIGPIPE)').toBe(true);

        // Logs must keep growing — proves stdio still works, not just PID.
        const sizeA = statSync(handle.logPath).size;
        await sleep(300);
        const sizeB = statSync(handle.logPath).size;
        expect(sizeB).toBeGreaterThan(sizeA);
      } finally {
        try { process.kill(handle.pid, 'SIGKILL'); } catch { /* ignore */ }
        try { rmSync(handle.workdir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* ignore */ }
      }
    },
    // The helper spawn alone budgets 15 s; the surrounding waits add ~0.8 s
    // more. Under the 5 s default the test could never reach its own timeout.
    30_000,
  );
});

function buildSpawnerScript(orchestratorUrl: string, logRotatorUrl: string): string {
  return `
import { HostProcessOrchestrator } from ${JSON.stringify(orchestratorUrl)};
import { defaultLogPath } from ${JSON.stringify(logRotatorUrl)};

const payload = JSON.parse(process.argv[2]);
const { rootDir, entrypoint, request, childEnv } = payload;

for (const [k, v] of Object.entries(childEnv ?? {})) {
  process.env[k] = String(v);
}

const orch = new HostProcessOrchestrator({
  rootDir,
  portRange: { start: 19000, end: 19999 },
  stopTimeoutMs: 1500,
  spawn: { entrypoint },
});

const res = await orch.createContainer(request);
const pid = Number(res.dockerId.split(':')[0]);
const workdir = (await import('node:path')).join(rootDir, request.containerId);
const logPath = defaultLogPath(workdir);

process.stdout.write(JSON.stringify({
  dockerId: res.dockerId,
  pid,
  workdir,
  logPath,
}) + '\\n');

// Exit cleanly — the detached/unref'd child should outlive us.
process.exit(0);
`;
}

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
