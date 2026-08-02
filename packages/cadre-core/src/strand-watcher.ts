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

  private knownStrands: Map<string, StrandRow> = new Map();
  /** Ids admitted under a `defer` decision; re-evaluated each poll until they resolve. */
  private provisional: Set<string> = new Set();
  /** Ids whose last launch attempt threw, with the backoff gating their retry. */
  private failureStates: Map<string, StrandFailureState> = new Map();
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private initialPollTimer: ReturnType<typeof setTimeout> | null = null;
  private running = false;

  constructor(
    queryable: StrandQueryable,
    callbacks: StrandWatcherCallbacks,
    filter: StrandFilter = { mode: 'all' },
    pollInterval: number = 5000,
    sAppIdLookup?: SAppIdLookup
  ) {
    this.queryable = queryable;
    this.callbacks = callbacks;
    this.filter = filter;
    this.pollInterval = pollInterval;
    this.sAppIdLookup = sAppIdLookup;
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
  private recordFailure(strandId: string, now: number): void {
    const failures = (this.failureStates.get(strandId)?.failures ?? 0) + 1;
    const delay = Math.min(this.pollInterval * 2 ** (failures - 1), MAX_RETRY_BACKOFF_MS);
    this.failureStates.set(strandId, { failures, nextAttemptAt: now + delay });
    log('Strand %s launch failed (%d consecutive) - next attempt in %dms', strandId, failures, delay);
  }

  /**
   * Poll for strand changes.
   *
   * @param now - Wall-clock reference for the retry backoff. Injectable so tests
   *   can advance time deterministically without fake timers.
   */
  private async poll(now: number = Date.now()): Promise<void> {
    if (!this.running) return;

    try {
      const currentStrands = await this.queryable.queryStrands();
      const currentMap = new Map(currentStrands.map(s => [s.Id, s]));

      // Find added strands
      for (const strand of currentStrands) {
        if (this.knownStrands.has(strand.Id)) continue;
        const failure = this.failureStates.get(strand.Id);
        if (failure && now < failure.nextAttemptAt) continue; // backing off after a failed launch
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
          // A failed launch leaves nothing running (StrandInstanceManager drops the
          // record), so forget the strand and let a later poll retry it — gated by
          // the backoff recorded here.
          this.knownStrands.delete(strand.Id);
          this.provisional.delete(strand.Id);
          this.recordFailure(strand.Id, now);
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

      // Drop backoff state for strands whose control-network row is gone; a row
      // that reappears is a fresh strand and gets a fresh first attempt.
      for (const strandId of [...this.failureStates.keys()]) {
        if (!currentMap.has(strandId)) {
          this.failureStates.delete(strandId);
        }
      }
    } catch (error) {
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
    log('StrandWatcher stopped');
  }

  /**
   * Get currently known strands
   */
  getKnownStrands(): Map<string, StrandRow> {
    return new Map(this.knownStrands);
  }

  /**
   * Force an immediate poll (useful for testing)
   *
   * @param now - Optional wall-clock reference, forwarded to the retry backoff so
   *   a test can advance past a strand's next-attempt time without fake timers.
   */
  async forcePoll(now?: number): Promise<void> {
    await this.poll(now);
  }
}

