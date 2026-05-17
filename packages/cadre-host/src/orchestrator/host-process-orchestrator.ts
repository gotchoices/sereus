import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import {
  existsSync,
  readFileSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  statSync,
  openSync,
  readSync,
  closeSync,
} from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';
import debug from 'debug';
import pidusage from 'pidusage';
import type {
  Orchestrator,
  OrchestratorCreateRequest,
  OrchestratorCreateResult,
  OrchestratorStats,
} from '@serfab/cadre-provider';

import { defaultLogPath, rotateOnDisk } from './log-rotator.js';
import { PortAllocator } from './port-allocator.js';
import { StateStore, type PersistedHandle, type PersistedState } from './state-store.js';
import { isPidAlive } from './pid-liveness.js';
import {
  decodeDockerId,
  encodeDockerId,
  type Handle,
  type HostProcessConfig,
} from './types.js';

const log = debug('cadre:host:orchestrator');

const DEFAULTS = {
  portRangeStart: 10000,
  portRangeEnd: 20000,
  stopTimeoutMs: 10000,
  logMaxBytes: 10 * 1024 * 1024,
  logMaxFiles: 5,
};

const STARTUP_TOKEN_FILE = '.startup-token';
const CONFIG_FILE = 'cadre.json';
const LIVENESS_POLL_MS = 100;

/**
 * Runs cadre nodes as plain Node child processes on the host.
 *
 * Each container gets its own workdir under `rootDir`. Handles are mirrored
 * to `<rootDir>/state.json` so cadre-host can re-attach after a restart.
 *
 * ## Child stdio: direct-fd inheritance
 *
 * Spawned children inherit a file descriptor opened on `<workdir>/node.log`
 * directly as their stdout and stderr. The orchestrator closes its own copy
 * of the fd immediately after spawn, so the child's write path no longer
 * touches any handle owned by this process. This is what lets children
 * survive — and keep logging through — an orchestrator restart. Were the
 * orchestrator instead piping stdout/stderr through an in-process Writable,
 * a parent exit would deliver SIGPIPE to the child (POSIX) or fail its
 * writes with EPIPE (Windows), silently breaking the documented "init()
 * re-attach" flow.
 *
 * ## Log rotation: spawn-time only
 *
 * Because the child holds a stable fd open against the inode, the
 * orchestrator cannot safely rename `node.log` while the child is running.
 * Rotation therefore happens only at spawn time, when no live child is
 * attached to the workdir (`createContainer` is the single producer per
 * workdir). If `node.log` already exceeds `logMaxBytes`, the rotation
 * cascade runs against the on-disk paths before the fresh fd is opened.
 * A child whose log grows past `logMaxBytes` mid-run will keep appending
 * to the active file until it (or its successor) is restarted; v1 traffic
 * is low enough that this is acceptable.
 */
export class HostProcessOrchestrator implements Orchestrator {
  private readonly rootDir: string;
  private readonly portAllocator: PortAllocator;
  private readonly stateStore: StateStore;
  private readonly stopTimeoutMs: number;
  private readonly logMaxBytes: number;
  private readonly logMaxFiles: number;
  private readonly defaultMemoryLimit?: string;
  private readonly handles = new Map<string, Handle>();
  private readonly cliEntrypoint: string;

  constructor(private readonly cfg: HostProcessConfig) {
    this.rootDir = resolvePath(cfg.rootDir);
    mkdirSync(this.rootDir, { recursive: true });
    this.portAllocator = new PortAllocator(
      cfg.portRange?.start ?? DEFAULTS.portRangeStart,
      cfg.portRange?.end ?? DEFAULTS.portRangeEnd,
    );
    this.stateStore = new StateStore(this.rootDir);
    this.stopTimeoutMs = cfg.stopTimeoutMs ?? DEFAULTS.stopTimeoutMs;
    this.logMaxBytes = cfg.logMaxBytes ?? DEFAULTS.logMaxBytes;
    this.logMaxFiles = cfg.logMaxFiles ?? DEFAULTS.logMaxFiles;
    this.defaultMemoryLimit = cfg.defaultResources?.memoryLimit;
    this.cliEntrypoint = cfg.spawn?.entrypoint ?? resolveCadreCliBin();
    log('HostProcessOrchestrator rootDir=%s cli=%s', this.rootDir, this.cliEntrypoint);
  }

  /**
   * Read persisted state and re-attach to surviving children. Not part of
   * `Orchestrator` — call once before handing the instance to a container
   * service.
   */
  async init(): Promise<void> {
    const state = this.stateStore.load();
    for (const persisted of state.handles) {
      const alive = isPidAlive(persisted.pid) && tokenMatches(persisted.workdir, persisted.startupToken);
      const handle: Handle = {
        containerId: persisted.containerId,
        dockerId: persisted.dockerId,
        pid: persisted.pid,
        startupToken: persisted.startupToken,
        workdir: persisted.workdir,
        ports: persisted.ports,
        spawnedAt: persisted.spawnedAt,
        partyId: persisted.partyId,
        profile: persisted.profile,
        alive,
      };
      this.handles.set(handle.dockerId, handle);
      // Always reserve ports — even for dead handles, until the caller cleans them up
      this.portAllocator.markUsed(persisted.ports.health);
      this.portAllocator.markUsed(persisted.ports.metrics);
      this.portAllocator.markUsed(persisted.ports.p2p);
    }
    log('init: re-attached %d handles', state.handles.length);
  }

  /** Handles that init() found dead (PID gone or token mismatch). */
  listDeadHandles(): PersistedHandle[] {
    const dead: PersistedHandle[] = [];
    for (const h of this.handles.values()) {
      if (!h.alive) {
        dead.push(this.toPersisted(h));
      }
    }
    return dead;
  }

  async createContainer(request: OrchestratorCreateRequest): Promise<OrchestratorCreateResult> {
    const healthPort = this.portAllocator.allocate();
    const metricsPort = this.portAllocator.allocate();
    const p2pPort = this.portAllocator.allocate();

    const workdir = join(this.rootDir, request.containerId);
    mkdirSync(workdir, { recursive: true });
    mkdirSync(join(workdir, 'storage'), { recursive: true });

    const token = randomBytes(16).toString('hex');
    const tokenPath = join(workdir, STARTUP_TOKEN_FILE);
    // Ensure stale token from a previous container with the same id is cleared.
    if (existsSync(tokenPath)) {
      try { rmSync(tokenPath); } catch { /* ignore */ }
    }

    const configPath = join(workdir, CONFIG_FILE);
    writeFileSync(
      configPath,
      JSON.stringify(this.buildChildConfig(request, workdir), null, 2),
      'utf8',
    );

    const memoryLimit = request.resources?.memoryLimit ?? this.defaultMemoryLimit;
    const heapBytes = parseMemoryLimit(memoryLimit);
    const heapMB = heapBytes !== undefined ? Math.max(64, Math.floor(heapBytes / (1024 * 1024))) : undefined;

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      CADRE_STARTUP_TOKEN: token,
      CADRE_HEALTH_PORT: String(healthPort),
      CADRE_METRICS_PORT: String(metricsPort),
      CADRE_LISTEN_ADDRS: `/ip4/0.0.0.0/tcp/${p2pPort}`,
    };
    if (heapMB !== undefined) {
      env.NODE_OPTIONS = `${process.env.NODE_OPTIONS ?? ''} --max-old-space-size=${heapMB}`.trim();
    }

    // Rotate the on-disk log files BEFORE opening the fd — once the child
    // is running it holds the inode open and any later rename would leave
    // it writing to the rotated file. See class docstring.
    const logPath = defaultLogPath(workdir);
    maybeRotateAtSpawn(logPath, this.logMaxBytes, this.logMaxFiles);
    const logFd = openSync(logPath, 'a');

    let child;
    try {
      child = spawn(
        process.execPath,
        [
          this.cliEntrypoint,
          'start',
          '-c', configPath,
          '--health-port', String(healthPort),
          '--metrics-port', String(metricsPort),
          '--startup-token-file', tokenPath,
        ],
        {
          cwd: workdir,
          detached: true,
          // Inherit the log fd directly. OS duplicates it into the child;
          // closing our copy below is safe and severs the parent's only
          // tie to the child's write path.
          stdio: ['ignore', logFd, logFd],
          env,
        },
      );
    } finally {
      // Always release the parent's copy of the fd — whether spawn succeeded
      // or threw. The child (if any) has its own duplicate.
      closeSync(logFd);
    }

    if (!child.pid) {
      // Spawn failed — release reservations and report.
      this.portAllocator.release(healthPort);
      this.portAllocator.release(metricsPort);
      this.portAllocator.release(p2pPort);
      throw new Error(`Failed to spawn child for container ${request.containerId}`);
    }

    child.unref();

    const dockerId = encodeDockerId(child.pid, token);
    const handle: Handle = {
      containerId: request.containerId,
      dockerId,
      pid: child.pid,
      startupToken: token,
      workdir,
      ports: { health: healthPort, metrics: metricsPort, p2p: p2pPort },
      spawnedAt: new Date().toISOString(),
      partyId: request.partyId,
      profile: request.profile,
      child,
      alive: true,
    };

    child.once('exit', () => {
      const h = this.handles.get(dockerId);
      if (h) {
        h.alive = false;
      }
    });

    this.handles.set(dockerId, handle);
    this.persist();

    log('created container %s -> pid %d ports=%j', request.containerId, child.pid, handle.ports);

    return {
      dockerId,
      healthEndpoint: `http://localhost:${healthPort}/health`,
      metricsEndpoint: `http://localhost:${metricsPort}/metrics`,
      p2pPort,
    };
  }

  async stopContainer(dockerId: string): Promise<void> {
    const handle = this.requireHandle(dockerId);
    if (!isPidAlive(handle.pid)) {
      handle.alive = false;
      this.persist();
      return;
    }

    // Capture the exit event before we send signals so we can await full
    // teardown — important on Windows where cwd handles release lazily.
    const exitPromise = handle.child
      ? new Promise<void>((resolve) => handle.child!.once('exit', () => resolve()))
      : Promise.resolve();

    log('SIGTERM container %s (pid=%d)', handle.containerId, handle.pid);
    try {
      process.kill(handle.pid, 'SIGTERM');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ESRCH') {
        throw err;
      }
    }

    const deadline = Date.now() + this.stopTimeoutMs;
    while (Date.now() < deadline) {
      if (!isPidAlive(handle.pid)) break;
      await sleep(LIVENESS_POLL_MS);
    }

    if (isPidAlive(handle.pid)) {
      log('SIGKILL container %s (pid=%d)', handle.containerId, handle.pid);
      try {
        process.kill(handle.pid, 'SIGKILL');
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== 'ESRCH') {
          throw err;
        }
      }
      const killDeadline = Date.now() + 2000;
      while (Date.now() < killDeadline && isPidAlive(handle.pid)) {
        await sleep(LIVENESS_POLL_MS);
      }
    }

    // Wait briefly for the OS to fully tear down the child (Windows cwd lock).
    await Promise.race([exitPromise, sleep(1000)]);

    handle.alive = false;
    this.persist();
  }

  async removeContainer(dockerId: string): Promise<void> {
    const handle = this.requireHandle(dockerId);
    if (isPidAlive(handle.pid)) {
      await this.stopContainer(dockerId);
    }

    this.portAllocator.release(handle.ports.health);
    this.portAllocator.release(handle.ports.metrics);
    this.portAllocator.release(handle.ports.p2p);

    // On Windows the OS releases the child's cwd handle asynchronously, so
    // retry rmSync to give the kernel a chance to drop it.
    try {
      rmSync(handle.workdir, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
    } catch (err) {
      log('failed to remove workdir %s: %o', handle.workdir, err);
    }

    this.handles.delete(dockerId);
    this.persist();
  }

  async isRunning(dockerId: string): Promise<boolean> {
    let handle: Handle | undefined = this.handles.get(dockerId);
    let pid: number;
    let token: string;
    let workdir: string | undefined;

    if (handle) {
      pid = handle.pid;
      token = handle.startupToken;
      workdir = handle.workdir;
    } else {
      try {
        const decoded = decodeDockerId(dockerId);
        pid = decoded.pid;
        token = decoded.token;
      } catch {
        return false;
      }
    }

    if (!isPidAlive(pid)) {
      if (handle) handle.alive = false;
      return false;
    }
    if (workdir === undefined) {
      // We have no record — without a workdir we can't verify the token,
      // so we must treat this as unknown rather than running.
      return false;
    }
    return tokenMatches(workdir, token);
  }

  async getStats(dockerId: string): Promise<OrchestratorStats> {
    const handle = this.requireHandle(dockerId);
    if (!isPidAlive(handle.pid)) {
      return { cpuPercent: 0, memoryBytes: 0, networkRxBytes: 0, networkTxBytes: 0 };
    }
    try {
      const usage = await pidusage(handle.pid);
      return {
        cpuPercent: usage.cpu,
        memoryBytes: usage.memory,
        networkRxBytes: 0,
        networkTxBytes: 0,
      };
    } catch (err) {
      log('pidusage failed for %d: %o', handle.pid, err);
      return { cpuPercent: 0, memoryBytes: 0, networkRxBytes: 0, networkTxBytes: 0 };
    }
  }

  async getLogs(dockerId: string, tail = 100): Promise<string> {
    const handle = this.requireHandle(dockerId);
    const logPath = defaultLogPath(handle.workdir);
    return tailFile(logPath, tail);
  }

  private requireHandle(dockerId: string): Handle {
    const handle = this.handles.get(dockerId);
    if (!handle) {
      throw new Error(`Container not found: ${dockerId}`);
    }
    return handle;
  }

  private buildChildConfig(req: OrchestratorCreateRequest, workdir: string): Record<string, unknown> {
    const cfg: Record<string, unknown> = {
      controlNetwork: {
        partyId: req.partyId,
        bootstrapNodes: req.bootstrapNodes,
      },
      profile: req.profile,
      strandFilter: req.strandFilter ?? 'all',
    };
    if (req.profile === 'storage') {
      const storage: Record<string, unknown> = {
        type: 'file',
        path: join(workdir, 'storage'),
      };
      if (req.resources?.storageQuotaBytes !== undefined) {
        storage.quotaBytes = req.resources.storageQuotaBytes;
      }
      cfg.storage = storage;
    }
    return cfg;
  }

  private persist(): void {
    const state: PersistedState = {
      version: 1,
      handles: [...this.handles.values()].map((h) => this.toPersisted(h)),
    };
    this.stateStore.save(state);
  }

  private toPersisted(h: Handle): PersistedHandle {
    return {
      containerId: h.containerId,
      dockerId: h.dockerId,
      pid: h.pid,
      startupToken: h.startupToken,
      workdir: h.workdir,
      ports: h.ports,
      spawnedAt: h.spawnedAt,
      partyId: h.partyId,
      profile: h.profile,
    };
  }
}

/**
 * Locate the cadre-cli bin via the consumer-style module resolver. Works for
 * both yarn-managed workspaces and traditional npm installs.
 */
function resolveCadreCliBin(): string {
  const req = createRequire(import.meta.url);
  try {
    return req.resolve('@serfab/cadre-cli/bin/cadre.js');
  } catch (err) {
    throw new Error(
      `Unable to resolve @serfab/cadre-cli bin from cadre-host. ` +
      `Ensure cadre-cli is built (yarn workspace @serfab/cadre-cli build) ` +
      `and listed as a dependency. Underlying error: ${(err as Error).message}`,
    );
  }
}

function tokenMatches(workdir: string, expected: string): boolean {
  const tokenPath = join(workdir, STARTUP_TOKEN_FILE);
  try {
    const contents = readFileSync(tokenPath, 'utf8').trim();
    return contents === expected;
  } catch {
    return false;
  }
}

/**
 * Rotate the on-disk log files for a workdir if the active file is already
 * at or above the byte threshold. Called from `createContainer` before the
 * child's stdio fd is opened — the only safe rotation point because the
 * caller guarantees no live child is attached to this workdir.
 */
function maybeRotateAtSpawn(logPath: string, maxBytes: number, maxFiles: number): void {
  if (maxBytes <= 0 || maxFiles < 1) return;
  let size = 0;
  try {
    size = statSync(logPath).size;
  } catch {
    return;
  }
  if (size >= maxBytes) {
    rotateOnDisk(logPath, maxFiles);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => {
    const t = setTimeout(res, ms);
    if (typeof t.unref === 'function') t.unref();
  });
}

/**
 * Read the last `n` lines from a log file. Reads from the tail in chunks
 * rather than slurping the whole file.
 */
function tailFile(path: string, n: number): string {
  if (!existsSync(path)) return '';
  const fd = openSync(path, 'r');
  try {
    const size = statSync(path).size;
    const chunkSize = 8192;
    let pos = size;
    const buffers: Buffer[] = [];
    let newlineCount = 0;
    while (pos > 0 && newlineCount <= n) {
      const readLen = Math.min(chunkSize, pos);
      pos -= readLen;
      const buf = Buffer.alloc(readLen);
      readSync(fd, buf, 0, readLen, pos);
      buffers.unshift(buf);
      for (let i = 0; i < buf.length; i++) {
        if (buf[i] === 0x0a) newlineCount++;
      }
    }
    const joined = Buffer.concat(buffers).toString('utf8');
    const lines = joined.split('\n');
    // Drop any trailing empty line from a terminating newline before counting.
    const trimmed = lines[lines.length - 1] === '' ? lines.slice(0, -1) : lines;
    return trimmed.slice(-n).join('\n');
  } finally {
    closeSync(fd);
  }
}

function parseMemoryLimit(limit?: string): number | undefined {
  if (!limit) return undefined;
  const match = limit.match(/^(\d+(?:\.\d+)?)\s*(B|K|M|G|T)?$/i);
  if (!match) return undefined;
  const [, num, unit] = match;
  const multipliers: Record<string, number> = { B: 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 };
  return Math.floor(parseFloat(num!) * (multipliers[unit?.toUpperCase() ?? 'B'] ?? 1));
}

