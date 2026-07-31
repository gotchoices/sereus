import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import debug from 'debug';

import type { Donation, DonationFile, DonationStatus } from './types.js';
import { DonationError } from './types.js';

const log = debug('cadre:host:donation-store');

const FILE_VERSION = 1;

/**
 * Statuses that count a donation as "live" against a grant's `maxNodes` quota.
 * `error` and `terminated` donations are kept for audit but do NOT count.
 */
const LIVE_STATUSES: ReadonlySet<DonationStatus> = new Set<DonationStatus>([
  'provisioning',
  'awaiting_seed',
  'seeded',
]);

/**
 * Atomic JSON store for `donations.json` — one row per donated node. Modelled on
 * `grant-store.ts`: a single file written to `<path>.tmp` then renamed, with an
 * in-memory cache keyed by donation id.
 *
 * **Persists `seedToken`.** Unlike the orchestrator handle (whose `toPersisted`
 * deliberately omits the freshly-minted-per-spawn seed token), this record keeps
 * it: if the host restarts in the request→seed gap, only the donation row can
 * reproduce the bearer needed to present the seed to the node. See
 * `tickets/complete/cadre-provider-seed-endpoint-never-populated.md`.
 *
 * Concurrency assumption: only one cadre-host process owns a given rootDir
 * (the orchestrator already enforces this). No file-locking primitives.
 *
 * NOTE: every method here is **synchronous**, and `DonationService` depends on
 * that for correctness, not just convenience — each of its long operations
 * re-reads a record and writes it back with no `await` in between, which is only
 * atomic against the event loop while `get`/`put` cannot yield. Giving this class
 * an async write path would silently reopen the resurrect-an-ended-loan races
 * those re-reads exist to close, and the tests that guard them would still pass.
 */
export class DonationStore {
  private readonly path: string;
  private cache: DonationFile | null = null;

  constructor(rootDir: string) {
    mkdirSync(rootDir, { recursive: true });
    this.path = join(rootDir, 'donations.json');
  }

  filePath(): string {
    return this.path;
  }

  /**
   * Load (with caching). A missing file returns an empty store. A
   * present-but-malformed file throws rather than silently wiping — losing the
   * records would orphan live child processes (their seed tokens gone).
   */
  load(): DonationFile {
    if (this.cache) return this.cache;
    if (!existsSync(this.path)) {
      this.cache = emptyFile();
      return this.cache;
    }
    let raw: string;
    try {
      raw = readFileSync(this.path, 'utf8');
    } catch (err) {
      throw new DonationError(
        'storage_error',
        `failed to read donations file at ${this.path}: ${(err as Error).message}`,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new DonationError(
        'storage_error',
        `donations file at ${this.path} is not valid JSON: ${(err as Error).message}`,
      );
    }
    if (!isDonationFile(parsed)) {
      throw new DonationError(
        'storage_error',
        `donations file at ${this.path} has unexpected shape`,
      );
    }
    this.cache = parsed;
    return this.cache;
  }

  /** Persist the current state atomically (write then rename). */
  save(state: DonationFile): void {
    // NOTE: rewrites the whole donations.json on every mutation. Fine at
    // household scale (a handful of donated nodes); if counts ever grow large,
    // switch to an append/compact log or per-id files.
    mkdirSync(dirname(this.path), { recursive: true });
    const payload = JSON.stringify({ ...state, version: FILE_VERSION }, null, 2);
    const tmp = `${this.path}.tmp`;
    try {
      writeFileSync(tmp, payload, { encoding: 'utf8' });
      renameSync(tmp, this.path);
    } catch (err) {
      throw new DonationError(
        'storage_error',
        `failed to write donations file at ${this.path}: ${(err as Error).message}`,
      );
    }
    this.cache = { ...state, version: FILE_VERSION };
    log('saved donations (%d) to %s', Object.keys(state.donations).length, this.path);
  }

  /** Insert or replace a donation row. */
  put(donation: Donation): void {
    const state = this.load();
    const { id, ...rest } = donation;
    state.donations[id] = rest;
    this.save(state);
  }

  get(id: string): Donation | undefined {
    const state = this.load();
    const row = state.donations[id];
    if (!row) return undefined;
    return { id, ...row };
  }

  list(): Donation[] {
    const state = this.load();
    return Object.entries(state.donations).map(([id, row]) => ({ id, ...row }));
  }

  /** All donations authorized by a given grant token. */
  listByGrant(grantToken: string): Donation[] {
    return this.list().filter((d) => d.grantToken === grantToken);
  }

  remove(id: string): boolean {
    const state = this.load();
    if (!(id in state.donations)) return false;
    delete state.donations[id];
    this.save(state);
    return true;
  }

  /**
   * The authoritative live-node tally the grant validator consumes: donations
   * under `grantToken` in a live status (`provisioning` / `awaiting_seed` /
   * `seeded`). `error` and `terminated` rows are excluded.
   */
  liveNodeCount(grantToken: string): number {
    return this.list().filter(
      (d) => d.grantToken === grantToken && LIVE_STATUSES.has(d.status),
    ).length;
  }
}

function emptyFile(): DonationFile {
  return { version: FILE_VERSION, donations: {} };
}

function isDonationFile(v: unknown): v is DonationFile {
  if (!v || typeof v !== 'object') return false;
  const obj = v as Record<string, unknown>;
  if (obj.version !== FILE_VERSION) return false;
  if (!obj.donations || typeof obj.donations !== 'object') return false;
  return true;
}
