import { spawn, type ChildProcess } from 'node:child_process';
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
import type { PushCredentials } from '@serfab/cadre-core';
import {
  decodeDockerId,
  encodeDockerId,
  type AuthoritySpawnConfig,
  type Handle,
  type HostProcessConfig,
  type ManagedNodeInfo,
  type NodePorts,
  type NodeStateListener,
  type PushCredentialsResolver,
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

/** Fixed friendly id for the admin's authority node. */
export const AUTHORITY_CONTAINER_ID = 'authority';

/** Endpoint + bearer for the authority node's loopback admin channel (6.6). */
export interface AuthorityAdminEndpoint {
  /** e.g. `http://127.0.0.1:<adminPort>`. */
  baseUrl: string;
  /** The child's `CADRE_STARTUP_TOKEN`, used as the admin bearer secret. */
  token: string;
}

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
  /** Resolves push credentials fresh on every spawn (see HostProcessConfig). */
  private readonly pushResolver?: PushCredentialsResolver;
  /** State-change listeners — invoked when a handle's alive state changes. */
  private readonly stateListeners = new Set<NodeStateListener>();
  /** Persisted spawn config for the authority node (re-spawn on demand). */
  private authorityConfig?: AuthoritySpawnConfig;

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
    this.pushResolver = cfg.pushResolver;
    log('HostProcessOrchestrator rootDir=%s cli=%s', this.rootDir, this.cliEntrypoint);
  }

  /**
   * Read persisted state and re-attach to surviving children. Not part of
   * `Orchestrator` — call once before handing the instance to a container
   * service.
   */
  async init(): Promise<void> {
    const state = this.stateStore.load();
    this.authorityConfig = state.authorityConfig;
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
        ...(persisted.authority ? { authority: true } : {}),
        alive,
      };
      this.handles.set(handle.dockerId, handle);
      // Always reserve ports — even for dead handles, until the caller cleans them up
      this.portAllocator.markUsed(persisted.ports.health);
      this.portAllocator.markUsed(persisted.ports.metrics);
      this.portAllocator.markUsed(persisted.ports.p2p);
      // `admin` is absent on handles persisted before this build.
      if (typeof persisted.ports.admin === 'number') {
        this.portAllocator.markUsed(persisted.ports.admin);
      }
    }
    log('init: re-attached %d handles', state.handles.length);
  }

  /**
   * Snapshot of currently-known managed nodes. Used by the local UI's
   * `/api/nodes` route.
   */
  listNodes(): ManagedNodeInfo[] {
    return [...this.handles.values()].map((h) => toNodeInfo(h));
  }

  /**
   * Look up a single managed node by either containerId (friendly id) or
   * dockerId (opaque `pid:token`). Returns undefined when neither matches.
   */
  getNode(idOrDockerId: string): ManagedNodeInfo | undefined {
    const direct = this.handles.get(idOrDockerId);
    if (direct) return toNodeInfo(direct);
    for (const h of this.handles.values()) {
      if (h.containerId === idOrDockerId) return toNodeInfo(h);
    }
    return undefined;
  }

  /**
   * Resolve the opaque dockerId for a friendly containerId so callers can
   * pass it into stopContainer / getLogs / getStats.
   */
  resolveDockerId(idOrDockerId: string): string | undefined {
    if (this.handles.has(idOrDockerId)) return idOrDockerId;
    for (const h of this.handles.values()) {
      if (h.containerId === idOrDockerId) return h.dockerId;
    }
    return undefined;
  }

  /**
   * Register a state-change listener. Invoked when a handle's `alive`
   * transitions (child exit, manual stop). Returns an unsubscribe fn.
   */
  onStateChange(listener: NodeStateListener): () => void {
    this.stateListeners.add(listener);
    return () => { this.stateListeners.delete(listener); };
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
    const ports: NodePorts = {
      health: this.portAllocator.allocate(),
      metrics: this.portAllocator.allocate(),
      p2p: this.portAllocator.allocate(),
      admin: this.portAllocator.allocate(),
    };
    // Only storage-profile nodes participate in strands and thus fan out push
    // wakes — a transaction-only node need not carry credentials.
    const push = request.profile === 'storage' ? await this.resolvePush() : undefined;
    return this.launchChild({
      containerId: request.containerId,
      partyId: request.partyId,
      profile: request.profile,
      ports,
      authority: false,
      buildConfig: (workdir) => this.buildChildConfig(request, workdir, push),
      extraArgs: [],
      ...(request.resources?.memoryLimit ? { memoryLimit: request.resources.memoryLimit } : {}),
    });
  }

  /**
   * Resolve the push credentials to inject into the node about to spawn. Called
   * on every spawn so a re-spawn re-reads the secret store — raw private keys are
   * never persisted. A resolver failure (e.g. a partial credential set) is
   * logged and degrades to "no push" rather than failing the spawn: the node
   * stays up and reachable, just without platform push-wake.
   */
  private async resolvePush(): Promise<PushCredentials | undefined> {
    if (!this.pushResolver) return undefined;
    try {
      const push = await this.pushResolver();
      if (push) {
        log('resolved push credentials: fcm=%s apns=%s cooldownMs=%s', !!push.fcm, !!push.apns, push.cooldownMs);
      }
      return push;
    } catch (err) {
      log('push resolver failed; spawning node without push: %s', (err as Error).message);
      return undefined;
    }
  }

  /**
   * Ensure the admin's authority node is running, spawning it if absent or
   * dead. Idempotent: a second call with the node already alive returns the
   * existing handle without launching a second child. The spawn parameters
   * are persisted so a later `/api/nodes/:id/{start,restart}` (or an
   * orchestrator restart) can re-spawn it without re-supplying them.
   *
   * The authority node is spawned as `cadre-cli start --authority
   * --admin-port <p> --identity-protobuf <identityPath>` so it carries the
   * host's libp2p identity, founds/joins the control network, and exposes the
   * loopback admin channel the manager delegates to.
   */
  async ensureAuthorityNode(cfg?: AuthoritySpawnConfig): Promise<ManagedNodeInfo> {
    const config = cfg ?? this.authorityConfig;
    if (!config) {
      throw new Error('ensureAuthorityNode: no authority config supplied and none persisted');
    }
    this.authorityConfig = config;

    const existing = this.findAuthorityHandle();
    if (existing && isPidAlive(existing.pid) && tokenMatches(existing.workdir, existing.startupToken)) {
      this.persist();
      return toNodeInfo(existing);
    }
    if (existing) {
      // Drop the stale handle and release its ports — but DO NOT delete the
      // workdir: the authority node's control-DB storage lives there and must
      // survive a restart. launchChild reuses the same workdir.
      this.releasePorts(existing.ports);
      this.handles.delete(existing.dockerId);
    }

    const profile = config.profile ?? 'storage';
    // Re-resolve push credentials from the secret store on every (re-)spawn so a
    // restart picks up rotated keys and nothing raw is replayed from state.json.
    const push = await this.resolvePush();
    const ports: NodePorts = {
      health: this.portAllocator.allocate(),
      metrics: this.portAllocator.allocate(),
      admin: this.portAllocator.allocate(),
      // The authority node must listen on the configured libp2p port so the
      // NAT mapping (external → internal) lands on it. That port is outside
      // the managed range, so markUsed is a harmless no-op.
      p2p: config.libp2pPort,
    };
    this.portAllocator.markUsed(config.libp2pPort);

    const result = this.launchChild({
      containerId: AUTHORITY_CONTAINER_ID,
      partyId: config.partyId,
      profile,
      ports,
      authority: true,
      buildConfig: (workdir) => this.buildAuthorityChildConfig(config, profile, workdir, push),
      extraArgs: ['--authority', '--admin-port', String(ports.admin), '--identity-protobuf', config.identityPath],
    });
    const handle = this.handles.get(result.dockerId)!;
    return toNodeInfo(handle);
  }

  /** Endpoint + bearer for the authority node's admin channel, if spawned. */
  getAuthorityAdminEndpoint(): AuthorityAdminEndpoint | undefined {
    const handle = this.findAuthorityHandle();
    if (!handle) return undefined;
    return {
      baseUrl: `http://127.0.0.1:${handle.ports.admin}`,
      token: handle.startupToken,
    };
  }

  /** Whether spawn parameters for the authority node are known (persisted). */
  hasAuthorityConfig(): boolean {
    return this.authorityConfig !== undefined;
  }

  /** Whether the given friendly/docker id refers to the authority node. */
  isAuthorityNode(idOrDockerId: string): boolean {
    if (idOrDockerId === AUTHORITY_CONTAINER_ID) return true;
    const direct = this.handles.get(idOrDockerId);
    if (direct?.authority) return true;
    for (const h of this.handles.values()) {
      if (h.authority && h.containerId === idOrDockerId) return true;
    }
    return false;
  }

  /** Stop the authority node (if running). Used on graceful shutdown. */
  async stopAuthorityNode(): Promise<void> {
    const handle = this.findAuthorityHandle();
    if (handle && isPidAlive(handle.pid)) {
      await this.stopContainer(handle.dockerId);
    }
  }

  /** Stop the authority node (if running), then re-spawn it from saved config. */
  async restartAuthorityNode(): Promise<ManagedNodeInfo> {
    const handle = this.findAuthorityHandle();
    if (handle && isPidAlive(handle.pid)) {
      await this.stopContainer(handle.dockerId);
    }
    return this.ensureAuthorityNode();
  }

  /**
   * Core spawn mechanics shared by `createContainer` and `ensureAuthorityNode`.
   * The caller has already allocated `ports`. Releases the ports on a
   * synchronous spawn failure.
   */
  private launchChild(opts: {
    containerId: string;
    partyId: string;
    profile: 'storage' | 'transaction';
    ports: NodePorts;
    authority: boolean;
    buildConfig: (workdir: string) => Record<string, unknown>;
    extraArgs: string[];
    memoryLimit?: string;
  }): OrchestratorCreateResult {
    const { containerId, ports } = opts;
    const workdir = join(this.rootDir, containerId);
    mkdirSync(workdir, { recursive: true });
    mkdirSync(join(workdir, 'storage'), { recursive: true });

    const token = randomBytes(16).toString('hex');
    // Per-container secret gating the node's `POST /seed` route. The node
    // refuses seed delivery unless the caller presents this as a bearer token
    // (and unregisters the route entirely when the env var is empty), so we
    // mint a fresh high-entropy value per child and hand it back on the result
    // for `ContainerService.applySeed` to send.
    const seedToken = randomBytes(32).toString('base64url');
    const tokenPath = join(workdir, STARTUP_TOKEN_FILE);
    // Ensure stale token from a previous container with the same id is cleared.
    if (existsSync(tokenPath)) {
      try { rmSync(tokenPath); } catch { /* ignore */ }
    }

    const configPath = join(workdir, CONFIG_FILE);
    writeFileSync(configPath, JSON.stringify(opts.buildConfig(workdir), null, 2), 'utf8');

    const memoryLimit = opts.memoryLimit ?? this.defaultMemoryLimit;
    const heapBytes = parseMemoryLimit(memoryLimit);
    const heapMB = heapBytes !== undefined ? Math.max(64, Math.floor(heapBytes / (1024 * 1024))) : undefined;

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      CADRE_STARTUP_TOKEN: token,
      CADRE_HEALTH_PORT: String(ports.health),
      CADRE_METRICS_PORT: String(ports.metrics),
      CADRE_LISTEN_ADDRS: `/ip4/0.0.0.0/tcp/${ports.p2p}`,
      CADRE_SEED_TOKEN: seedToken,
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

    const args = [
      this.cliEntrypoint,
      'start',
      '-c', configPath,
      '--health-port', String(ports.health),
      '--metrics-port', String(ports.metrics),
      '--startup-token-file', tokenPath,
      ...opts.extraArgs,
    ];

    let child: ChildProcess;
    try {
      child = spawn(process.execPath, args, {
        cwd: workdir,
        detached: true,
        // Inherit the log fd directly. OS duplicates it into the child;
        // closing our copy below is safe and severs the parent's only
        // tie to the child's write path.
        stdio: ['ignore', logFd, logFd],
        env,
      });
    } catch (err) {
      // Synchronous spawn failure — release the fd and the reserved ports
      // before propagating, so a bad-args bug doesn't leak resources.
      closeSync(logFd);
      this.releasePorts(ports);
      throw err;
    }
    // Always release the parent's copy of the fd — the child has its own.
    closeSync(logFd);

    if (!child.pid) {
      // Spawn returned without a pid — release reservations and report.
      this.releasePorts(ports);
      throw new Error(`Failed to spawn child for container ${containerId}`);
    }

    child.unref();

    const dockerId = encodeDockerId(child.pid, token);
    const handle: Handle = {
      containerId,
      dockerId,
      pid: child.pid,
      startupToken: token,
      workdir,
      ports,
      spawnedAt: new Date().toISOString(),
      partyId: opts.partyId,
      profile: opts.profile,
      ...(opts.authority ? { authority: true } : {}),
      child,
      alive: true,
    };

    child.once('exit', () => {
      const h = this.handles.get(dockerId);
      if (h && h.alive) {
        h.alive = false;
        this.emitStateChange(h);
      }
    });

    this.handles.set(dockerId, handle);
    this.persist();
    this.emitStateChange(handle);

    log('created container %s -> pid %d ports=%j', containerId, child.pid, handle.ports);

    return {
      dockerId,
      healthEndpoint: `http://localhost:${ports.health}/health`,
      metricsEndpoint: `http://localhost:${ports.metrics}/metrics`,
      // The node's seed API (`POST /seed`) is bound to the same server/port as `/health`.
      seedEndpoint: `http://localhost:${ports.health}/seed`,
      seedToken,
      p2pPort: ports.p2p,
    };
  }

  /** Locate the authority node's handle, if one has been spawned. */
  private findAuthorityHandle(): Handle | undefined {
    for (const h of this.handles.values()) {
      if (h.authority || h.containerId === AUTHORITY_CONTAINER_ID) return h;
    }
    return undefined;
  }

  private releasePorts(ports: NodePorts): void {
    this.portAllocator.release(ports.health);
    this.portAllocator.release(ports.metrics);
    this.portAllocator.release(ports.p2p);
    this.portAllocator.release(ports.admin);
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

    const wasAlive = handle.alive;
    handle.alive = false;
    this.persist();
    if (wasAlive) this.emitStateChange(handle);
  }

  async removeContainer(dockerId: string): Promise<void> {
    const handle = this.requireHandle(dockerId);
    if (isPidAlive(handle.pid)) {
      await this.stopContainer(dockerId);
    }

    this.releasePorts(handle.ports);

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
    const handle: Handle | undefined = this.handles.get(dockerId);
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

  private buildChildConfig(
    req: OrchestratorCreateRequest,
    workdir: string,
    push?: PushCredentials,
  ): Record<string, unknown> {
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
    // Push credentials land in the child's cadre.json on the host filesystem —
    // the same trust boundary as the control-DB storage in this workdir. The
    // private keys are NOT logged (the resolver redacts; we log only presence).
    if (push) cfg.push = push;
    return cfg;
  }

  /**
   * Child config for the authority node. It founds/joins the control network
   * for `partyId` (no bootstrap peers — it is the founding node), and carries
   * the host identity via `--identity-protobuf` (passed as a spawn arg).
   */
  private buildAuthorityChildConfig(
    cfg: AuthoritySpawnConfig,
    profile: 'storage' | 'transaction',
    workdir: string,
    push?: PushCredentials,
  ): Record<string, unknown> {
    const config: Record<string, unknown> = {
      controlNetwork: {
        partyId: cfg.partyId,
        bootstrapNodes: [],
      },
      profile,
      strandFilter: 'all',
    };
    if (profile === 'storage') {
      config.storage = { type: 'file', path: join(workdir, 'storage') };
    }
    // The always-on authority/storage node participates in strands, so it owns
    // the push-wake fan-out when credentials are configured. Written into
    // cadre.json (same host trust boundary as the workdir's control-DB); keys
    // are never logged — only the redacted presence line in resolvePush.
    if (push) config.push = push;
    return config;
  }

  private persist(): void {
    const state: PersistedState = {
      version: 1,
      handles: [...this.handles.values()].map((h) => this.toPersisted(h)),
      ...(this.authorityConfig ? { authorityConfig: this.authorityConfig } : {}),
    };
    this.stateStore.save(state);
  }

  private emitStateChange(handle: Handle): void {
    if (this.stateListeners.size === 0) return;
    const info = toNodeInfo(handle);
    for (const listener of this.stateListeners) {
      try {
        listener(info);
      } catch (err) {
        log('state listener threw for %s: %o', info.id, err);
      }
    }
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
      ...(h.authority ? { authority: true } : {}),
    };
  }
}

function toNodeInfo(h: Handle): ManagedNodeInfo {
  return {
    id: h.containerId,
    dockerId: h.dockerId,
    partyId: h.partyId,
    profile: h.profile,
    status: h.alive ? 'running' : 'stopped',
    spawnedAt: h.spawnedAt,
    workdir: h.workdir,
    ports: { ...h.ports },
    ...(h.authority ? { authority: true } : {}),
  };
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
      { cause: err },
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
  let size: number;
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

