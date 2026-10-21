import { describe, it, expect, vi, beforeEach } from 'vitest';
import { generatePrivateKey, getPublicKey } from '@optimystic/quereus-plugin-crypto';
import type { Database, StatementOptions } from '@quereus/quereus';
import { StrandInstanceManager, isAwaitingFirstSync, liveStrandStatus } from '../src/strand-instance-manager.js';
import type { StartStrandConfig } from '../src/strand-instance-manager.js';
import { StrandFirstSyncGate, StrandAwaitingFirstSyncError } from '../src/strand-first-sync-gate.js';
import { TABLE_CHANGE_COALESCE_MS } from '../src/table-change-watch.js';
import type { TimeoutScheduler } from '../src/timeout-scheduler.js';
import type { StrandDatabase } from '../src/strand-database.js';
import { signSchema } from '../src/schema-verification.js';
import type { StrandRow, SAppConfig } from '../src/types.js';

/**
 * **What this protects: the joining machine's first-sync write gate** —
 * `strand-first-sync-gate.ts` and its wiring in `StrandInstanceManager`.
 *
 * A machine that has never held a strand's `Strand.Header` must not commit to it (a
 * write before the first sync forks every table it touches; see the module doc). So a
 * NON-founder launch whose Header probe comes back empty must come up `'syncing'` with
 * its database withheld, publish it — and announce — the moment the Header is held,
 * survive a quiesce/resume with the probe rebuilt, and let a founder request open the
 * gate by writing the Header itself. A founder, and a machine whose store already holds
 * the Header, must never be gated.
 *
 * Same doubles as `strand-instance-manager-hibernation.spec.ts` — no real libp2p node or
 * Quereus database, and no storage change feed, so a gated launch here probes on its backstop.
 * The double's `eval` returns a Header row when the test's per-strand count is set, which
 * is how "the Header arrived from a peer" is simulated; it declares no schemas, so the
 * table half of the probe is exercised on the gate class below with fake schemas instead.
 */
const mocks = vi.hoisted(() => {
  const stop = vi.fn(async () => {});
  const close = vi.fn(async () => {});
  const initialize = vi.fn(async () => {});
  const ensureFounderBootstrap = vi.fn(async () => {});
  /** `Strand.Header` row count the double reports, per strand id (absent ⇒ 0). */
  const headerCounts = new Map<string, number>();
  const createLibp2pNode = vi.fn(async () => ({ coordinatedRepo: {}, stop, peerId: { toString: () => 'peer' }, getConnections: () => [], addEventListener: () => {}, removeEventListener: () => {} }));
  // Non-arrow so `new StrandDatabase(...)` is constructable; captures the strand id the
  // manager passes so the probe answers for THAT strand.
  const StrandDatabase = vi.fn(function StrandDatabaseMock(config: { strandId: string }) {
    const db = {
      eval: async function* () { if ((headerCounts.get(config.strandId) ?? 0) > 0) yield { 1: 1 }; },
      schemaManager: { getSchema: () => undefined }
    };
    return { initialize, close, ensureFounderBootstrap, getDatabase: () => db };
  });
  return { stop, close, initialize, ensureFounderBootstrap, createLibp2pNode, StrandDatabase, headerCounts };
});

// `createLibp2pNode` is stubbed; `resolveLinkDeadlines` stays real, because the dial limits
// cadre-core states on every node it builds are derived from it (`optimysticDialLimits`).
vi.mock(import('@optimystic/db-p2p'), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    createLibp2pNode: mocks.createLibp2pNode as unknown as typeof actual.createLibp2pNode,
    resolveLinkDeadlines: actual.resolveLinkDeadlines
  };
});
vi.mock('../src/strand-database.js', () => ({ StrandDatabase: mocks.StrandDatabase }));

const testSchema = 'table Test (id text primary key);';
const testVersion = '1.0.0';
/** Fast gate: a 5 ms probe backstop, and a 40 ms default wait so timeouts are cheap. */
const FAST_GATE = { backstopMs: 5, timeoutMs: 40 };

let authorPrivateKey: string;
let authorPublicKey: string;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.headerCounts.clear();
  authorPrivateKey = generatePrivateKey('ed25519', 'base64url') as string;
  authorPublicKey = getPublicKey(authorPrivateKey, 'ed25519', 'base64url', 'base64url') as string;
});

function createStartConfig(strandId: string, overrides?: Partial<StartStrandConfig>): StartStrandConfig {
  const strandRow: StrandRow = { Id: strandId, MemberPrivateKey: null, Type: 'o', FounderOwnerKey: null, FounderPeerId: null };
  const sAppConfig: SAppConfig = {
    id: authorPublicKey,
    version: testVersion,
    schema: testSchema,
    signature: signSchema(testSchema, testVersion, authorPrivateKey)
  };
  return {
    strandRow,
    sAppConfig,
    profile: 'transaction',
    defaultLatencyHint: 'interactive',
    firstSync: FAST_GATE,
    ...overrides
  };
}

describe('first-sync gate in StrandInstanceManager', () => {
  it('a founder launch publishes its database at once', async () => {
    const manager = new StrandInstanceManager();
    const instance = await manager.startStrand(createStartConfig('gate-founder', { founder: true }));

    expect(instance.status).toBe('active');
    expect(instance.database).toBeDefined();
    expect(isAwaitingFirstSync(instance)).toBe(false);
    await expect(manager.whenWritable('gate-founder')).resolves.toBe(instance);
  });

  it('a non-founder over a store that already holds the Header comes up active (restart / resume shape)', async () => {
    mocks.headerCounts.set('gate-held', 1);
    const manager = new StrandInstanceManager();
    const instance = await manager.startStrand(createStartConfig('gate-held'));

    expect(instance.status).toBe('active');
    expect(instance.database).toBeDefined();
  });

  it('a non-founder with no Header comes up syncing, its database withheld, and whenWritable times out retryably', async () => {
    const onWritable = vi.fn();
    const manager = new StrandInstanceManager();
    const instance = await manager.startStrand(createStartConfig('gate-syncing', { onWritable }));

    expect(instance.status).toBe('syncing');
    expect(instance.database).toBeUndefined();
    expect(instance.libp2pNode).toBeDefined();
    expect(isAwaitingFirstSync(instance)).toBe(true);
    expect(manager.isAwaitingFirstSync('gate-syncing')).toBe(true);
    expect(liveStrandStatus(instance)).toBe('syncing');

    const error = await manager.whenWritable('gate-syncing', { timeoutMs: 20 }).then(() => null, (e: unknown) => e);
    expect(error).toBeInstanceOf(StrandAwaitingFirstSyncError);
    expect((error as StrandAwaitingFirstSyncError).strandId).toBe('gate-syncing');
    expect((error as Error).message).toMatch(/has not yet received the strand's data from another member/);

    // Retryable: nothing was torn down and nothing was announced.
    expect(manager.hasStrand('gate-syncing')).toBe(true);
    expect(instance.status).toBe('syncing');
    expect(instance.libp2pNode).toBeDefined();
    expect(mocks.close).not.toHaveBeenCalled();
    expect(onWritable).not.toHaveBeenCalled();

    await manager.stopAll();
  });

  it('the retained firstSync.timeoutMs is the default wait', async () => {
    const manager = new StrandInstanceManager();
    await manager.startStrand(createStartConfig('gate-default-wait', { firstSync: { backstopMs: 5, timeoutMs: 15 } }));

    const startedAt = Date.now();
    await expect(manager.whenWritable('gate-default-wait')).rejects.toThrow(StrandAwaitingFirstSyncError);
    // Well under the module default (DEFAULT_STRAND_FIRST_SYNC_TIMEOUT_MS): the retained config's budget applied.
    expect(Date.now() - startedAt).toBeLessThan(5_000);

    await manager.stopAll();
  });

  it('the Header arriving opens the gate: database published, status active, waiters released, onWritable once', async () => {
    const onWritable = vi.fn();
    const manager = new StrandInstanceManager();
    const instance = await manager.startStrand(createStartConfig('gate-opens', { onWritable }));
    expect(instance.status).toBe('syncing');

    const waiting = manager.whenWritable('gate-opens', { timeoutMs: 5_000 });
    // "A peer delivered the Header": the next probe sees the row.
    mocks.headerCounts.set('gate-opens', 1);

    await expect(waiting).resolves.toBe(instance);
    expect(instance.status).toBe('active');
    expect(instance.database).toBeDefined();
    expect(isAwaitingFirstSync(instance)).toBe(false);
    expect(onWritable).toHaveBeenCalledTimes(1);
    expect(onWritable).toHaveBeenCalledWith('gate-opens');
    // Already writable: a later wait is immediate, and no second announcement.
    await expect(manager.whenWritable('gate-opens')).resolves.toBe(instance);
    expect(onWritable).toHaveBeenCalledTimes(1);

    await manager.stopAll();
  });

  it('the Header arriving after the hibernation idle timer flipped the label still opens: active, announced once', async () => {
    const onWritable = vi.fn();
    const manager = new StrandInstanceManager();
    const instance = await manager.startStrand(createStartConfig('gate-idle-flip', { onWritable }));
    expect(instance.status).toBe('syncing');

    // What `CadreNode.handleStrandIdle` does after `idleTimeout` with no activity recorded
    // on the gated joiner: the label flips while the database stays withheld.
    instance.status = 'idle';
    expect(isAwaitingFirstSync(instance)).toBe(true);

    const waiting = manager.whenWritable('gate-idle-flip', { timeoutMs: 5_000 });
    mocks.headerCounts.set('gate-idle-flip', 1);

    await expect(waiting).resolves.toBe(instance);
    expect(instance.status).toBe('active');
    expect(instance.database).toBeDefined();
    expect(onWritable).toHaveBeenCalledTimes(1);

    await manager.stopAll();
  });

  it('quiesce while syncing closes the withheld database and stops the probe; resume re-probes over the same store', async () => {
    const manager = new StrandInstanceManager();
    const instance = await manager.startStrand(createStartConfig('gate-quiesce'));
    expect(instance.status).toBe('syncing');

    await manager.quiesceStrand('gate-quiesce');
    expect(mocks.close).toHaveBeenCalledTimes(1);
    expect(instance.database).toBeUndefined();
    expect(instance.libp2pNode).toBeUndefined();
    expect(isAwaitingFirstSync(instance)).toBe(false);

    // Still no Header: the rebuilt runtime is gated again.
    const resumedGated = await manager.resumeStrand('gate-quiesce');
    expect(resumedGated.status).toBe('syncing');
    expect(resumedGated.database).toBeUndefined();

    // The Header landed while it was quiesced (a wake over a store a sibling filled):
    // the rebuild's first probe finds it and the strand comes up writable.
    await manager.quiesceStrand('gate-quiesce');
    mocks.headerCounts.set('gate-quiesce', 1);
    const resumed = await manager.resumeStrand('gate-quiesce');
    expect(resumed.status).toBe('active');
    expect(resumed.database).toBeDefined();

    await manager.stopAll();
  });

  it('a waiter outlives a quiesce and is released by the resume that publishes the database', async () => {
    const manager = new StrandInstanceManager();
    const instance = await manager.startStrand(createStartConfig('gate-wait-across-resume'));
    const waiting = manager.whenWritable('gate-wait-across-resume', { timeoutMs: 5_000 });

    await manager.quiesceStrand('gate-wait-across-resume');
    mocks.headerCounts.set('gate-wait-across-resume', 1);
    await manager.resumeStrand('gate-wait-across-resume');

    await expect(waiting).resolves.toBe(instance);
    await manager.stopAll();
  });

  it('stopStrand while syncing rejects the pending waiters and closes the withheld database', async () => {
    const manager = new StrandInstanceManager();
    await manager.startStrand(createStartConfig('gate-stop'));
    const waiting = manager.whenWritable('gate-stop', { timeoutMs: 5_000 });

    await manager.stopStrand('gate-stop');

    await expect(waiting).rejects.toThrow(/was stopped before becoming writable/);
    expect(mocks.close).toHaveBeenCalledTimes(1);
    expect(manager.hasStrand('gate-stop')).toBe(false);
  });

  it('a founder request against a syncing instance runs the bootstrap through the gate and opens it', async () => {
    const onWritable = vi.fn();
    const manager = new StrandInstanceManager();
    const instance = await manager.startStrand(createStartConfig('gate-found-in-place', { onWritable }));
    expect(instance.status).toBe('syncing');

    // The bootstrap writes the Header this machine was waiting to receive.
    await expect(manager.foundExistingStrand('gate-found-in-place')).resolves.toBe('bootstrapped');

    expect(mocks.ensureFounderBootstrap).toHaveBeenCalledTimes(1);
    expect(instance.status).toBe('active');
    expect(instance.database).toBeDefined();
    expect(onWritable).toHaveBeenCalledTimes(1);
    await expect(manager.whenWritable('gate-found-in-place')).resolves.toBe(instance);

    await manager.stopAll();
  });

  it('a founder request whose bootstrap is refused leaves the instance gated and withdraws the flip', async () => {
    mocks.ensureFounderBootstrap.mockRejectedValueOnce(new Error('refused on purpose'));
    const manager = new StrandInstanceManager();
    const instance = await manager.startStrand(createStartConfig('gate-refused'));

    await expect(manager.foundExistingStrand('gate-refused')).rejects.toThrow('refused on purpose');
    expect(instance.status).toBe('syncing');
    expect(instance.database).toBeUndefined();
    // Withdrawn: a retry re-runs the bootstrap rather than resolving 'already-founder'.
    await expect(manager.foundExistingStrand('gate-refused')).resolves.toBe('bootstrapped');
    expect(instance.status).toBe('active');

    await manager.stopAll();
  });

  it('a failed initialize is rolled back through the gate: the withheld database is closed and nothing is tracked', async () => {
    mocks.initialize.mockRejectedValueOnce(new Error('initialize failed on purpose'));
    const manager = new StrandInstanceManager();

    await expect(manager.startStrand(createStartConfig('gate-init-fails'))).rejects.toThrow('initialize failed on purpose');

    expect(mocks.close).toHaveBeenCalledTimes(1);
    expect(manager.hasStrand('gate-init-fails')).toBe(false);
  });

  it('whenWritable rejects at once for a strand this manager does not track', async () => {
    const manager = new StrandInstanceManager();
    await expect(manager.whenWritable('ghost')).rejects.toThrow(/not tracked/);
  });
});

describe('StrandFirstSyncGate', () => {
  interface FakeTimer {
    fn: () => void;
    ms: number;
  }

  /** A scheduler that runs nothing on its own — the test fires the shortest pending timer by hand. */
  function fakeScheduler(): TimeoutScheduler & { fire(): Promise<number>; pending(): number } {
    const pending: FakeTimer[] = [];
    return {
      setTimeout: (fn, ms) => {
        const timer = { fn, ms };
        pending.push(timer);
        return timer;
      },
      clearTimeout: (handle) => {
        const index = pending.indexOf(handle as FakeTimer);
        if (index >= 0) pending.splice(index, 1);
      },
      pending: () => pending.length,
      // Fire the timer with the shortest delay, let the probe it starts settle, and say which delay it was.
      fire: async () => {
        expect(pending.length, 'no probe was scheduled').toBeGreaterThan(0);
        const soonest = pending.reduce((a, b) => (b.ms < a.ms ? b : a));
        pending.splice(pending.indexOf(soonest), 1);
        soonest.fn();
        await new Promise((resolve) => setTimeout(resolve, 0));
        return soonest.ms;
      }
    };
  }

  /** A stand-in for the strand node's storage-wide change feed. */
  function fakeStorageFeed() {
    const listeners = new Set<() => void>();
    return {
      subscribe: (onChange: () => void) => {
        listeners.add(onChange);
        return () => { listeners.delete(onChange); };
      },
      emit: () => { for (const listener of listeners) listener(); },
      subscribers: () => listeners.size
    };
  }

  /**
   * `held` / `throws` drive the Header read; `strandTables` and `tables` declare the fake
   * `Strand` and `App` schemas, and `unreachable` names the tables (qualified, `'App.Message'`)
   * whose read throws (a collection the cohort has not served yet). Every table other than the
   * Header reads empty. `reads` records every statement and `options` every statement's options,
   * so a test can see what was probed and how.
   */
  interface FakeState {
    held: boolean;
    throws?: boolean;
    /** `schemaManager.getSchema` throws — a probe failure OUTSIDE the read guards. */
    schemaThrows?: boolean;
    strandTables?: string[];
    tables?: string[];
    unreachable?: string[];
    reads?: string[];
    options?: Array<StatementOptions | undefined>;
  }

  function fakeSchema(tables: string[] | undefined) {
    return tables ? { getAllTables: () => tables.map((t) => ({ name: t, isView: false })) } : undefined;
  }

  function fakeDatabase(state: FakeState): StrandDatabase {
    const db = {
      eval: async function* (sql: string, _params?: unknown, options?: StatementOptions) {
        state.reads?.push(sql);
        state.options?.push(options);
        const [, schema, table] = /from (Strand|App)\."(\w+)"/.exec(sql) ?? [];
        if (table !== undefined && table !== 'Header') {
          if (state.unreachable?.includes(`${schema}.${table}`)) throw new Error(`cohort-unreachable: ${schema}.${table}`);
          return;
        }
        if (state.throws) throw new Error('cohort-unreachable');
        if (state.held) yield { 1: 1 };
      },
      schemaManager: {
        getSchema: (name: string) => {
          if (state.schemaThrows) throw new Error('schema not loaded');
          return fakeSchema(name === 'Strand' ? state.strandTables : name === 'App' ? state.tables : undefined);
        }
      }
    } as unknown as Database;
    return { getDatabase: () => db, close: async () => {} } as unknown as StrandDatabase;
  }

  const HEADER_READ = 'select 1 from Strand."Header" limit 1';
  const strandRead = (table: string): string => `select 1 from Strand."${table}" limit 1`;
  const appRead = (table: string): string => `select 1 from App."${table}" limit 1`;

  it('reads one row per table, the Header first, then Strand, then App, stops at the first failing table, and never re-reads what settled', async () => {
    const state: FakeState = {
      held: false,
      // The Header is declared like any Strand table, and must still be read only once, first.
      strandTables: ['Header', 'Invite', 'Member'],
      tables: ['Participant', 'Message', 'Seat'],
      unreachable: ['Strand.Member', 'App.Message'],
      reads: [],
      options: []
    };
    const gate = new StrandFirstSyncGate({ label: 'p', database: fakeDatabase(state), onHeaderHeld: vi.fn() });

    // No Header row: no table is read.
    expect(await gate.probeOnce()).toBe(false);
    expect(state.reads).toEqual([HEADER_READ]);

    // Invite returns no row and still counts as settled (the founder's empty collection);
    // Strand.Member throws, so no App table is read.
    state.held = true;
    state.reads = [];
    expect(await gate.probeOnce()).toBe(false);
    expect(state.reads).toEqual([HEADER_READ, strandRead('Invite'), strandRead('Member')]);

    // Participant settles; App.Message throws, so Seat is not read.
    state.unreachable = ['App.Message'];
    state.reads = [];
    expect(await gate.probeOnce()).toBe(false);
    expect(state.reads).toEqual([strandRead('Member'), appRead('Participant'), appRead('Message')]);

    // Nothing that settled is read again.
    state.unreachable = [];
    state.reads = [];
    expect(await gate.probeOnce()).toBe(true);
    expect(state.reads).toEqual([appRead('Message'), appRead('Seat')]);

    // Serialized, never committed: a committed read does not refresh a table that schema apply
    // initialized over an empty collection staged before any peer answered, so it would read
    // that collection as settled and open the gate onto a fork (the NOTE on the probe).
    expect(state.options?.filter((options) => options?.readConcurrency === 'committed')).toEqual([]);
  });

  it('a throwing read, or a throw outside the read guards, is "not yet" rather than a rejection', async () => {
    const throwing: FakeState = { held: true, throws: true };
    const reads = new StrandFirstSyncGate({ label: 'r', database: fakeDatabase(throwing), onHeaderHeld: vi.fn() });
    expect(await reads.probeOnce()).toBe(false);
    throwing.throws = false;
    expect(await reads.probeOnce()).toBe(true);

    // The `App` schema lookup throwing — the launch's first probe must not fail the build over it.
    const lookup: FakeState = { held: true, tables: ['Message'], schemaThrows: true };
    const schema = new StrandFirstSyncGate({ label: 's', database: fakeDatabase(lookup), onHeaderHeld: vi.fn() });
    expect(await schema.probeOnce()).toBe(false);
    lookup.schemaThrows = false;
    expect(await schema.probeOnce()).toBe(true);
  });

  it('probes when data lands, on the backstop when none does, and opens exactly once', async () => {
    const state: FakeState = { held: false, reads: [] };
    const scheduler = fakeScheduler();
    const feed = fakeStorageFeed();
    const onHeaderHeld = vi.fn();
    const gate = new StrandFirstSyncGate(
      { label: 'g', database: fakeDatabase(state), onHeaderHeld, scheduler, subscribeStorageChanges: feed.subscribe },
      { backstopMs: 2_000 }
    );

    gate.start();
    // Armed, not probed: the caller probed once already.
    expect(state.reads).toEqual([]);
    expect(feed.subscribers()).toBe(1);

    // Nothing lands: the backstop probes and the gate re-arms.
    expect(await scheduler.fire()).toBe(2_000);
    expect(state.reads).toHaveLength(1);
    expect(onHeaderHeld).not.toHaveBeenCalled();

    // Data lands: the probe runs after the coalescing window, ahead of the backstop.
    state.held = true;
    feed.emit();
    feed.emit();
    expect(await scheduler.fire()).toBe(TABLE_CHANGE_COALESCE_MS);
    expect(state.reads).toHaveLength(2);
    expect(onHeaderHeld).toHaveBeenCalledTimes(1);
    expect(gate.isOpen).toBe(true);
    expect(scheduler.pending()).toBe(0);
    expect(feed.subscribers()).toBe(0);

    // Idempotent: nothing re-arms once open.
    gate.start();
    feed.emit();
    expect(scheduler.pending()).toBe(0);
  });

  it('once listening, hears data that lands before start(), and start() then probes without waiting for the backstop', async () => {
    // A first join listens while its database initializes, and a member's push can land in that
    // window (measured on the message-cost strand: 76 ms before initialize returned). Unheard,
    // the gate would sit out its whole backstop with the blocks already held.
    const scheduler = fakeScheduler();
    const feed = fakeStorageFeed();
    const onHeaderHeld = vi.fn();
    const gate = new StrandFirstSyncGate(
      { label: 'l', database: fakeDatabase({ held: true }), onHeaderHeld, scheduler, subscribeStorageChanges: feed.subscribe },
      { backstopMs: 2_000 }
    );

    gate.listen();
    expect(gate.heardDataSinceProbe).toBe(false);
    feed.emit();
    expect(gate.heardDataSinceProbe).toBe(true);
    expect(scheduler.pending()).toBe(0);

    gate.start();
    expect(feed.subscribers()).toBe(1);
    expect(await scheduler.fire()).toBe(TABLE_CHANGE_COALESCE_MS);
    expect(onHeaderHeld).toHaveBeenCalledTimes(1);
  });

  it('open() force-opens without calling onHeaderHeld; stop() cancels the schedule and the feed', async () => {
    const scheduler = fakeScheduler();
    const feed = fakeStorageFeed();
    const onHeaderHeld = vi.fn();
    const opened = new StrandFirstSyncGate(
      { label: 'o', database: fakeDatabase({ held: false }), onHeaderHeld, scheduler, subscribeStorageChanges: feed.subscribe }
    );
    opened.start();
    opened.open();
    expect(opened.isOpen).toBe(true);
    expect(scheduler.pending()).toBe(0);
    expect(feed.subscribers()).toBe(0);
    expect(onHeaderHeld).not.toHaveBeenCalled();

    const stopped = new StrandFirstSyncGate(
      { label: 's', database: fakeDatabase({ held: true }), onHeaderHeld, scheduler, subscribeStorageChanges: feed.subscribe }
    );
    stopped.start();
    expect(scheduler.pending()).toBe(1);
    stopped.stop();
    expect(scheduler.pending()).toBe(0);
    expect(feed.subscribers()).toBe(0);
    expect(stopped.isOpen).toBe(false);
    // A stopped gate never re-arms.
    stopped.start();
    expect(scheduler.pending()).toBe(0);
  });
});
