/**
 * Smallest cluster size Optimystic will honour — its own `minAbsoluteClusterSize`,
 * and the smallest value that reaches the cluster path at all (a lone node writes to
 * local storage without forming a cluster). A validation floor, not a default.
 */
export const MIN_CLUSTER_SIZE = 2;

/**
 * How many nodes each block of the **control** (cadre membership) database is replicated
 * to. Chosen to exceed any party's node count, so in practice every control block lands
 * on every member of the party.
 *
 * **Why full replication here.** Every control node reads the whole control database —
 * membership, peer addresses, the strand list — so a member that never receives a write is
 * a member that never learns the fact. Partial replication expects such a member to catch
 * up by *read repair*: on reading a block it asks the block's cohort for the newest
 * revision. At a cohort of two that is exactly one peer, and Optimystic's repair logic
 * accepts a single peer's answer as the cluster's truth when the cohort cannot hold a
 * second voter (`corroboratorCapacity` in `../optimystic/packages/db-p2p/src/cluster/quorum-restore.ts`
 * caps the corroboration floor at what the cohort can supply). If that one peer is the
 * member that also missed the write, it honestly answers with the older revision, the
 * reader concludes it is current, and re-arms its lazy repair window — so it never
 * converges, not slowly but never. Measured: 4 failures in 10 runs of the control-DB
 * replication scenario at size 2, 0 in 20 at size 3 and 0 in 10 at size 8.
 *
 * **Why a constant rather than the live member count.** Optimystic freezes the value when
 * the libp2p node is constructed, and Cadre builds its control node *before* the
 * `ControlDatabase` holding the `CadrePeer` rows exists. Deriving it per node would also
 * let two members disagree, which the cluster-membership gate punishes (see
 * {@link resolveStrandClusterSize}). A constant above the largest party keeps every
 * member's view identical.
 *
 * **Why this number.** Optimystic caps a cohort at the peers that actually serve the
 * network — `Libp2pKeyPeerNetwork.findCluster` keeps `min(serving peers, clusterSize - 1)`
 * non-self members — and downsizes a cohort it cannot fill (`allowDownsize: true`, which
 * Cadre passes). So any value at or above the party's node count yields the same behaviour:
 * cohort = whole party. 16 is roughly twice the largest deployment the product documents
 * (`docs/architecture.md` → "Enterprise (Multi-Node Mixed)", 7 nodes), leaving headroom
 * without pretending to support arbitrarily large parties. A party that genuinely runs more
 * than 16 nodes is back to partial replication for its control database and should raise
 * this.
 *
 * **Deliberately not `clusterPolicy.assumedClusterSize`.** That option means "the smallest
 * cohort this deployment can genuinely field", and a Cadre party legitimately runs one or
 * two nodes. Cadre therefore leaves it at Optimystic's default of 2. Asserting 16 there
 * would make the membership admission gate demand `ceil(0.75 x 16) = 12` declared peers on
 * its low-confidence path and refuse every real party's writes.
 */
export const CONTROL_REPLICATION_BREADTH = 16;

/**
 * Default number of nodes a **strand** network is told its replication cluster should have.
 *
 * Strand data is application data, where partial replication is a legitimate choice: only
 * the control database's every-member-reads-all-of-it character forces full replication.
 * Two is the floor ({@link MIN_CLUSTER_SIZE}) and inherits the read-repair weakness
 * described on {@link CONTROL_REPLICATION_BREADTH}; raising it per strand is the embedder's
 * call. Tracked as `backlog/debt-strand-replication-breadth-ignores-party-count`.
 */
export const DEFAULT_STRAND_CLUSTER_SIZE = 2;

/**
 * Resolve the cluster size to hand `createLibp2pNode` for a **strand** network, applying
 * {@link DEFAULT_STRAND_CLUSTER_SIZE} and rejecting values Optimystic cannot honour. The
 * control network does not route through here — it uses the fixed
 * {@link CONTROL_REPLICATION_BREADTH}.
 *
 * Leaving the value unset is NOT the same as passing the default: Optimystic's own fallback
 * is 10, so every strand node-creating path must route through here.
 *
 * Every node on the same strand should resolve to the same value. The number is a
 * replication-breadth target, and Optimystic's membership admission gate does *not* measure
 * a declared peer set against it (the gate's fallback yardstick is
 * `ClusterConsensusConfig.assumedClusterSize`, which Cadre leaves at Optimystic's default of
 * 2 — see `admitMembership` in
 * `../optimystic/packages/db-p2p/src/cluster/cluster-repo.ts`). But the gate's *confident*
 * path compares a declared set against the member's own cohort view, and that view is itself
 * bounded by this number: a member configured much higher than the coordinator derives a
 * larger expected cohort and can reject the coordinator's smaller declared set as a
 * downsize. Divergence is therefore still a live hazard whenever FRET has a confident
 * network-size estimate — it is simply not the unconditional refusal earlier revisions of
 * this comment described.
 */
export function resolveStrandClusterSize(configured?: number): number {
	if (configured === undefined) {
		return DEFAULT_STRAND_CLUSTER_SIZE;
	}
	if (!Number.isInteger(configured) || configured < MIN_CLUSTER_SIZE) {
		throw new Error(
			`clusterSize must be an integer >= ${MIN_CLUSTER_SIZE} (Optimystic's minimum cluster size); got ${configured}`
		);
	}
	return configured;
}
