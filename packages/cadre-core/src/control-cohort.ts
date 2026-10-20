/**
 * Control-cohort dial selection: the pure policy behind
 * {@link CadreNode.reconcileControlCohort}. Decides WHICH known cadre siblings a
 * node proactively dials each pass to keep the `CadreControl` collections' cohort
 * connected (and thus replicating), without devolving into an N² mesh.
 *
 * FRET only needs a *connected* graph with the block clusters reachable, not a
 * full mesh. Always-on (`storage` profile) machines are the stable, dialable
 * backbone that hold the control blocks, so the policy is **backbone-preferential
 * with a bounded out-degree**:
 *
 * - **Always dial every backbone (always-on) member** — a party runs few of them,
 *   and they are the machines that stay reachable while phones sleep or roam.
 * - **Fill the remainder** up to `targetDegree` with the other members (phones,
 *   and machines that have not yet published a profile), ordered
 *   deterministically (peerId sort) so every node makes the same stable choice
 *   across passes and load spreads predictably.
 *
 * For a small party (members ≤ degree) this degenerates to a full mesh, which is
 * correct, cheap, and matches what the convergence tests do by hand; for a large
 * party it bounds out-degree to `backbone + targetDegree`.
 */

import type { CohortPeerRow } from './strand-cohort.js';

/**
 * Default backstop for {@link CadreNode.reconcileControlCohort} (ms): a pass runs this long
 * after the last one settled whether or not anything woke it. Passes normally run on a
 * change — a membership table changing, a sibling connecting or disconnecting, an address
 * change — and on the retries a pass arms for itself ({@link nextReconcileWakeMs}); the
 * backstop bounds how stale this node can be after a change it hears nothing of: one that
 * reaches it with no storage event, which happens to a machine outside the block's cohort
 * (a cadre larger than `CONTROL_REPLICATION_BREADTH`) and to one in the cohort that the
 * writer could not reach when it committed. The membership rows view's maximum age
 * (`MEMBERSHIP_VIEW_MAX_AGE_MS`, 15 s) is shorter than this, so the backstop pass reads
 * storage and starts the cohort consult that brings such a change in.
 *
 * `network.controlCohort.reconcileMs` overrides it. An interval between a pass settling and
 * the next start, not a deadline on a pass: passes are single-flight, and one unreachable
 * sibling's dial alone can take the whole per-peer dial budget (86 s at the default
 * declared link).
 *
 * NOTE: a machine whose storage takes no event for a change — one outside the block's cohort
 * in a cadre larger than `CONTROL_REPLICATION_BREADTH` (16 machines), or one the writer could
 * not reach when it committed — sees it only at this backstop, where the change-driven path
 * serves a machine the commit reached within the 50 ms coalescing window. If a party ever
 * needs a tighter bound, lower the backstop for its nodes or give the plugin's change bridge
 * a path for outside-the-cohort reads.
 */
export const DEFAULT_CONTROL_COHORT_RECONCILE_MS = 120_000;

/**
 * First redial delay after a pass's dial of a selected sibling, or a cold-start bootstrap peer,
 * fails (ms). Doubles per consecutive such pass and is capped at the backstop, so a
 * sibling that is offline costs one dial per backstop once the ladder saturates, and a
 * stranded cold-start node keeps trying forever (15 s, 30 s, 60 s, then every backstop).
 */
export const CONTROL_COHORT_REDIAL_MS = 15_000;

/**
 * Default cap on the number of **non-backbone** members a single reconcile pass
 * proactively dials. Backbone (always-on) members are always dialed and do NOT
 * count against this cap.
 */
export const DEFAULT_CONTROL_COHORT_TARGET_DEGREE = 6;

// The per-sibling and per-address dial time limits live in `peer-dial.ts`
// (`DEFAULT_CONTROL_COHORT_DIAL_TIMEOUT_MS`,
// `DEFAULT_CONTROL_COHORT_PER_ADDRESS_DIAL_TIMEOUT_MS`), beside the dial they
// bound, which `seed-bootstrap.ts` also uses and cannot import from here.

/** Outcome of {@link selectControlCohortDials}: who to dial + what the cap dropped. */
export interface ControlCohortSelection {
  /**
   * Siblings to dial this pass, backbone first then the bounded non-backbone
   * fill. Already self-excluded (the caller must pass self-excluded `siblings`).
   * Still includes peers that may turn out to be already-connected — the caller
   * diffs against live connections separately.
   */
  dials: CohortPeerRow[];
  /** Non-backbone members dropped by the `targetDegree` cap (0 when none). */
  cappedNonBackbone: number;
}

/** What one {@link CadreNode.reconcileControlCohort} pass did. */
export interface ControlCohortReconcileResult {
  /**
   * Peer ids this pass dialled and whose dial resolved, in dial order: selected
   * siblings on the steady-state pass, retained bootstrap peers on the cold-start
   * pass (the pass takes one branch or the other, never both). A peer already
   * connected when the pass began is never listed — the pass skips it. A resolved
   * dial can still be refused moments later by the remote's membership gate, so
   * an entry means "this pass opened a connection", not "that connection is still
   * open".
   */
  dialed: string[];
}

/** Stable peerId ordering so the bounded fill is identical across passes/nodes. */
function byPeerId(a: CohortPeerRow, b: CohortPeerRow): number {
  if (a.peerId < b.peerId) return -1;
  if (a.peerId > b.peerId) return 1;
  return 0;
}

/**
 * Backbone-preferential, bounded-out-degree selection of control-cohort siblings
 * to dial.
 *
 * A member is **backbone** iff its `CadrePeer` row declares the `storage` profile
 * (an always-on machine). All backbone members are selected; the rest fill up to
 * `targetDegree` in deterministic peerId order. A member whose profile is still
 * unknown (it has not self-published) is not backbone until it publishes one.
 * A profile is a dial preference only: it is self-declared, and a machine
 * misdeclaring one costs extra dials, never access.
 *
 * @param siblings - cadre members EXCLUDING self (the caller filters self out).
 * @param targetDegree - cap on non-backbone dials (negative is treated as 0).
 */
export function selectControlCohortDials(
  siblings: CohortPeerRow[],
  targetDegree: number,
): ControlCohortSelection {
  const backbone: CohortPeerRow[] = [];
  const rest: CohortPeerRow[] = [];

  // NOTE: the backbone is uncapped, so out-degree grows with the number of always-on
  // machines (and with any sibling that declares `storage` without being one); if a party
  // ever runs more than a handful, cap the backbone too.
  for (const peer of siblings) {
    if (peer.profile === 'storage') {
      backbone.push(peer);
    } else {
      rest.push(peer);
    }
  }

  backbone.sort(byPeerId);
  rest.sort(byPeerId);

  const cap = Math.max(0, targetDegree);
  const fill = rest.slice(0, cap);

  return {
    dials: [...backbone, ...fill],
    cappedNonBackbone: rest.length - fill.length,
  };
}

/** What {@link nextReconcileWakeMs} decides from, all times epoch milliseconds. */
export interface ReconcileWakeInput {
  /**
   * Consecutive passes, this one included, whose dial of a selected sibling or a cold-start
   * bootstrap peer failed; 0 when none of this pass's dials did.
   */
  redialStreak: number;
  /** When the pass that just ended began. */
  passStartedAt: number;
  /** Every (sibling, strand) strand-address due time this node holds. */
  strandAddrDueAt: Iterable<number>;
  now: number;
  /** The scheduler's backstop (ms); no wake is later than it. */
  backstopMs: number;
}

/**
 * How long after a pass the next one should run for the pass's own reasons, or `undefined`
 * when the backstop covers everything:
 *
 * - **Redial.** A streak of unconnected passes wakes after
 *   `min(CONTROL_COHORT_REDIAL_MS × 2^(streak − 1), backstop)`.
 * - **Strand addresses.** The earliest strand-address due time LATER THAN the pass's start,
 *   when it is sooner than the backstop, wakes when it falls due (now at the latest). A due
 *   time at or before the start belongs to a (sibling, strand) the pass skipped for another
 *   reason — the strand stopped, the sibling disconnected — and waking for it would spin; the
 *   strand watcher's launch retry keeps the same rule.
 *
 * The smaller wins.
 */
export function nextReconcileWakeMs(input: ReconcileWakeInput): number | undefined {
  const { redialStreak, passStartedAt, strandAddrDueAt, now, backstopMs } = input;
  let wake: number | undefined;
  if (redialStreak > 0) {
    wake = Math.min(CONTROL_COHORT_REDIAL_MS * 2 ** (redialStreak - 1), backstopMs);
  }
  for (const dueAt of strandAddrDueAt) {
    if (dueAt <= passStartedAt) {
      continue;
    }
    const delay = Math.max(0, dueAt - now);
    if (delay < backstopMs && (wake === undefined || delay < wake)) {
      wake = delay;
    }
  }
  return wake;
}
