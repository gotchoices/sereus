/**
 * Strand-formation deadlines, derived from the declared link round trip.
 *
 * The wire protocol lives in `strand-formation-protocol.ts`; this module is only the
 * arithmetic it runs on: the ladder of deadlines one declaration yields
 * ({@link formationDeadlines}) and the clamping of a caller's configured provisioning budget
 * under its session ({@link resolveProvisionTimeoutMs}, {@link splitProvisionBudget}). It
 * reaches `link-budget.ts` for the counts and `formation-approval.ts` for the hook's flat
 * timeout, and nothing in the protocol, so both roles and the manager can import it freely.
 */

import debug from 'debug';
import { DEFAULT_APPROVAL_TIMEOUT_MS } from './formation-approval.js';
import {
  CIRCUIT_REQUEST_ROUND_TRIPS,
  cohortReadDeadlineMs,
  commitBudgetMs,
  relayedStreamOpenBudgetMs,
  resolveLinkRoundTripMs
} from './link-budget.js';

const log = debug('sereus:cadre:formation-deadlines');

/**
 * Every deadline of one formation session, derived from one declared link round trip
 * ({@link formationDeadlines}). Each waits on work that crosses the link between the two
 * parties' machines, so each is a round-trip count times the declaration rather than a
 * number chosen on a fast network; the initiator's and the responder's fields are derived
 * together so the ordering between the roles holds by construction.
 */
export interface FormationDeadlines {
  /** Initiator: open a possibly relayed connection and negotiate the formation protocol. */
  dialMs: number;
  /** Responder: from the handler starting to the contact frame arriving. */
  awaitContactMs: number;
  /**
   * Responder: `validateToken` plus `validateDisclosure`, budgeted as two consulting control
   * reads. Counted in the travel margin and the clamp room, not wrapped in a deadline of their
   * own: the session bounds them.
   */
  validationMs: number;
  /** Responder: the provisioning hook's work budget, after which its signal aborts. */
  provisionWorkMs: number;
  /** Responder: the settle grace after the abort, which must contain one control commit. */
  provisionGraceMs: number;
  /**
   * What the initiator's await-response holds over the responder's provisioning: the
   * contact frame's trip out, the result frame's trip back, and the validation reads that
   * run before the responder's provisioning clock starts.
   */
  responseTravelMarginMs: number;
  /** Initiator: the result frame read. */
  initiatorAwaitResponseMs: number;
  /** Both roles: the whole session. */
  sessionMs: number;
}

/**
 * Derive every formation deadline from the declared link round trip
 * (`NetworkConfig.linkRoundTripMs`; the default when none is declared is
 * `DECLARED_LINK_ROUND_TRIP_MS` in `link-budget.ts`). With `L` the declaration, `R` one
 * cohort read at that link (`cohortReadDeadlineMs`, 2L: one request and its answer over an
 * open circuit) and `K` one commit (`commitBudgetMs`, 20L, measured):
 *
 *   dialMs                   = a relayed dial plus one protocol negotiation    (5L + 2 000)
 *   awaitContactMs           = one request over the open stream               (2L)
 *   validationMs             = 2R                                             (4L)
 *   provisionWorkMs          = approval hook (10 000, flat) + 2R + K           (10 000 + 24L)
 *   provisionGraceMs         = R + K                                          (22L)
 *   responseTravelMarginMs   = L + validationMs                               (5L)
 *   initiatorAwaitResponseMs = work + grace + margin                          (10 000 + 51L)
 *   sessionMs                = dialMs + initiatorAwaitResponseMs              (12 000 + 56L)
 *
 * Why each term:
 *
 * - **awaitContact**: the listener's handler starts when it answers the protocol
 *   negotiation; the answer reaches the joiner and the contact frame comes back, one round
 *   trip, budgeted as a request over an open stream (2) for the same headroom as every other
 *   one-exchange read in `link-budget.ts`.
 * - **validation** and the reads inside **provisionWork** are budgeted at two consulting
 *   reads each, not one per read the code issues. What actually runs: validation is three
 *   control reads (`isTokenValid` reads the invite; `isTokenUsed` reads it again and counts
 *   its usages) plus whatever the disclosure validator does; the bound provisioning path
 *   (`StrandFormationManager.provisionAsResponder`) reads the invite and the strand row to
 *   resolve the host strand, the invite again, the approver's `ValidationKey` and the seat
 *   count around the outside approval hook (an HTTP call, so its own
 *   `DEFAULT_APPROVAL_TIMEOUT_MS` is link-independent and added flat), the strand row and its
 *   `StrandPartyKey` to issue the joiner's membership invite, and the host strand's stamp
 *   before the `FormationUsage` write; then one strand-database commit issues the invite.
 *   Every one of those is a read of this party's own control database, which in steady state
 *   touches held blocks and consults nobody (`cadre-consistency.md` → "Deadlines Over
 *   Optimystic's Reads and Commits"), so `R` is charged as headroom for the ones that do
 *   consult, not per read. Waking a hibernating host strand inside the issue is NOT counted
 *   either: `wakeHostStrandForFormation` cuts it off by design with a retryable rejection
 *   and leaves the wake running, so the joiner's retry finds the strand live.
 *   NOTE: if formation is seen timing out while the responder's control reads are consulting
 *   the cohort (a cold responder, a control database not yet converged), charge one `R` per
 *   read here rather than raising the flat headroom; the joiner is told 'Formation
 *   provisioning timed out' with its invite unspent, so the cost is a retry, not a spent
 *   invite.
 * - **provisionGrace**: the window it exists for opens when the `FormationUsage` insert
 *   attempt passes its abort check. `ControlDatabase.redeemInvitation` and
 *   `recordFormationUsage` check the signal once per attempt inside the write lock, then run
 *   the seat read (`assertSeatRemains`) and the transaction, so the grace contains one read
 *   plus one commit. A retry after a failed attempt re-checks the abort, so only one attempt
 *   needs containing.
 * - **responseTravelMargin**: half a round trip out, half back, plus the validation reads,
 *   which run on the initiator's await-response clock but before the responder's
 *   provisioning clock starts.
 * - **session**: the initiator's dial plus its await-response. The responder's whole path
 *   (awaitContact + validation + work + grace = 10 000 + 52L) is inside it at every L.
 *
 * Ordering, strict at every L > 0, and pinned by `strand-formation-deadlines.spec.ts`:
 * approval hook < provisionWork < work + grace < initiatorAwaitResponse < session, and the
 * responder's whole path < session. Each layer can therefore fail and report before the
 * layer above it gives up, and the work budget always outlasts the hook's own timeout, so a
 * dead hook reports 'Formation approval unavailable, retry' rather than racing a
 * provisioning timeout.
 *
 * **What this costs.** At the default declaration (3 500 ms) a joiner whose responder
 * accepts the contact and then hangs waits up to 188.5 s, about three minutes, before it is
 * told, where the fixed ladder this replaced told it after 15 s; the whole session is
 * bounded at 208 s. A responder that is unreachable still fails at the dial, 19.5 s. A host
 * that knows its party is on a fast link lowers `linkRoundTripMs` and gets roughly the old
 * numbers back (at L = 100: dial 2.5 s, provisioning 14.6 s, await-response 15.1 s, session
 * 17.6 s). Before this derivation, the fixed 5 s dial could not open a relayed connection
 * above a 1.25-second round trip, and the fixed 2 s grace could not contain one commit at the
 * supported link, so a joiner could be told 'timed out' over an invite that was in fact
 * spent.
 */
export function formationDeadlines(linkRoundTripMs?: number): FormationDeadlines {
  const link = resolveLinkRoundTripMs(linkRoundTripMs);
  const readMs = cohortReadDeadlineMs(link);
  const commitMs = commitBudgetMs(link);
  const dialMs = relayedStreamOpenBudgetMs(link);
  const validationMs = 2 * readMs;
  const provisionWorkMs = DEFAULT_APPROVAL_TIMEOUT_MS + 2 * readMs + commitMs;
  const provisionGraceMs = readMs + commitMs;
  const responseTravelMarginMs = link + validationMs;
  const initiatorAwaitResponseMs = provisionWorkMs + provisionGraceMs + responseTravelMarginMs;
  return {
    dialMs,
    awaitContactMs: CIRCUIT_REQUEST_ROUND_TRIPS * link,
    validationMs,
    provisionWorkMs,
    provisionGraceMs,
    responseTravelMarginMs,
    initiatorAwaitResponseMs,
    sessionMs: dialMs + initiatorAwaitResponseMs
  };
}

/**
 * Ceiling for a resolved provisioning budget.
 *
 * The session budget also has to cover what PRECEDES provisioning in the role
 * (`precedingMs`: the initiator's dial; the responder's contact read plus its validation
 * reads), so that whole span is held back rather than triggering only on a literal overrun.
 *
 * `reserveMs` is the EXTRA room only the responder holds back, so its own budget still
 * lands strictly before the initiator's larger await-response budget even when both are
 * clamped — without it, a configured budget large enough to clamp both roles puts the
 * responder's reply on the wire at the moment the initiator's timeout fires. Capped at half
 * the remaining room (like {@link splitProvisionBudget}) so a small session config still
 * spends most of it working.
 */
function provisionCeilingMs(sessionTimeoutMs: number, precedingMs: number, reserveMs: number): number {
  const roomMs = sessionTimeoutMs - precedingMs;
  return Math.max(1, roomMs - Math.min(reserveMs, Math.floor(roomMs / 2)));
}

/**
 * The extra room the responder's clamp holds back ({@link provisionCeilingMs}'s `reserveMs`).
 *
 * The initiator's clamped await-response is `session - dial`, and the responder's reply
 * reaches it `responseTravelMarginMs` after provisioning ends, so provisioning must end by
 * `session - dial - margin`. The responder's own room is `session - awaitContact -
 * validation`; the difference between the two is what it must hold back on top. Computed
 * from the responder's own derivation, since it cannot see the initiator's dial budget: the
 * module doc of `link-budget.ts` says why both parties must declare the same link.
 */
export function responderClampReserveMs(deadlines: FormationDeadlines, awaitContactMs: number): number {
  return Math.max(0, deadlines.dialMs + deadlines.responseTravelMarginMs - awaitContactMs - deadlines.validationMs);
}

/**
 * Resolve a caller-supplied provisioning budget: `0`/negative means "unset" (use
 * `defaultMs`). If the result would let provisioning outlive the session — no result
 * frame is ever sent, exactly the failure this budget exists to prevent — clamp it to
 * {@link provisionCeilingMs} and log a warning. A budget that exactly meets the ceiling is
 * not clamped: the derived defaults sit there by construction.
 */
export function resolveProvisionTimeoutMs(
  configured: number | undefined,
  defaultMs: number,
  sessionTimeoutMs: number,
  precedingMs: number,
  role: string,
  reserveMs = 0
): number {
  const requested = configured && configured > 0 ? configured : defaultMs;
  const ceilingMs = provisionCeilingMs(sessionTimeoutMs, precedingMs, reserveMs);
  if (requested > ceilingMs) {
    log(
      '%s provisionTimeoutMs %dms leaves no room under sessionTimeoutMs %dms (preceding %dms, reserve %dms); clamping to %dms',
      role, requested, sessionTimeoutMs, precedingMs, reserveMs, ceilingMs
    );
    return ceilingMs;
  }
  return requested;
}

/**
 * Split a resolved provisioning budget into the WORK budget and the trailing settle grace.
 *
 * The grace is carved OUT of the budget, never added on top, so the ladder in
 * {@link formationDeadlines} is untouched: the listener aborts the provisioning hook when the
 * work budget expires, then waits up to the grace for the work to settle anyway
 * (`FormationListener.settleWithinGrace` in `strand-formation-protocol.ts`). `graceCeilingMs`
 * is the derived grace, which contains one seat read plus one commit at the declared link; it
 * is capped at half the budget so a small configured budget still spends at least half its
 * time doing work.
 */
export function splitProvisionBudget(provisionTimeoutMs: number, graceCeilingMs: number): { workMs: number; graceMs: number } {
  const graceMs = Math.min(graceCeilingMs, Math.floor(provisionTimeoutMs / 2));
  return { workMs: provisionTimeoutMs - graceMs, graceMs };
}
