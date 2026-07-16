import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import debug from 'debug';

import type { Grant, GrantFile } from './types.js';
import { GrantError } from './types.js';

const log = debug('cadre:host:grant-store');

const FILE_VERSION = 1;

/**
 * Atomic JSON store for `grants.json`. Modelled on `auth/trust-circle-store.ts`:
 * a single file, written to `<path>.tmp` then renamed, with an in-memory cache
 * keyed by token.
 *
 * Unlike the trust-circle pending rows, grants are **not** self-reaping: a
 * grant may legitimately outlive many nodes, so expiry is evaluated at
 * validate time (in `GrantService`) and the admin removes stale grants
 * explicitly. This store keeps no clock.
 *
 * Concurrency assumption: only one cadre-host process owns a given rootDir
 * (the orchestrator already enforces this). No file-locking primitives.
 */
export class GrantStore {
  private readonly path: string;
  private cache: GrantFile | null = null;

  constructor(rootDir: string) {
    mkdirSync(rootDir, { recursive: true });
    this.path = join(rootDir, 'grants.json');
  }

  filePath(): string {
    return this.path;
  }

  /**
   * Load (with caching). A missing file returns an empty store (fresh
   * install). A present-but-malformed file throws — silently wiping it would
   * revoke every grantee at once.
   */
  load(): GrantFile {
    if (this.cache) return this.cache;
    if (!existsSync(this.path)) {
      this.cache = emptyFile();
      return this.cache;
    }
    let raw: string;
    try {
      raw = readFileSync(this.path, 'utf8');
    } catch (err) {
      throw new GrantError(
        'storage_error',
        `failed to read grants file at ${this.path}: ${(err as Error).message}`,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new GrantError(
        'storage_error',
        `grants file at ${this.path} is not valid JSON: ${(err as Error).message}`,
      );
    }
    if (!isGrantFile(parsed)) {
      throw new GrantError(
        'storage_error',
        `grants file at ${this.path} has unexpected shape`,
      );
    }
    this.cache = parsed;
    return this.cache;
  }

  /** Persist the current state atomically (write then rename). */
  save(state: GrantFile): void {
    // NOTE: rewrites the whole grants.json on every mutation. Fine at household
    // scale (a handful of grantees); if grant counts ever grow large, switch to
    // an append/compact log or per-token files.
    mkdirSync(dirname(this.path), { recursive: true });
    const payload = JSON.stringify({ ...state, version: FILE_VERSION }, null, 2);
    const tmp = `${this.path}.tmp`;
    try {
      writeFileSync(tmp, payload, { encoding: 'utf8' });
      renameSync(tmp, this.path);
    } catch (err) {
      // Surface as storage_error (→ 500) like load(), not a bare Error (→
      // "internal"); a write failure on issue/revoke should read consistently.
      throw new GrantError(
        'storage_error',
        `failed to write grants file at ${this.path}: ${(err as Error).message}`,
      );
    }
    this.cache = { ...state, version: FILE_VERSION };
    log('saved grants (%d) to %s', Object.keys(state.grants).length, this.path);
  }

  add(grant: Grant): void {
    const state = this.load();
    const { token, ...rest } = grant;
    state.grants[token] = rest;
    this.save(state);
  }

  get(token: string): Grant | undefined {
    const state = this.load();
    const row = state.grants[token];
    if (!row) return undefined;
    return { token, ...row };
  }

  list(): Grant[] {
    const state = this.load();
    return Object.entries(state.grants).map(([token, row]) => ({ token, ...row }));
  }

  remove(token: string): boolean {
    const state = this.load();
    if (!(token in state.grants)) return false;
    delete state.grants[token];
    this.save(state);
    return true;
  }

  /**
   * Mark a grant revoked at the given ISO instant. Idempotent: an
   * already-revoked grant keeps its original `revokedAt`. Returns false when
   * the token is unknown.
   */
  markRevoked(token: string, at: string): boolean {
    const state = this.load();
    const row = state.grants[token];
    if (!row) return false;
    if (!row.revokedAt) row.revokedAt = at;
    this.save(state);
    return true;
  }
}

function emptyFile(): GrantFile {
  return { version: FILE_VERSION, grants: {} };
}

function isGrantFile(v: unknown): v is GrantFile {
  if (!v || typeof v !== 'object') return false;
  const obj = v as Record<string, unknown>;
  if (obj.version !== FILE_VERSION) return false;
  if (!obj.grants || typeof obj.grants !== 'object') return false;
  return true;
}
