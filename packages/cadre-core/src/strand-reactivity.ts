/**
 * Which strand nodes are built with Optimystic's change-notification substrate
 * (`NodeOptions.cohortTopic` in `@optimystic/db-p2p`): a node built with it announces every
 * commit whose collection log tail it applied, and gives the strand's tables tagged
 * `"optimystic.network_watch" = true` a network watch, so an app on another machine is woken
 * by a commit instead of polling. Off unless the operator turns it on; `docs/strands.md` →
 * "Change notifications (reactivity)" says what turning it on costs and exposes.
 *
 * "Cohort topic" is Optimystic's name for the substrate and stays inside this module; cadre
 * calls the setting `strandReactivity`.
 */

/** Node-local, operator-supplied; never read from the control database, a strand row, or a peer. */
export interface StrandReactivityConfig {
  /** Master switch. Anything but `true` leaves every strand node exactly as before. */
  enabled: boolean;
  /** Strands to enable it for, by exact strand id. Absent or empty: every strand this node runs. */
  strandIds?: string[];
}

/**
 * The `createLibp2pNode` options slice for one strand: `{ cohortTopic: { enabled: true } }` when
 * `config.enabled === true` and (`strandIds` is absent, an empty array, or contains `strandId`
 * exactly); otherwise `{}` — no `cohortTopic` key at all, never `{ enabled: false }`, so db-p2p
 * takes its "absent" path unchanged.
 *
 * Fails closed on a JS embedder's mistake: an `enabled` that is not the boolean `true`, or a
 * `strandIds` that is present but not an array, enables nothing.
 *
 * Deliberately no `wantK` or `host` tuning: a reactivity root is the tail block's storage group
 * (`clusterSize` wide), verified at the consensus super-majority, and neither `wantK` nor
 * `cohortTopic.host.minSigs` governs it; the tiers below the root keep db-p2p's defaults.
 */
export function strandCohortTopicOption(
  config: StrandReactivityConfig | undefined,
  strandId: string
): { cohortTopic?: { enabled: true } } {
  return config?.enabled === true && strandSelected(config.strandIds, strandId)
    ? { cohortTopic: { enabled: true } }
    : {};
}

function strandSelected(strandIds: unknown, strandId: string): boolean {
  if (strandIds === undefined) {
    return true;
  }
  return Array.isArray(strandIds) && (strandIds.length === 0 || strandIds.includes(strandId));
}
