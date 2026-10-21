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
 * `Strand.Header` row, and has not read every `Strand` and `App` table once, must not commit
 * to it.** The founder writes the Header in its bootstrap; every other machine can only receive
 * it from a peer, so "no local Header" means "never synced". The gate therefore holds the
 * freshly initialized `StrandDatabase` back from the app — `StrandInstance.database` stays
 * unset and the instance reports `'syncing'` — and probes, whenever data lands in the strand's
 * store and on a backstop timer, until the Header is readable AND a read of each other table
 * settles, at which point the database is published and the instance goes `'active'`. A
 * machine whose store already holds the Header and every other table (a founder, and normally
 * a restart or a hibernation resume) passes the probe on the first try and is never gated, so
 * offline-first writes on a machine that has synced before keep working.
 *
 * "Has synced before" is decided by what the local store actually holds, not by whether this
 * machine once read the strand: a machine that left soon after its first sync can hold less
 * than it read, and is then gated like a joiner. The re-attach measurement on
 * {@link DEFAULT_STRAND_FIRST_SYNC_TIMEOUT_MS} saw exactly that — a machine back over the store
 * it kept, without the `Strand.Header` collection it had read before it left. Gating it is
 * right: writing into a collection this machine does not hold would fork it.
 *
 * Why the other tables too: the Header is ONE collection. It reaches a joiner ahead of the
 * founder's other collections (peer-join backfill and pull-on-read deliver those separately),
 * and a write to a table whose collection this machine has not yet fetched invents one exactly
 * as a lone joiner did. Measured on the reference chat schema (2026-09-16, direct connections,
 * Header-only probe): the joiner's participant + message written the instant `addStrand`
 * resolved diverged in 3 of 4 runs. The same holds for the `Strand` tables, which reach a joiner
 * by the same backfill: the membership loop writes `ConsumedInvite`, `Member` and `MemberPeer`
 * about a second after publication, and a manager writes `Invite`, `CancelledInvite`, `Manager`
 * and `Revocation`. Reading each table once pulls its collection while the founder is
 * reachable, so the write that follows appends.
 *
 * Every probe read is `select 1 from <table> limit 1` (`Strand.Header`, then each other `Strand`
 * table, then each `App` table, skipping those already seen settled): opening the table fetches
 * its collection header, and one row walks the root to the first leaf. Reads never commit a
 * collection (one ruled authoritatively absent is staged empty in memory only, and an
 * unreachable one throws), so probing is safe to repeat and a throw is just "not yet". Every
 * table declared at founding has a collection from the start (the founder bootstrap commits the
 * rest empty before its founding transaction writes the Header and the membership rows), so a
 * probe read fetches it; a table a later schema version adds reads as absent until its first
 * write creates the collection — see `docs/strands.md` ("Joining") for that residual.
 *
 * Owned by `StrandInstanceManager`: created in `buildStrandDatabase` for every database build, armed
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
 * absence ruling — and retries its database build on a timer, `StrandInstanceManager.deferUnreachableJoin`.) That is the same "two histories under one id" shape this gate
 * exists to prevent, and it is only safe because both sides derive byte-identical content
 * from the same schema text. If the catalog ever carries per-machine or ordering-dependent
 * content (optimystic's own `0.5-same-named-tables-in-two-schemas-share-storage` re-keys
 * it), a joiner's catalog will fork against the founder's — gate the schema apply on the
 * Header too, or have optimystic open the catalog read-only when a peer already holds it.
 */

import debug from 'debug';
import type { Database } from '@quereus/quereus';
import type { StrandDatabase } from './strand-database.js';
import { scheduleRuns, TABLE_CHANGE_COALESCE_MS, type TableChangeWatch } from './table-change-watch.js';
import { defaultTimeoutScheduler, type TimeoutScheduler } from './timeout-scheduler.js';

const log = debug('sereus:cadre:strand-first-sync');

/**
 * How long a gated launch goes without probing when no data lands in the strand's store: the
 * gate probes when data arrives, and this long after its last probe settled when none has. It
 * covers a probe that failed for a reason no storage event follows — a consult that missed its
 * deadline while the founder held the block, or a push that never comes.
 *
 * Why 2 s: arrivals wake the gate, so this timer is the fallback rather than the main path. At
 * the supported 3 s link round trip one consult takes about 6 s (two round trips, per the 1.8.0
 * measurements on {@link DEFAULT_STRAND_FIRST_SYNC_TIMEOUT_MS}), so a 2 s idle gap after a failed
 * probe adds at most a third of one probe round, and it is under 1% of that 360 s budget. Shorter
 * brings back the cost of polling (the gate re-probed every 500 ms before it woke on arrivals);
 * much longer (5 s) delays the case with no storage event by most of a probe round for nothing.
 */
export const DEFAULT_STRAND_FIRST_SYNC_BACKSTOP_MS = 2_000;

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
 * AT THE SUPPORTED LINK ON `@optimystic/*` 1.17.0 (2026-10-21), 1 500 ms one-way, the same
 * scenario, one run per arm, with the probe reading every `Strand` table as well as the `App`
 * one (`debt-first-sync-gate-reads-every-strand-table`); the kept-store arm was not run:
 *  - Fresh join: writable at 28.7 s and NOT gated, as on 1.15.0.
 *  - Re-attach over an EMPTY store: writable at 105.8 and 105.9 s over two runs, the row A wrote
 *    while B was away readable at the same moment. B's first database build fails at 7.0 s (no
 *    seed peer has answered; `StrandInstanceManager.deferUnreachableJoin` retries it), B's strand
 *    node connects to A's at 15.1 s, the retried build's `connectToStrand` takes 21.2 s, and the
 *    launch's first probe then takes 72.6 s and passes with no read failing, so the gate never
 *    arms.
 *  - The same arm with the probe held to the Header and the `App` table (one run, otherwise the
 *    same build): that probe took 12.1 s, writable at 45.4 s, the row at 63.5 s. So the seven
 *    `Strand` reads cost about 60 s here, about 8.6 s each, against about 6 s for each of the
 *    baseline's two reads — more than the 42 s estimated from one 6 s consult per read.
 *
 * AT THE SUPPORTED LINK ON `@optimystic/*` 1.15.0 (2026-10-20), 1 500 ms one-way, the same
 * scenario, one fresh-join run, with the one-row probes woken by data landing in the store
 * (`first-sync-gate-probes-cheaply`; the full-count probes polled every 500 ms gave the same
 * figures):
 *  - Fresh join: writable at 28.8 s, and NOT gated. The launch waits 27.3 s in
 *    `connectToStrand` for its seed peer (it hydrates the founder's catalog, 9 tables), and by
 *    then the store holds the strand: the first probe passed in 24 ms.
 *  - The strand case of `message-cost-accounting` (two relay-only parties on loopback) agrees:
 *    B's `addStrand` took 471 ms, with 13 `sync` streams to A, 4 block reads from the Header
 *    probe and 8 from the table probes. Its two tables are empty, so a full count would fetch
 *    the same blocks as a one-row read.
 *  - Neither arms the gate, so neither times the woken path. That was checked on
 *    `harness-topology`'s cross-party share (a joiner launched with no seed, dialed afterwards)
 *    with the backstop raised to 10 s: the founder's join backfill push opened the gate 2.1 s
 *    after it armed.
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
 * 360 s clears the worst harness sample (105.9 s, a re-attach over an empty store at the
 * supported link on 1.17.0) by about 3.4x, the reporter's re-attach by 2.4x and the device join
 * by about 2x. Set by the rule every re-measure applies: keep it while the worst harness sample
 * is at most 100 s, which holds a margin of at least 3x; otherwise raise it to 3x the worst
 * sample, rounded up to the next whole minute. The 1.17.0 sample crossed 100 s, and 3x 105.9 s
 * is 318 s, so 360 s (2026-10-21); the 1.7.0 and 1.8.0 re-measures (worst 82 s and 64 s) had
 * kept the 300 s before it. 240 s was rejected earlier: it clears the device join by only 1.35x,
 * and that sample was not a re-attach. History: the original 30 s sat INSIDE the 1000 ms fresh
 * band and refused about half of those joins while their sync was progressing normally; 120 s
 * was sized from fresh joins only and refused the reporter's re-attach.
 *
 * NOTE: accepted tradeoff — what 360 s costs. This wait is what an app's `addStrand` sits in
 * before it is told "not yet", so a strand none of whose members is reachable at all takes six
 * minutes to report instead of two. The slow report was weighed against refusing attaches that
 * were working, and the refusal is the worse failure. The cost is bounded — the rejection is
 * retryable, the strand stays launched and keeps probing, and `strand:writable` fires the
 * moment the sync lands, so an app that listens for the event rather than awaiting the call is
 * unaffected either way. Revisit if the gate ever learns whether ANY other member is connected:
 * "no peer at all" could then be reported at once and this budget would only ever be spent on a
 * sync that is actually in progress — worth more the longer this budget gets.
 */
// eslint-disable-next-line no-restricted-syntax -- measured, not derived: the bands above, from integration-tests' strand-reattach-first-sync-measure.integration.ts; a whole first sync has no round-trip count
export const DEFAULT_STRAND_FIRST_SYNC_TIMEOUT_MS = 360_000;

/** Embedder-facing tuning for the gate, threaded from `CadreNodeConfig.strandFirstSync`. */
export interface StrandFirstSyncConfig {
  /**
   * Default wait for `CadreNode.addStrand` (and `whenStrandWritable`) before a machine whose
   * first sync has not completed is reported as not yet writable. Default
   * {@link DEFAULT_STRAND_FIRST_SYNC_TIMEOUT_MS}.
   */
  timeoutMs?: number;
  /**
   * While gated, probe this long after the last probe settled when no data has landed in the
   * strand's store. Default {@link DEFAULT_STRAND_FIRST_SYNC_BACKSTOP_MS}.
   */
  backstopMs?: number;
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
 * What one gate has established, kept for the gate's lifetime so a later probe reads only what
 * is still missing: whether the Header is held, and the tables (qualified, `'App.Message'`)
 * whose probe read settled. It only ever gains entries; a collection this machine holds stays
 * held.
 */
interface FirstSyncProgress {
  header: boolean;
  tables: Set<string>;
}

/** A table the probe reads. */
interface ProbedTable {
  schema: string;
  name: string;
}

const STRAND_HEADER: ProbedTable = { schema: 'Strand', name: 'Header' };

function qualifiedName(table: ProbedTable): string {
  return `${table.schema}.${table.name}`;
}

/** The read `openTables` in `quereus-plugin-sereus/src/empty-collections.ts` opens a collection with. */
function probeSql(table: ProbedTable): string {
  return `select 1 from ${table.schema}."${table.name}" limit 1`;
}

/**
 * Whether this machine holds the strand's `Strand.Header` row — the "has synced at least once
 * (or founded)" signal: held when the read returns a row. A throwing read (an unreachable cohort
 * mid-sync, a store still hydrating) reports `false` with a log, since the caller's only
 * response to either answer is "probe again".
 */
async function headerHeld(db: Database, label: string): Promise<boolean> {
  try {
    for await (const _row of db.eval(probeSql(STRAND_HEADER))) {
      return true;
    }
    return false;
  } catch (error) {
    log('[%s] Header probe failed (treated as not yet held): %s', label,
      error instanceof Error ? error.message : String(error));
    return false;
  }
}

/**
 * Whether a read of `table` settles on this machine — its collection has been fetched from the
 * cohort, or is authoritatively absent. Only a throwing read (an unreachable cohort, a block not
 * yet arrived) reports `false`; an empty table is a settled read, because the founder commits
 * an empty collection for every declared table.
 */
async function tableReadable(db: Database, table: ProbedTable, label: string): Promise<boolean> {
  try {
    for await (const _row of db.eval(probeSql(table))) {
      break;
    }
    return true;
  } catch (error) {
    log('[%s] %s probe failed (treated as not yet synced): %s', label, qualifiedName(table),
      error instanceof Error ? error.message : String(error));
    return false;
  }
}

/** The tables `schemaName` declares, views excluded; none when the schema is absent. */
function schemaTables(db: Database, schemaName: string): ProbedTable[] {
  const schema = db.schemaManager.getSchema(schemaName);
  return schema
    ? Array.from(schema.getAllTables()).filter((table) => !table.isView).map((table) => ({ schema: schemaName, name: table.name }))
    : [];
}

/**
 * Every table this machine may write, in probe order: the membership tables in `Strand` (a fixed
 * set every strand has) and then the sApp's in `App`. The Header is left out, compared
 * case-insensitively as SQL identifiers are, because it is read first and alone, and its read
 * means something else (held = a row came back).
 */
function writableTables(db: Database): ProbedTable[] {
  const header = STRAND_HEADER.name.toLowerCase();
  return [
    ...schemaTables(db, STRAND_HEADER.schema).filter((table) => table.name.toLowerCase() !== header),
    ...schemaTables(db, 'App')
  ];
}

/**
 * The gate's whole probe: the Header is held AND a read of every other `Strand` table and every
 * `App` table has settled. Reads only what `progress` does not record yet, and records what it
 * establishes.
 *
 * The Header is read first and alone: a joiner with no peer would otherwise pay one failing
 * network read per table for nothing. The tables are then read one after another, stopping at
 * the first that fails — the next probe starts there, and while the cohort is unreachable every
 * read of a block this machine lacks fails the same way, each after a consult.
 *
 * NOTE: the reads are serialized (Quereus's default), not `readConcurrency: 'committed'`, though
 * committed reads would let the table reads overlap. The Optimystic plugin's committed read
 * serves the tree the table already holds and never refreshes it from the network, and schema
 * apply initializes every table when the joiner has no catalog to hydrate, over an empty
 * collection staged in memory when no peer could answer. A committed probe of such a table reads
 * that empty collection as settled and opens the gate onto a fork. A serialized read refreshes
 * the tree first (`Collection.update`), which adopts the founder's log once a peer holds it.
 * Revisit if the plugin's committed read ever refreshes a tree it has never synced, or the gate
 * can ask Optimystic directly whether a collection is held.
 */
async function strandFirstSyncComplete(db: Database, label: string, progress: FirstSyncProgress): Promise<boolean> {
  if (!progress.header) {
    if (!await headerHeld(db, label)) {
      return false;
    }
    progress.header = true;
  }
  for (const table of writableTables(db)) {
    const name = qualifiedName(table);
    if (progress.tables.has(name)) {
      continue;
    }
    if (!await tableReadable(db, table, label)) {
      return false;
    }
    progress.tables.add(name);
  }
  return true;
}

export interface StrandFirstSyncGateDeps {
  /** Log tag naming which strand this gate holds (the strand id). */
  label: string;
  /** The initialized database being held back from the app until the first sync completes. */
  database: StrandDatabase;
  /**
   * Called exactly once, from the gate's own probe, when the first sync completes. NOT called
   * by {@link StrandFirstSyncGate.open} — a caller that force-opens the gate (a founder
   * bootstrap it just ran) publishes the database itself.
   */
  onHeaderHeld: () => void;
  /**
   * Subscribe `onChange` to every block landing in this strand's store — a push such as join
   * backfill, a fetched block, a commit — and return the unsubscribe. `buildStrandDatabase`
   * passes the strand node's `storageRepo.onAnyCollectionChange`. Omitted (test doubles, a node
   * without it), the gate probes on its backstop alone.
   */
  subscribeStorageChanges?: (onChange: () => void) => () => void;
  /** Timer seam for the probe schedule; omit for real (unref'd) timeouts. */
  scheduler?: TimeoutScheduler;
}

/**
 * Holds one launch's `StrandDatabase` until the first sync completes: the `Strand.Header` row is
 * held and a read of every `Strand` and `App` table has settled. What a probe established is
 * remembered for the gate's lifetime, so a later probe — the gate's own, after the caller's
 * {@link probeOnce} — reads only what is still missing. A gate lives for one database build, so a
 * hibernation wake or a deferred-join retry starts over, and over a store that holds everything
 * every read answers locally.
 *
 * While armed it probes when data lands in the strand's store
 * ({@link StrandFirstSyncGateDeps.subscribeStorageChanges}, coalesced over
 * `TABLE_CHANGE_COALESCE_MS`), and {@link StrandFirstSyncConfig.backstopMs} after its last probe
 * settled when nothing has. Probes run on `scheduleRuns`: one at a time, and data landing during
 * one produces exactly one more.
 *
 * The wake source is the node's storage-wide change feed rather than a table watch
 * (`StrandDatabase.watchTables`): the Optimystic plugin arms a table's replicated-change bridge
 * only after the table initializes successfully, and the tables the gate waits on are the ones
 * whose collection could not be fetched yet, so a table watch would not hear the push that
 * delivers them. Each strand has its own libp2p node and store, so the feed hears this strand
 * only.
 *
 * NOTE: a probe's reads dial the founder, through the relay when that is the only route, even
 * while the founder is unreachable: one run of `joiner-first-commit-over-slow-relay` logged 17
 * `hop connect denied` at the relay in about 10 s, each a few frames on the joiner's relay
 * connection, when the gate re-probed every 500 ms and re-read every table. It now probes on
 * arrivals and a 2 s backstop and skips what it holds, so expect fewer. If that connection ever
 * shows saturated while no strand member is connected, hold the probe while the strand member
 * redial (`strand-peer-redial.ts`) reports none connected.
 */
export class StrandFirstSyncGate {
  private readonly scheduler: TimeoutScheduler;
  private readonly backstopMs: number;
  private readonly progress: FirstSyncProgress = { header: false, tables: new Set() };
  private probes: TableChangeWatch | undefined;
  private unsubscribeStorage: (() => void) | undefined;
  private listening = false;
  /**
   * Data landed since the last probe started (or, before any probe, since {@link listen}), so one
   * is already due and will read it.
   */
  private landedSinceProbe = false;
  private stopped = false;
  private opened = false;

  constructor(private readonly deps: StrandFirstSyncGateDeps, config?: StrandFirstSyncConfig) {
    this.scheduler = deps.scheduler ?? defaultTimeoutScheduler;
    this.backstopMs = config?.backstopMs ?? DEFAULT_STRAND_FIRST_SYNC_BACKSTOP_MS;
  }

  /** The database this gate is holding back. */
  get database(): StrandDatabase {
    return this.deps.database;
  }

  /** True once the first sync completed (or the gate was force-opened); probing is then done. */
  get isOpen(): boolean {
    return this.opened;
  }

  /** Whether a block landed since the last probe started, or since {@link listen} when none has. */
  get heardDataSinceProbe(): boolean {
    return this.landedSinceProbe;
  }

  /**
   * Subscribe to the storage change feed ahead of {@link start}, so a block landing before the
   * gate is armed is heard: {@link heardDataSinceProbe} reports it, and `start` then probes at
   * once. For a first join, which skips the caller's first probe unless a member's push already
   * landed while the database was initializing.
   */
  listen(): void {
    if (this.stopped || this.opened || this.listening) return;
    this.listening = true;
    this.unsubscribeStorage = this.subscribeStorage();
  }

  /**
   * Arm the probe schedule. It probes when data lands, or one backstop later; and at once when
   * data already landed since the last probe (or since {@link listen}). Without `listen`, data
   * that landed between the caller's probe and this call raised no event the gate heard, so
   * that first backstop is what catches it.
   */
  start(): void {
    if (this.stopped || this.opened || this.probes !== undefined) return;
    this.probes = scheduleRuns(() => this.probe(), {
      label: `first-sync:${this.deps.label}`,
      backstopMs: this.backstopMs,
      scheduler: this.scheduler,
    });
    this.listen();
    if (this.landedSinceProbe) {
      this.probes.trigger(TABLE_CHANGE_COALESCE_MS);
    }
    log('[%s] first-sync gate armed: probing when data lands, and %dms after the last probe otherwise',
      this.deps.label, this.backstopMs);
  }

  /**
   * Open without probing: the caller is publishing the database itself — a launch whose first
   * probe passed (or a founder's), which never armed the schedule, or a founder bootstrap just
   * run against the gated database. Stops probing; `onHeaderHeld` is NOT invoked.
   */
  open(): void {
    if (this.opened) return;
    this.opened = true;
    this.stop();
    log('[%s] database published by the caller; first-sync gate not needed or force-opened', this.deps.label);
  }

  /** Disarm: unsubscribe and drop the schedule; a probe already in flight completes and is then ignored. */
  stop(): void {
    this.stopped = true;
    this.unsubscribeStorage?.();
    this.unsubscribeStorage = undefined;
    this.probes?.dispose();
    this.probes = undefined;
  }

  /**
   * One probe's answer, reading only what this gate has not yet seen settled. A throw from
   * OUTSIDE the probe's own read guards — a schema lookup, or `getDatabase()` itself — is
   * reported as "not yet" like any failing read, so the caller's first probe cannot fail the
   * launch over it and the gate's log says what happened.
   */
  async probeOnce(): Promise<boolean> {
    this.landedSinceProbe = false;
    try {
      return await strandFirstSyncComplete(this.deps.database.getDatabase(), this.deps.label, this.progress);
    } catch (error) {
      log('[%s] first-sync probe threw (treated as not yet synced): %s', this.deps.label,
        error instanceof Error ? error.message : String(error));
      return false;
    }
  }

  /**
   * NOTE: a probe's own reads can land blocks (a fetched block, a read-repair), which fires this
   * feed and schedules one follow-up probe. Each follow-up means a block newly arrived, so they
   * stop when nothing new lands; if gated launches ever show probe storms in the logs, ignore
   * events while a probe is in flight.
   */
  private subscribeStorage(): (() => void) | undefined {
    const subscribe = this.deps.subscribeStorageChanges;
    if (!subscribe) {
      log('[%s] no storage change feed on this node; probing every %dms only', this.deps.label, this.backstopMs);
      return undefined;
    }
    return subscribe(() => this.onDataLanded());
  }

  /**
   * Called synchronously by the store after each block lands, so it only arms a timer. A push
   * lands its blocks one by one; only the first since the last probe started arms one, since
   * that probe has not started yet and will read the rest.
   */
  private onDataLanded(): void {
    if (this.landedSinceProbe) return;
    this.landedSinceProbe = true;
    this.probes?.trigger(TABLE_CHANGE_COALESCE_MS);
  }

  private async probe(): Promise<void> {
    if (this.stopped || this.opened) return;
    log('[%s] first-sync probe (%s)', this.deps.label, this.landedSinceProbe ? 'data landed' : 'backstop');
    const held = await this.probeOnce();
    // Re-check after the await: a release or a force-open may have landed mid-read.
    if (this.stopped || this.opened || !held) return;
    this.opened = true;
    this.stop();
    log('[%s] first-sync gate opened: Strand.Header, every Strand table and every App table read from a peer', this.deps.label);
    this.deps.onHeaderHeld();
  }
}
