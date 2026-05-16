import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import debug from 'debug';

import type {
  PendingInvite,
  TrustCircleFile,
  TrustCircleMember,
} from './types.js';
import { TrustCircleError } from './types.js';

const log = debug('cadre:host:trust-circle-store');

const FILE_VERSION = 1;

/**
 * Atomic JSON store for trust-circle.json. Mirrors the pattern in
 * `orchestrator/state-store.ts`: write to `<path>.tmp`, then rename.
 *
 * Concurrency assumption: only one cadre-host process owns a given rootDir
 * (the orchestrator already enforces this). No file-locking primitives.
 */
export class TrustCircleStore {
  private readonly path: string;
  private cache: TrustCircleFile | null = null;

  constructor(rootDir: string) {
    mkdirSync(rootDir, { recursive: true });
    this.path = join(rootDir, 'trust-circle.json');
  }

  filePath(): string {
    return this.path;
  }

  /** Load (with caching). A missing file returns an empty store. */
  load(): TrustCircleFile {
    if (this.cache) return this.cache;
    if (!existsSync(this.path)) {
      this.cache = emptyFile();
      return this.cache;
    }
    let raw: string;
    try {
      raw = readFileSync(this.path, 'utf8');
    } catch (err) {
      throw new TrustCircleError(
        'storage_error',
        `failed to read trust-circle file at ${this.path}: ${(err as Error).message}`,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new TrustCircleError(
        'storage_error',
        `trust-circle file at ${this.path} is not valid JSON: ${(err as Error).message}`,
      );
    }
    if (!isTrustCircleFile(parsed)) {
      throw new TrustCircleError(
        'storage_error',
        `trust-circle file at ${this.path} has unexpected shape`,
      );
    }
    this.cache = parsed;
    return this.cache;
  }

  /** Persist the current state atomically (write then rename). */
  save(state: TrustCircleFile): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const payload = JSON.stringify({ ...state, version: FILE_VERSION }, null, 2);
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, payload, { encoding: 'utf8' });
    renameSync(tmp, this.path);
    this.cache = { ...state, version: FILE_VERSION };
    log('saved trust-circle (%d members, %d pending) to %s',
      Object.keys(state.members).length,
      Object.keys(state.pendingInvites).length,
      this.path);
  }

  // --- Member ops ---

  addMember(member: TrustCircleMember): void {
    const state = this.load();
    const { peerId, ...rest } = member;
    state.members[peerId] = rest;
    this.save(state);
  }

  removeMember(peerId: string): boolean {
    const state = this.load();
    if (!(peerId in state.members)) return false;
    delete state.members[peerId];
    this.save(state);
    return true;
  }

  getMember(peerId: string): TrustCircleMember | undefined {
    const state = this.load();
    const row = state.members[peerId];
    if (!row) return undefined;
    return { peerId, ...row };
  }

  listMembers(): TrustCircleMember[] {
    const state = this.load();
    return Object.entries(state.members).map(([peerId, row]) => ({ peerId, ...row }));
  }

  // --- Pending invite ops ---

  addPending(invite: PendingInvite): void {
    const state = this.load();
    const { token, ...rest } = invite;
    state.pendingInvites[token] = rest;
    this.save(state);
  }

  removePending(token: string): boolean {
    const state = this.load();
    if (!(token in state.pendingInvites)) return false;
    delete state.pendingInvites[token];
    this.save(state);
    return true;
  }

  getPending(token: string): PendingInvite | undefined {
    const state = this.load();
    const row = state.pendingInvites[token];
    if (!row) return undefined;
    return { token, ...row };
  }

  listPending(): PendingInvite[] {
    const state = this.load();
    return Object.entries(state.pendingInvites).map(([token, row]) => ({ token, ...row }));
  }
}

function emptyFile(): TrustCircleFile {
  return { version: FILE_VERSION, members: {}, pendingInvites: {} };
}

function isTrustCircleFile(v: unknown): v is TrustCircleFile {
  if (!v || typeof v !== 'object') return false;
  const obj = v as Record<string, unknown>;
  if (obj.version !== FILE_VERSION) return false;
  if (!obj.members || typeof obj.members !== 'object') return false;
  if (!obj.pendingInvites || typeof obj.pendingInvites !== 'object') return false;
  return true;
}
