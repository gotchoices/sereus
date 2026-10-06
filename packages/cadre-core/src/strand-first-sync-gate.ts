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
 * and the instance goes `'active'`. A machine whose store already holds the Header and every
 * app table (a founder, and normally a restart or a hibernation resume) passes the probe on
 * the first try and is never gated, so offline-first writes on a machine that has synced
 * before keep working.
 *
 * "Has synced before" is decided by what the local store actually holds, not by whether this
 * machine once read the strand: a machine that left soon after its first sync can hold less
 * than it read, and is then gated like a joiner. The re-attach measurement on
 * {@link DEFAULT_STRAND_FIRST_SYNC_TIMEOUT_MS} saw exactly that — a machine back over the store
 * it kept, without the `Strand.Header` collection it had read before it left. Gating it is
 * right: writing into a collection this machine does not hold would fork it.
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
 * Owned by `StrandInstanceManager`: created in `buildStrandRuntime` for every launch, armed
 * only for a non-founder launch whose first probe fails, stopped and dropped in
 * `releaseRuntime` (so a quiesce → resume rebuild re-probes over the same store), and opened
 * by `publishDatabase` whenever the database is published without its loop — a launch that
 * needed no gate, or a founder request that ran the bootstrap against the still-gated
 * database (`foundExistingStrand`).
 *
 * NOTE: the gate covers app and membership tables, not the schema catalog. A launch with no
 * seed writes the catalog collection (`optimystic/schema` plus two hash-named blocks,
 * measured 2026-09-16) alone, during `connectToStrand`'s schema apply, before any peer
 * contact. (One with a seed cannot until a seed peer answers — Optimystic refuses the
 * absence ruling — and is rebuilt on a timer by `StrandInstanceManager.deferUnreachableJoin`.) That is the same "two histories under one id" shape this gate
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
 * How long `CadreNode.addStrand` waits for a machine's first sync before rejecting with
 * {@link StrandAwaitingFirstSyncError}. It has to cover the slowest attach sereus carries,
 * which is not a first join: a machine RE-attaching through a relay on a slow link can take
 * longer than one joining for the first time.
 *
 * Measured over a DIRECT connection (2026-09-16): the joiner reads the founder's rows about
 * 1.3 s after `addStrand` would previously have resolved. That is the fast case, and it is not
 * what this budget has to cover.
 *
 * Every harness figure below was taken on one shape: one Windows developer machine, two
 * relay-only `CadreNode`s (`listenAddrs: []`) on a shared loopback dedicated relay, with a
 * one-way per-frame outbound delay applied to every websocket by
 * `integration-tests/src/harness/ws-latency.ts` in `pipelined` mode — frames stay overlapped
 * in flight, so the figure is latency and bandwidth stays unlimited; the harness's other mode
 * (`serial`) is a per-socket frame-rate cap and its delays are NOT comparable
 * (`docs/testing.md` → "Link latency"). Two delays were used: 900 ms one-way, a round trip
 * near 1.8 s, the band sereus supported first; and 1 500 ms one-way, the supported 3-second
 * round trip. Times run from the `addStrand` call to writable.
 *
 * FRESH JOIN at 900 ms (2026-09-26), a machine holding nothing of the strand yet: 23, 27, 31
 * and 41 s over four runs at optimystic's 1000 ms cohort read deadline, and 35, 42 and 46 s
 * over three runs at a 5000 ms one; the re-attach scenario below later took 38.7, 38.7 and
 * 56.9 s for the same fresh join. At that delay the 5000 ms band, 35-57 s, was the one in
 * force: sereus then declared 5000 ms, because 1000 ms is shorter than one round trip on
 * that link and leaves every cohort read with no answer to corroborate against. Widening that
 * deadline makes a consult against a peer that cannot answer cost longer, and this phase runs
 * several of those — which is why both bands are recorded here, and why a change to either
 * number has to be weighed against the other.
 *
 * AT THE SUPPORTED LINK ON `@optimystic/*` 1.8.0 (2026-09-29), 1 500 ms one-way, the read
 * deadline derived from the declared link at 7 000 ms (`cohortReadDeadlineMs` in
 * `link-budget.ts`; the plugin's `COHORT_READ_DEADLINE_MS` is the same number), and cadre
 * stating its declared link to Optimystic, the same scenario, all under the coordinator debug
 * channel:
 *  - Fresh join: writable at 63.9 and 63.8 s over two runs, the row A wrote before the join
 *    readable at 88.0 s in both. B's strand node connected to A's at 18.3-18.4 s. No read was
 *    declined: every consult on B completed, 6.03-6.05 s after the one before it (two link
 *    round trips each). The time did not fall, because B's consults ran one after another and
 *    the gate opened only after the seventh.
 *  - Re-attach over the store B kept: no longer bimodal. All 3 runs held everything and came
 *    up writable at launch (9.2 s), and the row A wrote while B was away was readable at
 *    35.6 s in each, read with one consult for the collection and its data block together. No
 *    read was declined during the attach. The empty-store arm was not re-run.
 *
 * AT THE SUPPORTED LINK ON `@optimystic/*` 1.7.0 (2026-09-29), same delay, deadline and
 * scenario, before cadre stated its link to Optimystic:
 *  - Fresh join: writable at 52.1 and 82.1 s over two runs, and 63.6 s in a third run under
 *    the coordinator debug channel; a fourth run with the deadline set back to 5 000 ms took
 *    70.2 s. B's strand node connected to A's at 18.2-18.3 s in every run at this delay. The
 *    row A wrote before the join was readable at 67-124 s.
 *  - Re-attach over the store B kept: bimodal again. 1 of 3 runs held everything and came up
 *    writable at launch (9.1 s; the row at 33.4 s). The other 2 were gated and writable at
 *    75.7 and 78.7 s (the row at 120.8 and 175.0 s). The empty-store arm was not re-run; at
 *    900 ms it matched a fresh join.
 *  - What that band was NOT: a measure of the 7 000 ms deadline. Every cohort consult in those
 *    runs ended 3.00-3.02 s after the one before it, at 5 000 and 7 000 alike, because
 *    Optimystic's then-fixed 3 000 ms request dial deadline also bounded the protocol
 *    negotiation on an already-open connection, and one negotiation is one link round trip —
 *    3 s here. So it was the band of a join whose every consult failed and whose blocks
 *    arrived by peer-join backfill.
 *
 * RE-ATTACH at 900 ms (2026-09-26, the opt-in
 * `integration-tests/src/scenarios/strand-reattach-first-sync-measure.integration.ts` — re-run
 * it before changing this number): B attached once on an undelayed link, left with
 * `stopStrand`, A wrote while it was away, the delay was raised, and B called `addStrand`
 * again.
 *  - Over an EMPTY store (one minted per launch, cadre's default with no storage provider):
 *    gated in all four runs and writable at 38.7-56.8 s, the same as a fresh join.
 *  - Over the store it KEPT (a phone with durable storage), bimodal. In 3 of 8 runs the store
 *    held everything and the launch came up writable (5.6 s, the launch itself). In the other
 *    5 it lacked the `Strand.Header` collection B had read on its first attach, so B was gated
 *    like a joiner and became writable at 64.1-78.7 s — the slowest attach measured, about
 *    twice a fresh join. Why syncing over a partial store is slower sits inside optimystic
 *    (`tickets/blocked/report-reattach-over-partial-replica-to-optimystic`).
 *  - Neither a redial nor catching up on missed writes explains the time: B's strand node
 *    connected to A's at 11 s in every arm, fresh join included, and a run with 20 missed
 *    writes fell inside the run-to-run spread of those with 1.
 * This budget covers WRITABLE, not caught up: in the gated kept-store runs the row A wrote
 * while B was away became readable only at 140-162 s (121-175 s at the supported link).
 *
 * Two samples from outside this harness, neither reproduced here and neither discarded: a
 * reporter's re-attach of the same shape (optimystic #22; their harness, storage and delay
 * injector are unknown to us) opened the gate at about 150 s, after the previous 120 s budget
 * had already rejected; and a real Galaxy S7 joining fresh through relay.sereus.org took 178 s.
 *
 * 300 s clears the worst harness sample (82 s, a fresh join at the supported link on 1.7.0; the
 * worst on 1.8.0 is 64 s) by about 3.6x, the reporter's re-attach by 2x and the device join by
 * about 1.7x. Kept at 300 s on 2026-09-29, and again after the 1.8.0 re-measure the same day,
 * by the rule that re-measure applied and the next one should: keep it while the
 * worst harness sample is at most 100 s, which holds a margin of at least 3x; otherwise raise
 * it to 3x the worst sample, rounded up to the next whole minute. 240 s was rejected earlier:
 * it clears the device join by only 1.35x, and that sample was not a re-attach. History: the
 * original 30 s sat INSIDE the 1000 ms fresh band and refused about half of those joins while
 * their sync was progressing normally; 120 s was sized from fresh joins only and refused the
 * reporter's re-attach.
 *
 * NOTE: accepted tradeoff — what 300 s costs. This wait is what an app's `addStrand` sits in
 * before it is told "not yet", so a strand none of whose members is reachable at all takes five
 * minutes to report instead of two. The slow report was weighed against refusing attaches that
 * were working, and the refusal is the worse failure. The cost is bounded — the rejection is
 * retryable, the strand stays launched and keeps probing, and `strand:writable` fires the
 * moment the sync lands, so an app that listens for the event rather than awaiting the call is
 * unaffected either way. Revisit if the gate ever learns whether ANY other member is connected:
 * "no peer at all" could then be reported at once and this budget would only ever be spent on a
 * sync that is actually in progress — worth more the longer this budget gets.
 */
// eslint-disable-next-line no-restricted-syntax -- measured, not derived: the bands above, from integration-tests' strand-reattach-first-sync-measure.integration.ts; a whole first sync has no round-trip count
export const DEFAULT_STRAND_FIRST_SYNC_TIMEOUT_MS = 300_000;

/** Embedder-facing tuning for the gate, threaded from `CadreNodeConfig.strandFirstSync`. */
export interface StrandFirstSyncConfig {
  /**
   * Default wait for `CadreNode.addStrand` (and `whenStrandWritable`) before a machine whose
   * first sync has not completed is reported as not yet writable. Default
   * {@link DEFAULT_STRAND_FIRST_SYNC_TIMEOUT_MS}.
   */
  timeoutMs?: number;
  /** Probe cadence while gated. Default {@link DEFAULT_STRAND_FIRST_SYNC_POLL_MS}. */
  pollIntervalMs?: number;
}

/**
 * Thrown by `CadreNode.addStrand` / `whenStrandWritable` when a machine has not received the
 * strand's data from another member within the wait budget — because no other member is
 * reachable, or because one is and the sync is still arriving over a slow link; the gate
 * cannot tell the two apart. RETRYABLE: the strand stays launched and keeps probing, so a
 * later `addStrand` (or `whenStrandWritable`) for the same strand completes the attach once
 * the data has arrived; the `strand:writable` event fires at that moment too.
 */
export class StrandAwaitingFirstSyncError extends Error {
  readonly strandId: string;
  readonly waitedMs: number;

  constructor(strandId: string, waitedMs: number) {
    super(
      `Strand ${strandId} is not writable yet: this machine has not yet received the strand's data ` +
      `from another member (waited ${waitedMs} ms). Either no other member is reachable, or the ` +
      'link to one is slow and the sync is still in progress. The strand stays launched and keeps ' +
      'trying — call addStrand or whenStrandWritable(strandId) again to keep waiting, or listen ' +
      "for the 'strand:writable' event."
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
   * Open without the probe loop: the caller is publishing the database itself — a launch
   * whose first probe passed (or a founder's), which never armed the loop, or a founder
   * bootstrap just run against the gated database. Stops the loop; `onHeaderHeld` is NOT
   * invoked.
   */
  open(): void {
    if (this.opened) return;
    this.opened = true;
    this.stop();
    log('[%s] database published by the caller; first-sync gate not needed or force-opened', this.deps.label);
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
    const held = await this.probeHeld();
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

  /**
   * One probe's answer, with a throw from OUTSIDE {@link strandFirstSyncComplete}'s own read
   * guards — the `App` schema lookup, or `getDatabase()` itself — reported as "not yet" like
   * any failing read. The loop is scheduled from `void this.probe()`, so an escaping rejection
   * would be unhandled AND leave nothing scheduled: the strand would stay gated for the whole
   * `timeoutMs` and never recover, which is the one failure this gate must not have.
   */
  private async probeHeld(): Promise<boolean> {
    try {
      return await strandFirstSyncComplete(this.deps.database.getDatabase(), this.deps.label);
    } catch (error) {
      log('[%s] first-sync probe threw (treated as not yet synced): %s', this.deps.label,
        error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      this.probing = false;
    }
  }
}
