import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import debug from 'debug';

import type { HostedNode, HostedNodeFile } from './types.js';
import { HostedNodeError } from './types.js';

const log = debug('cadre:host:hosted-node-store');

const FILE_VERSION = 1;

/**
 * Atomic JSON store for `hosted-nodes.json` — one row per hosted node. A single
 * file written to `<path>.tmp` then renamed, with an in-memory cache keyed by id.
 *
 * **Persists the claim secret, or the invitation.** The orchestrator keeps nothing of
 * either (`state.json` omits every per-spawn env), so this row is what lets a respawn
 * start the child with the same secret, which keeps a QR code already shown valid and
 * lets a claimed node answer a rival `already-claimed`, and lets a `joining` node redeem
 * its invitation again.
 *
 * Concurrency assumption: only one cadre-host process owns a given rootDir
 * (the orchestrator already enforces this). No file-locking primitives.
 *
 * NOTE: every method here is **synchronous**, and `HostedNodeService` depends on
 * that for correctness, not just convenience — each of its long operations
 * re-reads a record and writes it back with no `await` in between, which is only
 * atomic against the event loop while `get`/`put` cannot yield. Giving this class
 * an async write path would silently reopen the resurrect-a-removed-node races
 * those re-reads exist to close, and the tests that guard them would still pass.
 */
export class HostedNodeStore {
  private readonly path: string;
  private cache: HostedNodeFile | null = null;

  constructor(rootDir: string) {
    mkdirSync(rootDir, { recursive: true });
    this.path = join(rootDir, 'hosted-nodes.json');
  }

  filePath(): string {
    return this.path;
  }

  /**
   * Load (with caching). A missing file returns an empty store. A
   * present-but-malformed file throws rather than silently wiping — losing the
   * records would orphan live child processes (their claim secrets gone).
   */
  load(): HostedNodeFile {
    if (this.cache) return this.cache;
    if (!existsSync(this.path)) {
      this.cache = emptyFile();
      return this.cache;
    }
    let raw: string;
    try {
      raw = readFileSync(this.path, 'utf8');
    } catch (err) {
      throw new HostedNodeError(
        'storage_error',
        `failed to read hosted-nodes file at ${this.path}: ${(err as Error).message}`,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new HostedNodeError(
        'storage_error',
        `hosted-nodes file at ${this.path} is not valid JSON: ${(err as Error).message}`,
      );
    }
    if (!isHostedNodeFile(parsed)) {
      throw new HostedNodeError(
        'storage_error',
        `hosted-nodes file at ${this.path} has unexpected shape`,
      );
    }
    this.cache = parsed;
    return this.cache;
  }

  /** Persist the current state atomically (write then rename). */
  save(state: HostedNodeFile): void {
    // NOTE: rewrites the whole hosted-nodes.json on every mutation. Fine at
    // household scale (a handful of nodes); if counts ever grow large, switch to
    // an append/compact log or per-id files.
    mkdirSync(dirname(this.path), { recursive: true });
    const payload = JSON.stringify({ ...state, version: FILE_VERSION }, null, 2);
    const tmp = `${this.path}.tmp`;
    try {
      writeFileSync(tmp, payload, { encoding: 'utf8' });
      renameSync(tmp, this.path);
    } catch (err) {
      throw new HostedNodeError(
        'storage_error',
        `failed to write hosted-nodes file at ${this.path}: ${(err as Error).message}`,
      );
    }
    this.cache = { ...state, version: FILE_VERSION };
    log('saved hosted nodes (%d) to %s', Object.keys(state.nodes).length, this.path);
  }

  /** Insert or replace a row. */
  put(node: HostedNode): void {
    const state = this.load();
    const { id, ...rest } = node;
    state.nodes[id] = rest;
    this.save(state);
  }

  get(id: string): HostedNode | undefined {
    const state = this.load();
    const row = state.nodes[id];
    if (!row) return undefined;
    return { id, ...row };
  }

  list(): HostedNode[] {
    const state = this.load();
    return Object.entries(state.nodes).map(([id, row]) => ({ id, ...row }));
  }

  remove(id: string): boolean {
    const state = this.load();
    if (!(id in state.nodes)) return false;
    delete state.nodes[id];
    this.save(state);
    return true;
  }
}

function emptyFile(): HostedNodeFile {
  return { version: FILE_VERSION, nodes: {} };
}

function isHostedNodeFile(v: unknown): v is HostedNodeFile {
  if (!v || typeof v !== 'object') return false;
  const obj = v as Record<string, unknown>;
  if (obj.version !== FILE_VERSION) return false;
  if (!obj.nodes || typeof obj.nodes !== 'object') return false;
  return true;
}
