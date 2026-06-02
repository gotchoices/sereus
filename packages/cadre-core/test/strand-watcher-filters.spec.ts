import { describe, it, expect } from 'vitest';
import { StrandWatcher, type StrandQueryable, type StrandWatcherCallbacks, type SAppIdLookup } from '../src/strand-watcher.js';
import type { StrandRow } from '../src/types.js';

describe('StrandWatcher Filters', () => {
  function createMockQueryable(strandsProvider: () => StrandRow[]): StrandQueryable {
    return {
      queryStrands: async () => strandsProvider()
    };
  }

  function createStrand(id: string): StrandRow {
    return { Id: id, MemberPrivateKey: null, Type: 'o' };
  }

  // Mock sAppId lookup for testing
  function createSAppIdLookup(mapping: Record<string, string>): SAppIdLookup {
    return {
      getSAppId: (strandId: string) => mapping[strandId]
    };
  }

  describe('mode: all', () => {
    it('should pass all strands through', async () => {
      const strands = [
        createStrand('strand-1'),
        createStrand('strand-2'),
        createStrand('strand-3')
      ];
      const queryable = createMockQueryable(() => strands);

      const addedStrands: StrandRow[] = [];
      const callbacks: StrandWatcherCallbacks = {
        onStrandAdded: async (strand) => { addedStrands.push(strand); },
        onStrandRemoved: async () => {}
      };

      const watcher = new StrandWatcher(queryable, callbacks, { mode: 'all' }, 60000);
      await watcher.start();
      await watcher.forcePoll();

      expect(addedStrands).toHaveLength(3);

      await watcher.stop();
    });
  });

  describe('mode: none', () => {
    it('should filter out all strands', async () => {
      const strands = [
        createStrand('strand-1'),
        createStrand('strand-2')
      ];
      const queryable = createMockQueryable(() => strands);

      const addedStrands: StrandRow[] = [];
      const callbacks: StrandWatcherCallbacks = {
        onStrandAdded: async (strand) => { addedStrands.push(strand); },
        onStrandRemoved: async () => {}
      };

      const watcher = new StrandWatcher(queryable, callbacks, { mode: 'none' }, 60000);
      await watcher.start();
      await watcher.forcePoll();

      expect(addedStrands).toHaveLength(0);

      await watcher.stop();
    });
  });

  describe('mode: strandId', () => {
    it('should only pass through matching strand', async () => {
      const strands = [
        createStrand('strand-1'),
        createStrand('target-strand'),
        createStrand('strand-3')
      ];
      const queryable = createMockQueryable(() => strands);

      const addedStrands: StrandRow[] = [];
      const callbacks: StrandWatcherCallbacks = {
        onStrandAdded: async (strand) => { addedStrands.push(strand); },
        onStrandRemoved: async () => {}
      };

      const watcher = new StrandWatcher(
        queryable,
        callbacks,
        { mode: 'strandId', strandId: 'target-strand' },
        60000
      );
      await watcher.start();
      await watcher.forcePoll();

      expect(addedStrands).toHaveLength(1);
      expect(addedStrands[0]!.Id).toBe('target-strand');

      await watcher.stop();
    });

    it('should not pass through non-matching strands', async () => {
      const strands = [
        createStrand('strand-1'),
        createStrand('strand-2')
      ];
      const queryable = createMockQueryable(() => strands);

      const addedStrands: StrandRow[] = [];
      const callbacks: StrandWatcherCallbacks = {
        onStrandAdded: async (strand) => { addedStrands.push(strand); },
        onStrandRemoved: async () => {}
      };

      const watcher = new StrandWatcher(
        queryable,
        callbacks,
        { mode: 'strandId', strandId: 'non-existent' },
        60000
      );
      await watcher.start();
      await watcher.forcePoll();

      expect(addedStrands).toHaveLength(0);

      await watcher.stop();
    });
  });

  describe('mode: sAppId', () => {
    it('should filter strands by sAppId when lookup is provided', async () => {
      const strands = [
        createStrand('strand-1'),
        createStrand('strand-2'),
        createStrand('strand-3')
      ];
      const queryable = createMockQueryable(() => strands);

      // strand-1 and strand-3 belong to 'target-app', strand-2 belongs to 'other-app'
      const sAppIdLookup = createSAppIdLookup({
        'strand-1': 'target-app',
        'strand-2': 'other-app',
        'strand-3': 'target-app'
      });

      const addedStrands: StrandRow[] = [];
      const callbacks: StrandWatcherCallbacks = {
        onStrandAdded: async (strand) => { addedStrands.push(strand); },
        onStrandRemoved: async () => {}
      };

      const watcher = new StrandWatcher(
        queryable,
        callbacks,
        { mode: 'sAppId', sAppId: 'target-app' },
        60000,
        sAppIdLookup
      );
      await watcher.start();
      await watcher.forcePoll();

      // Should only pass strands matching 'target-app'
      expect(addedStrands).toHaveLength(2);
      expect(addedStrands.map(s => s.Id)).toContain('strand-1');
      expect(addedStrands.map(s => s.Id)).toContain('strand-3');
      expect(addedStrands.map(s => s.Id)).not.toContain('strand-2');

      await watcher.stop();
    });

    it('should pass through strands with unknown sAppId', async () => {
      const strands = [createStrand('unknown-strand')];
      const queryable = createMockQueryable(() => strands);

      // Empty lookup - strand sAppId is unknown
      const sAppIdLookup = createSAppIdLookup({});

      const addedStrands: StrandRow[] = [];
      const callbacks: StrandWatcherCallbacks = {
        onStrandAdded: async (strand) => { addedStrands.push(strand); },
        onStrandRemoved: async () => {}
      };

      const watcher = new StrandWatcher(
        queryable,
        callbacks,
        { mode: 'sAppId', sAppId: 'some-app' },
        60000,
        sAppIdLookup
      );
      await watcher.start();
      await watcher.forcePoll();

      // Unknown strands pass through (deferred filtering)
      expect(addedStrands).toHaveLength(1);

      await watcher.stop();
    });

    it('should pass through all strands when no lookup provided', async () => {
      const strands = [createStrand('strand-1'), createStrand('strand-2')];
      const queryable = createMockQueryable(() => strands);

      const addedStrands: StrandRow[] = [];
      const callbacks: StrandWatcherCallbacks = {
        onStrandAdded: async (strand) => { addedStrands.push(strand); },
        onStrandRemoved: async () => {}
      };

      const watcher = new StrandWatcher(
        queryable,
        callbacks,
        { mode: 'sAppId', sAppId: 'some-app' },
        60000
        // No sAppIdLookup provided
      );
      await watcher.start();
      await watcher.forcePoll();

      // All strands pass through when no lookup
      expect(addedStrands).toHaveLength(2);

      await watcher.stop();
    });

    it('stops a deferred strand once its sAppId resolves to a non-match', async () => {
      const strands = [createStrand('late-strand')];
      const queryable: StrandQueryable = { queryStrands: async () => strands };
      const mapping: Record<string, string> = {};
      const sAppIdLookup: SAppIdLookup = { getSAppId: (id) => mapping[id] };
      const added: string[] = [];
      const removed: string[] = [];
      const callbacks: StrandWatcherCallbacks = {
        onStrandAdded: async (s) => { added.push(s.Id); },
        onStrandRemoved: async (id) => { removed.push(id); }
      };
      const watcher = new StrandWatcher(
        queryable, callbacks, { mode: 'sAppId', sAppId: 'target-app' }, 60000, sAppIdLookup
      );
      await watcher.start();
      await watcher.forcePoll();
      expect(added).toEqual(['late-strand']);     // deferred admission
      mapping['late-strand'] = 'other-app';        // resolves to non-match
      await watcher.forcePoll();
      expect(removed).toEqual(['late-strand']);
      expect(watcher.getKnownStrands().has('late-strand')).toBe(false);
      await watcher.stop();
    });

    it('keeps a deferred strand running once its sAppId resolves to a match', async () => {
      const strands = [createStrand('late-strand')];
      const queryable: StrandQueryable = { queryStrands: async () => strands };
      const mapping: Record<string, string> = {};
      const sAppIdLookup: SAppIdLookup = { getSAppId: (id) => mapping[id] };
      const added: string[] = [];
      const removed: string[] = [];
      const callbacks: StrandWatcherCallbacks = {
        onStrandAdded: async (s) => { added.push(s.Id); },
        onStrandRemoved: async (id) => { removed.push(id); }
      };
      const watcher = new StrandWatcher(
        queryable, callbacks, { mode: 'sAppId', sAppId: 'target-app' }, 60000, sAppIdLookup
      );
      await watcher.start();
      await watcher.forcePoll();
      expect(added).toEqual(['late-strand']);     // deferred admission
      mapping['late-strand'] = 'target-app';       // resolves to a match
      await watcher.forcePoll();
      expect(removed).toEqual([]);                 // stays running
      expect(watcher.getKnownStrands().has('late-strand')).toBe(true);

      // A subsequent poll must not re-add or re-remove it (admission is final).
      await watcher.forcePoll();
      expect(added).toEqual(['late-strand']);
      expect(removed).toEqual([]);
      await watcher.stop();
    });

    it('removes and prunes a still-deferred strand when it disappears from the network', async () => {
      let strands = [createStrand('late-strand')];
      const queryable: StrandQueryable = { queryStrands: async () => strands };
      // sAppId never resolves - the strand stays provisional until it disappears.
      const sAppIdLookup: SAppIdLookup = { getSAppId: () => undefined };
      const added: string[] = [];
      const removed: string[] = [];
      const callbacks: StrandWatcherCallbacks = {
        onStrandAdded: async (s) => { added.push(s.Id); },
        onStrandRemoved: async (id) => { removed.push(id); }
      };
      const watcher = new StrandWatcher(
        queryable, callbacks, { mode: 'sAppId', sAppId: 'target-app' }, 60000, sAppIdLookup
      );
      await watcher.start();
      await watcher.forcePoll();
      expect(added).toEqual(['late-strand']);     // deferred admission
      strands = [];                                // strand leaves the control network
      await watcher.forcePoll();
      expect(removed).toEqual(['late-strand']);
      expect(watcher.getKnownStrands().has('late-strand')).toBe(false);

      // Provisional entry must have been pruned: a further poll fires nothing,
      // and re-introducing the same id is treated as a fresh deferred admission.
      await watcher.forcePoll();
      expect(removed).toEqual(['late-strand']);
      strands = [createStrand('late-strand')];
      await watcher.forcePoll();
      expect(added).toEqual(['late-strand', 'late-strand']);
      expect(removed).toEqual(['late-strand']);
      await watcher.stop();
    });
  });
});

