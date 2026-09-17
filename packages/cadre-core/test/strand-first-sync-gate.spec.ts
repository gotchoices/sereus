import { describe, it, expect, vi, beforeEach } from 'vitest';
import { generatePrivateKey, getPublicKey } from '@optimystic/quereus-plugin-crypto';
import type { Database } from '@quereus/quereus';
import { StrandInstanceManager, isAwaitingFirstSync, liveStrandStatus } from '../src/strand-instance-manager.js';
import type { StartStrandConfig } from '../src/strand-instance-manager.js';
import {
  StrandFirstSyncGate,
  StrandAwaitingFirstSyncError,
  strandHeaderHeld,
  type FirstSyncScheduler,
} from '../src/strand-first-sync-gate.js';
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
 * Quereus database. The double's `eval` answers the Header probe from a per-strand count
 * the test flips, which is how "the Header arrived from a peer" is simulated.
 */
const mocks = vi.hoisted(() => {
  const stop = vi.fn(async () => {});
  const close = vi.fn(async () => {});
  const initialize = vi.fn(async () => {});
  const ensureFounderBootstrap = vi.fn(async () => {});
  /** `Strand.Header` row count the double reports, per strand id (absent ⇒ 0). */
  const headerCounts = new Map<string, number>();
  const createLibp2pNode = vi.fn(async () => ({ coordinatedRepo: {}, stop, peerId: { toString: () => 'peer' } }));
  // Non-arrow so `new StrandDatabase(...)` is constructable; captures the strand id the
  // manager passes so the probe answers for THAT strand.
  const StrandDatabase = vi.fn(function StrandDatabaseMock(config: { strandId: string }) {
    const db = {
      eval: async function* () { yield { Count: headerCounts.get(config.strandId) ?? 0 }; }
    };
    return { initialize, close, ensureFounderBootstrap, getDatabase: () => db };
  });
  return { stop, close, initialize, ensureFounderBootstrap, createLibp2pNode, StrandDatabase, headerCounts };
});

vi.mock('@optimystic/db-p2p', () => ({ createLibp2pNode: mocks.createLibp2pNode }));
vi.mock('../src/strand-database.js', () => ({ StrandDatabase: mocks.StrandDatabase }));

const testSchema = 'create table Test (id text primary key);';
const testVersion = '1.0.0';
/** Fast gate: a 5 ms probe cadence, and a 40 ms default wait so timeouts are cheap. */
const FAST_GATE = { pollIntervalMs: 5, timeoutMs: 40 };

let authorPrivateKey: string;
let authorPublicKey: string;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.headerCounts.clear();
  authorPrivateKey = generatePrivateKey('ed25519', 'base64url') as string;
  authorPublicKey = getPublicKey(authorPrivateKey, 'ed25519', 'base64url', 'base64url') as string;
});

function createStartConfig(strandId: string, overrides?: Partial<StartStrandConfig>): StartStrandConfig {
  const strandRow: StrandRow = { Id: strandId, MemberPrivateKey: null, Type: 'o', FounderOwnerKey: null };
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
    expect((error as Error).message).toMatch(/no member of this strand has been reachable/);

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
    await manager.startStrand(createStartConfig('gate-default-wait', { firstSync: { pollIntervalMs: 5, timeoutMs: 15 } }));

    const startedAt = Date.now();
    await expect(manager.whenWritable('gate-default-wait')).rejects.toThrow(StrandAwaitingFirstSyncError);
    // Well under the module default of 30 s: the retained config's budget applied.
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
  /** A scheduler that runs nothing on its own — the test fires each pending probe by hand. */
  function fakeScheduler(): FirstSyncScheduler & { fire(): Promise<void>; pending(): number } {
    const pending: Array<() => void> = [];
    return {
      setTimeout: (fn) => { pending.push(fn); return fn; },
      clearTimeout: (handle) => {
        const index = pending.indexOf(handle as () => void);
        if (index >= 0) pending.splice(index, 1);
      },
      pending: () => pending.length,
      // Fire the next probe and let its async read settle.
      fire: async () => {
        const fn = pending.shift();
        expect(fn, 'no probe was scheduled').toBeDefined();
        fn!();
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    };
  }

  function fakeDatabase(state: { held: boolean; throws?: boolean }): StrandDatabase {
    const db = {
      eval: async function* () {
        if (state.throws) throw new Error('cohort-unreachable');
        yield { Count: state.held ? 1 : 0 };
      }
    } as unknown as Database;
    return { getDatabase: () => db, close: async () => {} } as unknown as StrandDatabase;
  }

  it('probes on its cadence, reschedules while the Header is absent, and opens exactly once when it is held', async () => {
    const state = { held: false };
    const scheduler = fakeScheduler();
    const onHeaderHeld = vi.fn();
    const gate = new StrandFirstSyncGate({ label: 'g', database: fakeDatabase(state), onHeaderHeld, scheduler }, { pollIntervalMs: 1 });

    gate.start();
    expect(scheduler.pending()).toBe(1);
    await scheduler.fire();
    expect(onHeaderHeld).not.toHaveBeenCalled();
    expect(scheduler.pending()).toBe(1);
    expect(gate.isOpen).toBe(false);

    state.held = true;
    await scheduler.fire();
    expect(onHeaderHeld).toHaveBeenCalledTimes(1);
    expect(gate.isOpen).toBe(true);
    expect(scheduler.pending()).toBe(0);
    // Idempotent: a second start arms nothing once open.
    gate.start();
    expect(scheduler.pending()).toBe(0);
  });

  it('a throwing probe is "not yet": the loop keeps going and opens once the read succeeds', async () => {
    const state = { held: true, throws: true };
    const scheduler = fakeScheduler();
    const onHeaderHeld = vi.fn();
    const gate = new StrandFirstSyncGate({ label: 'g', database: fakeDatabase(state), onHeaderHeld, scheduler });

    gate.start();
    await scheduler.fire();
    expect(onHeaderHeld).not.toHaveBeenCalled();
    expect(scheduler.pending()).toBe(1);

    state.throws = false;
    await scheduler.fire();
    expect(onHeaderHeld).toHaveBeenCalledTimes(1);
  });

  it('open() force-opens without calling onHeaderHeld; stop() cancels the pending probe', async () => {
    const scheduler = fakeScheduler();
    const onHeaderHeld = vi.fn();
    const opened = new StrandFirstSyncGate({ label: 'o', database: fakeDatabase({ held: false }), onHeaderHeld, scheduler });
    opened.start();
    opened.open();
    expect(opened.isOpen).toBe(true);
    expect(scheduler.pending()).toBe(0);
    expect(onHeaderHeld).not.toHaveBeenCalled();

    const stopped = new StrandFirstSyncGate({ label: 's', database: fakeDatabase({ held: true }), onHeaderHeld, scheduler });
    stopped.start();
    expect(scheduler.pending()).toBe(1);
    stopped.stop();
    expect(scheduler.pending()).toBe(0);
    expect(stopped.isOpen).toBe(false);
    // A stopped gate never re-arms.
    stopped.start();
    expect(scheduler.pending()).toBe(0);
  });

  it('strandHeaderHeld reads the count and reports false on a throwing read', async () => {
    expect(await strandHeaderHeld(fakeDatabase({ held: true }).getDatabase(), 't')).toBe(true);
    expect(await strandHeaderHeld(fakeDatabase({ held: false }).getDatabase(), 't')).toBe(false);
    expect(await strandHeaderHeld(fakeDatabase({ held: true, throws: true }).getDatabase(), 't')).toBe(false);
  });
});
