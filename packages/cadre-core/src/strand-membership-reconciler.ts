/**
 * Strand membership reconciliation: the per-instance background loop that finishes a
 * party's join at strand bring-up and keeps the party's machine bindings whole. Every
 * machine of a party that runs a closed strand ends up with (1) the party's `Strand.Member`
 * row seated — redeeming the formation-staged invitation if one is pending — (2) its own
 * durable machine→party binding (`Strand.MemberPeer`) written, which is what revocation
 * enforcement and future admission control key on, and (3) every live sibling machine's
 * binding written under the party's current key, with a removed machine's binding cleared —
 * see "Binding the party's other machines" below.
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
 *   interval (default {@link DEFAULT_MEMBERSHIP_RECONCILE_INTERVAL_MS}). A pass
 *   that finds no member row AND no staged invitation is not an unfinished join but a wait
 *   for someone to admit this party — nothing this machine can do faster — so it re-arms on
 *   the flat poll interval and resets the ladder. The loop stops on the done state.
 * - **Done state**: the party's member row is visible locally, this machine's own binding
 *   is in place, every live sibling with a `StrandPeer` row is bound under the party's key
 *   (a pass that wrote a binding is not done; the next pass has to find nothing left), AND no
 *   invitation is still staged — the loop stops. A LATER revocation is the enforcer's
 *   business, not this loop's; a resume rebuilds the reconciler and re-verifies from scratch
 *   (every write is idempotent, so re-running is free), and a fresh invitation staged on a
 *   done loop, or a change to the party's machines, re-arms it in place ({@link rearm}).
 *
 * ## One pass
 *
 * 1. **Self-revocation check.** If the enforcer flags this node's own party as revoked and
 *    no invitation is staged, stop rather than fight — re-admission arrives (if ever) via
 *    a fresh formation, which re-arms the loop. With an invitation staged the loop reports
 *    the dead end (below) and carries on: the redemption is attempted like any other, and a
 *    manager's re-admission lets a later pass finish it.
 * 2. **Ensure membership.** Read first whether the party is moving to another key in this
 *    strand ({@link PartyStrandPeerSource.pendingKey}, one control read per pass); while it
 *    is, the step runs under that key instead — see "Redeeming under the pending key". Otherwise:
 *    member row visible → done with this step; if a staged invitation is still unspent, BURN it
 *    ({@link burnInvite} — the `ConsumedInvite` row alone) so the bearer credential cannot be
 *    spent by anyone else. A burn refused by the cohort keeps the invitation staged for the next
 *    pass (it is the same write gate a redemption faces, and the local member row may be stale —
 *    see "Re-arming"); a dead invitation is dropped. Member row absent + staged invitation →
 *    {@link consumeInvite} under the party's own key, retried across passes until the `Invite`
 *    row has replicated here and the write commits. Absent with no invitation (founder rows not
 *    yet synced, or a machine whose party never joined) → keep waiting, escalating to one
 *    visible warning after {@link IDLE_PASSES_BEFORE_ESCALATION} passes, never throwing.
 * 3. **Ensure the binding.** {@link registerMemberPeer} (insert-if-absent, restart-safe)
 *    with this node's own strand transport peer id — only after step 2 sees the member
 *    row locally (its deferred `MemberExists` reads the live local table). A binding
 *    written while a burn keeps being refused leaves the loop live to settle the
 *    invitation later.
 * 4. **Bind live siblings.** Every strand peer id the control database records for a live
 *    machine of this party ({@link PartyStrandPeerSource.read}) that has no binding under the
 *    party's key gets one, written here with the party key. See "Binding the party's other
 *    machines".
 * 5. **Clear removed machines.** A binding under the party's key for a machine removed from
 *    the cadre is cleared through the self branch of {@link removeMemberPeer} — unless the
 *    pending-key read at step 2 found a party key rotation pending for the strand, or failed.
 * 6. **Re-attempt this machine's own `StrandPeer` row** ({@link PartyStrandPeerSource.publishOwn}),
 *    the control-side statement step 4 on the siblings reads: a background write at bring-up
 *    that is deferred while alone or refused until this machine's own `CadrePeer` row arrives.
 *
 * ## Binding the party's other machines
 *
 * A `MemberPeer` binding is signed by the member key, which every machine of the party holds,
 * so any machine can bind any peer id under the party's key: the party vouching for its own
 * machine. Which peer ids are the party's machines comes from `CadreControl.StrandPeer`, each
 * machine's own signed statement of its peer id in the strand, joined to the party's live
 * machines and its `CadrePeer` tombstones (`strand-party-peers.ts`). The point is a party
 * member key that changes (a machine removal rotates it: `strand-party-key-rotation.ts`):
 * a sibling offline through the change returns to find itself bound under the new key by the
 * machines that were there, and a machine bound by a sibling that had not yet heard of its
 * removal is cleared once the tombstone arrives.
 *
 * Step 5 is gated on no rotation pending (the pending-key state step 2 read). While one is, the
 * removed machine's binding under the current key is exactly the orphan the rotation is about to
 * leave behind, and clearing it would hand the removed machine a clean slate the deny-list gate
 * admits. A failed pending read clears nothing for the same reason. After the swap the pending row is gone, and the step
 * clears a binding a lagging sibling wrote under the new key. The gate holds only because a
 * removal writes the machine's tombstone and the pending row in ONE transaction
 * (`ControlDatabase.removeMachine`): a tombstone that reaches this node without
 * its pending row reads as "no rotation", and this step clears the binding the rotation
 * meant to orphan, which leaves the removed machine admitted as a stranger rather than denied.
 *
 * The step reads the party's bindings once per pass (`listMemberPeers`) and compares in
 * JavaScript, the scan-not-seek idiom. Two machines binding one sibling at once collide on the
 * `MemberPeer` primary key; the loser's write is refused and its next pass finds the row. A
 * sibling's row that cannot be read keeps the loop live on the flat poll interval, and a write
 * that fails is retried on the ladder.
 *
 * ## Redeeming under the pending key
 *
 * A machine removal replaces the party's member key K in each closed strand with a fresh key K'
 * (`strand-party-key-rotation.ts`), and in a strand the party does not manage K cannot seat K'
 * itself: the strand's host has to re-invite the party, or its manager admit K' by hand
 * (docs/strands.md → Replacing the party's key). The host's fresh invitation is staged here like
 * any other and lands in step 2, which is why one rule governs that step: **while a
 * `PendingStrandPartyKey` row exists for the strand, this loop never writes a `Strand.Member`
 * row under K.** The removed machine holds K, and a seat written under K is a seat it keeps.
 * Three cases, decided by what {@link PartyStrandPeerSource.pendingKey} answers at the head of
 * the pass (a rejected read counts as pending with the key unreadable):
 *
 * - **No rotation pending**: the ordinary step 2 above.
 * - **Pending, the key not readable here** (the row is sealed to other machines: this machine
 *   was admitted after the removal, or runs on an ephemeral identity; or the read failed): the
 *   step neither consumes nor burns. A staged invitation stays staged, with one debug line, for
 *   a machine that can read the key to redeem; the pass is idle, and it does not count toward
 *   the probable blocked re-join report below — it left the invitation staged on purpose.
 * - **Pending, the key opened**: with K' already a member (admitted by hand, or seated by a
 *   sibling's redemption), a staged invitation is burned against K' and the rotation driver is
 *   kicked ({@link StrandMembershipReconcilerDeps.onPendingKeySeated}); with K' not yet a member
 *   and an invitation staged, it is redeemed under K' and the driver kicked; a refused
 *   redemption is classified as under K, except that a sealed strand is not terminal here (the
 *   party may still be a member under K) and only drops the dead invitation. With nothing staged
 *   the pass is idle: the driver has reported `needs-another-party`, and nothing happens until
 *   the host acts.
 *
 * Step 2 still answers whether K's member row is visible, which the binding steps that follow
 * are under: K is the party's current key until the control swap, and a binding written under K
 * after K has left (step 5 of the rotation, before the swap replicates here) is refused by
 * `MemberPeer.MemberExists` and polled, until the swap re-keys this loop. The loop does not
 * latch done while a rotation is pending, whatever else is in place, so a by-hand admission or a
 * sibling's redemption is noticed on the next pass and the driver kicked; a pass that wrote
 * nothing is idle, so the cadence is the flat poll interval. The pending state ends with the
 * swap: `StrandInstanceManager.rekeyParty` rebuilds this loop under K', whose next pass finds no
 * pending row, clears the removed machine's stale binding (step 5) and latches done as before.
 * Whoever redeems the host's invitation seats a key of its choosing, so the invitation must reach
 * the party's owner and not the removed machine, as with every invitation today.
 *
 * ## Stops, and re-arming
 *
 * Two kinds of stop. A RE-ARMABLE stop is one a fresh invitation, or a change to the
 * party's machines, should reopen:
 *
 * - **Done** (above).
 * - **Self-revoked with nothing staged** (step 1 above). A machine whose only binding is
 *   orphaned — its sibling rotated the key before this machine's `StrandPeer` row reached it —
 *   is denied by every other machine, so its own loop cannot write and stops here. The heal is
 *   a sibling binding it (step 4 there); its enforcer then drops its peer id from the deny set
 *   and reports `onSelfRestored`, which re-arms this loop.
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
 * finished during its first join, long before the removal. `CadreNode` also re-arms every
 * strand's loop when `CadreControl.StrandPeer`, `CadrePeer` or `Revocation` changes
 * (`StrandInstanceManager.notifyPartyPeersChanged`), so a sibling's row arriving binds it
 * within the watch's coalescing window rather than at the next resume.
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
 * A write refused because the strand's offline queue holds transactions
 * (`StrandOfflineQueueBusyError`, docs/strands.md → "Offline mode") is a busy refusal too: it
 * wrote nothing, and the ladder retries it until the queue drains. A membership commit queued
 * behind an app commit anyway (the race that refusal leaves open) can fail with Optimystic's
 * `OfflineCommitTimeoutError`, which is an unclassified failure here: a redemption keeps the
 * invitation and retries, and a binding is retried by the next pass. Each pass reads the state
 * before it writes (the member row, then the binding, which is insert-if-absent), so a write that
 * landed after all (`sent: true`) is found by that pass rather than written twice.
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
  StrandOfflineQueueBusyError,
  StrandTransactionBusyError,
  burnInvite,
  consumeInvite,
  isStrandMember,
  listMemberPeers,
  registerMemberPeer,
  removeMemberPeer,
  type StrandWriteOptions,
} from './strand-membership-writer.js';
import type { OpenedPendingPartyKey } from './strand-party-key-rotation.js';
import type { PartyStrandPeerSource, PartyStrandPeers, PendingPartyKeyState } from './strand-party-peers.js';
import { defaultTimeoutScheduler, type TimeoutScheduler } from './timeout-scheduler.js';
import { describeThrown } from './describe-thrown.js';

const log = debug('sereus:cadre:strand-membership-reconciler');

/**
 * Default poll interval, ms: the loop's idle cadence while nobody has admitted this party, and
 * the cap of its unfinished-join retry ladder. The loop stops once joined, so this matters only
 * while a machine is joining.
 */
export const DEFAULT_MEMBERSHIP_RECONCILE_INTERVAL_MS = 30_000;

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
 * as {@link IDLE_PASSES_BEFORE_ESCALATION}: about three minutes at the default cadence
 * (the ladder's five doubling rungs, then five passes at the 30 s cap). Counted by outcome
 * rather than by classified failure because a cut-off machine can fail before any write is
 * classified: its membership READ may already throw.
 */
export const UNFINISHED_PASSES_BEFORE_ESCALATION = 10;

/**
 * First retry delay, ms, for a pass that left the join UNFINISHED — a `consumeInvite`
 * whose `Strand.Invite` row has not replicated to this machine yet, a cohort briefly
 * unwritable, a database not yet published. Doubles per such pass up to the configured
 * poll interval. Sized for what it retries: invite-row replication resolves in about a
 * second over a direct connection and a few over a relay. The poll interval is NOT sized
 * for that — it is sized for the idle case (waiting to be admitted at all), which is why
 * this ladder exists instead of a shorter interval.
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
  /**
   * The app had a transaction open, or the strand's offline queue held transactions, so nothing
   * was tried — keep the invitation, retry.
   */
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
  const message = describeThrown(error);
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

/**
 * Whether a writer refused having written nothing, because another transaction was open or the
 * offline queue held transactions (see "Sharing the database with the app").
 */
function isTransactionBusy(error: unknown): boolean {
  return causeChain(error).some((link) =>
    link instanceof StrandTransactionBusyError || link instanceof StrandOfflineQueueBusyError);
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
   * The control-database seam for steps 2 and 4 to 6 of the pass (see "Binding the party's other
   * machines" and "Redeeming under the pending key" in the module doc): the party's pending key
   * in this strand as this machine can read it, the party's machines' strand peer ids, and this
   * machine's own `StrandPeer` row. Absent (tests, an embedder with no control database) means
   * no rotation is ever pending and the loop binds only this machine.
   */
  partyPeers?: PartyStrandPeerSource;
  /**
   * Called when a pass finds the party's PENDING key seated as a member of the strand (see
   * "Redeeming under the pending key"): it redeemed the staged invitation under that key, or found
   * it seated already. On every such pass until the control swap re-keys the loop. `CadreNode`
   * wires it to its party key rotation driver, which finishes the move on an owner machine.
   */
  onPendingKeySeated?: () => void;
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
   * yet — and the CAP of the unfinished-join retry ladder. Default
   * {@link DEFAULT_MEMBERSHIP_RECONCILE_INTERVAL_MS}.
   */
  pollIntervalMs?: number;
}

/**
 * The per-strand membership reconciliation loop. Created in
 * `StrandInstanceManager.buildStrandRuntime` (closed strands with a party key only),
 * started right after the strand database initializes, stopped and dropped in
 * `releaseRuntime` — so quiesce → resume rebuilds it and re-runs the (idempotent) ladder
 * from scratch.
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
   * Whether the pass in flight left the staged invitation alone ON PURPOSE (a rotation is pending
   * and this machine cannot read the key), which is not an attempt that failed and so does not
   * count toward the probable blocked re-join report. Reset at the head of every pass.
   */
  private inviteLeftStagedDeliberately = false;
  /** Whether this cycle has logged that the loop stays live for a pending rotation (one line per re-arm cycle). */
  private pendingRotationLogged = false;
  /**
   * Whether the pass that just ran is waiting on something no faster retry can shorten — no
   * member row and no staged invitation (a wait to be admitted, {@link noteIdlePass}), or the
   * party's machines unreadable ({@link waitForPoll}). Such a pass re-arms on the flat poll
   * interval; every other unfinished outcome climbs the ladder.
   *
   * NOTE: the ladder is therefore the DEFAULT for any outcome nobody classified — a new
   * early return added to {@link doPass} inherits the fast retry unless it calls
   * {@link noteIdlePass} or {@link waitForPoll}. Right for every outcome that exists today
   * (each is an unfinished join this machine can make progress on). If an early return is
   * ever added for a condition retrying cannot resolve, classify it so.
   */
  private lastPassIdle = false;
  /** Current rung of the unfinished-join retry ladder, ms; unset before the first retry. */
  private retryDelayMs: number | undefined;

  constructor(
    private readonly deps: StrandMembershipReconcilerDeps,
    config?: StrandMembershipReconciliationConfig
  ) {
    this.scheduler = deps.scheduler ?? defaultTimeoutScheduler;
    this.pollIntervalMs = config?.pollIntervalMs ?? DEFAULT_MEMBERSHIP_RECONCILE_INTERVAL_MS;
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
   * Something changed that a stopped loop should look at — `cause` names it for the log: a
   * fresh invitation was staged, the party's machines changed, or this machine is no longer
   * revoked. Reopen a loop that stopped on a re-armable state (done, or self-revoked with
   * nothing staged) and run one pass at once; merely kick a loop that is still running; do
   * nothing after a permanent stop. Never rejects, and serialized like {@link reconcile}: the
   * reopen happens when the queued pass STARTS, after any pass in flight has settled, so a
   * `done` that pass latches cannot swallow the re-arm — and a public {@link stop} that lands
   * first still wins, because the queued pass re-checks it.
   */
  rearm(cause = 'a fresh invitation'): Promise<void> {
    return this.enqueue(() => this.reopen(cause) ? this.doPass() : Promise.resolve());
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
  private reopen(cause: string): boolean {
    if (this.permanentlyStopped) {
      log('[%s] re-arm (%s) refused — the loop is stopped for good', this.deps.label, cause);
      return false;
    }
    if (!this.stoppedFlag) {
      // NOTE: a running loop keeps its counters and its once-per-cycle report latch, so a
      // party whose loop already reported and is then re-formed AGAIN gets no second report
      // for the replacement invitation. If that second report is ever wanted, key the latch
      // on the staged invitation's key rather than on the re-arm.
      log('[%s] %s on a running loop — kicking a pass', this.deps.label, cause);
      return true;
    }
    this.stoppedFlag = false;
    this.doneFlag = false;
    this.idlePasses = 0;
    this.idleEscalated = false;
    this.unfinishedPasses = 0;
    this.rejoinBlockedReported = false;
    this.pendingRotationLogged = false;
    this.retryDelayMs = undefined;
    log('[%s] membership reconciler re-armed by %s', this.deps.label, cause);
    return true;
  }

  /** One serialized pass; contains every failure (contract: never rejects). */
  private async doPass(): Promise<void> {
    if (this.stoppedFlag || this.doneFlag) return;
    this.lastPassIdle = false;
    try {
      if (this.deps.isSelfRevoked?.() === true && !this.stagedInviteBlockedBySelfRevocation()) {
        // NOTE: the enforcer's flag lags a re-admission by up to one of its polls. If the
        // pass that settled the last staged invitation then failed to write the binding, this
        // stop lands with the binding missing until the next resume rebuilds the loop. A
        // missing binding only mis-credits diversity today; if it ever gates admission, make
        // this stop also require the binding to be in place.
        this.finish('this party is revoked from the strand — re-admission arrives (if ever) via a fresh formation, '
          + 'or a sibling binds this machine under the party\'s current key', false);
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
   * Steps 2 to 6 against a live database, with the outcome counted toward the probable
   * blocked re-join report whether the attempt returned or threw.
   *
   * NOTE: steps 4 to 6 cost one `StrandPeer` read, one fresh membership read and one
   * `MemberPeer` scan per pass, per closed strand, and `CadreNode` re-arms every strand's loop
   * on each change to the party's machines, their records included. Fine at party scale; if a
   * party ever runs many strands on many machines, read `StrandPeer` once per control change
   * rather than per pass.
   */
  private async attempt(db: Database, keyPair: Ed25519KeyPair): Promise<void> {
    this.inviteLeftStagedDeliberately = false;
    try {
      const pending = await this.readPendingKeyState();
      if (!(await this.ensureMembership(db, keyPair, pending))) return;
      // NOTE: accepted tradeoff — the redemption (`Member` + `ConsumedInvite`) and the binding
      // below stay two SEPARATE commits on purpose. Merging them would save one commit: its
      // serial latency and, since Optimystic 1.19.0 pends and commits a transaction's collections
      // together, its `/cluster` requests (the two commits cost 6 on a two-member strand in
      // `message-cost-accounting` on 2026-10-25, 20 before). It would also let a torn commit
      // (Optimystic can report a multi-collection commit partly saved) or the cohort applying
      // the collections out of order show this machine's `MemberPeer` without its `Member`,
      // which the revocation enforcer reads as a removed member and hangs up on — fail closed,
      // undone only by a manager clearing the binding (module doc of
      // `strand-revocation-enforcer.ts`). And it would add a half-committed shape (`MemberPeer`
      // saved, the invitation still live) that {@link reportHalfCommittedJoin}'s dropping of the
      // invitation gets wrong. Revisit when Optimystic offers an all-or-nothing multi-collection
      // commit, or when the enforcer can tell a not-yet-seated binding from a removed member's.
      if (!(await this.ensureBinding(db, keyPair))) return;
      const siblingsSettled = await this.reconcileSiblings(db, keyPair, pending.pending);
      await this.publishOwnStrandPeer();
      this.latchDone(siblingsSettled, pending.pending);
    } finally {
      this.noteAttemptOutcome();
    }
  }

  /**
   * The party's pending key in this strand, read once per pass. No seam means no rotation is
   * ever pending; a rejected read is "pending, key unreadable", the posture under which nothing
   * is seated under the current key and no removed machine's binding is cleared (module doc).
   */
  private async readPendingKeyState(): Promise<PendingPartyKeyState> {
    const source = this.deps.partyPeers;
    if (!source) return { pending: false };
    try {
      return await source.pendingKey();
    } catch (error) {
      log('[%s] whether a party key rotation is pending could not be read — treated as pending with the key unreadable: %s',
        this.deps.label, describeThrown(error));
      return { pending: true, key: null };
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
   * The delay before the next pass: the flat poll interval while the loop is merely waiting
   * ({@link lastPassIdle}), otherwise the next rung
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
   * Step 2 of the pass: `true` iff the party's member row under its CURRENT key is visible
   * locally by the time this returns (already present, or seated by redeeming the staged
   * invitation). While a rotation is pending the staged invitation is spent under the pending
   * key instead, or left alone ("Redeeming under the pending key" in the module doc), and the
   * answer is only whether the current key is still a member.
   */
  private async ensureMembership(db: Database, keyPair: Ed25519KeyPair, pending: PendingPartyKeyState): Promise<boolean> {
    if (!pending.pending) {
      return this.ensureMembershipUnderOwnKey(db, keyPair);
    }
    const isMember = await isStrandMember(db, keyPair.publicKeyB64);
    if (pending.key === null) {
      this.leaveInviteStaged();
    } else {
      await this.seatPendingKey(db, pending.key);
    }
    return isMember;
  }

  /** Step 2 with no rotation pending: the member row under the party's own key, seated from the staged invitation if need be. */
  private async ensureMembershipUnderOwnKey(db: Database, keyPair: Ed25519KeyPair): Promise<boolean> {
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
      this.handleConsumeFailure(error, invite, 'own-key');
      return false;
    }
    this.deps.pendingInvite?.clear(invite);
    log('[%s] redeemed the staged membership invitation — Member row seated under this party\'s key', this.deps.label);
    return true;
  }

  /**
   * Step 2 while a rotation is pending whose key this machine cannot read: nothing is seated or
   * burned, since the only key this machine could sign with is the one being retired. A staged
   * invitation is left for a machine that can read the key, and the pass is idle.
   */
  private leaveInviteStaged(): void {
    this.waitForPoll();
    if (this.deps.pendingInvite?.get()) {
      this.inviteLeftStagedDeliberately = true;
      log('[%s] the staged invitation is left staged: the party is moving to a key this machine cannot read', this.deps.label);
    }
  }

  /**
   * Step 2 while a rotation is pending and this machine can read the pending key: see the
   * pending-and-opened case of "Redeeming under the pending key" in the module doc. A pending
   * key that does not decode throws to the pass's catch, which retries it.
   */
  private async seatPendingKey(db: Database, opened: OpenedPendingPartyKey): Promise<void> {
    const newKey = strandMemberKeyPair(opened.privateKey);
    const invite = this.deps.pendingInvite?.get();
    if (await isStrandMember(db, newKey.publicKeyB64)) {
      if (invite) {
        await this.burnLeftoverInvite(db, newKey);
      } else {
        this.waitForPoll();
      }
      this.kickRotationDriver('the pending key is a member');
      return;
    }
    if (!invite) {
      this.waitForPoll();
      return;
    }
    try {
      await consumeInvite(db, {
        inviteKey: invite.inviteKey,
        invitePrivateKey: invite.invitePrivateKey,
        memberKey: newKey.publicKeyB64,
      }, OWN_TRANSACTION);
    } catch (error) {
      this.handleConsumeFailure(error, invite, 'pending-key');
      return;
    }
    this.deps.pendingInvite?.clear(invite);
    log('[%s] redeemed the staged membership invitation under the party\'s PENDING key — the rotation can finish', this.deps.label);
    this.kickRotationDriver('the pending key was just seated');
  }

  /**
   * Tell the rotation driver the pending key is seated. Once per pass that sees the seat, so a
   * machine that cannot drive (no owner key here, or the swap deferred) hears it again on its
   * next pass rather than never.
   *
   * NOTE: a non-owner machine that reads the key kicks on every pass between the seat and the
   * swap, and `CadreNode.driveRotationIfPending` logs its refusal each time; bounded by the
   * seconds the swap takes on the owner machine. The owner machine alone does the same while
   * its swap is deferred (the only sibling offline): every pass kicks, the driver runs its
   * reads and ends "swap deferred", for as long as that sibling stays away. If either log
   * ever matters, kick once per seat (remember the pending stamp kicked for).
   */
  private kickRotationDriver(cause: string): void {
    try {
      this.deps.onPendingKeySeated?.();
      log('[%s] rotation driver kicked: %s', this.deps.label, cause);
    } catch (error) {
      log('[%s] the pending-key-seated callback threw: %s', this.deps.label, describeThrown(error));
    }
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
        log('[%s] burning the leftover invitation deferred — nothing was tried; it stays staged for the next '
          + 'pass: %s', this.deps.label, describeThrown(error));
        return;
      case 'sealed':
      case 'dead-invite':
        log('[%s] the leftover invitation is dead (already spent, cancelled, expired, or the strand sealed) — '
          + 'dropping it: %s', this.deps.label, describeThrown(error));
        this.deps.pendingInvite?.clear(invite);
        return;
      case 'half-committed':
      case 'retry':
        log('[%s] burning the leftover invitation was refused — it stays staged and is retried next tick '
          + '(the cohort refusing this machine, or a transient write failure): %s', this.deps.label, describeThrown(error));
        return;
    }
  }

  /**
   * Step 3 of the pass: write this machine's own `MemberPeer` binding (insert-if-absent);
   * `true` once it is in place. A missing transport peer id (a quiesce racing the pass)
   * defers to the next tick; a write failure — a busy refusal included — is contained by the
   * pass's outer catch and retried.
   */
  private async ensureBinding(db: Database, keyPair: Ed25519KeyPair): Promise<boolean> {
    const peerId = this.deps.getOwnPeerId();
    if (!peerId) {
      log('[%s] no live transport peer id this pass — binding deferred', this.deps.label);
      return false;
    }
    await registerMemberPeer(db, { memberKeyPair: keyPair, peerId }, OWN_TRANSACTION);
    return true;
  }

  /**
   * Steps 4 and 5 of the pass, against the party's machines as the control database records
   * them: `true` when nothing was left to write — every live sibling was already bound and no
   * removed machine's binding had to be cleared — so the pass may latch done. A pass that
   * wrote is not settled: the next one re-reads and confirms. Rows that cannot be read settle
   * nothing and move the next pass to the flat poll interval; nothing this machine can do
   * sooner. No seam means no siblings to bind: settled.
   */
  private async reconcileSiblings(db: Database, keyPair: Ed25519KeyPair, rotationPending: boolean): Promise<boolean> {
    const source = this.deps.partyPeers;
    if (!source) return true;
    let peers: PartyStrandPeers;
    try {
      peers = await source.read();
    } catch (error) {
      log('[%s] the party\'s strand peers could not be read — sibling bindings wait for the next poll: %s',
        this.deps.label, describeThrown(error));
      this.waitForPoll();
      return false;
    }
    const bound = new Set(await listMemberPeers(db, keyPair.publicKeyB64));
    const unbound = peers.live.map((peer) => peer.strandPeerId).filter((peerId) => !bound.has(peerId));
    const stale = peers.removed.filter((peerId) => bound.has(peerId));
    const siblingsBound = await this.bindSiblings(db, keyPair, unbound);
    const removedCleared = await this.clearRemovedMachines(db, keyPair, rotationPending, stale);
    return siblingsBound && removedCleared;
  }

  /**
   * Step 4: bind each of `unbound` under the party's key. Each write is contained on its own,
   * so one sibling's refusal (busy, or a collision with a sibling binding the same id) does
   * not keep the others waiting. `true` iff there was nothing to bind.
   */
  private async bindSiblings(db: Database, keyPair: Ed25519KeyPair, unbound: readonly string[]): Promise<boolean> {
    for (const peerId of unbound) {
      try {
        await registerMemberPeer(db, { memberKeyPair: keyPair, peerId }, OWN_TRANSACTION);
        log('[%s] bound sibling machine %s under the party\'s key', this.deps.label, peerId);
      } catch (error) {
        log('[%s] binding sibling machine %s failed — retried next tick: %s', this.deps.label, peerId, describeThrown(error));
      }
    }
    return unbound.length === 0;
  }

  /**
   * Step 5: clear the binding of each of `stale` (removed machines bound under the party's
   * key), through the self branch of {@link removeMemberPeer} — signed by the party key, which
   * is the row's own member key, so any peer id of the party's is reachable this way. Clears
   * nothing while a key rotation is pending for the strand, or while whether one is could not be
   * read, both of which `rotationPending` carries (see the module doc); that is settled, since
   * the loop stays live until the swap re-keys it. `true` iff nothing was left to clear.
   */
  private async clearRemovedMachines(
    db: Database,
    keyPair: Ed25519KeyPair,
    rotationPending: boolean,
    stale: readonly string[],
  ): Promise<boolean> {
    if (stale.length === 0) return true;
    if (rotationPending) {
      log('[%s] %d removed machine(s) stay bound: a party key rotation is pending, or whether one is could not be read',
        this.deps.label, stale.length);
      return true;
    }
    for (const peerId of stale) {
      try {
        await removeMemberPeer(db, { memberKeyPair: keyPair, peerId }, OWN_TRANSACTION);
        log('[%s] cleared the binding of removed machine %s', this.deps.label, peerId);
      } catch (error) {
        log('[%s] clearing the binding of removed machine %s failed — retried next tick: %s',
          this.deps.label, peerId, describeThrown(error));
      }
    }
    return false;
  }

  /** Step 6: re-attempt this machine's own `StrandPeer` row; the seam contains its failures and remembers success. */
  private async publishOwnStrandPeer(): Promise<void> {
    const peerId = this.deps.getOwnPeerId();
    if (!this.deps.partyPeers || !peerId) return;
    try {
      await this.deps.partyPeers.publishOwn(peerId);
    } catch (error) {
      log('[%s] publishing this machine\'s StrandPeer row threw — retried next pass: %s', this.deps.label, describeThrown(error));
    }
  }

  /**
   * The done decision, once the member row and the own binding are in place: not while a party
   * key rotation is pending (the loop stays live to notice the pending key seated, and is
   * rebuilt under that key by the swap; logged once per cycle), not while an invitation is still
   * staged (its burn keeps being refused; the loop stays live so a later pass can settle the
   * credential), and not while a sibling step wrote or could not read this pass. Otherwise latch
   * done and stop.
   */
  private latchDone(siblingsSettled: boolean, rotationPending: boolean): void {
    if (rotationPending) {
      // NOTE: a rotation the host never finishes (no re-invitation, no by-hand admission) keeps
      // this loop polling flat for good: one control read plus the strand reads of steps 2 to 5
      // per poll interval, per such strand. Fine at party scale; if a party ever carries many
      // strands with rotations pending indefinitely, re-arm on the strand's `Member` table
      // changing instead of polling for the seat.
      if (!this.pendingRotationLogged) {
        this.pendingRotationLogged = true;
        log('[%s] a party key rotation is pending — the loop stays live until the party\'s key is swapped', this.deps.label);
      }
      return;
    }
    if (this.deps.pendingInvite?.get()) {
      log('[%s] own MemberPeer binding is in place but an invitation is still staged — not done yet', this.deps.label);
      return;
    }
    if (!siblingsSettled) {
      log('[%s] sibling bindings changed or could not be read this pass — confirming next pass', this.deps.label);
      return;
    }
    this.doneFlag = true;
    this.finish('member row, own MemberPeer binding and every known sibling binding are in place', false);
  }

  /** Re-arm the next pass on the flat poll interval, for a wait no faster retry can shorten. */
  private waitForPoll(): void {
    this.lastPassIdle = true;
  }

  /**
   * Act on a `consumeInvite` rejection as {@link classifyConsumeFailure} routes it: busy → keep
   * the invitation and retry; half-committed → warn and drop; sealed → terminal under the party's
   * own key, but under the pending key only a dead invitation (the party may still be a member
   * under its current key, whose bindings this loop keeps whole, and the rotation stays pending
   * for the life of the row); dead invitation → drop; anything else → retry.
   */
  private handleConsumeFailure(error: unknown, invite: StrandMembershipInvite, under: 'own-key' | 'pending-key'): void {
    const failure = classifyConsumeFailure(error);
    switch (failure.kind) {
      case 'busy':
        log('[%s] redeeming the staged invitation deferred — nothing was tried; retrying next tick: %s',
          this.deps.label, describeThrown(error));
        return;
      case 'half-committed':
        this.reportHalfCommittedJoin(failure, error, invite);
        return;
      case 'sealed':
        // The staged credential is dead with the seal; drop it so the cache stays honest.
        this.deps.pendingInvite?.clear(invite);
        if (under === 'pending-key') {
          log('[%s] the strand is sealed, so the party\'s pending key can never be admitted there — the staged '
            + 'invitation is dead and dropped; the rotation stays pending', this.deps.label);
          this.waitForPoll();
          return;
        }
        this.finish('the strand is sealed — nobody can ever be admitted, so the staged invitation is dead', true);
        return;
      case 'dead-invite':
        // NOTE: accepted tradeoff — dropping a dead invitation does not mark the pass idle,
        // so the next attempt is one ladder rung away rather than a full poll interval. Kept:
        // the pass AFTER it finds no member row and no invitation, marks itself idle, and
        // re-arms flat, so the cost is one extra read per dead credential. Revisit if a
        // source of dead invitations ever repeats per pass.
        log('[%s] the staged invitation is dead (expired, cancelled, or consumed elsewhere) — dropping it; '
          + 'a fresh formation stages a new one: %s', this.deps.label, describeThrown(error));
        this.deps.pendingInvite?.clear(invite);
        return;
      case 'retry':
        log('[%s] consumeInvite failed — retrying next tick (Invite row not yet replicated here, the cohort '
          + 'refusing this machine, or a transient write failure): %s', this.deps.label, describeThrown(error));
        return;
    }
  }

  /**
   * Count an attempted pass that left the invitation staged (whatever stopped it — a
   * refused or busy write, or a read that threw on a cut-off machine); one that settled
   * it, or finished, ends the streak. A pass that left it staged on purpose (a rotation
   * pending whose key this machine cannot read) is no attempt: it neither counts nor ends
   * the streak. At {@link UNFINISHED_PASSES_BEFORE_ESCALATION} report the PROBABLE blocked
   * re-join.
   */
  private noteAttemptOutcome(): void {
    if (this.inviteLeftStagedDeliberately) return;
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
      this.finish(`the party membership key does not decode — nothing can be signed (${describeThrown(error)})`, true);
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
      permanent ? '' : ' — a fresh invitation or a change to the party\'s machines re-arms it');
  }
}
