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
 * - **Done state**: the party's member row is visible locally AND this machine's own
 *   binding is in place — the loop stops for good. A LATER revocation is the enforcer's
 *   business, not this loop's; a resume rebuilds the reconciler and re-verifies from
 *   scratch (every write is idempotent, so re-running is free).
 *
 * ## One pass
 *
 * 1. **Self-revocation check.** If the enforcer flags this node's own party as revoked,
 *    stop rather than fight — re-admission arrives (if ever) via a fresh formation.
 * 2. **Ensure membership.** Member row visible → done with this step; if a staged
 *    invitation is still unspent, BURN it ({@link burnInvite} — the `ConsumedInvite` row
 *    alone) so the bearer credential cannot be spent by anyone else, ignoring burn
 *    failures beyond a log. Member row absent + staged invitation → {@link consumeInvite}
 *    under the party's own key, retried across passes until the `Invite` row has
 *    replicated here and the write commits. Absent with no invitation (founder rows not
 *    yet synced, or a machine whose party never joined) → keep waiting, escalating to one
 *    visible warning after {@link IDLE_PASSES_BEFORE_ESCALATION} passes, never throwing.
 * 3. **Ensure the binding.** {@link registerMemberPeer} (insert-if-absent, restart-safe)
 *    with this node's own strand transport peer id — only after step 2 sees the member
 *    row locally (its deferred `MemberExists` reads the live local table).
 *
 * ## Terminal states (stop without done)
 *
 * - **Sealed strand**: `consumeInvite` rejected by `ConsumedInvite.NotSealed` — nobody
 *   can ever be admitted, so retrying forever is noise. Terminal-with-log.
 * - **Self-revoked** (step 1 above).
 * - **Undecodable party key**: nothing can be signed; loud log, stop.
 *
 * A DEAD invitation that is not terminal for the loop — expired, cancelled, or already
 * consumed by someone else (`ConsumedInvite`'s primary key) — is dropped with a log and
 * the loop keeps idling: a fresh formation stages a new invitation, and a manager-side
 * admission (`addMemberByManager`) seats the member row without one.
 */

import debug from 'debug';
import type { Database } from '@quereus/quereus';
import type { Ed25519KeyPair } from './ed25519-key.js';
import type { StrandMembershipInvite } from './types.js';
import { strandMemberKeyPair } from './strand-member-key.js';
import {
  burnInvite,
  consumeInvite,
  isStrandMember,
  registerMemberPeer,
} from './strand-membership-writer.js';
import { DEFAULT_REVOCATION_POLL_INTERVAL_MS } from './strand-revocation-enforcer.js';

const log = debug('sereus:cadre:strand-membership-reconciler');

/**
 * Idle passes (no member row, no staged invitation) before ONE `console.warn`
 * escalation — at the default 30 s cadence, about five minutes of waiting. The loop
 * keeps retrying quietly after it; the warning exists so a joiner stuck waiting on
 * founder-row replication is visible without the debug namespace enabled.
 */
export const IDLE_PASSES_BEFORE_ESCALATION = 10;

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

/**
 * `consumeInvite` rejections that mean the strand is SEALED — `ConsumedInvite.NotSealed`
 * fired. Terminal for a non-member: nobody can ever be admitted again.
 */
const SEALED_REJECTION = /NotSealed/;

/**
 * `consumeInvite` rejections that mean the INVITATION is dead but the loop should keep
 * waiting for membership to arrive another way: expired (`NotExpired`), cancelled
 * (`NotCancelled`), or already consumed by someone else (the `ConsumedInvite.InviteKey`
 * primary key — its UNIQUE-violation message names the table, which no other rejection
 * on this path does).
 */
const DEAD_INVITE_REJECTION = /NotExpired|NotCancelled|ConsumedInvite/i;

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
  /** Drop the staged invitation (spent, burned, or dead). */
  clear(): void;
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
   * When it does, the loop stops rather than fight the enforcer — see the module doc.
   * Absent (enforcement disarmed) means "not known revoked".
   */
  isSelfRevoked?: () => boolean;
  /** Timer seam; omit for real (unref'd) timeouts. See {@link MembershipRetryScheduler}. */
  scheduler?: MembershipRetryScheduler;
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
 * Timer seam for the retry ladder; omit for real (unref'd) timeouts. Timeouts rather than
 * the enforcer's repeating interval because the delay changes per pass and the next pass is
 * armed only once the previous one settles, so a slow pass never stacks ticks behind it.
 */
export interface MembershipRetryScheduler {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const defaultScheduler: MembershipRetryScheduler = {
  setTimeout: (fn, ms) => {
    const handle = setTimeout(fn, ms);
    (handle as { unref?: () => void }).unref?.();
    return handle;
  },
  clearTimeout: (handle) => clearTimeout(handle as Parameters<typeof clearTimeout>[0])
};

/**
 * The per-strand membership reconciliation loop. Lifecycle mirrors
 * `StrandRevocationEnforcer`: created in `StrandInstanceManager.buildStrandRuntime`
 * (closed strands with a party key only), started right after the strand database
 * initializes, stopped and dropped in `releaseRuntime` — so quiesce → resume rebuilds
 * it and re-runs the (idempotent) ladder from scratch.
 */
export class StrandMembershipReconciler {
  private readonly scheduler: MembershipRetryScheduler;
  private readonly pollIntervalMs: number;
  /** Tail of the pass chain — serializes passes (no two in flight). */
  private tail: Promise<void> = Promise.resolve();
  private timer: unknown;
  private started = false;
  private stoppedFlag = false;
  private doneFlag = false;
  /** Lazily decoded party keypair — see {@link StrandMembershipReconcilerDeps.partyMemberPrivateKey}. */
  private keyPair: Ed25519KeyPair | undefined;
  private idlePasses = 0;
  private idleEscalated = false;
  /**
   * Whether the pass that just ran found nothing to act on — no member row and no staged
   * invitation. That is a wait to be admitted, not an unfinished join, so it re-arms on the
   * flat poll interval; every other unfinished outcome climbs the ladder.
   */
  private lastPassIdle = false;
  /** Current rung of the unfinished-join retry ladder, ms; unset before the first retry. */
  private retryDelayMs: number | undefined;

  constructor(
    private readonly deps: StrandMembershipReconcilerDeps,
    config?: StrandMembershipReconciliationConfig
  ) {
    this.scheduler = deps.scheduler ?? defaultScheduler;
    this.pollIntervalMs = config?.pollIntervalMs ?? DEFAULT_REVOCATION_POLL_INTERVAL_MS;
  }

  /** True once member row + own binding were both confirmed and the loop stopped. */
  get done(): boolean {
    return this.doneFlag;
  }

  /** True once the loop has stopped — done, terminal, or externally stopped. */
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

  /** Disarm the retry timer; a pass already in flight completes but writes idempotently. */
  stop(): void {
    if (this.stoppedFlag) return;
    this.stoppedFlag = true;
    this.clearTimer();
    log('[%s] membership reconciler stopped%s', this.deps.label, this.doneFlag ? ' (done)' : '');
  }

  /**
   * Run one pass now. Never rejects. Serialized: concurrent calls chain, so no two
   * passes overlap and each explicit call gets a pass that STARTS after the call. On a
   * started loop the pass re-arms the retry timer where it settles, so an explicit call —
   * `StrandInstanceManager.publishDatabase`'s kick when a joiner's database is finally
   * published — REPLACES the pending timer rather than running alongside it.
   */
  reconcile(): Promise<void> {
    const run = this.tail.then(() => this.doPass());
    this.tail = run;
    return run;
  }

  /** One serialized pass; contains every failure (contract: never rejects). */
  private async doPass(): Promise<void> {
    if (this.stoppedFlag || this.doneFlag) return;
    this.lastPassIdle = false;
    try {
      if (this.deps.isSelfRevoked?.() === true) {
        // NOTE: "arrives via a fresh formation" is aspirational, not current behaviour.
        // A fresh formation stages a new invitation (`adoptFormationMembershipInvite`)
        // but does NOT re-arm this loop — `finish` latches `stoppedFlag` and `start()`
        // early-returns on it, so only a strand relaunch (quiesce → resume, or a process
        // restart) builds a reconciler that would redeem it. The same latch applies on the
        // `done` path below, which is the case a REMOVED party actually hits: it finished
        // its first join long before it was removed. Measured end to end in
        // `strand-party-removal-via-formation-e2e.integration.ts` (test 2), tracked as
        // `backlog/bug-removed-party-cannot-redeem-its-way-back`.
        this.finish('this party is revoked from the strand — re-admission arrives (if ever) via a fresh formation');
        return;
      }
      const keyPair = this.resolveKeyPair();
      if (!keyPair) return; // undecodable key already stopped the loop
      const db = this.deps.getDatabase();
      if (!db) return; // no live database this instant (quiesce race) — next tick decides
      if (!(await this.ensureMembership(db, keyPair))) return;
      // NOTE: the redemption (`Member` + `ConsumedInvite`) and the binding below are two
      // SEPARATE commits — measured at 27 and 18 `/cluster` streams on 2026-09-17.
      // `inStrandTransaction` would let both run in one transaction (`MemberPeer.MemberExists`
      // reads the LIVE `Member` table, and `MemberPeer.Authorized`'s add branch only verifies a
      // self-signature over the new row), worth perhaps a third of that plus one commit
      // round-trip. Left as two deliberately: the saving is unmeasured, and merging them merges
      // their failure modes — today a redemption that lands but reports torn simply heals on the
      // next pass, which sees the member row and proceeds to the binding. If a joiner's write
      // cost ever shows up in a measurement, try the single transaction and measure against the
      // 27 + 18 baseline.
      await this.ensureBinding(db, keyPair);
    } catch (error) {
      log('[%s] reconcile pass failed — retrying next tick: %o', this.deps.label, error);
    } finally {
      this.scheduleNext();
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
      });
    } catch (error) {
      this.classifyConsumeFailure(error);
      return false;
    }
    this.deps.pendingInvite?.clear();
    log('[%s] redeemed the staged membership invitation — Member row seated under this party\'s key', this.deps.label);
    return true;
  }

  /**
   * The already-member arm: spend a still-staged invitation so nobody else can. Burn
   * failures (already spent, cancelled, expired — or a racing seal) are logged and
   * otherwise ignored, and the stage is cleared either way: with the member row
   * present the invitation has no further local use, and keeping a possibly-dead
   * credential staged would leave `getPendingMembershipInvite` lying.
   *
   * NOTE: accepted tradeoff — a burn that failed for a TRANSIENT reason is never
   * retried, so that bearer credential stays spendable until it expires. Weighed and
   * kept because it lands in the same state the strand already documents as normal
   * ("removal does not cancel an unspent invitation", docs/strands.md) and retrying
   * would mean keeping a dead-or-alive credential staged indefinitely. Revisit if
   * unspent invitations ever become a real admission risk — which is when
   * `feat-strand-member-allowlist-admission` lands.
   */
  private async burnLeftoverInvite(db: Database, keyPair: Ed25519KeyPair): Promise<void> {
    const pending = this.deps.pendingInvite;
    const invite = pending?.get();
    if (!pending || !invite) return;
    try {
      await burnInvite(db, {
        inviteKey: invite.inviteKey,
        invitePrivateKey: invite.invitePrivateKey,
        memberKey: keyPair.publicKeyB64,
      });
      log('[%s] burned the leftover invitation (member row already present)', this.deps.label);
    } catch (error) {
      log('[%s] burning the leftover invitation failed (already spent, cancelled, or expired) — dropping it: %o',
        this.deps.label, error);
    }
    pending.clear();
  }

  /**
   * Step 3 of the pass: write this machine's own `MemberPeer` binding (insert-if-absent)
   * and, on success, latch the done state and stop the loop. A missing transport peer id
   * (a quiesce racing the pass) defers to the next tick; a write failure is contained by
   * the pass's outer catch and retried.
   */
  private async ensureBinding(db: Database, keyPair: Ed25519KeyPair): Promise<void> {
    const peerId = this.deps.getOwnPeerId();
    if (!peerId) {
      log('[%s] no live transport peer id this pass — binding deferred', this.deps.label);
      return;
    }
    await registerMemberPeer(db, { memberKeyPair: keyPair, peerId });
    this.doneFlag = true;
    this.finish('member row and own MemberPeer binding are both in place');
  }

  /** Route a `consumeInvite` rejection: sealed → terminal; dead invitation → drop; else retry. */
  private classifyConsumeFailure(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    if (SEALED_REJECTION.test(message)) {
      // The staged credential is dead with the seal; drop it so the cache stays honest.
      this.deps.pendingInvite?.clear();
      this.finish('the strand is sealed — nobody can ever be admitted, so the staged invitation is dead');
      return;
    }
    if (DEAD_INVITE_REJECTION.test(message)) {
      log('[%s] the staged invitation is dead (expired, cancelled, or consumed elsewhere) — dropping it; '
        + 'a fresh formation stages a new one: %s', this.deps.label, message);
      this.deps.pendingInvite?.clear();
      return;
    }
    log('[%s] consumeInvite failed — retrying next tick (Invite row not yet replicated here, or a transient '
      + 'write failure): %s', this.deps.label, message);
  }

  /** Decode the party key once; an undecodable key is terminal (nothing can be signed). */
  private resolveKeyPair(): Ed25519KeyPair | undefined {
    if (this.keyPair) return this.keyPair;
    try {
      this.keyPair = strandMemberKeyPair(this.deps.partyMemberPrivateKey);
    } catch (error) {
      this.finish(`the party membership key does not decode — nothing can be signed (${
        error instanceof Error ? error.message : String(error)})`);
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

  /** Stop with a reason — the terminal and done paths' shared exit. */
  private finish(reason: string): void {
    log('[%s] membership reconciliation stopping: %s', this.deps.label, reason);
    this.stop();
  }
}
