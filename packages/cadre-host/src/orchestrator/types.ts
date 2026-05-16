/**
 * Public + internal types for the HostProcessOrchestrator.
 */

import type { ChildProcess } from 'node:child_process';
import type { LogRotator } from './log-rotator.js';

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
}

/** In-memory record per managed child. */
export interface Handle {
  containerId: string;
  dockerId: string;
  pid: number;
  startupToken: string;
  workdir: string;
  ports: { health: number; metrics: number; p2p: number };
  spawnedAt: string;
  partyId: string;
  profile: 'storage' | 'transaction';
  /** Live ChildProcess reference; absent after re-attach via init(). */
  child?: ChildProcess;
  logRotator?: LogRotator;
  /** Marked false when init() finds the PID dead or token mismatched. */
  alive: boolean;
}

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
