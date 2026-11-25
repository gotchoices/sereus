import { existsSync, readFileSync, renameSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import debug from 'debug';

import type { NodeClass } from '@serfab/cadre-core';

import type { NodePorts } from './types.js';

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
  nodeClass: NodeClass;
  /** The public addresses the child was started announcing. Absent in a file written before they existed. */
  announcedAddrs?: string[];
}

export interface PersistedState {
  version: 1;
  handles: PersistedHandle[];
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
    const handles = this.readHandles();
    assertNodeClass(handles, this.path);
    return { version: STATE_VERSION, handles };
  }

  /** The file's handles — none when it is missing, unreadable, or not the shape this writes. */
  private readHandles(): PersistedHandle[] {
    if (!existsSync(this.path)) {
      return [];
    }
    try {
      const raw = readFileSync(this.path, 'utf8');
      const parsed = JSON.parse(raw) as PersistedState;
      if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.handles)) {
        log('state file at %s has unexpected shape; treating as empty', this.path);
        return [];
      }
      return parsed.handles;
    } catch (err) {
      // A corrupt state file is operationally significant — surviving children
      // may now be leaked to the OS without an in-memory handle. Make the
      // failure visible rather than silently returning empty.
      log('failed to load state file at %s: %o', this.path, err);
      return [];
    }
  }

  save(state: PersistedState): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const payload = JSON.stringify({ version: STATE_VERSION, handles: state.handles }, null, 2);
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, payload, { encoding: 'utf8' });
    renameSync(tmp, this.path);
  }

  filePath(): string {
    return this.path;
  }
}

/**
 * A handle written before `profile` became `nodeClass` carries no node class, and there
 * is no migration from the old field. Refuse the whole file by name: re-attaching to its
 * children would re-spawn them as the wrong kind of machine, and treating it as empty
 * would leak every surviving child to the OS with no handle to stop it by.
 */
function assertNodeClass(handles: readonly PersistedHandle[], path: string): void {
  if (!handles.some((handle) => typeof handle === 'object' && handle !== null && 'profile' in handle)) return;
  throw new Error(
    `state file at ${path} names "profile" on a handle, which this version replaced with "nodeClass"; `
    + 'there is no migration — stop the node processes it lists, delete the file, and start cadre-host again',
  );
}
