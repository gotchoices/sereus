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
   * Poll for strand changes
   */
  private async poll(): Promise<void> {
    if (!this.running) return;

    try {
      const currentStrands = await this.queryable.queryStrands();
      const currentMap = new Map(currentStrands.map(s => [s.Id, s]));

      // Find added strands
      for (const strand of currentStrands) {
        if (this.knownStrands.has(strand.Id)) continue;
        const decision = this.evaluateFilter(strand);
        if (decision === 'reject') continue;
        log('Strand added: %s', strand.Id);
        this.knownStrands.set(strand.Id, strand);
        if (decision === 'defer') {
          // Provisional admission: sAppId unknown, re-check on later polls.
          this.provisional.add(strand.Id);
        }
        try {
          await this.callbacks.onStrandAdded(strand);
        } catch (error) {
          log('Error handling strand add for %s: %o', strand.Id, error);
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

      // Find removed strands
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
   */
  async forcePoll(): Promise<void> {
    await this.poll();
  }
}

