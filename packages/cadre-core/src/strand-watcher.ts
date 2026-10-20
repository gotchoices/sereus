import debug from 'debug';
import { scheduleRuns } from './table-change-watch.js';
import type { TableChangeWatch, TableChangeWatchOptions } from './table-change-watch.js';
import type { StrandFilter, StrandRow } from './types.js';

const log = debug('sereus:cadre:strand-watcher');

/**
 * Outcome of evaluating a strand against the current filter.
 * - `pass`: admit (final)
 * - `reject`: exclude
 * - `defer`: admit provisionally; sAppId not yet known, re-evaluate when it is learned
 */
type FilterDecision = 'pass' | 'reject' | 'defer';

/**
 * Ceiling on the retry delay for a strand whose launch keeps failing. Attempts
 * are never abandoned — the failure this backoff exists for (a transient network
 * or storage fault) can last a long time — but a permanently-unlaunchable strand
 * must not re-attempt on every run and storm the host app with `strand:error`.
 */
const MAX_RETRY_BACKOFF_MS = 5 * 60 * 1000;

/**
 * Default backstop: the longest the watcher goes without re-reading when no change to
 * `Strand` or `JoinedStrand` is heard (`docs/architecture.md` → "Table change subscriptions"
 * says what the change subscription misses).
 *
 * NOTE: on a cadre larger than `CONTROL_REPLICATION_BREADTH` (16), a machine outside the
 * `Strand` block's cohort hears no change event, so this backstop is its only path and a
 * strand founded elsewhere reaches it up to 5 minutes later. If that matters, shorten the
 * backstop for such machines rather than for everyone.
 */
export const DEFAULT_STRAND_WATCH_BACKSTOP_MS = 5 * 60 * 1000;

/**
 * First step of the launch-retry and read-retry ladders, unless the backstop is shorter: a
 * test or scenario that passes a short interval keeps the short base it always had.
 */
const LAUNCH_RETRY_BASE_MS = 5000;

/** Ceiling on the read-retry ladder (see `StrandWatcher.scheduleReadRetry`), unless the backstop is shorter. */
const READ_RETRY_CAP_MS = 60_000;

/** Delay before the first run, so `start()` never reads synchronously. */
const INITIAL_RUN_DELAY_MS = 100;

/** Per-strand consecutive-failure state driving the launch retry backoff. */
interface StrandFailureState {
  /** Consecutive `onStrandAdded` failures since the last success. */
  failures: number;
  /** Earliest wall-clock time (ms) at which the next attempt may run. */
  nextAttemptAt: number;
}

/**
 * Extended strand row that includes the sAppId for filtering purposes.
 * The sAppId is provided by the hosting application, not from the control network.
 */
export interface StrandRowWithApp extends StrandRow {
  /** sApp ID if known (for filtering) */
  sAppId?: string;
}

/**
 * Callback for strand changes
 */
export interface StrandWatcherCallbacks {
  onStrandAdded: (strand: StrandRow) => Promise<void>;
  onStrandRemoved: (strandId: string) => Promise<void>;
}

/**
 * What the watcher reads, and how it hears that what it reads changed.
 */
export interface StrandQueryable {
  queryStrands(): Promise<StrandRow[]>;
  /** Subscribe to changes of the tables {@link queryStrands} reads. Absent: runs come from `trigger` and the backstop only. */
  watchChanges?(onChange: () => Promise<void>, options: TableChangeWatchOptions): TableChangeWatch;
  /** True when the last {@link queryStrands} answered part of its result from a stand-in after a failed read. */
  lastReadPartial?(): boolean;
}

/**
 * Interface for looking up sAppId for a strand (for filtering)
 */
export interface SAppIdLookup {
  /** Get the sAppId for a strand, if known */
  getSAppId(strandId: string): string | undefined;
}

/**
 * Watches the control network's Strand table for changes and triggers
 * strand instance start/stop via callbacks.
 *
 * Every read is one run on a {@link TableChangeWatch}: once at start, on a change to the
 * tables the queryable reads, on the watcher's own retries, and on the backstop.
 */
export class StrandWatcher {
  private readonly filter: StrandFilter;
  /** Longest gap between runs when no change is heard. */
  private readonly backstopMs: number;
  /** First step of the launch-retry and read-retry ladders. */
  private readonly retryBaseMs: number;
  private readonly readRetryCapMs: number;
  private readonly callbacks: StrandWatcherCallbacks;
  private readonly queryable: StrandQueryable;
  private readonly sAppIdLookup?: SAppIdLookup;
  /**
   * Wall-clock source for the retry backoff. Read fresh at each use rather than
   * snapshotted per poll: a poll awaits `onStrandAdded`, and a launch that fails
   * slowly (e.g. a dial timeout) would otherwise be scheduled off the clock as it
   * read *before* the attempt, putting `nextAttemptAt` in the past. Injectable so
   * tests can advance time deterministically without fake timers.
   */
  private readonly now: () => number;

  private knownStrands: Map<string, StrandRow> = new Map();
  /** Ids admitted under a `defer` decision; re-evaluated each run until they resolve. */
  private provisional: Set<string> = new Set();
  /** Ids whose last launch attempt threw, with the backoff gating their retry. */
  private failureStates: Map<string, StrandFailureState> = new Map();
  /**
   * Ids a deliberate local stop has withdrawn from offer for the rest of the session
   * (see {@link suppressStrand}). Before {@link forgetStrand} existed, `knownStrands`
   * retention alone made a stop permanent; now that a failed claim can un-know a
   * strand, the permanence has to be recorded explicitly.
   */
  private suppressed: Set<string> = new Set();
  /** Consecutive runs whose read failed or was partial; drives {@link scheduleReadRetry}. */
  private readFailures = 0;
  /** Built by {@link start}, disposed by {@link stop}; a restart builds a new one. */
  private watch: TableChangeWatch | null = null;
  private running = false;

  /**
   * @param backstopMs - `CadreNodeConfig.strandWatchInterval`: the longest the watcher goes
   *   without re-reading when no change is heard. Also caps the retry ladders' first step.
   */
  constructor(
    queryable: StrandQueryable,
    callbacks: StrandWatcherCallbacks,
    filter: StrandFilter = { mode: 'all' },
    backstopMs: number = DEFAULT_STRAND_WATCH_BACKSTOP_MS,
    sAppIdLookup?: SAppIdLookup,
    now: () => number = Date.now
  ) {
    this.queryable = queryable;
    this.callbacks = callbacks;
    this.filter = filter;
    this.backstopMs = backstopMs;
    this.retryBaseMs = Math.min(backstopMs, LAUNCH_RETRY_BASE_MS);
    this.readRetryCapMs = Math.min(backstopMs, READ_RETRY_CAP_MS);
    this.sAppIdLookup = sAppIdLookup;
    this.now = now;
    log('StrandWatcher created with filter: %o, backstop: %dms', filter, backstopMs);
  }

  /**
   * Evaluate a strand against the current filter, distinguishing a not-yet-known
   * sAppId (`defer`) from a known non-match (`reject`). A `defer` admission is
   * provisional and re-checked on subsequent runs (see {@link sAppIdLearned}).
   */
  private evaluateFilter(strand: StrandRow): FilterDecision {
    switch (this.filter.mode) {
      case 'all':
        return 'pass';
      case 'none':
        return 'reject';
      case 'strandId':
        return strand.Id === this.filter.strandId ? 'pass' : 'reject';
      case 'sAppId': {
        if (!this.sAppIdLookup) {
          // No way to ever decide - admit permanently (no lookup configured).
          return 'pass';
        }
        const sAppId = this.sAppIdLookup.getSAppId(strand.Id);
        if (sAppId === undefined) {
          // sAppId not yet known - admit provisionally and re-evaluate once it is learned.
          log('sAppId unknown for strand %s - deferring filter decision', strand.Id);
          return 'defer';
        }
        const matches = sAppId === this.filter.sAppId;
        log('sAppId filter: strand %s has sAppId %s, filter wants %s, match=%s',
            strand.Id, sAppId, this.filter.sAppId, matches);
        return matches ? 'pass' : 'reject';
      }
      default:
        return 'pass';
    }
  }

  /**
   * Record a failed launch attempt and schedule when the strand may be retried:
   * `retryBaseMs * 2^(failures-1)`, capped at {@link MAX_RETRY_BACKOFF_MS}.
   */
  private recordFailure(strandId: string): void {
    const failures = (this.failureStates.get(strandId)?.failures ?? 0) + 1;
    const delay = Math.min(this.retryBaseMs * 2 ** (failures - 1), MAX_RETRY_BACKOFF_MS);
    this.failureStates.set(strandId, { failures, nextAttemptAt: this.now() + delay });
    log('Strand %s launch failed (%d consecutive) - next attempt in %dms', strandId, failures, delay);
  }

  /**
   * One run: read, reconcile, then arm the follow-up runs this run needs. A run the watch
   * starts clears every pending wake, so each run re-arms the retries still owed. A
   * {@link forcePoll} run clears none, so what it arms may sit beside an equivalent wake;
   * whichever fires first runs and clears the other.
   */
  private async runOnce(): Promise<void> {
    const startedAt = this.now();
    const readComplete = await this.poll();
    if (this.running) {
      this.scheduleLaunchRetry(startedAt);
      this.scheduleReadRetry(readComplete);
    }
  }

  /**
   * Wake for the earliest launch retry falling due after `since`. A backoff that expired at
   * or before `since` belongs to a strand the run starting then either attempted or skipped
   * for a reason other than backoff (suppressed, filtered out); waking for it would spin.
   * Without this a failed launch would wait for an unrelated change or the backstop.
   */
  private scheduleLaunchRetry(since: number): void {
    let earliest = Infinity;
    for (const { nextAttemptAt } of this.failureStates.values()) {
      if (nextAttemptAt > since) {
        earliest = Math.min(earliest, nextAttemptAt);
      }
    }
    if (earliest !== Infinity) {
      this.watch?.trigger(Math.max(0, earliest - this.now()));
    }
  }

  /**
   * After a failed or partial read, run again on a ladder from `retryBaseMs`, doubling per
   * consecutive failed run up to `readRetryCapMs`; a complete read resets it. Not left to
   * the backstop because the plugin arms a table's replicated-change bridge on the table's
   * first successful initialization: a machine whose first read failed (cut off from its
   * party, or its sibling unreachable for a never-written `JoinedStrand`) would otherwise
   * hear nothing until then.
   */
  private scheduleReadRetry(readComplete: boolean): void {
    if (readComplete) {
      this.readFailures = 0;
      return;
    }
    this.readFailures++;
    const delay = Math.min(this.retryBaseMs * 2 ** (this.readFailures - 1), this.readRetryCapMs);
    log('Strand read incomplete (%d consecutive) - re-reading in %dms', this.readFailures, delay);
    this.watch?.trigger(delay);
  }

  /**
   * Read and reconcile. Resolves true when the read answered in full: false when it threw,
   * or when the queryable answered part of it from a stand-in.
   */
  private async poll(): Promise<boolean> {
    if (!this.running) return true;

    try {
      const currentStrands = await this.queryable.queryStrands();
      const currentMap = new Map(currentStrands.map(s => [s.Id, s]));

      // Find added strands
      for (const strand of currentStrands) {
        if (this.suppressed.has(strand.Id)) continue; // deliberately stopped locally
        if (this.knownStrands.has(strand.Id)) continue;
        const failure = this.failureStates.get(strand.Id);
        // Clock read per candidate, not once per run: an earlier strand's launch
        // may have taken a long time, and this one's gate must reflect that.
        if (failure && this.now() < failure.nextAttemptAt) continue; // backing off after a failed launch
        const decision = this.evaluateFilter(strand);
        if (decision === 'reject') continue;
        log('Strand added: %s', strand.Id);
        // Set BEFORE the await: this doubles as the in-flight guard that stops a
        // concurrent run (`forcePoll` beside a scheduled one) from launching the strand twice.
        this.knownStrands.set(strand.Id, strand);
        if (decision === 'defer') {
          // Provisional admission: sAppId unknown, re-check on later runs.
          this.provisional.add(strand.Id);
        }
        try {
          await this.callbacks.onStrandAdded(strand);
          this.failureStates.delete(strand.Id);
        } catch (error) {
          log('Error handling strand add for %s: %o', strand.Id, error);
          this.forgetStrand(strand.Id);
        }
      }

      // Re-evaluate provisional admissions whose sAppId may now be resolvable.
      // Snapshot ids so we can mutate provisional/knownStrands inside the loop.
      for (const strandId of [...this.provisional]) {
        const strand = currentMap.get(strandId);
        if (!strand) continue; // handled by the removed-strand loop below
        const decision = this.evaluateFilter(strand);
        if (decision === 'pass') {
          // Resolved to a match - admission is now final.
          this.provisional.delete(strandId);
        } else if (decision === 'reject') {
          // Resolved to a non-match - stop the provisionally-admitted strand.
          log('Provisional strand rejected on re-evaluation: %s', strandId);
          this.knownStrands.delete(strandId);
          this.provisional.delete(strandId);
          try {
            await this.callbacks.onStrandRemoved(strandId);
          } catch (error) {
            log('Error handling strand remove for %s: %o', strandId, error);
          }
        }
        // decision === 'defer': still unknown, leave provisional until sAppIdLearned wakes a run.
      }

      // Find removed strands. A strand whose launch failed is no longer in
      // knownStrands, so it correctly never fires onStrandRemoved — nothing was
      // ever started for it.
      for (const [strandId] of this.knownStrands) {
        if (!currentMap.has(strandId)) {
          log('Strand removed: %s', strandId);
          this.knownStrands.delete(strandId);
          this.provisional.delete(strandId);
          try {
            await this.callbacks.onStrandRemoved(strandId);
          } catch (error) {
            log('Error handling strand remove for %s: %o', strandId, error);
          }
        }
      }

      // Drop backoff and suppression state for strands whose control-network row is
      // gone; a row that reappears is a fresh strand and gets a fresh first attempt,
      // un-backed-off and un-suppressed.
      for (const strandId of [...this.failureStates.keys()]) {
        if (!currentMap.has(strandId)) {
          this.failureStates.delete(strandId);
        }
      }
      // NOTE: the clear needs a run that actually SEES the row absent, so a sibling that
      // unpublishes and re-publishes a locally-stopped id between two runs leaves
      // it suppressed for the session. Contrived today — re-seating a removed id is
      // owner-gated and manual — and there is no row version to distinguish the new row
      // from the old. If re-publishing a removed id ever becomes routine, give the row a
      // generation column and clear suppression on a change rather than on absence.
      for (const strandId of [...this.suppressed]) {
        if (!currentMap.has(strandId)) {
          this.suppressed.delete(strandId);
        }
      }
      return !(this.queryable.lastReadPartial?.() ?? false);
    } catch (error) {
      // NOTE: a machine cut off from its party before it ever received the `Strand` block
      // fails this read `cohort-unreachable` on every step of the read-retry ladder and logs
      // here (observed in `control-cohort-edge-carries-data`). Harmless: nothing was ever
      // launched from a block this machine never held, and this catch keeps the known set. Do
      // not answer it as empty the way `ControlDatabase.queryRevokedStamps` does for
      // `Revocation` — an empty answer here runs the removed-strand loop above. Revisit if
      // the log volume matters.
      log('Error polling strands: %o', error);
      return false;
    }
  }

  /**
   * Start watching for strand changes
   */
  async start(): Promise<void> {
    if (this.running) {
      log('StrandWatcher already running');
      return;
    }

    log('Starting StrandWatcher');
    // Subscribed before the first read, so a commit landing between them is either seen by
    // that read or wakes a follow-up run.
    this.watch = this.subscribe();
    this.running = true;
    // Deferred so start() doesn't block the caller; strands added via addStrand()
    // typically arrive after start() completes.
    this.watch.trigger(INITIAL_RUN_DELAY_MS);

    log('StrandWatcher started');
  }

  /** The watch every run goes through: the queryable's change subscription, or a timer-only one. */
  private subscribe(): TableChangeWatch {
    const onChange = (): Promise<void> => this.runOnce();
    const options: TableChangeWatchOptions = { label: 'strand-watcher', backstopMs: this.backstopMs };
    return this.queryable.watchChanges?.(onChange, options) ?? scheduleRuns(onChange, options);
  }

  /**
   * Stop watching for strand changes
   */
  async stop(): Promise<void> {
    if (!this.running) {
      return;
    }

    log('Stopping StrandWatcher');
    this.running = false;
    // A run already in flight finishes; `running` keeps it from arming anything further.
    this.watch?.dispose();
    this.watch = null;

    this.knownStrands.clear();
    this.provisional.clear();
    this.failureStates.clear();
    this.suppressed.clear();
    this.readFailures = 0;
    log('StrandWatcher stopped');
  }

  /**
   * Forget a strand whose launch failed outside this watcher, so a later run
   * re-offers it — gated by the same backoff a watcher-driven failure gets, and woken
   * when that backoff expires.
   *
   * A failed launch normally leaves nothing running (StrandInstanceManager drops the
   * record), which is what makes re-offering it correct. One case does leave something
   * running: a row this machine published lands on an instance something else already
   * attached, and honouring the founder request on it (CadreNode.launchStrand →
   * StrandInstanceManager.foundExistingStrand) throws. The instance stays up as a joiner
   * and the retry re-attempts the bootstrap on it, which is what should happen — but do
   * not read the line above as "nothing is running".
   */
  forgetStrand(strandId: string): void {
    this.knownStrands.delete(strandId);
    this.provisional.delete(strandId);
    this.recordFailure(strandId);
    if (this.running) {
      this.scheduleLaunchRetry(this.now());
    }
  }

  /**
   * Re-read soon: something the queryable merges in beside the watched tables changed
   * (`CadreNode`'s machine-local joined-strand records). A no-op once stopped.
   */
  refresh(): void {
    this.watch?.trigger();
  }

  /**
   * The host just learned `strandId`'s sAppId: if the strand was admitted provisionally
   * under an `sAppId` filter, run so the admission resolves now rather than on the backstop.
   */
  sAppIdLearned(strandId: string): void {
    if (this.provisional.has(strandId)) {
      this.watch?.trigger();
    }
  }

  /**
   * Never offer this strand again this session. Two callers, both meaning "the retry
   * ladder cannot help here": a deliberate local stop, and a launch that can never
   * succeed — a strand whose id is unusable as a storage scope key
   * (`CadreNode.handleStrandAdded`), which every later attempt would reject identically.
   * A launch that merely FAILED is not one of them; that goes to {@link forgetStrand}.
   *
   * Cleared when the strand's control row disappears, because a row that reappears is a
   * strand the party re-published and the stop said nothing about it; also cleared by
   * {@link stop}, since sApp configs do not survive it either, and by
   * {@link unsuppressStrand} when the caller claims the strand again.
   */
  suppressStrand(strandId: string): void {
    log('Suppressing strand %s — deliberate local stop, will not be re-offered', strandId);
    this.suppressed.add(strandId);
  }

  /**
   * Revoke a {@link suppressStrand}: a deliberate local claim overrides the deliberate
   * local stop that preceded it.
   *
   * Not cosmetic — the suppression check runs before the `knownStrands` one, so a
   * suppressed id is never re-recorded there, and the removed-strand loop iterates
   * `knownStrands`. A strand re-claimed while still suppressed would therefore run with
   * the watcher blind to it: a party-wide removal would never stop it locally. That is
   * reachable whenever the stop found the id already un-known — after a claim that
   * failed, or for a strand the filter never admitted.
   */
  unsuppressStrand(strandId: string): void {
    if (this.suppressed.delete(strandId)) {
      log('Strand %s re-claimed — suppression lifted', strandId);
    }
  }

  /**
   * Get currently known strands
   */
  getKnownStrands(): Map<string, StrandRow> {
    return new Map(this.knownStrands);
  }

  /**
   * Run once now, outside the watch's schedule (tests, and callers that just wrote a row
   * and want this node to converge before returning). May overlap a scheduled run:
   * `knownStrands` is updated before each callback's await, so neither launches nor
   * removes a strand twice.
   */
  async forcePoll(): Promise<void> {
    await this.runOnce();
  }
}

