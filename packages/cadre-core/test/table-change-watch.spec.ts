import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Database } from '@quereus/quereus';
import { watchTables, TABLE_CHANGE_COALESCE_MS } from '../src/table-change-watch.js';
import type { TableChangeWatch, TableChangeWatchOptions } from '../src/table-change-watch.js';
import type { TimeoutScheduler } from '../src/timeout-scheduler.js';

/**
 * **What this protects: the scheduling contract of `table-change-watch.ts`**, which the
 * change-driven pollers (strand watcher, control reconcile, pending-join runner, revocation
 * enforcer) and the membership-row cache all rely on: changes inside the coalescing window
 * share one run, a change during a run produces exactly one follow-up, nothing runs after
 * `dispose()`, and `onInvalidate` hears every changed table by the name the consumer passed.
 *
 * A real in-memory Quereus `Database` (local commits only; replicated changes are
 * Optimystic's contract) and a virtual clock, so no test waits on a real timer.
 */

/** Hand-cranked timers on a virtual clock; `advance` fires what falls due, in order, letting each run's promises settle. */
function virtualClock(): { scheduler: TimeoutScheduler; advance(ms: number): Promise<void> } {
  let now = 0;
  let nextId = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const nextDue = (until: number): [number, { at: number; fn: () => void }] | undefined =>
    [...timers.entries()]
      .filter(([, timer]) => timer.at <= until)
      .sort(([idA, a], [idB, b]) => a.at - b.at || idA - idB)[0];
  return {
    scheduler: {
      setTimeout: (fn, ms) => {
        timers.set(++nextId, { at: now + ms, fn });
        return nextId;
      },
      clearTimeout: handle => { timers.delete(handle as number); },
    },
    async advance(ms) {
      const until = now + ms;
      for (let due = nextDue(until); due; due = nextDue(until)) {
        timers.delete(due[0]);
        now = due[1].at;
        due[1].fn();
        await settle();
      }
      now = until;
      await settle();
    },
  };
}

function settle(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0));
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}

describe('watchTables', () => {
  let db: Database;
  let clock: ReturnType<typeof virtualClock>;
  let runs: number;
  let watch: TableChangeWatch | undefined;

  beforeEach(async () => {
    db = new Database();
    await db.exec(`
      declare schema Probe {
        table Thing (Id integer primary key);
        table Other (Id integer primary key);
      }
      apply schema Probe;
    `);
    clock = virtualClock();
    runs = 0;
    watch = undefined;
  });

  afterEach(async () => {
    watch?.dispose();
    await db.close();
  });

  function subscribe(onChange: () => Promise<void>, options: Partial<TableChangeWatchOptions> = {}): TableChangeWatch {
    watch = watchTables(db, ['Probe.Thing', 'Probe.Other'], onChange, { label: 'spec', scheduler: clock.scheduler, ...options });
    return watch;
  }

  const insert = (table: string, id: number): Promise<void> => db.exec(`insert into Probe.${table} (Id) values (?)`, [id]);

  it('runs once for two commits inside the window, after invalidating each table by the name passed', async () => {
    const invalidated: string[] = [];
    subscribe(async () => { runs++; }, { onInvalidate: table => invalidated.push(table) });

    await insert('Thing', 1);
    await insert('Other', 1);
    expect(invalidated).toEqual(['Probe.Thing', 'Probe.Other']);
    expect(runs).toBe(0);

    await clock.advance(TABLE_CHANGE_COALESCE_MS);
    expect(runs).toBe(1);
    await clock.advance(TABLE_CHANGE_COALESCE_MS * 10);
    expect(runs).toBe(1);
  });

  it('runs exactly once more for any number of changes during a run', async () => {
    const held = deferred();
    subscribe(async () => {
      runs++;
      if (runs === 1) {
        await held.promise;
      }
    });

    await insert('Thing', 1);
    await clock.advance(TABLE_CHANGE_COALESCE_MS);
    expect(runs).toBe(1);

    await insert('Thing', 2);
    await clock.advance(TABLE_CHANGE_COALESCE_MS); // the window ends while the run is still open
    await insert('Thing', 3);
    await insert('Other', 1);
    await clock.advance(TABLE_CHANGE_COALESCE_MS * 4);
    expect(runs).toBe(1);

    held.resolve();
    await settle();
    await clock.advance(TABLE_CHANGE_COALESCE_MS * 10);
    expect(runs).toBe(2);
  });

  it('starts no run after dispose, whether a change was pending or a run was in flight', async () => {
    const pending = subscribe(async () => { runs++; });
    await insert('Thing', 1);
    pending.dispose();
    await clock.advance(TABLE_CHANGE_COALESCE_MS * 10);
    expect(runs).toBe(0);

    const held = deferred();
    const inFlight = subscribe(async () => {
      runs++;
      await held.promise;
    }, { backstopMs: 1_000 });
    await insert('Thing', 2);
    await clock.advance(TABLE_CHANGE_COALESCE_MS);
    expect(runs).toBe(1);
    await insert('Thing', 3);
    inFlight.dispose();
    inFlight.trigger();
    held.resolve();
    await settle();
    await clock.advance(10_000);
    expect(runs).toBe(1);
  });

  it('lets the earliest of a trigger, a change and the backstop start the run, and re-arms the backstop from each settle', async () => {
    subscribe(async () => { runs++; }, { backstopMs: 1_000 });

    await clock.advance(999);
    expect(runs).toBe(0);
    await clock.advance(1);
    expect(runs).toBe(1); // backstop armed at subscribe

    watch!.trigger(5_000);
    await insert('Thing', 1);
    await clock.advance(TABLE_CHANGE_COALESCE_MS);
    expect(runs).toBe(2); // the change's window beat the trigger, and cleared it

    await clock.advance(999);
    expect(runs).toBe(2);
    await clock.advance(1);
    expect(runs).toBe(3); // backstop counted from the last settle, not from subscribe
  });
});
