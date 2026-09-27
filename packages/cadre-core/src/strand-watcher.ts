import debug from 'debug';
import type { StrandFilter, StrandRow } from './types.js';

const log = debug('sereus:cadre:strand-watcher');

/**
 * Outcome of evaluating a strand against the current filter.
 * - `pass`: admit (final)
 * - `reject`: exclude
 * - `defer`: admit provisionally; sAppId not yet known, re-evaluate next poll
 */
type FilterDecision = 'pass' | 'reject' | 'defer';

/**
 * Ceiling on the retry delay for a strand whose launch keeps failing. Attempts
 * are never abandoned — the failure this backoff exists for (a transient network
 * or storage fault) can last a long time — but a permanently-unlaunchable strand
 * must not re-attempt on every poll and storm the host app with `strand:error`.
 */
const MAX_RETRY_BACKOFF_MS = 5 * 60 * 1000;

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
 * Interface for querying strands from control network
 */
export interface StrandQueryable {
  queryStrands(): Promise<StrandRow[]>;
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
 * Uses polling until Optimystic supports reactive subscriptions.
 */
export class StrandWatcher {
  private readonly filter: StrandFilter;
  private readonly pollInterval: number;
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
  /** Ids admitted under a `defer` decision; re-evaluated each poll until they resolve. */
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
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private initialPollTimer: ReturnType<typeof setTimeout> | null = null;
  private running = false;

  constructor(
    queryable: StrandQueryable,
    callbacks: StrandWatcherCallbacks,
    filter: StrandFilter = { mode: 'all' },
    pollInterval: number = 5000,
    sAppIdLookup?: SAppIdLookup,
    now: () => number = Date.now
  ) {
    this.queryable = queryable;
    this.callbacks = callbacks;
    this.filter = filter;
    this.pollInterval = pollInterval;
    this.sAppIdLookup = sAppIdLookup;
    this.now = now;
    log('StrandWatcher created with filter: %o, interval: %dms', filter, pollInterval);
  }

  /**
   * Evaluate a strand against the current filter, distinguishing a not-yet-known
   * sAppId (`defer`) from a known non-match (`reject`). A `defer` admission is
   * provisional and re-checked on subsequent polls.
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
          // sAppId not yet known - admit provisionally and re-evaluate next poll.
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
   * `pollInterval * 2^(failures-1)`, capped at {@link MAX_RETRY_BACKOFF_MS}.
   */
  private recordFailure(strandId: string): void {
    const failures = (this.failureStates.get(strandId)?.failures ?? 0) + 1;
    const delay = Math.min(this.pollInterval * 2 ** (failures - 1), MAX_RETRY_BACKOFF_MS);
    this.failureStates.set(strandId, { failures, nextAttemptAt: this.now() + delay });
    log('Strand %s launch failed (%d consecutive) - next attempt in %dms', strandId, failures, delay);
  }

  /**
   * Poll for strand changes.
   */
  private async poll(): Promise<void> {
    if (!this.running) return;

    try {
      const currentStrands = await this.queryable.queryStrands();
      const currentMap = new Map(currentStrands.map(s => [s.Id, s]));

      // Find added strands
      for (const strand of currentStrands) {
        if (this.suppressed.has(strand.Id)) continue; // deliberately stopped locally
        if (this.knownStrands.has(strand.Id)) continue;
        const failure = this.failureStates.get(strand.Id);
        // Clock read per candidate, not once per poll: an earlier strand's launch
        // may have taken a long time, and this one's gate must reflect that.
        if (failure && this.now() < failure.nextAttemptAt) continue; // backing off after a failed launch
        const decision = this.evaluateFilter(strand);
        if (decision === 'reject') continue;
        log('Strand added: %s', strand.Id);
        // Set BEFORE the await: this doubles as the in-flight guard that stops the
        // interval timer from starting a second concurrent launch for the same strand.
        this.knownStrands.set(strand.Id, strand);
        if (decision === 'defer') {
          // Provisional admission: sAppId unknown, re-check on later polls.
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
        // decision === 'defer': still unknown, leave provisional for next poll.
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
      // NOTE: the clear needs a poll that actually SEES the row absent, so a sibling that
      // unpublishes and re-publishes a locally-stopped id inside one poll interval leaves
      // it suppressed for the session. Contrived today — re-seating a removed id is
      // owner-gated and manual — and there is no row version to distinguish the new row
      // from the old. If re-publishing a removed id ever becomes routine, give the row a
      // generation column and clear suppression on a change rather than on absence.
      for (const strandId of [...this.suppressed]) {
        if (!currentMap.has(strandId)) {
          this.suppressed.delete(strandId);
        }
      }
    } catch (error) {
      // NOTE: a machine cut off from its party before it ever received the `Strand` block
      // fails this read `cohort-unreachable` on every poll and logs here (observed in
      // `control-cohort-edge-carries-data`). Harmless: nothing was ever launched from a block
      // this machine never held, and this catch keeps the known set. Do not answer it as
      // empty the way `ControlDatabase.queryRevokedStamps` does for `Revocation` — an empty
      // answer here runs the removed-strand loop above. Revisit if the log volume matters.
      log('Error polling strands: %o', error);
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
    this.running = true;

    // Set up periodic polling
    this.pollTimer = setInterval(() => {
      void this.poll();
    }, this.pollInterval);

    // Defer the first poll so start() doesn't block the caller.
    // Strands added via addStrand() typically arrive after start() completes.
    this.initialPollTimer = setTimeout(() => {
      this.initialPollTimer = null;
      void this.poll();
    }, 100);

    log('StrandWatcher started');
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

    if (this.initialPollTimer) {
      clearTimeout(this.initialPollTimer);
      this.initialPollTimer = null;
    }

    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }

    this.knownStrands.clear();
    this.provisional.clear();
    this.failureStates.clear();
    this.suppressed.clear();
    log('StrandWatcher stopped');
  }

  /**
   * Forget a strand whose launch failed outside this watcher, so a later poll
   * re-offers it — gated by the same backoff a watcher-driven failure gets.
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
   * Force an immediate poll (useful for testing)
   */
  async forcePoll(): Promise<void> {
    await this.poll();
  }
}

