/**
 * The first-sync write gate for a JOINING machine.
 *
 * A machine that has never received anything from another member of a strand must not
 * commit to it. With no strand peer connected, Optimystic's cohort for every block is the
 * machine itself, so the first write to a table finds no collection locally and INVENTS
 * one — exactly what a founder writing alone legitimately does. When the connection comes
 * up, two independently created histories share one collection id: Optimystic keeps one and
 * drops the other's commits, or never reconciles them at all. The joiner's own rows silently
 * vanish (`joining-machine-writes-before-first-sync-fork-tables`). Optimystic cannot tell a
 * founder from a joiner; sereus can, because the launch knows whether it is founding.
 *
 * The invariant this module enforces: **a machine that has never held this strand's
 * `Strand.Header` row, and has not read every `App` table once, must not commit to it.**
 * The founder writes the Header in its bootstrap; every other machine can only receive it
 * from a peer, so "no local Header" means "never synced". The gate therefore holds the
 * freshly initialized `StrandDatabase` back from the app — `StrandInstance.database` stays
 * unset and the instance reports `'syncing'` — and probes on a cadence until the Header is
 * readable AND a read of each app table settles, at which point the database is published
 * and the instance goes `'active'`. A machine that already holds the Header (a restart, a
 * hibernation resume, a founder) passes the probe on the first try and is never gated, so
 * offline-first writes on a machine that has synced before keep working.
 *
 * Why the app tables too: the Header is ONE collection. It reaches a joiner ahead of the
 * founder's app-table collections (peer-join backfill and pull-on-read deliver those
 * separately), and a write to a table whose collection this machine has not yet fetched
 * invents one exactly as a lone joiner did. Measured on the reference chat schema
 * (2026-09-16, direct connections, Header-only probe): the joiner's participant + message
 * written the instant `addStrand` resolved diverged in 3 of 4 runs. Reading each table once
 * pulls its collection while the founder is reachable, so the write that follows appends.
 *
 * Every probe is a read (`Strand.Header`, then `select count(1)` on each `App` table). Reads
 * never invent a collection (Optimystic's `Collection.open` resolves undefined on an
 * authoritatively absent header, and throws on an unreachable one), so probing is safe to
 * repeat and a throw is just "not yet". A table nobody has written yet reads as absent on
 * every machine; the first write to it still creates its collection — see `docs/strands.md`
 * ("Joining") for that residual.
 *
 * Owned by `StrandInstanceManager`: created in `buildStrandRuntime` for a non-founder launch
 * whose first probe finds no Header, stopped and dropped in `releaseRuntime` (so a quiesce →
 * resume rebuild re-probes over the same store), and force-opened when a founder request
 * runs the bootstrap against the still-gated database (`foundExistingStrand`).
 *
 * NOTE: the gate covers app and membership tables, not the schema catalog. Every launch —
 * joiner or founder — writes the catalog collection (`optimystic/schema` plus two
 * hash-named blocks, measured 2026-09-16) alone, during `connectToStrand`'s schema apply,
 * before any peer contact. That is the same "two histories under one id" shape this gate
 * exists to prevent, and it is only safe because both sides derive byte-identical content
 * from the same schema text. If the catalog ever carries per-machine or ordering-dependent
 * content (optimystic's own `0.5-same-named-tables-in-two-schemas-share-storage` re-keys
 * it), a joiner's catalog will fork against the founder's — gate the schema apply on the
 * Header too, or have optimystic open the catalog read-only when a peer already holds it.
 */

import debug from 'debug';
import type { Database } from '@quereus/quereus';
import type { StrandDatabase } from './strand-database.js';
import { defaultTimeoutScheduler, type TimeoutScheduler } from './timeout-scheduler.js';

const log = debug('sereus:cadre:strand-first-sync');

/** How often a gated launch re-probes (`Strand.Header`, then every `App` table) while waiting for its first sync. */
export const DEFAULT_STRAND_FIRST_SYNC_POLL_MS = 500;

/**
 * How long `CadreNode.addStrand` waits for a joining machine's first sync before rejecting
 * with {@link StrandAwaitingFirstSyncError}. Measured: over a direct connection the
 * joiner reads the founder's rows about 1.3 s after `addStrand` would previously have
 * resolved; a relayed path is slower, and a phone that just redeemed an invitation has the
 * host reachable moments ago, so 30 s is generous without leaving an app hanging.
 */
export const DEFAULT_STRAND_FIRST_SYNC_TIMEOUT_MS = 30_000;

/** Embedder-facing tuning for the gate, threaded from `CadreNodeConfig.strandFirstSync`. */
export interface StrandFirstSyncConfig {
  /**
   * Default wait for `CadreNode.addStrand` (and `whenStrandWritable`) before a joining
   * machine that has reached no other member is reported as not yet writable. Default
   * {@link DEFAULT_STRAND_FIRST_SYNC_TIMEOUT_MS}.
   */
  timeoutMs?: number;
  /** Probe cadence while gated. Default {@link DEFAULT_STRAND_FIRST_SYNC_POLL_MS}. */
  pollIntervalMs?: number;
}

/**
 * Thrown by `CadreNode.addStrand` / `whenStrandWritable` when a joining machine has not
 * received the strand's data from any other member within the wait budget. RETRYABLE: the
 * strand stays launched and keeps probing, so a later `addStrand` (or `whenStrandWritable`)
 * for the same strand completes the attach once another member is reachable; the
 * `strand:writable` event fires at that moment too.
 */
export class StrandAwaitingFirstSyncError extends Error {
  readonly strandId: string;
  readonly waitedMs: number;

  constructor(strandId: string, waitedMs: number) {
    super(
      `Strand ${strandId} is not writable yet: no member of this strand has been reachable ` +
      `since this machine joined, so it has not received the strand's data (waited ${waitedMs} ms). ` +
      'The strand stays launched and keeps trying — call addStrand again, or wait for the ' +
      "'strand:writable' event, once another member is reachable."
    );
    this.name = 'StrandAwaitingFirstSyncError';
    this.strandId = strandId;
    this.waitedMs = waitedMs;
  }
}

/**
 * Whether this machine holds the strand's `Strand.Header` row — the "has synced at least
 * once (or founded)" signal. A read, never a write: it cannot invent the collection. A
 * throwing read (an unreachable cohort mid-sync, a store still hydrating) reports `false`
 * with a log, since the caller's only response to either answer is "probe again".
 */
export async function strandHeaderHeld(db: Database, label: string): Promise<boolean> {
  try {
    for await (const row of db.eval('select count(1) as Count from Strand.Header')) {
      return ((row.Count as number) ?? 0) > 0;
    }
    return false;
  } catch (error) {
    log('[%s] Header probe failed (treated as not yet held): %s', label,
      error instanceof Error ? error.message : String(error));
    return false;
  }
}

/** The tables the sApp declared in the `App` schema, by name; views excluded. */
function appTableNames(db: Database): string[] {
  const app = db.schemaManager.getSchema('App');
  return app ? Array.from(app.getAllTables()).filter((table) => !table.isView).map((table) => table.name) : [];
}

/**
 * Whether a read of every `App` table settles on this machine — the "each app collection
 * has been fetched from the cohort, or is authoritatively absent" signal. Only a throwing
 * read (an unreachable cohort) reports `false`; an empty table is a settled read.
 */
export async function appTablesReadable(db: Database, label: string): Promise<boolean> {
  for (const table of appTableNames(db)) {
    try {
      for await (const _row of db.eval(`select count(1) as Count from App."${table}"`)) {
        break;
      }
    } catch (error) {
      log('[%s] App.%s probe failed (treated as not yet synced): %s', label, table,
        error instanceof Error ? error.message : String(error));
      return false;
    }
  }
  return true;
}

/**
 * The gate's whole probe: the Header is held AND every app table has been read once. The
 * app tables are read only once the Header is — a joiner with no peer would otherwise pay
 * one failing network read per table per probe for nothing.
 */
export async function strandFirstSyncComplete(db: Database, label: string): Promise<boolean> {
  return await strandHeaderHeld(db, label) && await appTablesReadable(db, label);
}

export interface StrandFirstSyncGateDeps {
  /** Log tag naming which strand this gate holds (the strand id). */
  label: string;
  /** The initialized database being held back from the app until the Header is held. */
  database: StrandDatabase;
  /**
   * Called exactly once, on the gate's own probe loop, when the first sync completes.
   * NOT called by {@link StrandFirstSyncGate.open} — a caller that force-opens the gate
   * (a founder bootstrap it just ran) publishes the database itself.
   */
  onHeaderHeld: () => void;
  /** Timer seam for the probe loop; omit for real (unref'd) timeouts. */
  scheduler?: TimeoutScheduler;
}

/**
 * Holds one launch's `StrandDatabase` until {@link strandFirstSyncComplete}. Probes are
 * sequential (the next is scheduled only after the previous read settles), so a slow
 * network read never stacks probes.
 */
export class StrandFirstSyncGate {
  private readonly scheduler: TimeoutScheduler;
  private readonly pollIntervalMs: number;
  private timer: unknown;
  private stopped = false;
  private opened = false;
  private probing = false;

  constructor(private readonly deps: StrandFirstSyncGateDeps, config?: StrandFirstSyncConfig) {
    this.scheduler = deps.scheduler ?? defaultTimeoutScheduler;
    this.pollIntervalMs = config?.pollIntervalMs ?? DEFAULT_STRAND_FIRST_SYNC_POLL_MS;
  }

  /** The database this gate is holding back. */
  get database(): StrandDatabase {
    return this.deps.database;
  }

  /** True once the Header was seen (or the gate was force-opened); the loop is then done. */
  get isOpen(): boolean {
    return this.opened;
  }

  /** Arm the probe loop. The first probe runs after one interval — the caller already probed once. */
  start(): void {
    if (this.stopped || this.opened || this.timer !== undefined) return;
    this.schedule();
    log('[%s] first-sync gate armed: no Strand.Header held yet; probing every %dms',
      this.deps.label, this.pollIntervalMs);
  }

  /**
   * Force-open: the caller has just written the Header itself (a founder bootstrap run
   * against the gated database). Stops the loop; `onHeaderHeld` is NOT invoked.
   */
  open(): void {
    if (this.opened) return;
    this.opened = true;
    this.stop();
    log('[%s] first-sync gate opened by the caller (Header written locally)', this.deps.label);
  }

  /** Disarm the loop; a probe already in flight completes and is then ignored. */
  stop(): void {
    this.stopped = true;
    if (this.timer !== undefined) {
      this.scheduler.clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  private schedule(): void {
    this.timer = this.scheduler.setTimeout(() => {
      this.timer = undefined;
      void this.probe();
    }, this.pollIntervalMs);
  }

  private async probe(): Promise<void> {
    if (this.stopped || this.opened || this.probing) return;
    this.probing = true;
    const held = await strandFirstSyncComplete(this.deps.database.getDatabase(), this.deps.label)
      .finally(() => { this.probing = false; });
    // Re-check after the await: a release or a force-open may have landed mid-read.
    if (this.stopped || this.opened) return;
    if (!held) {
      this.schedule();
      return;
    }
    this.opened = true;
    this.stop();
    log('[%s] first-sync gate opened: Strand.Header and every App table read from a peer', this.deps.label);
    this.deps.onHeaderHeld();
  }
}
