/**
 * The pending-join retry policy (`pending-join-runner.ts`), driven through its injected seam:
 * an in-memory table of joins with the real changed-join checks, scripted formation attempts,
 * and a hand-cranked clock. Covers how each kind of attempt failure is read and how an outcome
 * write that another machine's write beat is settled.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { PendingJoinRunner, type PendingJoinRunnerDeps } from '../src/pending-join-runner.js';
import { PendingJoinChangedError } from '../src/control-database.js';
import {
  FormationPostApprovalError,
  FormationRejectedError,
  FormationUnreachableError
} from '../src/strand-formation-rejection.js';
import type { FormStrandResult, JoinOutcome, PendingJoin, PendingJoinStatus } from '../src/types.js';
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
  table: Map<string, PendingJoin>;
  script: ScriptedAttempt[];
  attempts: number;
  emitted: Array<PendingJoinStatus & { at: number }>;
  row(): PendingJoin | undefined;
  /** Another owner machine records an outcome on the live request. */
  siblingRecords(outcome: JoinOutcome): void;
  /** Another owner machine re-issues the request unchanged under a fresh stamp. */
  siblingReissues(): void;
}

function pendingJoin(overrides: Partial<PendingJoin> = {}): PendingJoin {
  return {
    Id: ROW_ID,
    Invitation: 'encoded-invitation',
    Disclosure: '{}',
    RequestedAt: T0,
    ExpiresAt: T0 + 7 * DAY_MS,
    StampId: 'stamp-0',
    outcome: null,
    ...overrides,
  };
}

const joinedOutcome = (strandId: string): JoinOutcome => ({ kind: 'joined', RecordedAt: T0, StrandId: strandId, MembershipInvite: null });
const failedOutcome = (code: string, reason: string): JoinOutcome => ({ kind: 'failed', RecordedAt: T0, Code: code, Reason: reason });

function approved(strandId: string): FormStrandResult {
  return { memberKey: 'member', invitePrivateKey: 'invite-key', strandId, strandAddrs: [] };
}

const spent = (): Promise<FormStrandResult> => Promise.reject(new FormationRejectedError('token-spent', 'Invalid token'));

let current: Harness | undefined;

afterEach(() => {
  current?.runner.stop();
  current = undefined;
});

function harness(script: ScriptedAttempt[], join: PendingJoin = pendingJoin(), overrides: Partial<PendingJoinRunnerDeps> = {}): Harness {
  const clock = manualClock();
  const table = new Map<string, PendingJoin>([[join.Id, join]]);
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
    record: async (expected, outcome) => {
      const live = table.get(expected.Id) ?? null;
      if (!live || live.StampId !== expected.StampId || live.outcome?.kind !== expected.outcome?.kind) {
        throw new PendingJoinChangedError(expected.Id, live);
      }
      const written = { ...live, outcome };
      table.set(expected.Id, written);
      return written;
    },
    rewrite: async (expectedStampId, next) => {
      const live = table.get(next.Id) ?? null;
      if (!live || live.StampId !== expectedStampId) {
        throw new PendingJoinChangedError(next.Id, live);
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
    row: () => table.get(join.Id),
    siblingRecords: (outcome: JoinOutcome) => {
      table.set(join.Id, { ...table.get(join.Id)!, outcome });
    },
    siblingReissues: () => {
      table.set(join.Id, { ...table.get(join.Id)!, StampId: `sibling-${++stamps}` });
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
  const cases: Array<{ name: string; script: ScriptedAttempt[]; attempts: number; outcome: Partial<JoinOutcome> }> = [
    {
      name: 'a token spent on the confirming attempt too fails the join',
      script: [spent, spent],
      attempts: 2,
      outcome: { kind: 'failed', Code: 'token-spent' },
    },
    {
      name: 'a spent token whose re-read shows another machine joined adopts that join',
      script: [(h) => {
        h.siblingRecords(joinedOutcome('strand-sibling'));
        return spent();
      }],
      attempts: 1,
      outcome: { kind: 'joined', StrandId: 'strand-sibling' },
    },
    {
      name: 'a final rejection fails the join with its code and reason',
      script: [() => Promise.reject(new FormationRejectedError('approval-refused', 'not this one'))],
      attempts: 1,
      outcome: { kind: 'failed', Code: 'approval-refused', Reason: 'not this one' },
    },
    {
      name: 'an approval followed by a failed local step fails the join as local',
      script: [() => Promise.reject(new FormationPostApprovalError('strand-x', 'remembering the join failed'))],
      attempts: 1,
      outcome: { kind: 'failed', Code: 'local' },
    },
    {
      name: 'a join replaces a failure another machine recorded while it ran',
      script: [(h) => {
        h.siblingRecords(failedOutcome('approval-refused', 'no'));
        return Promise.resolve(approved('strand-mine'));
      }],
      attempts: 1,
      outcome: { kind: 'joined', StrandId: 'strand-mine' },
    },
    {
      name: 'a failure replaces the same request re-issued by another machine while it ran',
      script: [(h) => {
        h.siblingReissues();
        return Promise.reject(new FormationRejectedError('approval-refused', 'not this one'));
      }],
      attempts: 1,
      outcome: { kind: 'failed', Code: 'approval-refused' },
    },
  ];

  for (const { name, script, attempts, outcome } of cases) {
    it(name, async () => {
      const h = harness(script);
      await runScript(h);
      expect(h.attempts).toBe(attempts);
      expect(h.row()?.outcome).toMatchObject(outcome);
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
    expect(h.row()?.outcome).toMatchObject({ kind: 'joined', StrandId: 'strand-late' });
    expect(h.row()?.StampId, 'an outcome is added to the request, not written over it').toBe('stamp-0');
    expect(h.emitted.at(-1)?.state).toBe('joined');
  });

  it('fails a request found past its expiry as expired, without an attempt', async () => {
    const h = harness([], pendingJoin({ ExpiresAt: T0 - 1 }));
    h.runner.start();
    await h.clock.advance(0);
    expect(h.attempts).toBe(0);
    expect(h.row()?.outcome).toMatchObject({ kind: 'failed', Code: 'expired' });
  });

  it('backs off a failing outcome write on an expired request instead of retrying it at once', async () => {
    let writes = 0;
    const h = harness([], pendingJoin({ ExpiresAt: T0 - 1 }), {
      record: async () => {
        writes++;
        throw new Error('store unavailable');
      },
    });
    h.runner.start();
    await h.clock.advance(1_000);
    expect(writes).toBe(1);
  });

  it('re-issues a join written while alone as a whole, request and outcome, under a fresh stamp', async () => {
    let alone = true;
    const h = harness([() => Promise.resolve(approved('strand-alone'))], pendingJoin(), { isAlone: () => alone });
    h.runner.noteWritten(h.row()!, 'request');
    await runScript(h);
    expect(h.row()?.outcome).toMatchObject({ kind: 'joined', StrandId: 'strand-alone' });

    alone = false;
    await h.runner.reissueWritesMadeAlone();
    expect(h.row()?.StampId).not.toBe('stamp-0');
    expect(h.row()?.outcome).toMatchObject({ kind: 'joined', StrandId: 'strand-alone' });

    await h.runner.reissueWritesMadeAlone();
    expect(h.row()?.StampId, 'a connected re-issue clears the mark').toBe('stamp-1');
  });
});
