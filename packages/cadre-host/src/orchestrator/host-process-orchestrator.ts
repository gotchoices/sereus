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
import { join, resolve as resolvePath, sep } from 'node:path';
import debug from 'debug';
import pidusage from 'pidusage';
import type {
  Orchestrator,
  OrchestratorCreateRequest,
  OrchestratorCreateResult,
  OrchestratorStats,
} from '@serfab/cadre-provider';

import { defaultLogPath, rotateOnDisk } from './log-rotator.js';
import { ensureNodeIdentity } from './node-identity.js';
import { allocateNodePorts, PortAllocator } from './port-allocator.js';
import { StateStore, type PersistedHandle, type PersistedState } from './state-store.js';
import { isPidAlive } from './pid-liveness.js';
import type { PushCredentials } from '@serfab/cadre-core';
import {
  decodeDockerId,
  encodeDockerId,
  type OwnerSpawnConfig,
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

const CADRE_ENV_PREFIX = 'CADRE_';

/**
 * Manager's own `process.env` with every `CADRE_*` key removed. A child node
 * takes its whole configuration from the config file this orchestrator writes
 * plus the vars set explicitly below, and `@serfab/cadre-cli` treats inherited
 * `CADRE_*` vars as overrides that BEAT that config file — so inheriting them
 * would let a var set on the manager (e.g. CADRE_PARTY_ID) silently
 * reconfigure every spawned child. Scrubbing the whole prefix rather than a
 * list of known keys means a new cli env var can't reintroduce the leak by
 * being forgotten here. Non-CADRE vars (PATH, DEBUG, proxy/TLS settings, etc.)
 * still pass through untouched.
 */
function scrubbedParentEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith(CADRE_ENV_PREFIX)) delete env[key];
  }
  return env;
}

/** Fixed friendly id for the admin's owner node. */
export const OWNER_CONTAINER_ID = 'owner';

/** Endpoint + bearer for the owner node's loopback admin channel (6.6). */
export interface OwnerAdminEndpoint {
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
  /** Persisted spawn config for the owner node (re-spawn on demand). */
  private ownerConfig?: OwnerSpawnConfig;

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
    this.ownerConfig = state.ownerConfig;
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
        ...(persisted.owner ? { owner: true } : {}),
        alive,
      };
      this.handles.set(handle.dockerId, handle);
      // Always reserve ports — even for dead handles, until the caller cleans them up
      this.reservePorts(persisted.ports);
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

  /**
   * Spawn a generic managed node — the donated-node path (the requester's cadre,
   * pinned to the *requester's* owner key). The node is given its own protobuf
   * identity key inside its workdir (`ensureNodeIdentity`, reused across
   * re-spawns of the same containerId), which is what makes its peer id stable
   * across restarts AND what makes its node-local stores durable: `cadre-cli
   * start` opens the file-backed bootstrap-peer and trusted-owner stores only
   * when a protobuf identity key file is configured, and puts them beside it.
   * Terminating the loan (`removeContainer`) deletes the workdir, so the key and
   * both stores go with it.
   */
  async createContainer(request: OrchestratorCreateRequest): Promise<OrchestratorCreateResult> {
    const workdir = this.workdirFor(request.containerId);
    // Sampled BEFORE `ensureNodeIdentity`, which brings the directory into
    // existence as a side effect of writing the key. Only a spawn that found
    // nothing here may delete anything on its way out — a re-spawn is REUSING
    // the identity key and node-local stores this directory holds, and they are
    // the whole reason the node comes back as the same peer. `false` is
    // therefore the safe default: a directory that exists for any reason
    // (respawn, an earlier failed provision, an operator's file) is never
    // touched by the unwind below.
    const isNewWorkdir = !existsSync(workdir);
    let dropped: Handle[] = [];
    let ports: NodePorts | undefined;
    try {
      // Identity BEFORE any port is reserved: it is the one step here that can
      // fail on its own (an unreadable or undecodable identity.key throws rather
      // than silently re-keying), and everything past the allocation is either
      // infallible or releases the ports itself. Allocating first would leak four
      // ports from a bounded range on every failed provision attempt.
      const identity = await ensureNodeIdentity(workdir);
      log('container %s identity peerId=%s', request.containerId, identity.peerId);
      // A node started with pinned owner keys belongs to a FOREIGN cadre (the
      // node-donation flow: it trusts the requester's owner key, not the host's).
      // The host's FCM/APNs credentials are minted for the host owner's own app
      // and are meaningless to a foreign cadre — so donated nodes get NO push
      // block. (Per-grantee push creds would be a future ticket; none in v1.)
      const foreignParty = (request.pinnedOwnerKeys?.length ?? 0) > 0;
      // Only storage-profile nodes participate in strands and thus fan out push
      // wakes — a transaction-only node need not carry credentials. Resolved
      // BEFORE the drop below: it is the last `await` on this path, which is what
      // keeps the drop → launch window synchronous (see restoreDroppedHandles).
      const push = request.profile === 'storage' && !foreignParty ? await this.resolvePush() : undefined;
      // Pinned owner key(s) reach the child via CADRE_OWNER_KEYS (comma-separated);
      // `cadre-cli start` unions it into its cold-start pinnedKeyTrustPolicy so the
      // node will accept the foreign-authority-signed seed presented via POST /seed.
      const extraEnv = request.pinnedOwnerKeys?.length
        ? { CADRE_OWNER_KEYS: request.pinnedOwnerKeys.join(',') }
        : undefined;

      // Nothing from here to the launch is `await`ed — which is what keeps
      // `restoreDroppedHandles`'s documented precondition true even though the
      // `try` now opens further up. Do not add an `await` past this line.
      dropped = this.dropStaleHandle(request.containerId);
      // NOTE: the p2p port is re-allocated per spawn, so a re-spawned donated
      // node keeps its peer id but may announce a different port. Recoverable —
      // it dials out to its retained bootstrap peers and republishes its own
      // CadrePeer row once connected. If that reconnect ever proves too slow,
      // pin the p2p port per containerId (see donated-node-respawn-core).
      ports = allocateNodePorts(this.portAllocator);
      return this.launchChild({
        containerId: request.containerId,
        partyId: request.partyId,
        profile: request.profile,
        ports,
        owner: false,
        buildConfig: () => this.buildChildConfig(request, workdir, push),
        extraArgs: ['--identity-protobuf', identity.path],
        ...(extraEnv ? { extraEnv } : {}),
        ...(request.resources?.memoryLimit ? { memoryLimit: request.resources.memoryLimit } : {}),
      });
    } catch (err) {
      // Release BEFORE restoring: a re-spawn allocates the very ports the drop
      // just freed, so restoring first and releasing second would hand the
      // restored handle's own ports straight back to the allocator.
      if (ports) this.releasePorts(ports);
      // A no-op for the failures that happen before the drop (`dropped` is
      // still empty).
      this.restoreDroppedHandles(dropped);
      // Safe because a throw out of `launchChild` means NO child is running:
      // its throw surface ends where the child is spawned and its handle stored
      // (everything past that line is best-effort), and the `if (!child.pid)`
      // throw is on the no-process side too. So nothing is ever holding the
      // directory this deletes.
      if (isNewWorkdir) this.discardWorkdir(workdir);
      throw err;
    }
  }

  /**
   * Remove the working directory a spawn created for `containerId` when no
   * handle owns it — the cleanup of last resort for a donation record that
   * never got a `dockerId` (the host died between `ensureNodeIdentity` and the
   * handle write, so `createContainer`'s own unwind never ran). Returns whether
   * anything was removed.
   *
   * Synchronous, mirroring {@link resolveDockerId}: nothing on this path needs
   * to await.
   */
  reclaimWorkdir(containerId: string): boolean {
    // The admin's own node is never reclaimed by this route: its workdir is a
    // single fixed path reused by every restart and it holds the host's own
    // control-DB storage.
    if (containerId === OWNER_CONTAINER_ID) return false;
    // A live handle owns that directory, and `removeContainer` — which stops
    // the child first — is the only thing allowed to delete it.
    if (this.resolveDockerId(containerId)) return false;
    const workdir = this.workdirFor(containerId);
    // Defence, not a live case: donation ids are `grn_<base64url>` and so can
    // hold neither a path separator nor a dot. A caller that ever passes
    // something else must not be able to walk out of `rootDir`.
    if (!workdir.startsWith(this.rootDir + sep)) {
      log('refusing to reclaim workdir outside rootDir: %s', workdir);
      return false;
    }
    // Must be a DIRECTORY, not merely something that exists: `rootDir` also
    // holds `state.json` (this orchestrator's own persisted handles), and
    // `discardWorkdir`'s `rmSync` deletes files as happily as trees. Same
    // defence class as the escape check above — no real containerId names a
    // file — but the blast radius if one ever did is the whole handle map.
    if (!statSync(workdir, { throwIfNoEntry: false })?.isDirectory()) return false;
    this.discardWorkdir(workdir);
    return true;
  }

  /**
   * Best-effort removal of a workdir no handle owns. Logs, never throws: every
   * caller is either unwinding a failure it must report instead of this one, or
   * tearing a container down along a path where a surviving directory is a
   * nuisance rather than a fault.
   *
   * `retries` sizes the wait for the OS to release a cwd handle — Windows drops
   * it asynchronously after a child exits. `createContainer`'s unwind needs none
   * of that (its throw surface ends before any child is spawned), but
   * `reclaimWorkdir` can still meet an orphan process the previous host left
   * running with this directory as its cwd, so it is not a *guaranteed*
   * no-process path either — it simply logs and leaves the directory when the
   * removal fails.
   */
  private discardWorkdir(workdir: string, retries = { maxRetries: 5, retryDelay: 100 }): void {
    try {
      rmSync(workdir, { recursive: true, force: true, ...retries });
      log('discarded workdir %s', workdir);
    } catch (err) {
      log('failed to discard workdir %s: %o', workdir, err);
    }
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
   * Ensure the admin's owner node is running, spawning it if absent or
   * dead. Idempotent: a second call with the node already alive returns the
   * existing handle without launching a second child. The spawn parameters
   * are persisted so a later `/api/nodes/:id/{start,restart}` (or an
   * orchestrator restart) can re-spawn it without re-supplying them.
   *
   * The owner node is spawned as `cadre-cli start --owner
   * --admin-port <p> --identity-protobuf <identityPath>` so it carries the
   * host's libp2p identity, founds/joins the control network, and exposes the
   * loopback admin channel the manager delegates to.
   */
  async ensureOwnerNode(cfg?: OwnerSpawnConfig): Promise<ManagedNodeInfo> {
    const config = cfg ?? this.ownerConfig;
    if (!config) {
      throw new Error('ensureOwnerNode: no owner config supplied and none persisted');
    }
    this.ownerConfig = config;

    const existing = this.findOwnerHandle();
    if (existing && isPidAlive(existing.pid) && tokenMatches(existing.workdir, existing.startupToken)) {
      this.persist();
      return toNodeInfo(existing);
    }

    const profile = config.profile ?? 'storage';
    // Re-resolve push credentials from the secret store on every (re-)spawn so a
    // restart picks up rotated keys and nothing raw is replayed from state.json.
    // Resolved BEFORE the drop below so the drop → launch window stays
    // synchronous (see restoreDroppedHandles).
    const push = await this.resolvePush();

    // NOTE: the short-circuit above matches via `findOwnerHandle` (owner flag OR
    // containerId), this drop only by containerId. Equivalent today — every
    // owner handle is launched with OWNER_CONTAINER_ID. If an owner spawn ever
    // takes a different containerId, the two would disagree and the handle the
    // short-circuit found would survive here, leaking it and its ports.
    const dropped = this.dropStaleHandle(OWNER_CONTAINER_ID);
    let ports: NodePorts | undefined;
    try {
      // The owner node must listen on the configured libp2p port so the NAT
      // mapping (external → internal) lands on it — hence the p2p override.
      ports = allocateNodePorts(this.portAllocator, { p2p: config.libp2pPort });
      const result = this.launchChild({
        containerId: OWNER_CONTAINER_ID,
        partyId: config.partyId,
        profile,
        ports,
        owner: true,
        buildConfig: (workdir) => this.buildOwnerChildConfig(config, profile, workdir, push),
        extraArgs: ['--owner', '--admin-port', String(ports.admin), '--identity-protobuf', config.identityPath],
      });
      const handle = this.handles.get(result.dockerId)!;
      return toNodeInfo(handle);
    } catch (err) {
      // Release before restoring — see the same note in createContainer.
      if (ports) this.releasePorts(ports);
      this.restoreDroppedHandles(dropped);
      // Deliberately NOT `discardWorkdir` — the asymmetry with createContainer
      // is the point. `<rootDir>/owner` is a single fixed path reused by every
      // restart and holds the host's own control-DB storage, so it neither
      // grows without bound nor is safe to delete on a failed spawn.
      throw err;
    }
  }

  /** Endpoint + bearer for the owner node's admin channel, if spawned. */
  getOwnerAdminEndpoint(): OwnerAdminEndpoint | undefined {
    const handle = this.findOwnerHandle();
    if (!handle) return undefined;
    return {
      baseUrl: `http://127.0.0.1:${handle.ports.admin}`,
      token: handle.startupToken,
    };
  }

  /** Whether spawn parameters for the owner node are known (persisted). */
  hasOwnerConfig(): boolean {
    return this.ownerConfig !== undefined;
  }

  /** Whether the given friendly/docker id refers to the owner node. */
  isOwnerNode(idOrDockerId: string): boolean {
    if (idOrDockerId === OWNER_CONTAINER_ID) return true;
    const direct = this.handles.get(idOrDockerId);
    if (direct?.owner) return true;
    for (const h of this.handles.values()) {
      if (h.owner && h.containerId === idOrDockerId) return true;
    }
    return false;
  }

  /** Stop the owner node (if running). Used on graceful shutdown. */
  async stopOwnerNode(): Promise<void> {
    const handle = this.findOwnerHandle();
    if (handle && isPidAlive(handle.pid)) {
      await this.stopContainer(handle.dockerId);
    }
  }

  /** Stop the owner node (if running), then re-spawn it from saved config. */
  async restartOwnerNode(): Promise<ManagedNodeInfo> {
    const handle = this.findOwnerHandle();
    if (handle && isPidAlive(handle.pid)) {
      await this.stopContainer(handle.dockerId);
    }
    return this.ensureOwnerNode();
  }

  /**
   * Core spawn mechanics shared by `createContainer` and `ensureOwnerNode`.
   *
   * The caller has already allocated `ports` and **owns their lifetime**: this
   * method never releases them, so every caller must release on any throw out
   * of here (it has to unwind its handle drop on the same path anyway — see
   * `restoreDroppedHandles`).
   *
   * That contract holds because this method throws only *before* the child is
   * spawned and its handle stored — everything after that point is
   * best-effort. Anything new added at the tail must keep it that way.
   *
   * Entirely synchronous, which is what makes that unwind sound. Do not add an
   * `await` here.
   */
  private launchChild(opts: {
    containerId: string;
    partyId: string;
    profile: 'storage' | 'transaction';
    ports: NodePorts;
    owner: boolean;
    buildConfig: (workdir: string) => Record<string, unknown>;
    extraArgs: string[];
    /** Extra env vars merged into the child's environment (e.g. CADRE_OWNER_KEYS). */
    extraEnv?: Record<string, string>;
    memoryLimit?: string;
  }): OrchestratorCreateResult {
    const { containerId, ports } = opts;
    const workdir = this.workdirFor(containerId);
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
      // Scrubbed, not raw process.env: every CADRE_* config-override key is
      // stripped so a var set on the manager can't silently reconfigure every
      // child (see scrubbedParentEnv). Caller-supplied extras come next — the
      // fixed per-child vars below always win so extraEnv can never clobber
      // the seed/startup tokens or port wiring.
      ...scrubbedParentEnv(),
      ...opts.extraEnv,
      CADRE_STARTUP_TOKEN: token,
      CADRE_HEALTH_PORT: String(ports.health),
      CADRE_METRICS_PORT: String(ports.metrics),
      CADRE_LISTEN_ADDRS: `/ip4/0.0.0.0/tcp/${ports.p2p}`,
      // NOTE: the scrub above drops every CADRE_* var and `extraEnv` is built only from
      // pinnedOwnerKeys, so a managed child advertises only the port assigned to it here
      // — `CADRE_ANNOUNCE_ADDRS`/`CADRE_APPEND_ANNOUNCE_ADDRS` cannot reach it. Fine while
      // children are reached at that port or through a relay; if a host is ever fronted by
      // a proxy or DNS name, plumb an announce var through from host config.
      CADRE_SEED_TOKEN: seedToken,
      // Pin each child's node-local state (trusted-owner anchor, retained
      // cold-start dial targets) to its OWN workdir. This is the same value the
      // cli would derive by default (the config file lives here too), but stated
      // explicitly rather than relying on the scrub above (belt and suspenders).
      CADRE_NODE_STATE_DIR: workdir,
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
      // Synchronous spawn failure — close the fd before propagating. This is
      // the ONLY fd-leak guard on this path: nothing between the `openSync`
      // above and the `spawn` can throw, so no other catch is needed. Keep it
      // that way, or add one. (The ports are the caller's to release.)
      closeSync(logFd);
      throw err;
    }
    // Always release the parent's copy of the fd — the child has its own.
    closeSync(logFd);

    if (!child.pid) {
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
      ...(opts.owner ? { owner: true } : {}),
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
    // Past this line the launch has SUCCEEDED: the child is running and this
    // handle owns its ports. So the state mirror is best-effort — a throw here
    // would reach the caller's unwind, which would release ports the live child
    // is bound to and restore the handle this spawn just replaced, leaving two
    // handles for one container and one of them holding unreserved ports. A
    // lost write self-heals: the next persist() (any stop/remove/spawn)
    // rewrites the whole map. Until then a manager restart would fail to
    // re-attach this child, hence the log.
    try {
      this.persist();
    } catch (err) {
      log('failed to persist state after launching container %s: %o', containerId, err);
    }
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

  /**
   * Drop any handle left over from a previous spawn of the same `containerId`
   * and release its ports. Handles are keyed by the per-spawn `dockerId`, so
   * without this a re-spawn (donated-node respawn) would strand the prior
   * handle in the map forever, leaking four ports from a bounded range each
   * time. Mirrors the same cleanup in `ensureOwnerNode`.
   *
   * DO NOT delete the workdir: the identity key and node-local stores
   * (trusted-owner anchor, retained cold-start dial targets) live there and are
   * the whole reason a respawn comes back as the same node. `launchChild`
   * reuses the same workdir.
   *
   * NOTE: releasing the ports hands them straight back to the allocator, so a
   * re-spawn while the *previous* child is still listening can bind-clash. Every
   * caller today re-spawns only a container it has established is not running
   * (`DonationService.respawn`, `ensureOwnerNode`). If a caller ever needs to
   * replace a live child, stop it first — or hold the ports until its exit.
   *
   * **The drop is reversible.** It happens before the launch can fail, so the
   * dropped handles are returned and every caller restores them via
   * {@link restoreDroppedHandles} when the launch throws — otherwise the caller
   * would be left holding a dockerId this orchestrator no longer knows, and the
   * node's workdir could never be reclaimed. On a *successful* spawn the drop
   * stands: `DonationService.abandonRespawn` depends on the old handle being
   * gone by then.
   */
  private dropStaleHandle(containerId: string): Handle[] {
    const dropped: Handle[] = [];
    for (const h of this.handles.values()) {
      if (h.containerId !== containerId) continue;
      log('dropping stale handle %s for container %s', h.dockerId, containerId);
      this.releasePorts(h.ports);
      this.handles.delete(h.dockerId);
      dropped.push(h);
    }
    return dropped;
  }

  /**
   * Inverse of {@link dropStaleHandle}, for a spawn that then failed: put each
   * handle back in the map and re-reserve its four ports, leaving host state
   * exactly as the failed attempt found it.
   *
   * **Precondition: the drop → launch window is synchronous.** Restoring is
   * sound only because nothing can have taken those ports or run cleanup
   * against the handle in between — `launchChild` contains no `await` and both
   * callers resolve push credentials *before* their drop. `launchChild`'s half
   * is enforced: its declared return type is not a Promise, so adding an
   * `await` there is a compile error. The callers' half is not — an `await`
   * slipped between a drop and its launch silently breaks this.
   *
   * No `persist()` here: `state.json` is rewritten only by `launchChild` and
   * only *after* the new handle is stored, so throughout the failure window the
   * on-disk state still lists the dropped handle — this restore realigns memory
   * to disk rather than diverging from it.
   *
   * NOTE: a restored handle keeps `alive: true` even if its child exited while
   * it was out of the map (`launchChild`'s exit listener looks the handle up by
   * dockerId and finds nothing). Only reachable by re-spawning a container
   * whose child is still live, which `dropStaleHandle`'s note above already
   * forbids.
   */
  private restoreDroppedHandles(dropped: Handle[]): void {
    for (const h of dropped) {
      log('restoring dropped handle %s for container %s after failed launch', h.dockerId, h.containerId);
      this.handles.set(h.dockerId, h);
      this.reservePorts(h.ports);
    }
  }

  /** A managed node's own directory under `rootDir` — config, log, storage, identity. */
  private workdirFor(containerId: string): string {
    return join(this.rootDir, containerId);
  }

  /** Locate the owner node's handle, if one has been spawned. */
  private findOwnerHandle(): Handle | undefined {
    for (const h of this.handles.values()) {
      if (h.owner || h.containerId === OWNER_CONTAINER_ID) return h;
    }
    return undefined;
  }

  /**
   * Inverse of {@link releasePorts} — hold a handle's whole port set against
   * the allocator. Used both to rehydrate on `init` and to undo a drop whose
   * launch then failed.
   */
  private reservePorts(ports: NodePorts): void {
    this.portAllocator.markUsed(ports.health);
    this.portAllocator.markUsed(ports.metrics);
    this.portAllocator.markUsed(ports.p2p);
    // `admin` is absent on handles persisted before this build; markUsed would
    // otherwise put `undefined` in the used-set.
    if (typeof ports.admin === 'number') this.portAllocator.markUsed(ports.admin);
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

    // Longer retries than the other callers': this is the one path that has
    // just killed a child which held this directory as its cwd, and on Windows
    // the OS releases that handle asynchronously.
    this.discardWorkdir(handle.workdir, { maxRetries: 20, retryDelay: 200 });

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
   * Child config for the **host's own personal cadre** owner node — the opt-in
   * "founder" persona spawned only when `ownCadre.enabled` (see
   * docs/cadre-host.md § Two roles: donor and founder). It founds/joins the
   * control network for the host's own `partyId` (no bootstrap peers — it is the
   * founding node of the host's *own* cadre) and carries the host identity via
   * `--identity-protobuf` (passed as a spawn arg).
   *
   * This is NOT the node cadre-host donates to a requester. Donated nodes are
   * generic (`createContainer` / `buildChildConfig`): they join the
   * **requester's** cadre via bootstrap peers and pin the *requester's* owner
   * key — they never run a host genesis.
   */
  private buildOwnerChildConfig(
    cfg: OwnerSpawnConfig,
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
    // The host-own-cadre owner/storage node participates in strands, so it owns
    // the push-wake fan-out when credentials are configured. (Donated nodes
    // belong to foreign cadres and get NO host push block — see the donor path.)
    // Written into cadre.json (same host trust boundary as the workdir's
    // control-DB); keys are never logged — only the redacted presence line in
    // resolvePush.
    if (push) config.push = push;
    return config;
  }

  private persist(): void {
    const state: PersistedState = {
      version: 1,
      handles: [...this.handles.values()].map((h) => this.toPersisted(h)),
      ...(this.ownerConfig ? { ownerConfig: this.ownerConfig } : {}),
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
      ...(h.owner ? { owner: true } : {}),
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
    ...(h.owner ? { owner: true } : {}),
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

