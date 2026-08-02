import { describe, it, expect, vi, afterEach } from 'vitest';
import { StrandWatcher, type StrandQueryable, type StrandWatcherCallbacks } from '../src/strand-watcher.js';
import type { StrandRow } from '../src/types.js';

describe('StrandWatcher', () => {
  // Mock queryable that returns configurable strands
  function createMockQueryable(strandsProvider: () => StrandRow[]): StrandQueryable {
    return {
      queryStrands: async () => strandsProvider()
    };
  }

  // Helper to create test strand rows
  function createStrand(id: string, type: 'o' | 'c' = 'o'): StrandRow {
    return {
      Id: id,
      MemberPrivateKey: type === 'c' ? 'test-key' : null,
      Type: type
    };
  }

  describe('constructor', () => {
    it('should create a watcher with default filter', () => {
      const queryable = createMockQueryable(() => []);
      const callbacks: StrandWatcherCallbacks = {
        onStrandAdded: async () => {},
        onStrandRemoved: async () => {}
      };

      const watcher = new StrandWatcher(queryable, callbacks);
      expect(watcher.getKnownStrands().size).toBe(0);
    });

    it('should accept custom filter and poll interval', () => {
      const queryable = createMockQueryable(() => []);
      const callbacks: StrandWatcherCallbacks = {
        onStrandAdded: async () => {},
        onStrandRemoved: async () => {}
      };

      const watcher = new StrandWatcher(
        queryable,
        callbacks,
        { mode: 'strandId', strandId: 'specific-strand' },
        1000
      );
      expect(watcher).toBeInstanceOf(StrandWatcher);
    });
  });

  describe('start/stop', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('should not poll synchronously during start', async () => {
      const strands = [createStrand('strand-1'), createStrand('strand-2')];
      const queryable = createMockQueryable(() => strands);

      const addedStrands: StrandRow[] = [];
      const callbacks: StrandWatcherCallbacks = {
        onStrandAdded: async (strand) => { addedStrands.push(strand); },
        onStrandRemoved: async () => {}
      };

      const watcher = new StrandWatcher(queryable, callbacks, { mode: 'all' }, 60000);
      await watcher.start();

      expect(addedStrands).toHaveLength(0);
      expect(watcher.getKnownStrands().size).toBe(0);

      await watcher.stop();
    });

    it('should detect strands after deferred first poll', async () => {
      const strands = [createStrand('strand-1'), createStrand('strand-2')];
      const queryable = createMockQueryable(() => strands);

      const addedStrands: StrandRow[] = [];
      const callbacks: StrandWatcherCallbacks = {
        onStrandAdded: async (strand) => { addedStrands.push(strand); },
        onStrandRemoved: async () => {}
      };

      const watcher = new StrandWatcher(queryable, callbacks, { mode: 'all' }, 60000);
      await watcher.start();
      await watcher.forcePoll();

      expect(addedStrands).toHaveLength(2);
      expect(watcher.getKnownStrands().size).toBe(2);

      await watcher.stop();
    });

    it('should clear known strands on stop', async () => {
      const strands = [createStrand('strand-1')];
      const queryable = createMockQueryable(() => strands);

      const callbacks: StrandWatcherCallbacks = {
        onStrandAdded: async () => {},
        onStrandRemoved: async () => {}
      };

      const watcher = new StrandWatcher(queryable, callbacks, { mode: 'all' }, 60000);
      await watcher.start();
      await watcher.forcePoll();
      expect(watcher.getKnownStrands().size).toBe(1);

      await watcher.stop();
      expect(watcher.getKnownStrands().size).toBe(0);
    });

    it('should cancel deferred poll when stop is called before it fires', async () => {
      let pollCount = 0;
      const queryable: StrandQueryable = {
        queryStrands: async () => { pollCount++; return []; }
      };
      const callbacks: StrandWatcherCallbacks = {
        onStrandAdded: async () => {},
        onStrandRemoved: async () => {}
      };

      const watcher = new StrandWatcher(queryable, callbacks, { mode: 'all' }, 60000);
      await watcher.start();
      await watcher.stop();

      expect(pollCount).toBe(0);
    });
  });

  describe('strand detection', () => {
    it('should detect added strands', async () => {
      let strands: StrandRow[] = [];
      const queryable = createMockQueryable(() => strands);

      const addedStrands: StrandRow[] = [];
      const callbacks: StrandWatcherCallbacks = {
        onStrandAdded: async (strand) => { addedStrands.push(strand); },
        onStrandRemoved: async () => {}
      };

      const watcher = new StrandWatcher(queryable, callbacks, { mode: 'all' }, 60000);
      await watcher.start();
      expect(addedStrands).toHaveLength(0);

      // Add a strand
      strands = [createStrand('new-strand')];
      await watcher.forcePoll();

      expect(addedStrands).toHaveLength(1);
      expect(addedStrands[0]!.Id).toBe('new-strand');

      await watcher.stop();
    });

    it('should detect removed strands', async () => {
      let strands = [createStrand('strand-to-remove')];
      const queryable = createMockQueryable(() => strands);

      const removedIds: string[] = [];
      const callbacks: StrandWatcherCallbacks = {
        onStrandAdded: async () => {},
        onStrandRemoved: async (id) => { removedIds.push(id); }
      };

      const watcher = new StrandWatcher(queryable, callbacks, { mode: 'all' }, 60000);
      await watcher.start();
      await watcher.forcePoll();

      // Remove the strand
      strands = [];
      await watcher.forcePoll();

      expect(removedIds).toHaveLength(1);
      expect(removedIds[0]).toBe('strand-to-remove');

      await watcher.stop();
    });

    it('should not trigger callback for unchanged strands', async () => {
      const strands = [createStrand('stable-strand')];
      const queryable = createMockQueryable(() => strands);

      let addCount = 0;
      const callbacks: StrandWatcherCallbacks = {
        onStrandAdded: async () => { addCount++; },
        onStrandRemoved: async () => {}
      };

      const watcher = new StrandWatcher(queryable, callbacks, { mode: 'all' }, 60000);
      await watcher.start();
      await watcher.forcePoll();
      expect(addCount).toBe(1);

      // Poll again - should not trigger another add
      await watcher.forcePoll();
      expect(addCount).toBe(1);

      await watcher.stop();
    });
  });

  describe('failed launch retry', () => {
    // pollInterval is the backoff base: first retry is due `pollInterval` ms after
    // the failure, then 2x, 4x, ... A small interval keeps the injected clock readable.
    const INTERVAL = 1000;

    /** Mutable wall clock handed to the watcher; `pollAt` advances it. */
    interface Clock { now: number }

    /**
     * Watcher wired to `clock` instead of `Date.now`. The real initial/interval
     * timers, should they fire mid-test, read the same clock — so a stray poll
     * behaves identically to a `pollAt` at the current time (a no-op while the
     * strand is backing off) rather than a nondeterministic extra attempt.
     */
    function createWatcher(
      queryable: StrandQueryable,
      callbacks: StrandWatcherCallbacks,
      clock: Clock,
      pollInterval = INTERVAL
    ): StrandWatcher {
      return new StrandWatcher(queryable, callbacks, { mode: 'all' }, pollInterval, undefined, () => clock.now);
    }

    /** Advance the injected clock to `at`, then run one poll. */
    async function pollAt(watcher: StrandWatcher, clock: Clock, at: number): Promise<void> {
      clock.now = at;
      await watcher.forcePoll();
    }

    it('should retry a strand whose onStrandAdded threw', async () => {
      const strands = [createStrand('flaky-strand')];
      const queryable = createMockQueryable(() => strands);

      let addCount = 0;
      const callbacks: StrandWatcherCallbacks = {
        onStrandAdded: async () => { addCount++; throw new Error('launch failed'); },
        onStrandRemoved: async () => {}
      };

      const clock: Clock = { now: 0 };
      const watcher = createWatcher(queryable, callbacks, clock);
      await watcher.start();

      await pollAt(watcher, clock, 0);
      expect(addCount).toBe(1);
      // A failed launch must not leave the strand marked as known/added.
      expect(watcher.getKnownStrands().size).toBe(0);

      // Backoff of one interval has elapsed - retry.
      await pollAt(watcher, clock, INTERVAL);
      expect(addCount).toBe(2);

      await watcher.stop();
    });

    it('should defer the retry until the backoff has elapsed', async () => {
      const strands = [createStrand('flaky-strand')];
      const queryable = createMockQueryable(() => strands);

      let addCount = 0;
      const callbacks: StrandWatcherCallbacks = {
        onStrandAdded: async () => { addCount++; throw new Error('launch failed'); },
        onStrandRemoved: async () => {}
      };

      const clock: Clock = { now: 0 };
      const watcher = createWatcher(queryable, callbacks, clock);
      await watcher.start();

      await pollAt(watcher, clock, 0);
      expect(addCount).toBe(1);

      // Still inside the first backoff window - no retry.
      await pollAt(watcher, clock, INTERVAL - 1);
      expect(addCount).toBe(1);

      // Second failure doubles the window: due at INTERVAL + 2*INTERVAL.
      await pollAt(watcher, clock, INTERVAL);
      expect(addCount).toBe(2);
      await pollAt(watcher, clock, INTERVAL * 2);
      expect(addCount).toBe(2);
      await pollAt(watcher, clock, INTERVAL * 3);
      expect(addCount).toBe(3);

      await watcher.stop();
    });

    it('should schedule the backoff from the failure, not from the start of the poll', async () => {
      // A real launch fails slowly (dial timeout), so the clock has moved on by the
      // time the attempt throws. Scheduling off the clock as read at poll START
      // would put `nextAttemptAt` in the past and defeat the backoff entirely.
      const strands = [createStrand('slow-failing-strand')];
      const queryable = createMockQueryable(() => strands);
      const clock: Clock = { now: 0 };

      let addCount = 0;
      const callbacks: StrandWatcherCallbacks = {
        onStrandAdded: async () => {
          addCount++;
          clock.now += INTERVAL * 10; // launch grinds for ten poll intervals...
          throw new Error('launch timed out'); // ...then fails
        },
        onStrandRemoved: async () => {}
      };

      const watcher = createWatcher(queryable, callbacks, clock);
      await watcher.start();

      await pollAt(watcher, clock, 0);
      expect(addCount).toBe(1);
      expect(clock.now).toBe(INTERVAL * 10);

      // Due at 11*INTERVAL (failure time + one interval), so a poll at the moment
      // the attempt failed must not retry.
      await watcher.forcePoll();
      expect(addCount).toBe(1);

      await pollAt(watcher, clock, INTERVAL * 11);
      expect(addCount).toBe(2);

      await watcher.stop();
    });

    it('should not re-add a strand whose launch succeeded', async () => {
      const strands = [createStrand('good-strand')];
      const queryable = createMockQueryable(() => strands);

      let addCount = 0;
      const callbacks: StrandWatcherCallbacks = {
        onStrandAdded: async () => { addCount++; },
        onStrandRemoved: async () => {}
      };

      const clock: Clock = { now: 0 };
      const watcher = createWatcher(queryable, callbacks, clock);
      await watcher.start();

      await pollAt(watcher, clock, 0);
      await pollAt(watcher, clock, INTERVAL * 100);
      expect(addCount).toBe(1);
      expect(watcher.getKnownStrands().size).toBe(1);

      await watcher.stop();
    });

    it('should reset the backoff after a successful add', async () => {
      const strands = [createStrand('recovering-strand')];
      const queryable = createMockQueryable(() => strands);

      let addCount = 0;
      let failNext = true;
      const callbacks: StrandWatcherCallbacks = {
        onStrandAdded: async () => {
          addCount++;
          if (failNext) throw new Error('launch failed');
        },
        onStrandRemoved: async () => {}
      };

      const clock: Clock = { now: 0 };
      const watcher = createWatcher(queryable, callbacks, clock);
      await watcher.start();

      await pollAt(watcher, clock, 0);
      expect(addCount).toBe(1);

      failNext = false;
      await pollAt(watcher, clock, INTERVAL);
      expect(addCount).toBe(2);
      expect(watcher.getKnownStrands().size).toBe(1);

      // Row disappears then returns: the successful add cleared the failure state,
      // so the re-add is a fresh first attempt with no backoff to wait out.
      strands.length = 0;
      await pollAt(watcher, clock, INTERVAL);
      expect(watcher.getKnownStrands().size).toBe(0);

      strands.push(createStrand('recovering-strand'));
      failNext = true;
      await pollAt(watcher, clock, INTERVAL);
      expect(addCount).toBe(3);

      await watcher.stop();
    });

    it('should clear failure state when the strand row disappears', async () => {
      const strands = [createStrand('vanishing-strand')];
      const queryable = createMockQueryable(() => strands);

      let addCount = 0;
      const callbacks: StrandWatcherCallbacks = {
        onStrandAdded: async () => { addCount++; throw new Error('launch failed'); },
        onStrandRemoved: async () => {}
      };

      const clock: Clock = { now: 0 };
      const watcher = createWatcher(queryable, callbacks, clock);
      await watcher.start();

      // Two failures -> next attempt would otherwise be due at 3 * INTERVAL.
      await pollAt(watcher, clock, 0);
      await pollAt(watcher, clock, INTERVAL);
      expect(addCount).toBe(2);

      // Row vanishes; the pruning pass drops the backoff entry.
      strands.length = 0;
      await pollAt(watcher, clock, INTERVAL);

      // Row returns well before the old window would have expired - attempted anyway.
      strands.push(createStrand('vanishing-strand'));
      await pollAt(watcher, clock, INTERVAL + 1);
      expect(addCount).toBe(3);

      await watcher.stop();
    });

    it('should never fire onStrandRemoved for a strand that never launched', async () => {
      const strands = [createStrand('never-launched')];
      const queryable = createMockQueryable(() => strands);

      const removedIds: string[] = [];
      const callbacks: StrandWatcherCallbacks = {
        onStrandAdded: async () => { throw new Error('launch failed'); },
        onStrandRemoved: async (id) => { removedIds.push(id); }
      };

      const clock: Clock = { now: 0 };
      const watcher = createWatcher(queryable, callbacks, clock);
      await watcher.start();

      await pollAt(watcher, clock, 0);
      strands.length = 0;
      await pollAt(watcher, clock, INTERVAL);

      expect(removedIds).toHaveLength(0);

      await watcher.stop();
    });

    it('should clear failure state on stop', async () => {
      const strands = [createStrand('restart-strand')];
      const queryable = createMockQueryable(() => strands);

      let addCount = 0;
      const callbacks: StrandWatcherCallbacks = {
        onStrandAdded: async () => { addCount++; throw new Error('launch failed'); },
        onStrandRemoved: async () => {}
      };

      const clock: Clock = { now: 0 };
      const watcher = createWatcher(queryable, callbacks, clock);
      await watcher.start();
      await pollAt(watcher, clock, 0);
      expect(addCount).toBe(1);

      await watcher.stop();
      await watcher.start();

      // Fresh watcher state: the attempt is made immediately, not after a backoff.
      await pollAt(watcher, clock, 0);
      expect(addCount).toBe(2);

      await watcher.stop();
    });

    it('should cap the backoff at five minutes', async () => {
      const strands = [createStrand('hopeless-strand')];
      const queryable = createMockQueryable(() => strands);

      let addCount = 0;
      const callbacks: StrandWatcherCallbacks = {
        onStrandAdded: async () => { addCount++; throw new Error('launch failed'); },
        onStrandRemoved: async () => {}
      };

      // 60 s interval: uncapped, the 10th failure would schedule 60s * 2^9 = ~8.5 hours.
      const clock: Clock = { now: 0 };
      const watcher = createWatcher(queryable, callbacks, clock, 60_000);
      await watcher.start();

      for (let i = 0; i < 12; i++) {
        await pollAt(watcher, clock, i * 5 * 60 * 1000); // one full cap window apart
      }
      expect(addCount).toBe(12);

      await watcher.stop();
    });
  });
});

