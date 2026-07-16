import { existsSync, readFileSync, renameSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import debug from 'debug';

import type { OwnerSpawnConfig, NodePorts } from './types.js';

const log = debug('cadre:host:state-store');

/**
 * Persisted record for a single managed child. The orchestrator mirrors its
 * in-memory map to disk so that cadre-host can re-attach to surviving
 * children after a restart.
 */
export interface PersistedHandle {
  containerId: string;        // provider-assigned ID, passed in createContainer
  dockerId: string;           // opaque token returned to callers (encoded "pid:token")
  pid: number;
  startupToken: string;
  workdir: string;
  ports: NodePorts;
  spawnedAt: string;          // ISO timestamp
  partyId: string;
  profile: 'storage' | 'transaction';
  /** True for the admin's owner node. */
  owner?: boolean;
}

export interface PersistedState {
  version: 1;
  handles: PersistedHandle[];
  /** Spawn parameters for the owner node, so it can be re-spawned on demand. */
  ownerConfig?: OwnerSpawnConfig;
}

const STATE_VERSION = 1;

/** JSON state file at `<rootDir>/state.json`, written atomically. */
export class StateStore {
  private readonly path: string;

  constructor(rootDir: string) {
    mkdirSync(rootDir, { recursive: true });
    this.path = join(rootDir, 'state.json');
  }

  load(): PersistedState {
    if (!existsSync(this.path)) {
      return { version: STATE_VERSION, handles: [] };
    }
    try {
      const raw = readFileSync(this.path, 'utf8');
      const parsed = JSON.parse(raw) as PersistedState;
      if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.handles)) {
        log('state file at %s has unexpected shape; treating as empty', this.path);
        return { version: STATE_VERSION, handles: [] };
      }
      return {
        version: STATE_VERSION,
        handles: parsed.handles,
        ...(parsed.ownerConfig ? { ownerConfig: parsed.ownerConfig } : {}),
      };
    } catch (err) {
      // A corrupt state file is operationally significant — surviving children
      // may now be leaked to the OS without an in-memory handle. Make the
      // failure visible rather than silently returning empty.
      log('failed to load state file at %s: %o', this.path, err);
      return { version: STATE_VERSION, handles: [] };
    }
  }

  save(state: PersistedState): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const payload = JSON.stringify(
      {
        version: STATE_VERSION,
        handles: state.handles,
        ...(state.ownerConfig ? { ownerConfig: state.ownerConfig } : {}),
      },
      null,
      2,
    );
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, payload, { encoding: 'utf8' });
    renameSync(tmp, this.path);
  }

  filePath(): string {
    return this.path;
  }
}
