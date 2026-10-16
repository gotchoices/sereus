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
 * Default recurring cadence for {@link CadreNode.reconcileControlCohort} (ms).
 * In the same spirit as the 5s strand-watch poll but lighter, since a control
 * cohort changes far less often than strand activity.
 *
 * An interval between pass starts, not a deadline on a pass. Passes are
 * single-flight, so a pass that runs longer than this is joined rather than
 * stacked, and the effective cadence becomes the pass length: one unreachable
 * sibling's dial alone can take the whole per-peer dial budget (86 s at the
 * default declared link).
 */
export const DEFAULT_CONTROL_COHORT_RECONCILE_MS = 15_000;

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
