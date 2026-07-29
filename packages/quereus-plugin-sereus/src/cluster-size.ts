/**
 * Default number of nodes Optimystic is told a replication cluster should have.
 * Two is Optimystic's own `minAbsoluteClusterSize` and the smallest value that
 * reaches the cluster path at all (a lone node writes locally without forming a
 * cluster). See {@link resolveClusterSize} for the rule.
 */
export const DEFAULT_CLUSTER_SIZE = 2;

/**
 * Resolve the cluster size to hand `createLibp2pNode`, applying the default and
 * rejecting values Optimystic cannot honour.
 *
 * Every node on the same network MUST resolve to the same value. Optimystic's
 * cluster member treats the number as an admission gate: a member refuses to
 * vote on a write when the coordinator's declared peer set is smaller than the
 * member's own configured size and the member has no confident network-size
 * estimate. A commit needs a super-majority (unanimity at two nodes), so one
 * refusal fails the write. Under-configuring is safe — a node admits any cohort
 * at or above its own number.
 *
 * Leaving it unset is NOT the same as passing the default: Optimystic's own
 * fallback is 10, which gates every write on a party smaller than ten nodes.
 * Every node-creating path must route through here.
 */
export function resolveClusterSize(configured?: number): number {
	if (configured === undefined) {
		return DEFAULT_CLUSTER_SIZE;
	}
	if (!Number.isInteger(configured) || configured < DEFAULT_CLUSTER_SIZE) {
		throw new Error(
			`clusterSize must be an integer >= ${DEFAULT_CLUSTER_SIZE} (Optimystic's minimum cluster size); got ${configured}`
		);
	}
	return configured;
}
