/**
 * Atomic JSON store for `<dataDir>/update-state.json`.
 *
 * Mirrors `TrustCircleStore` / `NatStore`: load on demand, write to
 * `<path>.tmp` then rename. Single-writer assumption — only one cadre-host
 * process owns a given dataDir.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import debug from 'debug';

import { UpdateErrorException, type UpdateState } from './types.js';

const log = debug('cadre:host:update-store');

const FILE_VERSION = 1;
const FILE_NAME = 'update-state.json';

export class UpdateStateStore {
  private readonly path: string;
  private cache: UpdateState | null = null;

  constructor(rootDir: string) {
    mkdirSync(rootDir, { recursive: true });
    this.path = join(rootDir, FILE_NAME);
  }

  filePath(): string {
    return this.path;
  }

  /** Load (with caching). A missing file returns an empty state. */
  load(): UpdateState {
    if (this.cache) return this.cache;
    if (!existsSync(this.path)) {
      this.cache = { version: FILE_VERSION };
      return this.cache;
    }
    let raw: string;
    try {
      raw = readFileSync(this.path, 'utf8');
    } catch (err) {
      throw new UpdateErrorException(
        'storage_error',
        `failed to read update-state at ${this.path}: ${(err as Error).message}`,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new UpdateErrorException(
        'storage_error',
        `update-state at ${this.path} is not valid JSON: ${(err as Error).message}`,
      );
    }
    if (!parsed || typeof parsed !== 'object') {
      throw new UpdateErrorException('storage_error', `update-state at ${this.path} is not an object`);
    }
    const obj = parsed as Record<string, unknown>;
    if (obj.version !== FILE_VERSION) {
      throw new UpdateErrorException(
        'unsupported_state_version',
        `update-state at ${this.path} has unsupported version ${String(obj.version)}`,
      );
    }
    this.cache = obj as unknown as UpdateState;
    return this.cache;
  }

  /** Persist a new state atomically. */
  save(state: UpdateState): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const next: UpdateState = { ...state, version: FILE_VERSION };
    const payload = JSON.stringify(next, null, 2) + '\n';
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, payload, { encoding: 'utf8' });
    renameSync(tmp, this.path);
    this.cache = next;
    log('saved update-state.json (available=%s, applying=%s) to %s',
      next.available?.version ?? '-',
      next.applyInProgress ? `${next.applyInProgress.fromVersion}→${next.applyInProgress.toVersion}` : '-',
      this.path);
  }

  /** Merge a patch into the current state and persist. */
  update(patch: Partial<Omit<UpdateState, 'version'>>): UpdateState {
    const current = this.load();
    const next: UpdateState = { ...current, ...patch, version: FILE_VERSION };
    this.save(next);
    return next;
  }

  /** Drop a specific field from the persisted state. */
  clearField<K extends keyof Omit<UpdateState, 'version'>>(field: K): UpdateState {
    const current = { ...this.load() };
    delete current[field];
    this.save(current);
    return current;
  }
}
