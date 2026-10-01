/**
 * The pending-join retry policy (`pending-join-runner.ts`), driven through its injected seam:
 * an in-memory `PendingJoin` table with the real stamp check, scripted formation attempts, and
 * a hand-cranked clock. Covers how each kind of attempt failure is read and how an outcome
 * write that another machine's write beat is settled.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { PendingJoinRunner, type PendingJoinFields, type PendingJoinRunnerDeps } from '../src/pending-join-runner.js';
import { PendingJoinChangedError } from '../src/control-database.js';
import {
  FormationPostApprovalError,
  FormationRejectedError,
  FormationUnreachableError
} from '../src/strand-formation-rejection.js';
import type { FormStrandResult, PendingJoinRow, PendingJoinStatus } from '../src/types.js';
import type { TimeoutScheduler } from '../src/timeout-scheduler.js';

const T0 = 1_700_000_000_000;
const ROW_ID = 'join-1';
const DAY_MS = 24 * 3600_000;

/** Let every promise chain started by a fired timer run to completion. */
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** A clock whose timers fire only when the test advances it. */
function manualClock(): {
  now: () => number;
  scheduler: TimeoutScheduler;
  advanceToNext: () => Promise<void>;
  advance: (ms: number) => Promise<void>;
} {
  let now = T0;
  let nextHandle = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const fireEarliest = async (until: number): Promise<boolean> => {
    let earliest: [number, { at: number; fn: () => void }] | undefined;
    for (const entry of timers) {
      if (entry[1].at <= until && (!earliest || entry[1].at < earliest[1].at)) earliest = entry;
    }
    if (!earliest) return false;
    timers.delete(earliest[0]);
    now = Math.max(now, earliest[1].at);
    earliest[1].fn();
    await settle();
    return true;
  };
  return {
    now: () => now,
    scheduler: {
      setTimeout: (fn, ms) => {
        const handle = nextHandle++;
        timers.set(handle, { at: now + ms, fn });
        return handle;
      },
      clearTimeout: (handle) => { timers.delete(handle as number); },
    },
    advanceToNext: async () => { await fireEarliest(Number.POSITIVE_INFINITY); },
    advance: async (ms) => {
      const until = now + ms;
      while (await fireEarliest(until)) { /* fire every timer due by `until` */ }
      now = until;
    },
  };
}

type ScriptedAttempt = (h: Harness) => Promise<FormStrandResult>;

interface Harness {
  runner: PendingJoinRunner;
  clock: ReturnType<typeof manualClock>;
  table: Map<string, PendingJoinRow>;
  script: ScriptedAttempt[];
  attempts: number;
  emitted: Array<PendingJoinStatus & { at: number }>;
  row(): PendingJoinRow | undefined;
  /** Another owner machine replaces the row. */
  siblingWrites(fields: Partial<PendingJoinFields>): void;
}

function pendingRow(overrides: Partial<PendingJoinRow> = {}): PendingJoinRow {
  return {
    Id: ROW_ID,
    Invitation: 'encoded-invitation',
    Disclosure: '{}',
    RequestedAt: T0,
    ExpiresAt: T0 + 7 * DAY_MS,
    Outcome: null,
    OutcomeAt: null,
    StrandId: null,
    MembershipInvite: null,
    FailureCode: null,
    FailureReason: null,
    StampId: 'stamp-0',
    ...overrides,
  };
}

function approved(strandId: string): FormStrandResult {
  return { memberKey: 'member', invitePrivateKey: 'invite-key', strandId, strandAddrs: [] };
}

const spent = (): Promise<FormStrandResult> => Promise.reject(new FormationRejectedError('token-spent', 'Invalid token'));

let current: Harness | undefined;

afterEach(() => {
  current?.runner.stop();
  current = undefined;
});

function harness(script: ScriptedAttempt[], row: PendingJoinRow = pendingRow(), overrides: Partial<PendingJoinRunnerDeps> = {}): Harness {
  const clock = manualClock();
  const table = new Map<string, PendingJoinRow>([[row.Id, row]]);
  let stamps = 0;
  const h = {} as Harness;
  const deps: PendingJoinRunnerDeps = {
    selfId: 'self-peer',
    // A fast declared link keeps the derived delays small: base 5 s, spent confirmation 35.2 s.
    linkRoundTripMs: 100,
    isOwner: async () => true,
    readRows: async () => [...table.values()],
    readRow: async (id) => table.get(id) ?? null,
    attempt: async () => {
      h.attempts++;
      const next = h.script.shift();
      if (!next) throw new Error('unscripted attempt');
      return next(h);
    },
    replace: async (expectedStampId, next) => {
      const live = table.get(next.Id);
      if (!live || live.StampId !== expectedStampId) {
        throw new PendingJoinChangedError(next.Id, expectedStampId, live?.StampId ?? null);
      }
      const written = { ...next, StampId: `stamp-${++stamps}` };
      table.set(next.Id, written);
      return written;
    },
    remove: async (id) => table.delete(id),
    isAlone: () => false,
    sAppIdOf: () => 'sapp',
    observeRows: () => undefined,
    emit: (status) => h.emitted.push({ ...status, at: clock.now() }),
    now: clock.now,
    random: () => 0.5, // no jitter
    scheduler: clock.scheduler,
    ...overrides,
  };
  Object.assign(h, {
    runner: new PendingJoinRunner(deps),
    clock,
    table,
    script: [...script],
    attempts: 0,
    emitted: [],
    row: () => table.get(row.Id),
    siblingWrites: (fields: Partial<PendingJoinFields>) => {
      const live = table.get(row.Id)!;
      table.set(row.Id, { ...live, ...fields, StampId: `sibling-${++stamps}` });
    },
  });
  current = h;
  return h;
}

/** Ask for the join on this machine, then let every scripted attempt run on its schedule. */
async function runScript(h: Harness): Promise<void> {
  h.runner.start();
  await h.runner.attemptNow(h.row()!);
  for (let guard = 0; h.script.length > 0; guard++) {
    if (guard > 50) throw new Error('scripted attempts never ran');
    await h.clock.advanceToNext();
  }
}

describe('PendingJoinRunner', () => {
  const cases: Array<{ name: string; script: ScriptedAttempt[]; attempts: number; row: Partial<PendingJoinRow> }> = [
    {
      name: 'a token spent on the confirming attempt too fails the row',
      script: [spent, spent],
      attempts: 2,
      row: { Outcome: 'failed', FailureCode: 'token-spent' },
    },
    {
      name: 'a spent token whose re-read shows another machine joined adopts that join',
      script: [(h) => {
        h.siblingWrites({ Outcome: 'joined', OutcomeAt: T0, StrandId: 'strand-sibling' });
        return spent();
      }],
      attempts: 1,
      row: { Outcome: 'joined', StrandId: 'strand-sibling' },
    },
    {
      name: 'a final rejection fails the row with its code and reason',
      script: [() => Promise.reject(new FormationRejectedError('approval-refused', 'not this one'))],
      attempts: 1,
      row: { Outcome: 'failed', FailureCode: 'approval-refused', FailureReason: 'not this one' },
    },
    {
      name: 'an approval followed by a failed local step fails the row as local',
      script: [() => Promise.reject(new FormationPostApprovalError('strand-x', 'remembering the join failed'))],
      attempts: 1,
      row: { Outcome: 'failed', FailureCode: 'local', StrandId: null },
    },
    {
      name: 'a join replaces a failure another machine recorded while it ran',
      script: [(h) => {
        h.siblingWrites({ Outcome: 'failed', OutcomeAt: T0, FailureCode: 'approval-refused', FailureReason: 'no' });
        return Promise.resolve(approved('strand-mine'));
      }],
      attempts: 1,
      row: { Outcome: 'joined', StrandId: 'strand-mine', FailureCode: null },
    },
    {
      name: 'a failure replaces the same request re-issued by another machine while it ran',
      script: [(h) => {
        h.siblingWrites({});
        return Promise.reject(new FormationRejectedError('approval-refused', 'not this one'));
      }],
      attempts: 1,
      row: { Outcome: 'failed', FailureCode: 'approval-refused' },
    },
  ];

  for (const { name, script, attempts, row } of cases) {
    it(name, async () => {
      const h = harness(script);
      await runScript(h);
      expect(h.attempts).toBe(attempts);
      expect(h.row()).toMatchObject(row);
    });
  }

  it('waits longer after each retryable failure, then records the join', async () => {
    const h = harness([
      () => Promise.reject(new FormationUnreachableError('no address answered')),
      () => Promise.reject(new FormationRejectedError('busy', 'at capacity')),
      () => Promise.reject(new FormationUnreachableError('no address answered')),
      () => Promise.resolve(approved('strand-late')),
    ]);
    await runScript(h);
    const waits = h.emitted.filter((status) => status.state === 'waiting');
    expect(waits.map((status) => status.lastError?.code)).toEqual(['unreachable', 'busy', 'unreachable']);
    const gaps = waits.map((status) => status.nextAttemptAt! - status.at);
    expect(gaps[1]).toBeGreaterThan(gaps[0]!);
    expect(gaps[2]).toBeGreaterThan(gaps[1]!);
    expect(h.row()).toMatchObject({ Outcome: 'joined', StrandId: 'strand-late' });
    expect(h.emitted.at(-1)?.state).toBe('joined');
  });

  it('fails a row found past its expiry as expired, without an attempt', async () => {
    const h = harness([], pendingRow({ ExpiresAt: T0 - 1 }));
    h.runner.start();
    await h.clock.advance(0);
    expect(h.attempts).toBe(0);
    expect(h.row()).toMatchObject({ Outcome: 'failed', FailureCode: 'expired' });
  });

  it('backs off a failing outcome write on an expired row instead of retrying it at once', async () => {
    let writes = 0;
    const h = harness([], pendingRow({ ExpiresAt: T0 - 1 }), {
      replace: async () => {
        writes++;
        throw new Error('store unavailable');
      },
    });
    h.runner.start();
    await h.clock.advance(1_000);
    expect(writes).toBe(1);
  });
});
