/**
 * The pending-join retry loop: carries on a join this party asked for through another party's
 * invitation (`CadreControl.JoinRequest`, one row per invitation, with its outcome in
 * `JoinSuccess` / `JoinFailure`) in the background, on every owner machine of the party, until
 * the join works, the invitation is used up or expires, or the user dismisses it. The behaviour
 * is described in `docs/strands.md` → "Joining while the inviter is offline".
 *
 * `CadreNode` owns every side effect and hands this module plain functions
 * ({@link PendingJoinRunnerDeps}): read the joins, run one attempt (its own `formStrand`), write
 * an outcome, say whether this machine is an owner, and the clock. This module owns the policy:
 * when to attempt, how to read an attempt's failure, and how to settle an outcome write that
 * another machine's write beat.
 *
 * Only owner machines run it, because every pending-join write is owner-signed. Letting a
 * machine without an owner key finish a join is `blocked/decide-non-owner-machine-completes-a-pending-join`;
 * that changes {@link PendingJoinRunnerDeps.isOwner} and the write functions, not this loop.
 */

import debug from 'debug';
import type {
  FormStrandResult,
  JoinOutcome,
  PendingJoin,
  PendingJoinStatus,
  StrandFormationDisclosure,
  StrandMembershipInvite
} from './types.js';
import { canonicalJson } from './canonical-json.js';
import { PendingJoinChangedError, type JoinRequestFields, type PendingJoinFields } from './control-database.js';
import { FormationPostApprovalError, FormationRejectedError, FormationUnreachableError } from './strand-formation-rejection.js';
import { formationDeadlines } from './strand-formation-deadlines.js';
import { MEMBERSHIP_INVITE_TTL_MS } from './strand-formation-manager.js';
import { defaultTimeoutScheduler, type TimeoutScheduler } from './timeout-scheduler.js';

const log = debug('sereus:cadre:pending-join');

/** How often an owner machine re-reads the party's pending joins (it also reads once right after start). */
export const PENDING_JOIN_POLL_MS = 30_000;

/** Ceiling on the wait between two attempts of one join on one machine, before jitter. */
export const PENDING_JOIN_MAX_BACKOFF_MS = 10 * 60_000;

/**
 * The longest a join is tried for. A request's `ExpiresAt` is the earlier of this and the
 * invitation's own expiration, which the inviter chose.
 */
export const MAX_PENDING_JOIN_MS = 30 * 24 * 3600_000;

/** Background attempts one machine runs at once. An explicit `requestJoin` does not wait for a slot. */
const MAX_BACKGROUND_ATTEMPTS = 2;

/** Each retry delay is moved by up to this fraction either way, so machines that failed together do not retry together. */
const RETRY_JITTER = 0.2;

/** Re-read-and-rewrite rounds after another machine's write won, before the next pass decides instead. */
const MAX_OUTCOME_WRITE_ROUNDS = 3;

type AttemptError = NonNullable<PendingJoinStatus['lastError']>;

/** Which pending-join write this machine made: the request itself (an insert or a rewrite), or an outcome row for it. */
export type PendingJoinWrite = 'request' | 'outcome';

export interface PendingJoinRunnerDeps {
  /** This machine's peer id; with the request id it fixes when this machine first tries a join it did not ask for. */
  selfId: string;
  /** `NetworkConfig.linkRoundTripMs`: the retry pace follows the formation deadlines it yields. */
  linkRoundTripMs?: number;
  /** Whether this machine may write pending joins now. Asked every pass. */
  isOwner(): Promise<boolean>;
  readRows(): Promise<PendingJoin[]>;
  readRow(id: string): Promise<PendingJoin | null>;
  /** One formation attempt for the request's invitation and disclosure (`CadreNode.formStrand`). */
  attempt(join: PendingJoin): Promise<FormStrandResult>;
  /** `ControlDatabase.recordJoinOutcome`, owner-signed: throws `PendingJoinChangedError` when the live join is not `expected`. */
  record(expected: PendingJoin, outcome: JoinOutcome): Promise<PendingJoin>;
  /** `ControlDatabase.rewritePendingJoin`, owner-signed: throws `PendingJoinChangedError` when the live request is not `expectedStampId`. */
  rewrite(expectedStampId: string, next: PendingJoinFields): Promise<PendingJoin>;
  /** `ControlDatabase.deletePendingJoin`, owner-signed. */
  remove(id: string): Promise<boolean>;
  /** Whether this machine has no control connection now, so a write it commits reaches no other machine. */
  isAlone(): boolean;
  /** The sApp the request's invitation names. */
  sAppIdOf(join: PendingJoin): string;
  /** Every pass's joins, read by an owner machine; `CadreNode` stages the membership invitations they carry. */
  observeRows(joins: readonly PendingJoin[]): void;
  emit(status: PendingJoinStatus): void;
  now?: () => number;
  random?: () => number;
  scheduler?: TimeoutScheduler;
}

/** This machine's memory of one join. Nothing here survives a restart; the rows are the durable state. */
interface TrackedJoin {
  row: PendingJoin;
  /** Retryable failures on this machine since the join was first seen or asked for again. */
  failures: number;
  timer?: unknown;
  /** Due, waiting for a background attempt slot. */
  queued: boolean;
  /** Set while an attempt (or a re-run of its outcome write) is running. */
  attempt?: Promise<void>;
  trying: boolean;
  nextAttemptAt?: number;
  lastError?: AttemptError;
  /** An earlier attempt here answered `token-spent`; the next such answer fails the join. */
  spentOnce: boolean;
  /** This machine's approved join, held until its outcome write lands, so a later pass rewrites it rather than attempting a spent token. */
  joinedHere?: JoinOutcome;
  lastEmitted?: string;
}

/** What to do after an outcome write found that another write had changed or removed the join. */
type LostWriteResolution = 'gone' | 'adopt' | 'rewrite';

/**
 * A `joined` outcome replaces anything still live, since a join that happened cannot be undone
 * by another machine's failure. A failure replaces a pending request of the same ask: only a
 * re-issue of a request written alone writes one, unchanged, so it decides nothing. Any other
 * live join wins, and a fresh request is then decided again by the loop.
 */
function resolveLostWrite(live: PendingJoin | null, expected: PendingJoin, next: JoinOutcome): LostWriteResolution {
  if (live === null) return 'gone';
  if (live.outcome?.kind === 'joined') return 'adopt';
  if (next.kind === 'joined') return 'rewrite';
  return live.outcome === null && live.RequestedAt === expected.RequestedAt ? 'rewrite' : 'adopt';
}

/**
 * The request a `requestJoin` writes: tried until the invitation's own expiration or
 * {@link MAX_PENDING_JOIN_MS} from now, whichever comes first.
 */
export function requestedPendingJoin(
  id: string,
  encodedInvitation: string,
  disclosure: StrandFormationDisclosure,
  invitationExpiresAt: number,
  now: number
): JoinRequestFields {
  return {
    Id: id,
    Invitation: encodedInvitation,
    Disclosure: canonicalJson(disclosure),
    RequestedAt: now,
    ExpiresAt: Math.min(invitationExpiresAt, now + MAX_PENDING_JOIN_MS),
  };
}

/** A request's stored disclosure, as the next attempt sends it. Owner-signed, so anything but an object is a bug. */
export function parseStoredDisclosure(join: PendingJoin): StrandFormationDisclosure {
  const parsed: unknown = JSON.parse(join.Disclosure);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`JoinRequest ${join.Id}: the stored disclosure is not a JSON object`);
  }
  return parsed as StrandFormationDisclosure;
}

/** A `JoinSuccess` row's `MembershipInvite` column, or null when it is not the `{inviteKey, invitePrivateKey}` JSON the loop writes. */
export function parseStoredMembershipInvite(text: string): StrandMembershipInvite | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const { inviteKey, invitePrivateKey } = parsed as Record<string, unknown>;
  return typeof inviteKey === 'string' && typeof invitePrivateKey === 'string' ? { inviteKey, invitePrivateKey } : null;
}

/**
 * The membership invitations joined requests carry that this process has not staged yet, so a
 * closed strand joined on one owner machine can be seated by whichever machine launches it
 * first. Joins older than {@link MEMBERSHIP_INVITE_TTL_MS} are skipped: their invitation is dead.
 * `alreadyStaged` holds invite keys; a malformed column is skipped and logged.
 */
export function membershipInvitesToStage(
  joins: readonly PendingJoin[],
  alreadyStaged: ReadonlySet<string>,
  now: number
): Array<{ rowId: string; strandId: string; invite: StrandMembershipInvite }> {
  const toStage: Array<{ rowId: string; strandId: string; invite: StrandMembershipInvite }> = [];
  for (const join of joins) {
    const { outcome } = join;
    if (outcome?.kind !== 'joined' || outcome.MembershipInvite === null) continue;
    if (now >= outcome.RecordedAt + MEMBERSHIP_INVITE_TTL_MS) continue;
    const invite = parseStoredMembershipInvite(outcome.MembershipInvite);
    if (!invite) {
      log('pending join %s: its MembershipInvite column does not parse; not staged', join.Id);
      continue;
    }
    if (!alreadyStaged.has(invite.inviteKey)) {
      toStage.push({ rowId: join.Id, strandId: outcome.StrandId, invite });
    }
  }
  return toStage;
}

/** The join without its stamp, as a rewrite takes it. */
function fieldsOf(join: PendingJoin): PendingJoinFields {
  const { StampId: _stampId, ...fields } = join;
  return fields;
}

function joinedOutcome(result: FormStrandResult, now: number): JoinOutcome {
  const invite = result.membershipInvite;
  return {
    kind: 'joined',
    RecordedAt: now,
    StrandId: result.strandId,
    MembershipInvite: invite ? JSON.stringify({ inviteKey: invite.inviteKey, invitePrivateKey: invite.invitePrivateKey }) : null,
  };
}

function failedOutcome(code: string, reason: string, now: number): JoinOutcome {
  return { kind: 'failed', RecordedAt: now, Code: code, Reason: reason };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A fraction in [0, 1) fixed by `key` (32-bit FNV-1a): the same machine staggers the same join the same way every time. */
function stableFraction(key: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) / 0x1_0000_0000;
}

export class PendingJoinRunner {
  private readonly tracked = new Map<string, TrackedJoin>();
  /** Joins whose latest write by this machine committed with no control connection: id → the request stamp written. */
  private readonly writtenAlone = new Map<string, string>();
  private readonly dueQueue: TrackedJoin[] = [];
  private readonly scheduler: TimeoutScheduler;
  private readonly now: () => number;
  private readonly random: () => number;
  /** First retry delay, and the window a join this machine did not ask for is first tried in. */
  private readonly baseDelayMs: number;
  /** How long a `token-spent` answer waits before its confirming attempt: long enough for a sibling's `joined` write to replicate. */
  private readonly spentConfirmDelayMs: number;
  private running = false;
  private pollTimer: unknown;
  private passInFlight: Promise<void> | null = null;
  private passAgain = false;
  private backgroundAttempts = 0;

  constructor(private readonly deps: PendingJoinRunnerDeps) {
    this.scheduler = deps.scheduler ?? defaultTimeoutScheduler;
    this.now = deps.now ?? Date.now;
    this.random = deps.random ?? Math.random;
    const deadlines = formationDeadlines(deps.linkRoundTripMs);
    this.baseDelayMs = 2 * deadlines.dialMs;
    this.spentConfirmDelayMs = 2 * deadlines.sessionMs;
  }

  /** Start passes: one at once, then every {@link PENDING_JOIN_POLL_MS}. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.schedulePass(0);
  }

  /**
   * Stop scheduling. Clears every timer and starts no new attempt.
   *
   * NOTE: an attempt already in flight is not awaited, because `formStrand` takes no abort
   * signal. An approval that lands while the node stops can lose its local records; the request
   * then stays pending, and the next start's attempt answers `token-spent`, which fails it after
   * its confirming attempt. Honest and bounded; if it shows up in practice, give `formStrand` a
   * signal and abort it here.
   */
  stop(): void {
    this.running = false;
    this.clearPollTimer();
    for (const entry of this.tracked.values()) this.cancelTimer(entry);
    this.tracked.clear();
    this.dueQueue.length = 0;
    this.writtenAlone.clear();
  }

  /** Run a pass now, for a change that may make one useful (this machine just became an owner). */
  kick(): void {
    if (!this.running) return;
    this.clearPollTimer();
    void this.pass();
  }

  /**
   * Try `join` on this machine at once, outside the background slots, and report the status
   * after the attempt. Joins an attempt already running for it.
   */
  async attemptNow(join: PendingJoin): Promise<PendingJoinStatus> {
    const entry = this.adopt(join);
    if (entry.row.outcome === null) {
      await this.startAttempt(entry);
    }
    return this.describe(entry.row, entry);
  }

  /** This machine's view of `join`: its own state, with this machine's attempt state laid over a pending one. */
  statusOf(join: PendingJoin): PendingJoinStatus {
    return this.describe(join, this.tracked.get(join.Id));
  }

  /**
   * Record a pending-join write this machine made, for {@link reissueWritesMadeAlone}. A write
   * made alone marks the join. A request write made connected clears the mark, since it
   * carried the request; an outcome write made connected does not, since the request it names
   * may still be unknown to the other machines.
   */
  noteWritten(join: PendingJoin, write: PendingJoinWrite): void {
    if (this.deps.isAlone()) {
      this.writtenAlone.set(join.Id, join.StampId);
    } else if (write === 'request') {
      this.writtenAlone.delete(join.Id);
    }
  }

  /** Stop tracking a join the user dismissed. An attempt in flight finishes; its outcome write then finds the request gone. */
  forgetRow(id: string): void {
    const entry = this.tracked.get(id);
    if (entry) this.forget(entry);
  }

  /**
   * Re-write, with identical content under a fresh stamp, each join this machine last wrote while
   * it had no control connection, so the other machines receive it. Called on the control
   * connection growth edge. A join someone wrote since is left alone.
   *
   * NOTE: in memory only, so a join written alone by a process that stopped before it reconnected
   * reaches the party only with that join's next write. A sweep of every join this machine wrote,
   * on the first connection after start, would cover that, at the cost of one permanent
   * `Revocation` tombstone per join per start. Revisit if other machines are seen missing such joins.
   */
  async reissueWritesMadeAlone(): Promise<void> {
    if (this.writtenAlone.size === 0) return;
    if (!(await this.deps.isOwner())) {
      this.writtenAlone.clear();
      return;
    }
    for (const [id, stampId] of [...this.writtenAlone]) {
      try {
        const live = await this.deps.readRow(id);
        if (!live || live.StampId !== stampId) {
          this.writtenAlone.delete(id);
          continue;
        }
        const written = await this.deps.rewrite(stampId, fieldsOf(live));
        this.noteWritten(written, 'request');
        const entry = this.tracked.get(id);
        if (entry?.row.StampId === stampId) entry.row = written;
        log('pending join %s: re-issued the join written while alone', id);
      } catch (error) {
        log('pending join %s: re-issuing the join written while alone failed; kept for the next connection: %s', id, errorText(error));
      }
    }
  }

  private schedulePass(delayMs: number): void {
    if (!this.running) return;
    this.clearPollTimer();
    this.pollTimer = this.scheduler.setTimeout(() => {
      this.pollTimer = undefined;
      void this.pass();
    }, delayMs);
  }

  private clearPollTimer(): void {
    if (this.pollTimer !== undefined) {
      this.scheduler.clearTimeout(this.pollTimer);
      this.pollTimer = undefined;
    }
  }

  /** One pass at a time; a kick during a pass runs one more after it. */
  private pass(): Promise<void> {
    if (this.passInFlight) {
      this.passAgain = true;
      return this.passInFlight;
    }
    const run = this.runPass()
      .catch((error: unknown) => log('pending-join pass failed; the next one retries: %s', errorText(error)))
      .finally(() => {
        this.passInFlight = null;
        if (this.passAgain && this.running) {
          this.passAgain = false;
          void this.pass();
          return;
        }
        this.schedulePass(PENDING_JOIN_POLL_MS);
      });
    this.passInFlight = run;
    return run;
  }

  private async runPass(): Promise<void> {
    if (!this.running) return;
    if (!(await this.deps.isOwner())) {
      log('pending-join pass skipped: this machine is not an enrolled owner');
      this.pauseAttempts();
      return;
    }
    const joins = await this.deps.readRows();
    if (!this.running) return;
    this.deps.observeRows(joins);
    const live = new Set(joins.map((join) => join.Id));
    for (const entry of [...this.tracked.values()]) {
      if (!live.has(entry.row.Id) && !entry.attempt) this.forget(entry);
    }
    for (const join of joins) {
      if (!this.running) return;
      try {
        await this.consider(join);
      } catch (error) {
        log('pending join %s: this pass could not handle it; the next one retries: %s', join.Id, errorText(error));
      }
    }
  }

  /** Drop every scheduled attempt; the first pass that finds this machine an owner again schedules afresh. */
  private pauseAttempts(): void {
    for (const entry of this.tracked.values()) {
      this.cancelTimer(entry);
      entry.nextAttemptAt = undefined;
    }
    for (const entry of this.dueQueue) entry.queued = false;
    this.dueQueue.length = 0;
  }

  /** Bring one read join into this machine's schedule. */
  private async consider(join: PendingJoin): Promise<void> {
    const entry = this.adopt(join);
    if (entry.attempt) return;
    if (entry.row.outcome !== null) {
      this.emitIfChanged(entry);
      await this.ageOut(entry);
      return;
    }
    if (entry.joinedHere || this.now() >= entry.row.ExpiresAt) {
      await this.startAttempt(entry);
      return;
    }
    if (entry.timer === undefined && !entry.queued) {
      this.scheduleAttempt(entry, Math.floor(stableFraction(`${this.deps.selfId}|${entry.row.Id}`) * this.baseDelayMs));
    }
    this.emitIfChanged(entry);
  }

  /**
   * The tracked entry for `join`, updated to it. A join asked for again (`RequestedAt` changed)
   * starts this machine's counting over; a finished join stops its schedule.
   */
  private adopt(join: PendingJoin): TrackedJoin {
    const entry = this.tracked.get(join.Id);
    if (!entry) {
      const fresh: TrackedJoin = { row: join, failures: 0, queued: false, trying: false, spentOnce: false };
      this.tracked.set(join.Id, fresh);
      return fresh;
    }
    if (entry.row.StampId === join.StampId && entry.row.outcome?.kind === join.outcome?.kind) return entry;
    if (join.outcome !== null || entry.row.RequestedAt !== join.RequestedAt) {
      this.cancelTimer(entry);
      entry.failures = 0;
      entry.spentOnce = false;
      entry.lastError = undefined;
      entry.nextAttemptAt = undefined;
    }
    if (join.outcome?.kind === 'joined') entry.joinedHere = undefined;
    entry.row = join;
    return entry;
  }

  private scheduleAttempt(entry: TrackedJoin, delayMs: number): void {
    if (!this.running) return;
    this.cancelTimer(entry);
    const now = this.now();
    // A request already past its expiry keeps the full delay: its due attempt is an outcome
    // write, and clamping to a past expiry would retry a failing write with no wait at all.
    const at = now < entry.row.ExpiresAt ? Math.min(now + delayMs, entry.row.ExpiresAt) : now + delayMs;
    entry.nextAttemptAt = at;
    entry.timer = this.scheduler.setTimeout(() => {
      entry.timer = undefined;
      this.enqueue(entry);
    }, Math.max(0, at - this.now()));
  }

  private cancelTimer(entry: TrackedJoin): void {
    if (entry.timer !== undefined) {
      this.scheduler.clearTimeout(entry.timer);
      entry.timer = undefined;
    }
  }

  private enqueue(entry: TrackedJoin): void {
    if (!this.running || this.tracked.get(entry.row.Id) !== entry || entry.queued) return;
    entry.queued = true;
    this.dueQueue.push(entry);
    this.pump();
  }

  /** Start due attempts while background slots are free. */
  private pump(): void {
    while (this.running && this.backgroundAttempts < MAX_BACKGROUND_ATTEMPTS && this.dueQueue.length > 0) {
      const entry = this.dueQueue.shift()!;
      entry.queued = false;
      if (entry.attempt || this.tracked.get(entry.row.Id) !== entry) continue;
      this.backgroundAttempts++;
      void this.startAttempt(entry).finally(() => {
        this.backgroundAttempts--;
        this.pump();
      });
    }
  }

  /** Run one attempt for `entry`, or join the one already running. Never rejects. */
  private startAttempt(entry: TrackedJoin): Promise<void> {
    if (entry.attempt) return entry.attempt;
    this.cancelTimer(entry);
    if (entry.queued) {
      entry.queued = false;
      this.dueQueue.splice(this.dueQueue.indexOf(entry), 1);
    }
    // NOTE: only a join is held for re-writing (`joinedHere`); a failed write of a final failure is
    // retried by attempting again, so a `local` failure whose write failed ends up recorded as
    // `token-spent`. If apps come to branch on that code, hold failures the same way.
    const run = this.attemptOnce(entry)
      .catch((error: unknown) => {
        entry.trying = false;
        log('pending join %s: attempt failed on this machine: %s', entry.row.Id, errorText(error));
        if (entry.row.outcome === null && this.tracked.get(entry.row.Id) === entry) {
          this.retryLater(entry, { code: 'local', reason: errorText(error) });
        }
      })
      .finally(() => {
        entry.attempt = undefined;
      });
    entry.attempt = run;
    return run;
  }

  private async attemptOnce(entry: TrackedJoin): Promise<void> {
    if (entry.row.outcome !== null) return;
    if (entry.joinedHere) {
      await this.writeOutcome(entry, entry.joinedHere);
      return;
    }
    if (this.now() >= entry.row.ExpiresAt) {
      const reason = `No attempt starts after ${new Date(entry.row.ExpiresAt).toISOString()}`;
      await this.writeOutcome(entry, failedOutcome('expired', reason, this.now()));
      return;
    }
    entry.trying = true;
    entry.nextAttemptAt = undefined;
    this.emitIfChanged(entry);
    let result: FormStrandResult;
    try {
      result = await this.deps.attempt(entry.row);
    } catch (error) {
      entry.trying = false;
      await this.onAttemptFailed(entry, error);
      return;
    }
    entry.trying = false;
    log('pending join %s: approved, strand %s', entry.row.Id, result.strandId);
    entry.joinedHere = joinedOutcome(result, this.now());
    await this.writeOutcome(entry, entry.joinedHere);
  }

  /** Read a failed attempt: retry, confirm a spent token, or fail the join. */
  private async onAttemptFailed(entry: TrackedJoin, error: unknown): Promise<void> {
    const now = this.now();
    if (error instanceof FormationRejectedError && error.code === 'token-spent') {
      await this.onSpent(entry, error);
    } else if (error instanceof FormationPostApprovalError) {
      log('pending join %s: approved, then a step on this machine failed; failing the join', entry.row.Id);
      await this.writeOutcome(entry, failedOutcome('local', error.message, now));
    } else if (error instanceof FormationRejectedError && !error.retryable) {
      log('pending join %s: refused (%s); failing the join', entry.row.Id, error.code);
      await this.writeOutcome(entry, failedOutcome(error.code, error.reason, now));
    } else if (error instanceof FormationRejectedError) {
      this.retryLater(entry, { code: error.code, reason: error.reason });
    } else if (error instanceof FormationUnreachableError) {
      this.retryLater(entry, { code: 'unreachable', reason: error.message });
    } else {
      // Retrying is safe: nothing is attempted after the request's expiry.
      log('pending join %s: attempt threw an unexpected error; retrying: %s', entry.row.Id, errorText(error));
      this.retryLater(entry, { code: 'local', reason: errorText(error) });
    }
  }

  /**
   * A `token-spent` answer may mean another owner machine of this party won the same
   * invitation. Adopt its outcome if the join already shows one; otherwise confirm once, after
   * long enough for that machine's `joined` write to arrive, before failing the join.
   */
  private async onSpent(entry: TrackedJoin, error: FormationRejectedError): Promise<void> {
    const live = await this.deps.readRow(entry.row.Id);
    if (!live) {
      this.forget(entry);
      return;
    }
    this.adopt(live);
    if (live.outcome !== null) {
      this.emitIfChanged(entry);
      return;
    }
    if (entry.spentOnce) {
      log('pending join %s: token spent again after the confirming wait; failing the join', entry.row.Id);
      await this.writeOutcome(entry, failedOutcome('token-spent', error.reason, this.now()));
      return;
    }
    entry.spentOnce = true;
    entry.lastError = { code: 'token-spent', reason: error.reason };
    this.scheduleAttempt(entry, this.spentConfirmDelayMs);
    this.emitIfChanged(entry);
  }

  private retryLater(entry: TrackedJoin, lastError: AttemptError): void {
    entry.failures++;
    entry.lastError = lastError;
    this.scheduleAttempt(entry, this.backoffMs(entry.failures));
    this.emitIfChanged(entry);
  }

  /** `min(base × 2^(n−1), max)`, moved by up to ±{@link RETRY_JITTER}. */
  private backoffMs(failures: number): number {
    const capped = Math.min(this.baseDelayMs * 2 ** (failures - 1), PENDING_JOIN_MAX_BACKOFF_MS);
    return Math.round(capped * (1 + (this.random() * 2 - 1) * RETRY_JITTER));
  }

  /**
   * Record `next` on the join this machine last read. When another write got there first, settle
   * by {@link resolveLostWrite} from the live join the refusal carries. A join the user dismissed
   * meanwhile is not recreated; a join this machine made is still remembered machine-locally, as
   * every `formStrand` join is.
   */
  private async writeOutcome(entry: TrackedJoin, next: JoinOutcome): Promise<void> {
    let expected = entry.row;
    for (let round = 0; round < MAX_OUTCOME_WRITE_ROUNDS; round++) {
      let live: PendingJoin | null;
      try {
        const written = await this.deps.record(expected, next);
        this.noteWritten(written, 'outcome');
        this.settle(written);
        log('pending join %s: recorded %s', entry.row.Id, next.kind === 'failed' ? `failed (${next.Code})` : 'joined');
        return;
      } catch (error) {
        if (!(error instanceof PendingJoinChangedError)) throw error;
        live = error.live;
      }
      const resolution = resolveLostWrite(live, expected, next);
      if (resolution === 'gone') {
        log('pending join %s: dismissed while this machine was recording %s; not recreated', entry.row.Id, next.kind);
        this.forget(entry);
        return;
      }
      if (resolution === 'adopt') {
        this.settle(live!);
        return;
      }
      expected = live!;
    }
    log('pending join %s: another machine kept changing the join; the next pass decides', entry.row.Id);
  }

  private settle(join: PendingJoin): void {
    const entry = this.adopt(join);
    if (join.outcome !== null) entry.joinedHere = undefined;
    this.emitIfChanged(entry);
  }

  /**
   * Remove a finished join {@link MEMBERSHIP_INVITE_TTL_MS} after its outcome: the membership
   * invitation it carries is dead by then, and an app that was not running has seen the strand
   * through `strand:discovered`. Only while connected, like every write nothing waits on.
   *
   * NOTE: `deletePendingJoin` removes whichever incarnation is live, so a `requestJoin` of the
   * same invitation landing on another machine in the same instant can be removed with it. The
   * user asks again; revisit if that is ever seen.
   */
  private async ageOut(entry: TrackedJoin): Promise<void> {
    const recordedAt = entry.row.outcome?.RecordedAt;
    if (recordedAt === undefined || this.now() < recordedAt + MEMBERSHIP_INVITE_TTL_MS || this.deps.isAlone()) return;
    await this.deps.remove(entry.row.Id);
    log('pending join %s: removed, %d days after its outcome', entry.row.Id, MEMBERSHIP_INVITE_TTL_MS / (24 * 3600_000));
    this.forget(entry);
  }

  private forget(entry: TrackedJoin): void {
    this.cancelTimer(entry);
    if (this.tracked.get(entry.row.Id) === entry) this.tracked.delete(entry.row.Id);
  }

  private emitIfChanged(entry: TrackedJoin): void {
    if (!this.running || this.tracked.get(entry.row.Id) !== entry) return;
    const status = this.describe(entry.row, entry);
    const key = JSON.stringify(status);
    if (key === entry.lastEmitted) return;
    entry.lastEmitted = key;
    this.deps.emit(status);
  }

  private describe(join: PendingJoin, entry: TrackedJoin | undefined): PendingJoinStatus {
    const base = {
      id: join.Id,
      sAppId: this.deps.sAppIdOf(join),
      requestedAt: join.RequestedAt,
      expiresAt: join.ExpiresAt,
    };
    const { outcome } = join;
    if (outcome?.kind === 'joined') {
      return { ...base, state: 'joined', strandId: outcome.StrandId };
    }
    if (outcome?.kind === 'failed') {
      return { ...base, state: 'failed', failure: { code: outcome.Code, reason: outcome.Reason } };
    }
    const local = entry && entry.row.outcome === null && entry.row.RequestedAt === join.RequestedAt ? entry : undefined;
    if (local?.trying) {
      return { ...base, state: 'trying' };
    }
    if (local?.lastError && local.nextAttemptAt !== undefined) {
      return { ...base, state: 'waiting', nextAttemptAt: local.nextAttemptAt, lastError: local.lastError };
    }
    return { ...base, state: 'pending' };
  }
}
