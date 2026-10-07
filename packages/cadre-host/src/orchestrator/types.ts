/**
 * Public + internal types for the HostProcessOrchestrator.
 */

import type { ChildProcess } from 'node:child_process';
import type { PushCredentials } from '@serfab/cadre-core';
import type { OrchestratorCreateRequest } from '@serfab/cadre-provider';

/**
 * What `HostProcessOrchestrator.createContainer` takes: the shared create request plus how
 * the node gets into its cadre — the claim secret of a node started waiting to be claimed
 * (`cadre-cli start` with `CADRE_CLAIM_SECRET`), or the cadre invitation it redeems
 * (`CADRE_INVITATION`). At most one of the two. Each is a credential and reaches the child
 * through its environment only: never as an argument (an argument shows in the process
 * list), never in `state.json`, never in a log line.
 */
export type HostedSpawnRequest = OrchestratorCreateRequest & {
  /** The node's one-time claim secret, base64url. Absent, the child starts with no claim. */
  claimSecret?: string;
  /** An encoded cadre invitation the child redeems right after it starts. */
  invitation?: string;
};

/** User-facing configuration for `HostProcessOrchestrator`. */
export interface HostProcessConfig {
  /** Root directory under which per-container workdirs live. */
  rootDir: string;
  /** Port allocation range (default 10000..20000). */
  portRange?: { start: number; end: number };
  /** Default resource limits (memory only in v1). */
  defaultResources?: { memoryLimit?: string };
  /** SIGTERM → SIGKILL grace period (default 10000 ms). */
  stopTimeoutMs?: number;
  /** Log rotation: bytes per file (default 10 MB). */
  logMaxBytes?: number;
  /** Log rotation: max rotated files (default 5). */
  logMaxFiles?: number;
  /**
   * Test-only hook: override the child entrypoint. When set, the orchestrator
   * spawns `node <entrypoint> ...` instead of resolving `@serfab/cadre-cli`.
   */
  spawn?: { entrypoint?: string };
  /**
   * Resolver for the platform push credentials (FCM/APNs) to inject into a
   * spawned strand-participating node's `cadre.json` (`config.push`). Called
   * fresh on EVERY spawn/re-spawn so the secret store stays the source of truth
   * and no raw private key is ever persisted in `state.json`. Returns `undefined`
   * when no push credentials are configured (the default — push is opt-in). The
   * resolver itself is responsible for rejecting a partial credential set.
   */
  pushResolver?: PushCredentialsResolver;
  /**
   * The public multiaddrs a node about to spawn should announce beside its listen
   * addresses (`CADRE_APPEND_ANNOUNCE_ADDRS`), given its container id and the ports just
   * allocated to it. Synchronous on purpose: both spawn paths allocate ports inside a
   * window that must contain no `await` (see `restoreDroppedHandles`), and the addresses
   * depend on those ports. A throw is logged and the node starts announcing nothing extra.
   * Absent, no node announces anything beyond what libp2p reports.
   */
  announceAddrs?: (containerId: string, ports: NodePorts) => string[];
}

/**
 * Resolves the push credentials to inject into a node being spawned. Re-invoked
 * per spawn so a restart re-reads the secret store rather than replaying stale
 * (or persisted) material. See {@link HostProcessConfig.pushResolver}.
 */
export type PushCredentialsResolver = () => Promise<PushCredentials | undefined>;

/**
 * Per-child allocated ports.
 *
 * A handle read back from a `state.json` written by an older build lacks every key
 * added since, whatever this type says — the node-set helpers in `port-allocator.ts`
 * skip a missing key rather than reserving `undefined`.
 */
export interface NodePorts {
  health: number;
  metrics: number;
  /** libp2p TCP listener. */
  p2p: number;
  /**
   * libp2p WebSocket listener. The one a phone dials: a phone's node has no TCP
   * transport, so the `p2p` port is unreachable to it.
   */
  ws: number;
}

/** In-memory record per managed child. */
export interface Handle {
  containerId: string;
  dockerId: string;
  pid: number;
  startupToken: string;
  workdir: string;
  ports: NodePorts;
  spawnedAt: string;
  partyId: string;
  profile: 'storage' | 'transaction';
  /** The public addresses the child was started announcing ({@link HostProcessConfig.announceAddrs}). */
  announcedAddrs: string[];
  /** Live ChildProcess reference; absent after re-attach via init(). */
  child?: ChildProcess;
  /** Marked false when init() finds the PID dead or token mismatched. */
  alive: boolean;
}

/** Public view of a managed node — surfaced to `/api/nodes` callers. */
export interface ManagedNodeInfo {
  /** Friendly container id passed at create time. */
  id: string;
  /** Opaque dockerId (`pid:token`) — pass to stop/getStats/getLogs. */
  dockerId: string;
  partyId: string;
  profile: 'storage' | 'transaction';
  /** Runtime state derived from `Handle.alive`. */
  status: 'running' | 'stopped';
  spawnedAt: string;
  workdir: string;
  ports: NodePorts;
  /**
   * The public addresses the node was started announcing. It learns them only at start,
   * so `NatService` compares this with the node's current public addresses and asks for
   * a restart when they differ.
   */
  announcedAddrs: string[];
}

/**
 * Listener invoked when a managed node's lifecycle state changes
 * (create, child exit, manual stop). Subscribe via
 * `HostProcessOrchestrator.onStateChange`.
 */
export type NodeStateListener = (info: ManagedNodeInfo) => void;

const TOKEN_SEPARATOR = ':';

/**
 * Encode an opaque handle that callers treat the same way they treat a
 * Docker container hash. The shape is `<pid>:<token>`; tokens are hex
 * generated from `crypto.randomBytes` so they never contain `:`.
 */
export function encodeDockerId(pid: number, token: string): string {
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error(`Invalid pid for docker id: ${pid}`);
  }
  if (token.length === 0 || token.includes(TOKEN_SEPARATOR)) {
    throw new Error(`Invalid token for docker id: ${JSON.stringify(token)}`);
  }
  return `${pid}${TOKEN_SEPARATOR}${token}`;
}

export function decodeDockerId(id: string): { pid: number; token: string } {
  const idx = id.indexOf(TOKEN_SEPARATOR);
  if (idx <= 0) {
    throw new Error(`Malformed dockerId: ${id}`);
  }
  const pid = Number.parseInt(id.slice(0, idx), 10);
  const token = id.slice(idx + 1);
  if (!Number.isInteger(pid) || pid <= 0 || token.length === 0) {
    throw new Error(`Malformed dockerId: ${id}`);
  }
  return { pid, token };
}
