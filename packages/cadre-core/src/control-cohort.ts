/**
 * Control-cohort dial selection: the pure policy behind
 * {@link CadreNode.reconcileControlCohort}. Decides WHICH known cadre siblings a
 * node proactively dials each pass to keep the `CadreControl` collections' cohort
 * connected (and thus replicating), without devolving into an N² mesh.
 *
 * FRET only needs a *connected* graph with the block clusters reachable, not a
 * full mesh. Storage/authority nodes are the stable, publicly-dialable backbone
 * that hold the control blocks, so the policy is **backbone-preferential with a
 * bounded out-degree**:
 *
 * - **Always dial every backbone (authority) member** — the authority set is
 *   small by design, and routing cohort formation through publicly-dialable
 *   authority nodes keeps the cohort ≥2 where authority-signed writes originate.
 * - **Fill the remainder** up to `targetDegree` with non-authority members,
 *   ordered deterministically (peerId sort) so every node makes the same stable
 *   choice across passes and load spreads predictably.
 *
 * For a small party (members ≤ degree) this degenerates to a full mesh, which is
 * correct, cheap, and matches what the convergence tests do by hand; for a large
 * party it bounds out-degree to `backbone + targetDegree`.
 */

import { ed25519PublicKeyB64FromPeerId } from './seed-bootstrap.js';
import type { CohortPeerRow } from './strand-cohort.js';

/**
 * Default recurring cadence for {@link CadreNode.reconcileControlCohort} (ms).
 * In the same spirit as the 5s strand-watch poll but lighter, since a control
 * cohort changes far less often than strand activity.
 */
export const DEFAULT_CONTROL_COHORT_RECONCILE_MS = 15_000;

/**
 * Default cap on the number of **non-authority** members a single reconcile pass
 * proactively dials. Backbone (authority) members are always dialed and do NOT
 * count against this cap.
 */
export const DEFAULT_CONTROL_COHORT_TARGET_DEGREE = 6;

/** Outcome of {@link selectControlCohortDials}: who to dial + what the cap dropped. */
export interface ControlCohortSelection {
  /**
   * Siblings to dial this pass, backbone first then the bounded non-authority
   * fill. Already self-excluded (the caller must pass self-excluded `siblings`).
   * Still includes peers that may turn out to be already-connected — the caller
   * diffs against live connections separately.
   */
  dials: CohortPeerRow[];
  /** Non-authority members dropped by the `targetDegree` cap (0 when none). */
  cappedNonAuthority: number;
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
 * A member is **backbone** iff the ed25519 key derived from its peerId
 * (see {@link ed25519PublicKeyB64FromPeerId}) is in `authorityKeys`. All backbone
 * members are selected; non-authority members fill up to `targetDegree` in
 * deterministic peerId order.
 *
 * @param siblings - cadre members EXCLUDING self (the caller filters self out).
 * @param authorityKeys - the converged `AuthorityKey` set; may be empty/partial
 *   before authority convergence, in which case no member classifies as backbone
 *   yet and the bounded fill still makes progress (preference sharpens later).
 * @param targetDegree - cap on non-authority dials (negative is treated as 0).
 */
export function selectControlCohortDials(
  siblings: CohortPeerRow[],
  authorityKeys: ReadonlySet<string>,
  targetDegree: number,
): ControlCohortSelection {
  const backbone: CohortPeerRow[] = [];
  const rest: CohortPeerRow[] = [];

  for (const peer of siblings) {
    const pubKey = ed25519PublicKeyB64FromPeerId(peer.peerId);
    if (pubKey !== null && authorityKeys.has(pubKey)) {
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
    cappedNonAuthority: rest.length - fill.length,
  };
}
