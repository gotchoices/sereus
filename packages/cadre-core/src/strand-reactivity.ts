/**
 * Which strand nodes are built with Optimystic's change-notification substrate
 * (`NodeOptions.cohortTopic` in `@optimystic/db-p2p`): a node built with it announces every
 * commit whose collection log tail it applied, and gives the strand's tables tagged
 * `"optimystic.network_watch" = true` a network watch, so an app on another machine is woken
 * by a commit instead of polling. Off unless the operator turns it on; `docs/strands/app-schema.md` →
 * "Change notifications" says what turning it on costs and exposes.
 *
 * "Cohort topic" is Optimystic's name for the substrate and stays inside this module. Cadre
 * splits it into two settings: `strandReactivity` turns it on, per strand, and the node's
 * {@link ReactivityRole} says whether this machine then carries other subscribers'
 * notifications or only receives its own (`node-roles.ts`).
 */

import { coreProfile, edgeProfile, type NodeProfile } from '@optimystic/db-core';
import type { ReactivityRole } from './node-roles.js';

/** Node-local, operator-supplied; never read from the control database, a strand row, or a peer. */
export interface StrandReactivityConfig {
  /** Master switch. Anything but `true` leaves every strand node exactly as before. */
  enabled: boolean;
  /** Strands to enable it for, by exact strand id. Absent or empty: every strand this node runs. */
  strandIds?: string[];
}

/**
 * The `createLibp2pNode` options slice for one strand: `{ cohortTopic: { enabled: true, host } }`
 * when `config.enabled === true` and (`strandIds` is absent, an empty array, or contains
 * `strandId` exactly); otherwise `{}` — no `cohortTopic` key at all, never `{ enabled: false }`,
 * so db-p2p takes its "absent" path unchanged.
 *
 * Fails closed on a JS embedder's mistake: an `enabled` that is not the boolean `true`, or a
 * `strandIds` that is present but not an array, enables nothing.
 *
 * The only host tuning is `profile`, from the node's {@link ReactivityRole}. Deliberately no
 * `wantK` and no `minSigs`: a reactivity root is the tail block's storage group (`clusterSize`
 * wide), verified at the consensus super-majority, and neither option governs it; the tiers
 * below the root keep db-p2p's defaults.
 */
export function strandCohortTopicOption(
  config: StrandReactivityConfig | undefined,
  strandId: string,
  reactivity: ReactivityRole
): { cohortTopic?: { enabled: true; host: { profile: NodeProfile } } } {
  return config?.enabled === true && strandSelected(config.strandIds, strandId)
    ? { cohortTopic: { enabled: true, host: { profile: hostProfile(reactivity) } } }
    : {};
}

/**
 * The cohort-topic node profile a reactivity role is built with. `'forwarder'` passes
 * `coreProfile()` EXPLICITLY, which is also db-p2p's own default when no profile is given — so
 * the forwarder path is today's behaviour by construction, not by agreement with a default.
 *
 * Exhaustive on purpose: a role added to {@link ReactivityRole} has to decide its profile here
 * rather than inherit one.
 */
function hostProfile(reactivity: ReactivityRole): NodeProfile {
  switch (reactivity) {
    case 'forwarder': return coreProfile();
    case 'subscriber': return edgeProfile();
  }
}

function strandSelected(strandIds: unknown, strandId: string): boolean {
  if (strandIds === undefined) {
    return true;
  }
  return Array.isArray(strandIds) && (strandIds.length === 0 || strandIds.includes(strandId));
}
