/**
 * Strand membership reconciliation: the per-instance background loop that finishes a
 * party's join at strand bring-up. Every machine of a party that runs a closed strand
 * ends up with (1) the party's `Strand.Member` row seated — redeeming the
 * formation-staged invitation if one is pending — and (2) its own durable
 * machine→party binding (`Strand.MemberPeer`) written, which is what revocation
 * enforcement and future admission control key on.
 *
 * ## Contract
 *
 * - **Never blocks or fails bring-up.** Armed by `StrandInstanceManager.buildStrandRuntime`
 *   right after the strand database initializes (launch AND hibernation resume — the one
 *   seam where a transport peer id and a live `Database` both exist), and every pass is
 *   fully contained: a joiner at that instant has typically not synced the founder's rows
 *   and may lack write quorum, so failure means "retry next tick", never a throw.
 * - **Kicked the moment its database appears.** A joining machine's first pass runs while
 *   the first-sync write gate still withholds `instance.database`, so it finds no database
 *   and returns at once. `StrandInstanceManager.publishDatabase` calls `reconcile()` as it
 *   hands the database to the app, which is what makes the join finish about a second after
 *   the strand becomes writable rather than on the next timer.
 * - **Retries fast while the join is unfinished, slowly while it is only waiting.** A pass
 *   that leaves the join unfinished re-arms on a ladder starting at
 *   {@link INITIAL_JOIN_RETRY_INTERVAL_MS} and doubling, capped at the configured poll
 *   interval (default {@link DEFAULT_REVOCATION_POLL_INTERVAL_MS}; an embedder's
 *   `revocationEnforcement.pollIntervalMs` is mirrored here by the instance manager). A pass
 *   that finds no member row AND no staged invitation is not an unfinished join but a wait
 *   for someone to admit this party — nothing this machine can do faster — so it re-arms on
 *   the flat poll interval and resets the ladder. The loop stops on the done state.
 * - **Done state**: the party's member row is visible locally, this machine's own binding
 *   is in place, AND no invitation is still staged — the loop stops. A LATER revocation is
 *   the enforcer's business, not this loop's; a resume rebuilds the reconciler and
 *   re-verifies from scratch (every write is idempotent, so re-running is free), and a
 *   fresh invitation staged on a done loop re-arms it in place ({@link rearm}).
 *
 * ## One pass
 *
 * 1. **Self-revocation check.** If the enforcer flags this node's own party as revoked and
 *    no invitation is staged, stop rather than fight — re-admission arrives (if ever) via
 *    a fresh formation, which re-arms the loop. With an invitation staged the loop reports
 *    the dead end (below) and carries on: the redemption is attempted like any other, and a
 *    manager's re-admission lets a later pass finish it.
 * 2. **Ensure membership.** Member row visible → done with this step; if a staged
 *    invitation is still unspent, BURN it ({@link burnInvite} — the `ConsumedInvite` row
 *    alone) so the bearer credential cannot be spent by anyone else. A burn refused by the
 *    cohort keeps the invitation staged for the next pass (it is the same write gate a
 *    redemption faces, and the local member row may be stale — see "Re-arming"); a dead
 *    invitation is dropped. Member row absent + staged invitation → {@link consumeInvite}
 *    under the party's own key, retried across passes until the `Invite` row has
 *    replicated here and the write commits. Absent with no invitation (founder rows not
 *    yet synced, or a machine whose party never joined) → keep waiting, escalating to one
 *    visible warning after {@link IDLE_PASSES_BEFORE_ESCALATION} passes, never throwing.
 * 3. **Ensure the binding.** {@link registerMemberPeer} (insert-if-absent, restart-safe)
 *    with this node's own strand transport peer id — only after step 2 sees the member
 *    row locally (its deferred `MemberExists` reads the live local table). Done only once
 *    the binding is in place AND nothing is staged; a binding written while a burn keeps
 *    being refused leaves the loop live to settle the invitation later.
 *
 * ## Stops, and re-arming
 *
 * Two kinds of stop. A RE-ARMABLE stop is one a fresh invitation should reopen:
 *
 * - **Done** (above).
 * - **Self-revoked with nothing staged** (step 1 above).
 *
 * A PERMANENT stop is one a fresh invitation changes nothing about — {@link rearm} is a
 * no-op after it:
 *
 * - **Sealed strand**: `consumeInvite` rejected by `ConsumedInvite.NotSealed` — nobody
 *   can ever be admitted, so retrying forever is noise. Terminal-with-log.
 * - **Undecodable party key**: nothing can be signed; loud log, stop.
 * - **The public {@link stop}**: `StrandInstanceManager.releaseRuntime` and
 *   `clearOwnMemberPeerBinding` both call it and mean it — the latter stops the loop and
 *   awaits {@link settle} precisely so no pass can re-register the binding it is about to
 *   delete, and a re-arm that restarted the loop would undo that.
 *
 * `CadreNode.adoptFormationMembershipInvite` stages every fresh invitation and notifies
 * the instance manager, which calls {@link rearm}: a done loop reopens and runs one pass
 * at once; a running loop is merely kicked. This is what lets a party that was REMOVED
 * from the strand, and then handed a new invitation, actually attempt it — the loop
 * finished during its first join, long before the removal.
 *
 * On a removed party the local replica is usually stale: the cohort cut this machine off
 * at about the moment the removal was written, so `isStrandMember` still answers true and
 * a re-armed pass lands in the already-member arm. That is why the burn arm keeps a
 * refused invitation staged and why the done state requires nothing staged — otherwise
 * the fresh credential would be dropped on the first refused burn and the loop would latch
 * done again, with the only trace a debug line.
 *
 * A DEAD invitation that is not terminal for the loop — expired, cancelled, or already
 * consumed by someone else (`ConsumedInvite`'s primary key) — is dropped with a log and
 * the loop keeps idling: a fresh formation stages a new invitation, and a manager-side
 * admission (`addMemberByManager`) seats the member row without one.
 *
 * ## Reporting a blocked re-join
 *
 * Redeeming (or burning) writes into the strand, and the machines that would carry that
 * write are exactly the ones the remaining members refuse once this party is removed. So
 * the attempt is expected to fail, and the failure is REPORTED rather than left to the
 * ladder: one `console.warn` plus the {@link StrandMembershipReconcilerDeps.onRejoinBlocked}
 * callback (`CadreNode`'s `strand:rejoin-blocked` event), at most once per re-arm cycle.
 * Two triggers:
 *
 * - **Confirmed** — a pass finds this party self-revoked AND an invitation staged. The node
 *   knows it was removed and is holding a credential it cannot spend.
 * - **Probable** — {@link UNFINISHED_PASSES_BEFORE_ESCALATION} consecutive attempted passes
 *   left the invitation staged. The case that matters most in the field: a removed party
 *   that never learned it was removed (the removal did not replicate here before the cut).
 *   It is a suspicion, not a verdict — the invitation's `Invite` row may simply not have
 *   replicated here yet — and the warning names both causes.
 *
 * The remedy in either case is a remaining manager admitting this party's member key
 * directly (`addMemberByManager`): that lifts the refusal, replication resumes, and the
 * still-running loop sees the member row, burns the leftover credential and finishes by
 * itself.
 *
 * ## Sharing the database with the app
 *
 * The strand `Database` this loop writes to is the one the app holds. Every write here
 * passes `joinOpenTransaction: false`, so it runs as a transaction of its own and never
 * joins one the app has open: the writer refuses with `StrandTransactionBusyError`, having
 * written nothing, and the pass retries on the ladder. A busy refusal is never read as a
 * dead invitation, and a busy burn leaves the invitation staged for the next pass.
 *
 * ## Half-committed join
 *
 * On a networked strand optimystic commits `Member` and `ConsumedInvite` as separate
 * collections and can report that only some of them were saved (`CoordinatorPartialCommitError`,
 * or the plugin's legacy `PartialCommitError`). When `ConsumedInvite` is saved and `Member` is
 * not, the invitation is spent and the schema seats a `Member` through an invitation only in the
 * same transaction as a fresh consumption, so this loop can never seat the party from it. Such a
 * failure is recognised by TYPE before any message text is read (its message names the
 * `ConsumedInvite` collection, which a text match once mistook for a dead invitation), reported
 * with ONE `console.warn`, and the invitation is dropped. The loop keeps running like it does
 * after a dead invitation: a manager admission, or a `Member` row that did land, is picked up by
 * the next pass, which then writes the binding. Whether sereus should repair such a join itself
 * is `blocked/strand-half-committed-join-recovery`.
 */

import debug from 'debug';
import type { Database } from '@quereus/quereus';
import { CoordinatorPartialCommitError } from '@optimystic/db-core';
import { PartialCommitError } from '@optimystic/quereus-plugin-optimystic';
import { causeChain } from './control-retry.js';
import type { Ed25519KeyPair } from './ed25519-key.js';
import type { StrandMembershipInvite } from './types.js';
import { strandMemberKeyPair } from './strand-member-key.js';
import {
  StrandTransactionBusyError,
  burnInvite,
  consumeInvite,
  isStrandMember,
  registerMemberPeer,
  type StrandWriteOptions,
} from './strand-membership-writer.js';
import { DEFAULT_REVOCATION_POLL_INTERVAL_MS } from './strand-revocation-enforcer.js';
import { defaultTimeoutScheduler, type TimeoutScheduler } from './timeout-scheduler.js';

const log = debug('sereus:cadre:strand-membership-reconciler');

/**
 * Idle passes (no member row, no staged invitation) before ONE `console.warn`
 * escalation — at the default 30 s cadence, about five minutes of waiting. The loop
 * keeps retrying quietly after it; the warning exists so a joiner stuck waiting on
 * founder-row replication is visible without the debug namespace enabled.
 */
export const IDLE_PASSES_BEFORE_ESCALATION = 10;

/**
 * Consecutive passes that ran against a live database and ended with the staged
 * invitation still unsettled — whatever refused it — before the loop reports a probable
 * blocked re-join (see "Reporting a blocked re-join" in the module doc). The same order
 * as {@link IDLE_PASSES_BEFORE_ESCALATION}: about five minutes once the ladder reaches the
 * 30 s cap. Counted by outcome rather than by classified failure because a cut-off machine
 * can fail before any write is classified: its membership READ may already throw.
 */
export const UNFINISHED_PASSES_BEFORE_ESCALATION = 10;

/**
 * First retry delay, ms, for a pass that left the join UNFINISHED — a `consumeInvite`
 * whose `Strand.Invite` row has not replicated to this machine yet, a cohort briefly
 * unwritable, a database not yet published. Doubles per such pass up to the configured
 * poll interval. Sized for what it retries: invite-row replication resolves in about a
 * second over a direct connection and a few over a relay. The poll interval is NOT sized
 * for that — it is the revocation enforcer's deny-set refresh cadence, mirrored here for
 * the idle case (waiting to be admitted at all), which is why this ladder exists instead
 * of a shorter interval.
 */
export const INITIAL_JOIN_RETRY_INTERVAL_MS = 1_000;

/** Every write this loop makes runs in a transaction of its own — see "Sharing the database with the app". */
const OWN_TRANSACTION: StrandWriteOptions = { joinOpenTransaction: false };

/**
 * The `consumeInvite` rejection that means the strand is SEALED — `ConsumedInvite.NotSealed`
 * fired, which Quereus renders `CHECK constraint failed: NotSealed (<its expression>)`.
 * Terminal for a non-member: nobody can ever be admitted again.
 */
const SEALED_REJECTION = /CHECK constraint failed: NotSealed\b/;

/**
 * `consumeInvite` rejections that mean the INVITATION is dead but the loop should keep
 * waiting for membership to arrive another way: expired (`CHECK constraint failed: NotExpired`),
 * cancelled (`CHECK constraint failed: NotCancelled`), or already consumed by someone else
 * (`UNIQUE constraint failed: ConsumedInvite.InviteKey`, the primary key).
 *
 * Anchored to the engine's full constraint-failure texts, not the bare names: other failures
 * embed those names — a half-committed join's message names the `default/strand/ConsumedInvite`
 * collection, which the bare `ConsumedInvite` this used to match read as a dead invitation. The
 * texts are pinned against the real engine in `strand-membership-reconciler.spec.ts`, so a
 * rewording in Quereus fails a spec instead of silently turning a dead invitation into an
 * endless retry.
 */
const DEAD_INVITE_REJECTION =
  /CHECK constraint failed: (?:NotExpired|NotCancelled)\b|UNIQUE constraint failed: ConsumedInvite\.InviteKey\b/;

/**
 * A redemption only part of which was saved: the collections (or, on the plugin's legacy
 * path, tree labels) that were saved and those that were not, as the error reports them.
 */
export interface HalfCommittedJoin {
  kind: 'half-committed';
  saved: readonly string[];
  unsaved: readonly string[];
}

/** Where {@link classifyConsumeFailure} routes a failed `consumeInvite` or `burnInvite`. */
export type ConsumeFailure =
  | HalfCommittedJoin
  /** The app had a transaction open, so nothing was tried — keep the invitation, retry. */
  | { kind: 'busy' }
  /** The strand is sealed — terminal for a non-member; a member's leftover invitation is merely dead. */
  | { kind: 'sealed' }
  /** Expired, cancelled, or consumed by someone else — drop the invitation, keep waiting. */
  | { kind: 'dead-invite' }
  /**
   * Anything else — the `Invite` row has not replicated here yet, or the cohort refused the
   * write (a removed party's machines are denied) — keep the invitation, retry.
   */
  | { kind: 'retry' };

/**
 * Route a `consumeInvite` or `burnInvite` rejection. Both write the `Strand.ConsumedInvite`
 * row under the same `NotExpired` / `NotCancelled` / `NotSealed` / primary-key constraints
 * (a burn writes that row alone), so one classifier serves both. Typed checks run before any
 * text check: a busy refusal (another transaction was open, so nothing ran) and a
 * half-committed join are recognised by their error's type anywhere in the `cause` chain.
 * The busy refusal carries Quereus's own refusal as its cause, and a half-committed join's
 * message embeds collection names and the underlying failure's text, either of which a text
 * matcher can misread. The sealed and dead-invitation checks then read the top-level message.
 *
 * A second loaded copy of `@optimystic/db-core` (or of the plugin) would fail `instanceof`; the
 * half-commit then falls through the anchored texts to `retry`, and once the saved `ConsumedInvite`
 * row is visible here a later attempt fails on its primary key and drops the invitation quietly —
 * the old silent outcome, a few passes later, never a wrong write.
 */
export function classifyConsumeFailure(error: unknown): ConsumeFailure {
  if (isTransactionBusy(error)) return { kind: 'busy' };
  const halfCommitted = halfCommittedJoin(error);
  if (halfCommitted) return halfCommitted;
  const message = errorMessage(error);
  if (SEALED_REJECTION.test(message)) return { kind: 'sealed' };
  if (DEAD_INVITE_REJECTION.test(message)) return { kind: 'dead-invite' };
  return { kind: 'retry' };
}

/**
 * The first partial-commit error in the `cause` chain, as the lists it reports.
 *
 * NOTE: `PartialCommitError` is imported from the plugin's root entry while strands register the
 * plugin through its `/plugin` entry (`quereus-plugin-sereus`'s `compose-strand.ts`); the two are
 * one class only because the plugin's build emits both entries over one shared chunk — the same
 * dependency, and the same remedy if upstream ever bundles them apart, as the NOTE on
 * `reportsPossiblyStoredWrite` in `control-write-retry.ts`.
 */
function halfCommittedJoin(error: unknown): HalfCommittedJoin | undefined {
  for (const link of causeChain(error)) {
    if (link instanceof CoordinatorPartialCommitError) {
      return { kind: 'half-committed', saved: link.committedCollections, unsaved: link.failedCollections };
    }
    if (link instanceof PartialCommitError) {
      return { kind: 'half-committed', saved: link.persisted, unsaved: link.unpersisted };
    }
  }
  return undefined;
}

/** Whether a writer refused because another transaction was open (see "Sharing the database with the app"). */
function isTransactionBusy(error: unknown): boolean {
  return causeChain(error).some((link) => link instanceof StrandTransactionBusyError);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The staged formation invitation seam — `CadreNode`'s in-memory
 * `pendingMembershipInvites` cache, scoped to one strand. Read lazily per pass (a
 * re-formation may replace the entry between passes) and cleared by the reconciler once
 * the invitation is spent, burned, or dead — the invalidation half the cache itself
 * deliberately does not own.
 */
export interface PendingMembershipInviteSource {
  /** The staged invitation, or `undefined` when none is pending for this strand. */
  get(): StrandMembershipInvite | undefined;
  /**
   * Drop `settled` (spent, burned, or dead) — only if it is still the staged one. A
   * re-formation can replace the entry between a pass's {@link get} and this call, and
   * the fresh invitation it staged must survive the older one being settled.
   */
  clear(settled: StrandMembershipInvite): void;
}

export interface StrandMembershipReconcilerDeps {
  /** Log tag naming which strand this reconciler serves (the strand id). */
  label: string;
  /**
   * THIS party's own strand membership private key (base64 protobuf, the control-layer
   * `StrandPartyKey` row's content). Decoded LAZILY on the first pass, so a malformed
   * key stops the loop with a log instead of failing bring-up.
   */
  partyMemberPrivateKey: string;
  /**
   * The live strand `Database`, read per pass, never captured — the instance's handle
   * is dropped on quiesce, and `undefined` means "no live database this instant" (the
   * pass simply waits for the next tick).
   */
  getDatabase: () => Database | undefined;
  /**
   * This node's own strand transport peer id — the `MemberPeer.PeerId` to bind. Read
   * per pass for the same lifecycle reason as {@link getDatabase}.
   */
  getOwnPeerId: () => string | undefined;
  /** The staged invitation seam. Absent for flows with no invitation (e.g. tests). */
  pendingInvite?: PendingMembershipInviteSource;
  /**
   * Whether the revocation enforcer currently flags THIS node's own party as revoked.
   * When it does and nothing is staged, the loop stops rather than fight the enforcer;
   * with an invitation staged it reports the blocked re-join and keeps trying — see the
   * module doc. Absent (enforcement disarmed) means "not known revoked".
   */
  isSelfRevoked?: () => boolean;
  /**
   * Called when the loop reports a blocked re-join (see "Reporting a blocked re-join" in
   * the module doc) — at most once per re-arm cycle, after the `console.warn`. `CadreNode`
   * wires it to its `strand:rejoin-blocked` event.
   */
  onRejoinBlocked?: () => void;
  /**
   * Timer seam for the retry ladder; omit for real (unref'd) timeouts. Timeouts rather
   * than the enforcer's repeating interval because the delay changes per pass and the next
   * pass is armed only once the previous one settles, so a slow pass never stacks ticks
   * behind it — the same seam the first-sync gate's probe loop uses.
   */
  scheduler?: TimeoutScheduler;
}

/** Embedder-facing tuning, threaded by `StrandInstanceManager`. */
export interface StrandMembershipReconciliationConfig {
  /**
   * Default true. False disarms the loop entirely — meant for test fixtures that
   * hand-drive the membership writers and assert exact row sets; a production
   * node that disarms it never seats a joiner's member row or binds its machines.
   */
  enabled?: boolean;
  /**
   * Idle cadence, ms — how often the loop re-checks while nobody has admitted this party
   * yet — and the CAP of the unfinished-join retry ladder. When omitted the instance
   * manager mirrors the revocation enforcer's configured cadence; default
   * {@link DEFAULT_REVOCATION_POLL_INTERVAL_MS}.
   */
  pollIntervalMs?: number;
}

/**
 * The per-strand membership reconciliation loop. Lifecycle mirrors
 * `StrandRevocationEnforcer`: created in `StrandInstanceManager.buildStrandRuntime`
 * (closed strands with a party key only), started right after the strand database
 * initializes, stopped and dropped in `releaseRuntime` — so quiesce → resume rebuilds
 * it and re-runs the (idempotent) ladder from scratch.
 */
export class StrandMembershipReconciler {
  private readonly scheduler: TimeoutScheduler;
  private readonly pollIntervalMs: number;
  /** Tail of the pass chain — serializes passes (no two in flight). */
  private tail: Promise<void> = Promise.resolve();
  private timer: unknown;
  private started = false;
  private stoppedFlag = false;
  /**
   * Whether the last stop was one {@link rearm} may not undo — see "Stops, and re-arming"
   * in the module doc. Latched by the public {@link stop} and the permanent terminal
   * states, never cleared.
   */
  private permanentlyStopped = false;
  private doneFlag = false;
  /** Lazily decoded party keypair — see {@link StrandMembershipReconcilerDeps.partyMemberPrivateKey}. */
  private keyPair: Ed25519KeyPair | undefined;
  private idlePasses = 0;
  private idleEscalated = false;
  /** Consecutive attempted passes that left the invitation staged — see {@link UNFINISHED_PASSES_BEFORE_ESCALATION}. */
  private unfinishedPasses = 0;
  /** Whether the blocked re-join was already reported this re-arm cycle (one report, either trigger). */
  private rejoinBlockedReported = false;
  /**
   * Whether the pass that just ran found nothing to act on — no member row and no staged
   * invitation. That is a wait to be admitted, not an unfinished join, so it re-arms on the
   * flat poll interval; every other unfinished outcome climbs the ladder.
   *
   * NOTE: the ladder is therefore the DEFAULT for any outcome nobody classified — a new
   * early return added to {@link doPass} inherits the fast retry unless it calls
   * {@link noteIdlePass}. Right for every outcome that exists today (each is an unfinished
   * join this machine can make progress on). If an early return is ever added for a
   * condition retrying cannot resolve, classify it idle.
   */
  private lastPassIdle = false;
  /** Current rung of the unfinished-join retry ladder, ms; unset before the first retry. */
  private retryDelayMs: number | undefined;

  constructor(
    private readonly deps: StrandMembershipReconcilerDeps,
    config?: StrandMembershipReconciliationConfig
  ) {
    this.scheduler = deps.scheduler ?? defaultTimeoutScheduler;
    this.pollIntervalMs = config?.pollIntervalMs ?? DEFAULT_REVOCATION_POLL_INTERVAL_MS;
  }

  /**
   * True once member row + own binding were both confirmed with nothing staged and the
   * loop stopped. Cleared again by {@link rearm}.
   */
  get done(): boolean {
    return this.doneFlag;
  }

  /** True while the loop is stopped — done, terminal, or externally stopped. */
  get stopped(): boolean {
    return this.stoppedFlag;
  }

  /**
   * Kick an immediate pass (not awaited — bring-up never blocks on it). Every later pass
   * is armed only once the previous one settles — see the retry ladder in the module doc —
   * so there is no repeating interval to arm here.
   */
  start(): void {
    if (this.started || this.stoppedFlag) return;
    this.started = true;
    void this.reconcile();
    log('[%s] membership reconciler started (retry from %dms, idle poll %dms)',
      this.deps.label, Math.min(INITIAL_JOIN_RETRY_INTERVAL_MS, this.pollIntervalMs), this.pollIntervalMs);
  }

  /**
   * Resolve once no pass is in flight. {@link stop} only disarms the retry TIMER — a pass
   * already past its stopped check runs to completion, so a caller that must know the
   * loop can no longer write (`StrandInstanceManager.clearOwnMemberPeerBinding`, which
   * would otherwise have its removal undone by a racing `registerMemberPeer`) awaits
   * this after stopping. Never rejects: the pass chain contains every failure.
   */
  async settle(): Promise<void> {
    await this.tail;
  }

  /**
   * Disarm the retry timer, for good: a later {@link rearm} is refused. A pass already in
   * flight completes but writes idempotently — {@link settle} is what waits it out.
   */
  stop(): void {
    this.halt('stopped by the runtime', true);
  }

  /**
   * A fresh invitation was staged: reopen a loop that stopped on a re-armable state (done,
   * or self-revoked with nothing staged) and run one pass at once; merely kick a loop that
   * is still running; do nothing after a permanent stop. Never rejects, and serialized
   * like {@link reconcile}: the reopen happens when the queued pass STARTS, after any pass
   * in flight has settled, so a `done` that pass latches cannot swallow the re-arm — and a
   * public {@link stop} that lands first still wins, because the queued pass re-checks it.
   */
  rearm(): Promise<void> {
    return this.enqueue(() => this.reopen() ? this.doPass() : Promise.resolve());
  }

  /**
   * Run one pass now. Never rejects. Serialized: concurrent calls chain, so no two
   * passes overlap and each explicit call gets a pass that STARTS after the call. On a
   * started loop the pass re-arms the retry timer where it settles, so an explicit call —
   * `StrandInstanceManager.publishDatabase`'s kick when a joiner's database is finally
   * published — REPLACES the pending timer rather than running alongside it.
   */
  reconcile(): Promise<void> {
    return this.enqueue(() => this.doPass());
  }

  /** Chain `pass` after every pass already queued; the tail never rejects. */
  private enqueue(pass: () => Promise<void>): Promise<void> {
    // The catch is what keeps the chain alive. `doPass` contains its own failures, but its
    // `finally` calls into the injected scheduler, and a throw from there would leave `tail`
    // REJECTED — after which every later `reconcile()` short-circuits on it and the join
    // stalls for good, silently. Swallowing it here makes the "never rejects" contract
    // {@link reconcile}, {@link rearm}, {@link settle} and the `void`-ed call sites all rely
    // on structural rather than incidental.
    const run = this.tail.then(pass).catch((error) => {
      log('[%s] reconcile pass threw outside its own handler — the chain continues: %o',
        this.deps.label, error);
    });
    this.tail = run;
    return run;
  }

  /**
   * The re-arm itself, run at the head of the queued pass: `false` refuses the pass (a
   * permanent stop), a running loop is left as it is, and a re-armable stop is reopened
   * with the idle and unfinished counters, both escalation latches and the retry ladder
   * reset — a fresh invitation is a fresh cycle.
   */
  private reopen(): boolean {
    if (this.permanentlyStopped) {
      log('[%s] re-arm refused — the loop is stopped for good', this.deps.label);
      return false;
    }
    if (!this.stoppedFlag) {
      log('[%s] fresh invitation staged on a running loop — kicking a pass', this.deps.label);
      return true;
    }
    this.stoppedFlag = false;
    this.doneFlag = false;
    this.idlePasses = 0;
    this.idleEscalated = false;
    this.unfinishedPasses = 0;
    this.rejoinBlockedReported = false;
    this.retryDelayMs = undefined;
    log('[%s] membership reconciler re-armed by a fresh invitation', this.deps.label);
    return true;
  }

  /** One serialized pass; contains every failure (contract: never rejects). */
  private async doPass(): Promise<void> {
    if (this.stoppedFlag || this.doneFlag) return;
    this.lastPassIdle = false;
    try {
      if (this.deps.isSelfRevoked?.() === true && !this.stagedInviteBlockedBySelfRevocation()) {
        this.finish('this party is revoked from the strand — re-admission arrives (if ever) via a fresh formation', false);
        return;
      }
      const keyPair = this.resolveKeyPair();
      if (!keyPair) return; // undecodable key already stopped the loop
      const db = this.deps.getDatabase();
      if (!db) return; // no live database this instant (quiesce race) — next tick decides
      await this.attempt(db, keyPair);
    } catch (error) {
      log('[%s] reconcile pass failed — retrying next tick: %o', this.deps.label, error);
    } finally {
      this.scheduleNext();
    }
  }

  /**
   * Steps 2 and 3 against a live database, with the outcome counted toward the probable
   * blocked re-join report whether the attempt returned or threw.
   */
  private async attempt(db: Database, keyPair: Ed25519KeyPair): Promise<void> {
    try {
      if (!(await this.ensureMembership(db, keyPair))) return;
      // NOTE: the redemption (`Member` + `ConsumedInvite`) and the binding below are two
      // SEPARATE commits — measured at 27 and 18 `/cluster` streams on 2026-09-17.
      // One write batch could carry both (`MemberPeer.MemberExists`
      // reads the LIVE `Member` table, and `MemberPeer.Authorized`'s add branch only verifies a
      // self-signature over the new row), worth perhaps a third of that plus one commit
      // round-trip. Left as two deliberately: the saving is unmeasured, and merging them merges
      // their failure modes — today a redemption that lands but reports torn simply heals on the
      // next pass, which sees the member row and proceeds to the binding. If a joiner's write
      // cost ever shows up in a measurement, try the single transaction and measure against the
      // 27 + 18 baseline.
      await this.ensureBinding(db, keyPair);
    } finally {
      this.noteAttemptOutcome();
    }
  }

  /**
   * Arm the next pass, now that this one has settled — so a slow pass never stacks ticks
   * behind it. Only a STARTED loop schedules: a caller driving {@link reconcile} by hand
   * (the unit tests, and the publish kick on a launch whose `start()` has not run yet) gets
   * exactly the passes it asks for and no background timer.
   */
  private scheduleNext(): void {
    if (!this.started || this.stoppedFlag || this.doneFlag) return;
    this.clearTimer();
    const delayMs = this.nextDelayMs();
    this.timer = this.scheduler.setTimeout(() => {
      this.timer = undefined;
      void this.reconcile();
    }, delayMs);
  }

  /**
   * The delay before the next pass: the flat poll interval while the loop is merely idling
   * (no member row, no staged invitation — {@link noteIdlePass}), otherwise the next rung
   * of the doubling ladder from {@link INITIAL_JOIN_RETRY_INTERVAL_MS}, capped at the poll
   * interval. A pass that lands idle resets the ladder, so a later unfinished join starts
   * over at the bottom rung.
   */
  private nextDelayMs(): number {
    if (this.lastPassIdle) {
      this.retryDelayMs = undefined;
      return this.pollIntervalMs;
    }
    this.retryDelayMs = Math.min(
      this.retryDelayMs === undefined ? INITIAL_JOIN_RETRY_INTERVAL_MS : this.retryDelayMs * 2,
      this.pollIntervalMs
    );
    return this.retryDelayMs;
  }

  private clearTimer(): void {
    if (this.timer !== undefined) {
      this.scheduler.clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  /**
   * Step 2 of the pass: `true` iff the party's member row is visible locally by the
   * time this returns (already present, or seated by redeeming the staged invitation).
   */
  private async ensureMembership(db: Database, keyPair: Ed25519KeyPair): Promise<boolean> {
    if (await isStrandMember(db, keyPair.publicKeyB64)) {
      await this.burnLeftoverInvite(db, keyPair);
      return true;
    }
    const invite = this.deps.pendingInvite?.get();
    if (!invite) {
      this.noteIdlePass();
      return false;
    }
    try {
      await consumeInvite(db, {
        inviteKey: invite.inviteKey,
        invitePrivateKey: invite.invitePrivateKey,
        memberKey: keyPair.publicKeyB64,
      }, OWN_TRANSACTION);
    } catch (error) {
      this.handleConsumeFailure(error, invite);
      return false;
    }
    this.deps.pendingInvite?.clear(invite);
    log('[%s] redeemed the staged membership invitation — Member row seated under this party\'s key', this.deps.label);
    return true;
  }

  /**
   * The already-member arm: spend a still-staged invitation so nobody else can. The stage
   * is cleared once the burn lands or the invitation is known dead (already spent,
   * cancelled, expired, or the strand sealed around a party that is still a member) — with
   * the member row present a dead credential has no further local use, and keeping it
   * staged would leave `getPendingMembershipInvite` lying. A refused burn keeps it staged:
   * a busy refusal tried nothing, and a write the cohort refused is the removed-party shape
   * ("Stops, and re-arming" in the module doc), where the local member row is stale and the
   * credential is the one thing a later manager admission lets this loop settle.
   *
   * NOTE: this REPLACES an earlier accepted tradeoff that never retried a burn which failed
   * for a transient reason and dropped the invitation instead. That decision was made when
   * this arm could only ever see an invitation staged before the first join finished, so a
   * dropped credential cost nothing but a spendable bearer token. {@link rearm} makes the
   * arm reachable with a freshly issued invitation the app wants redeemed, and dropping
   * that one on the first refused write is the silent failure this loop exists to avoid.
   */
  private async burnLeftoverInvite(db: Database, keyPair: Ed25519KeyPair): Promise<void> {
    const invite = this.deps.pendingInvite?.get();
    if (!invite) return;
    try {
      await burnInvite(db, {
        inviteKey: invite.inviteKey,
        invitePrivateKey: invite.invitePrivateKey,
        memberKey: keyPair.publicKeyB64,
      }, OWN_TRANSACTION);
    } catch (error) {
      this.handleBurnFailure(error, invite);
      return;
    }
    this.deps.pendingInvite?.clear(invite);
    log('[%s] burned the leftover invitation (member row already present)', this.deps.label);
  }

  /**
   * Act on a `burnInvite` rejection as {@link classifyConsumeFailure} routes it. Unlike a
   * redemption, a sealed strand is not terminal here — the member row is present, so this
   * party is a member of the sealed strand and only its leftover credential is dead — and a
   * half-committed burn (one collection, so a report of it means the commit's durability
   * was in doubt) is retried: the next pass either lands it or fails on the row's primary
   * key, which drops it as dead.
   */
  private handleBurnFailure(error: unknown, invite: StrandMembershipInvite): void {
    const failure = classifyConsumeFailure(error);
    switch (failure.kind) {
      case 'busy':
        log('[%s] burning the leftover invitation deferred — the app has a transaction open; it stays staged '
          + 'for the next pass', this.deps.label);
        return;
      case 'sealed':
      case 'dead-invite':
        log('[%s] the leftover invitation is dead (already spent, cancelled, expired, or the strand sealed) — '
          + 'dropping it: %s', this.deps.label, errorMessage(error));
        this.deps.pendingInvite?.clear(invite);
        return;
      case 'half-committed':
      case 'retry':
        log('[%s] burning the leftover invitation was refused — it stays staged and is retried next tick '
          + '(the cohort refusing this machine, or a transient write failure): %s', this.deps.label, errorMessage(error));
        return;
    }
  }

  /**
   * Step 3 of the pass: write this machine's own `MemberPeer` binding (insert-if-absent)
   * and, once it is in place with nothing staged, latch the done state and stop the loop.
   * A missing transport peer id (a quiesce racing the pass) defers to the next tick; a
   * write failure — a busy refusal included — is contained by the pass's outer catch and
   * retried. A binding written while an invitation is still staged (its burn keeps being
   * refused) is not done: the loop stays live so a later pass can settle the credential.
   */
  private async ensureBinding(db: Database, keyPair: Ed25519KeyPair): Promise<void> {
    const peerId = this.deps.getOwnPeerId();
    if (!peerId) {
      log('[%s] no live transport peer id this pass — binding deferred', this.deps.label);
      return;
    }
    await registerMemberPeer(db, { memberKeyPair: keyPair, peerId }, OWN_TRANSACTION);
    if (this.deps.pendingInvite?.get()) {
      log('[%s] own MemberPeer binding is in place but an invitation is still staged — not done yet', this.deps.label);
      return;
    }
    this.doneFlag = true;
    this.finish('member row and own MemberPeer binding are both in place', false);
  }

  /**
   * Act on a `consumeInvite` rejection as {@link classifyConsumeFailure} routes it: busy → keep
   * the invitation and retry; half-committed → warn and drop; sealed → terminal; dead
   * invitation → drop; anything else → retry.
   */
  private handleConsumeFailure(error: unknown, invite: StrandMembershipInvite): void {
    const failure = classifyConsumeFailure(error);
    switch (failure.kind) {
      case 'busy':
        log('[%s] redeeming the staged invitation deferred — the app has a transaction open on the strand '
          + 'database; retrying next tick', this.deps.label);
        return;
      case 'half-committed':
        this.reportHalfCommittedJoin(failure, error, invite);
        return;
      case 'sealed':
        // The staged credential is dead with the seal; drop it so the cache stays honest.
        this.deps.pendingInvite?.clear(invite);
        this.finish('the strand is sealed — nobody can ever be admitted, so the staged invitation is dead', true);
        return;
      case 'dead-invite':
        // NOTE: accepted tradeoff — dropping a dead invitation does not mark the pass idle,
        // so the next attempt is one ladder rung away rather than a full poll interval. Kept:
        // the pass AFTER it finds no member row and no invitation, marks itself idle, and
        // re-arms flat, so the cost is one extra read per dead credential. Revisit if a
        // source of dead invitations ever repeats per pass.
        log('[%s] the staged invitation is dead (expired, cancelled, or consumed elsewhere) — dropping it; '
          + 'a fresh formation stages a new one: %s', this.deps.label, errorMessage(error));
        this.deps.pendingInvite?.clear(invite);
        return;
      case 'retry':
        log('[%s] consumeInvite failed — retrying next tick (Invite row not yet replicated here, the cohort '
          + 'refusing this machine, or a transient write failure): %s', this.deps.label, errorMessage(error));
        return;
    }
  }

  /**
   * Count an attempted pass that left the invitation staged (whatever stopped it — a
   * refused or busy write, or a read that threw on a cut-off machine); one that settled
   * it, or finished, ends the streak. At {@link UNFINISHED_PASSES_BEFORE_ESCALATION}
   * report the PROBABLE blocked re-join.
   */
  private noteAttemptOutcome(): void {
    if (this.doneFlag || !this.deps.pendingInvite?.get()) {
      this.unfinishedPasses = 0;
      return;
    }
    this.unfinishedPasses += 1;
    if (this.unfinishedPasses >= UNFINISHED_PASSES_BEFORE_ESCALATION) {
      this.reportRejoinBlocked(
        `${this.unfinishedPasses} membership reconcile passes have left the staged membership invitation `
        + 'unsettled. Either this party was removed from the strand and the remaining members are refusing its '
        + 'machines, or the invitation\'s Strand.Invite row has not replicated here yet.'
      );
    }
  }

  /**
   * Step 1's CONFIRMED trigger: self-revoked with an invitation staged. Reports (once per
   * re-arm cycle) and answers `true` so the pass carries on — the redemption is attempted
   * and refused like any other write, and a manager's re-admission lets a later pass finish.
   * `false` (nothing staged) means step 1 stops the loop as before.
   */
  private stagedInviteBlockedBySelfRevocation(): boolean {
    if (!this.deps.pendingInvite?.get()) return false;
    this.reportRejoinBlocked(
      'this party is revoked from the strand and holds a staged membership invitation it cannot spend: the '
      + 'remaining members refuse this machine\'s strand writes, so the redemption cannot land.'
    );
    return true;
  }

  /**
   * ONE `console.warn` and one callback per re-arm cycle, whichever trigger fires first —
   * see "Reporting a blocked re-join" in the module doc. `cause` is the trigger's own
   * sentence; the remedy and the loop's posture are the same for both.
   */
  private reportRejoinBlocked(cause: string): void {
    if (this.rejoinBlockedReported) return;
    this.rejoinBlockedReported = true;
    console.warn(
      `[sereus] strand ${this.deps.label}: ${cause} A fresh invitation cannot re-admit a removed party by itself — `
      + 'a remaining manager must admit this party\'s member key directly (addMemberByManager). The membership '
      + 'loop keeps retrying quietly and completes the join once a Member row for this party appears.'
    );
    this.deps.onRejoinBlocked?.();
  }

  /**
   * A redemption only part of which was saved (see "Half-committed join" in the module doc):
   * ONE visible warning naming both halves, and the staged invitation dropped. The pass is not
   * marked idle, so the next one runs a ladder rung later and either finds a `Member` row (a
   * saved one, or a manager's admission) and writes the binding, or idles flat.
   *
   * NOTE: the invitation is dropped whichever half was saved. In the observed shape
   * (`ConsumedInvite` saved, `Member` not) it is spent and a retry could only fail on
   * `ConsumedInvite`'s primary key. In the opposite shape (`Member` saved, `ConsumedInvite` not)
   * keeping it would let the already-member arm burn it; dropping it leaves that bearer
   * credential spendable until it expires — the state the burn arm's accepted tradeoff already
   * lands in. Not branched on, because telling the shapes apart means parsing the lists, which
   * are collection ids on the coordinator path but free-form tree labels on the plugin's legacy
   * path. Revisit if a `Member`-saved half-commit is ever observed, or when
   * `blocked/strand-half-committed-join-recovery` is decided.
   */
  private reportHalfCommittedJoin(failure: HalfCommittedJoin, error: unknown, invite: StrandMembershipInvite): void {
    console.warn(
      `[sereus] strand ${this.deps.label}: redeeming the staged membership invitation was only partly saved. `
      + `Saved: [${failure.saved.join(', ')}]. Not saved: [${failure.unsaved.join(', ')}]. `
      + 'The invitation is dropped: a saved ConsumedInvite row spends it, so it cannot be redeemed again. '
      + 'If this party\'s Member row is not among the saved, the party is not a member of the strand and '
      + 'cannot become one from this invitation — a manager must admit it directly (addMemberByManager). '
      + 'The membership loop keeps checking and completes the join once a Member row for this party appears.'
    );
    log('[%s] half-committed redemption, full error: %o', this.deps.label, error);
    this.deps.pendingInvite?.clear(invite);
    // The idle passes that follow are the wait this warning already explained; the escalation's
    // "waiting on the founder rows to replicate" would be a second, misleading warning.
    this.idleEscalated = true;
  }

  /** Decode the party key once; an undecodable key is terminal (nothing can be signed). */
  private resolveKeyPair(): Ed25519KeyPair | undefined {
    if (this.keyPair) return this.keyPair;
    try {
      this.keyPair = strandMemberKeyPair(this.deps.partyMemberPrivateKey);
    } catch (error) {
      this.finish(`the party membership key does not decode — nothing can be signed (${errorMessage(error)})`, true);
      return undefined;
    }
    return this.keyPair;
  }

  /**
   * Count a no-member/no-invitation pass; escalate to ONE visible warning at the bound.
   *
   * NOTE: an idling loop never gives up — a machine whose party is never admitted keeps
   * polling for the life of the process, one `Strand.Member` scan per strand per
   * interval (30 s by default). Negligible at the handful of strands a device runs and
   * the handful of members a strand has; if a node ever runs strands by the hundred, or
   * a strand's member set grows large, bound the idle phase (give up after N passes and
   * surface it) rather than shortening the interval.
   */
  private noteIdlePass(): void {
    this.lastPassIdle = true;
    this.idlePasses += 1;
    if (this.idlePasses >= IDLE_PASSES_BEFORE_ESCALATION && !this.idleEscalated) {
      this.idleEscalated = true;
      console.warn(
        `[sereus] strand ${this.deps.label}: ${this.idlePasses} membership reconcile passes and still no `
        + 'Member row for this party and no staged invitation — a joiner is waiting on the founder rows to '
        + 'replicate (or on a manager admission). The loop keeps retrying quietly.'
      );
    }
  }

  /**
   * Stop with a reason — the terminal and done paths' shared exit. `permanent` says whether
   * a fresh invitation may reopen the loop ("Stops, and re-arming" in the module doc).
   */
  private finish(reason: string, permanent: boolean): void {
    this.halt(`membership reconciliation stopping: ${reason}`, permanent);
  }

  /** Latch the stop and disarm the timer; a permanent latch sticks even on an already-stopped loop. */
  private halt(reason: string, permanent: boolean): void {
    if (permanent) this.permanentlyStopped = true;
    if (this.stoppedFlag) return;
    this.stoppedFlag = true;
    this.clearTimer();
    log('[%s] membership reconciler stopped%s: %s%s', this.deps.label, this.doneFlag ? ' (done)' : '', reason,
      permanent ? '' : ' — a fresh invitation re-arms it');
  }
}
