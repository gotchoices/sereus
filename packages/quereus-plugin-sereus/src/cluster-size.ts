import type { NodeOptions } from '@optimystic/db-p2p';

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
 * membership, peer addresses, the strand list — so a member left out of a block's cohort is
 * a member that may never learn the fact, and at a cohort of two the *read repair* that is
 * supposed to make that safe cannot converge (it can ask exactly one peer, and that peer may
 * be the member that also missed the write). Measured: 4 failures in 10 runs of the
 * control-DB replication scenario at size 2, 0 in 20 at size 3 and 0 in 10 at size 8.
 *
 * **Why this number, and why a constant.** Optimystic caps a cohort at the peers that
 * actually serve the network and downsizes a cohort it cannot fill (`allowDownsize: true`,
 * which Cadre passes), so any value at or above the party's node count yields the same
 * behaviour: cohort = whole party. 16 is roughly twice the largest deployment the product
 * documents (`docs/architecture.md` → "Enterprise (Multi-Node Mixed)", 7 nodes) — headroom
 * without pretending to support arbitrarily large parties; a party genuinely running more
 * than 16 nodes is back to partial replication for its control database and should raise
 * this. It is a constant rather than the live member count because Optimystic freezes the
 * value at libp2p-node construction, before the `ControlDatabase` holding the `CadrePeer`
 * rows exists, and because a per-node derivation lets two members disagree.
 *
 * Canonical explanation of all of the above — the read-repair mechanics, what whole-party
 * breadth does and does not remove, and what the wider cohort costs in write availability —
 * is `docs/architecture.md` → "Replication cluster size". Keep it there, not here.
 *
 * **Deliberately not `clusterPolicy.assumedClusterSize`.** That option means "the smallest
 * cohort this deployment can genuinely field", and it feeds both the membership admission
 * gate's low-confidence path *and* the read-repair/reconcile corroboration floor. A Cadre
 * party legitimately runs one or two nodes, so Cadre leaves it at Optimystic's default of 2;
 * asserting 16 there would make the admission gate demand `ceil(0.75 x 16) = 12` declared
 * peers and refuse every real party's writes.
 *
 * NOTE: cohort selection overfetches proportionally to this number —
 * `Libp2pKeyPeerNetwork.membershipOverfetch` asks FRET for
 * `max(clusterSize * 4, clusterSize + 16)` candidates and does a peerStore protocol lookup
 * per candidate, so 16 requests a 64-peer proximity band. Free today, because the result is
 * bounded by the peers FRET actually knows (2 in a 3-node party). If control-network cohort
 * selection ever shows up as slow on a large mesh, look here first.
 */
export const CONTROL_REPLICATION_BREADTH = 16;

/**
 * Cluster consensus policy every CONTROL-network libp2p node runs — production
 * (`CadreNode.buildControlNodeOptions`) and the integration harness alike. One definition so
 * the two cannot drift: the object literal used to be hand-copied at both sites, and the copy
 * at the harness had picked up a `superMajorityThreshold` override production never had.
 *
 * `superMajorityThreshold` is deliberately ABSENT. Omitting it makes both the cluster member
 * and the coordinator fall back to Optimystic's `DEFAULT_SUPER_MAJORITY_THRESHOLD` (0.75) —
 * the bar a real party commits control writes against. Setting it here, or at any one
 * consumer, reintroduces exactly the divergence this constant exists to prevent. The absence
 * is a researched decision, not an inherited default: no threshold both relaxes the
 * three-node unanimity bar and satisfies Optimystic's partition-safety condition at the
 * shipped admission fraction — see `docs/architecture.md` → "Replication cluster size".
 *
 * `sizeTolerance` only makes sense alongside `allowDownsize`: a fixed
 * {@link CONTROL_REPLICATION_BREADTH}-wide target is unsatisfiable by any real (2-7 node)
 * party, so the cohort must be allowed to shrink to the party that actually exists.
 *
 * NOT for strand networks: `strand-instance-manager.ts` passes a structurally identical
 * literal for a different network with different reasoning. The shape match is a coincidence;
 * keep them separate.
 *
 * The `satisfies` is load-bearing: without it a mistyped or obsolete key would compile at both
 * this definition and every consumer, because TypeScript only excess-property-checks fresh
 * object literals, not a shared constant handed to `clusterPolicy`.
 */
export const CONTROL_CLUSTER_POLICY = Object.freeze({
	allowDownsize: true,
	sizeTolerance: 0.5,
} satisfies NonNullable<NodeOptions['clusterPolicy']>);

/**
 * Default number of nodes a **strand** network is told its replication cluster should have.
 *
 * Strand data is application data, where partial replication is a legitimate choice: only
 * the control database's every-member-reads-all-of-it character forces full replication
 * ({@link CONTROL_REPLICATION_BREADTH}). So the question here is not "everyone" but "how
 * few is too few", and the answer is four.
 *
 * **Why four.** A write commits when a super-majority of the cohort approves, and that bar is
 * Optimystic's `DEFAULT_SUPER_MAJORITY_THRESHOLD` of 0.75 — which Cadre selects by naming no
 * threshold at all (see {@link CONTROL_CLUSTER_POLICY}). Approvals needed is
 * `ceil(cohort x 0.75)`, so:
 *
 * | copies | approvals needed | holders that may be offline |
 * |--------|------------------|-----------------------------|
 * | 2      | 2                | 0                           |
 * | 3      | 3                | 0                           |
 * | 4      | 3                | 1                           |
 * | 5      | 4                | 1                           |
 * | 6      | 5                | 1                           |
 *
 * Four is the smallest breadth that lets a write commit while one holder is away. At two or
 * three every holder must be awake for every write, which for a workspace shared between
 * phones and laptops is the ordinary case, not the rare one. Six buys no more fault tolerance
 * than four and costs more overfetch (see the NOTE below).
 *
 * **It is also a correctness floor, not only a durability one.** At breadth 2 a node that has
 * fallen behind asks exactly one peer whether it is current, and Optimystic accepts that single
 * answer as the cluster's truth (`corroboratorCapacity` in `db-p2p/src/cluster/quorum-restore.ts`
 * lowers the corroboration floor to one when the cohort cannot hold a second voter). If that
 * peer is also behind it honestly reports the stale revision, the reader concludes it is
 * current, and re-arms its repair window forever. Measured on the control-DB replication
 * scenario: 4 failures in 10 runs at breadth 2, 0 in 20 at breadth 3, 0 in 10 at breadth 8.
 * Any value above 2 lifts the floor off a single voter. The underlying Optimystic behaviour is
 * unfixed — `backlog/debt-read-repair-single-voter-corroboration` — so a caller that configures
 * 2 explicitly still takes the exposure.
 *
 * **Why not derived from the party or member count.** The strand's `Member` rows live *in* the
 * strand database, which runs on the strand libp2p node, whose cluster size is frozen at
 * construction — reading the list to configure the node needs the node to exist. Open strands
 * have no member list at all. The count also changes in the unsafe direction: a node that
 * restarted after someone joined derives a wider expected cohort than one that did not, and the
 * membership admission gate's confident path is what rejects the *wider* view. And a `Member` is
 * a party, not a machine; cohort width consumes machines. Full reasoning in
 * `docs/architecture.md` → "Replication cluster size".
 *
 * Raising or lowering it per strand is still the embedder's call
 * ({@link resolveStrandClusterSize}, `CadreNodeConfig.strandClusterSize`,
 * `StrandConnectionOptions.clusterSize`) — but every node on one strand must agree, so a change
 * means restarting all of them. There is no smaller-than-{@link MIN_CLUSTER_SIZE} option.
 *
 * NOTE: cohort selection overfetches proportionally — `Libp2pKeyPeerNetwork.membershipOverfetch`
 * asks FRET for `max(clusterSize * 4, clusterSize + 16)` candidates and does one peerStore
 * protocol lookup per candidate, so 4 requests a 20-peer band (was 18 at breadth 2). Negligible,
 * and bounded by the peers FRET actually knows. If strand cohort selection ever shows up as slow,
 * look here first.
 */
export const DEFAULT_STRAND_CLUSTER_SIZE = 4;

/**
 * Resolve the cluster size to hand `createLibp2pNode` for a **strand** network, applying
 * {@link DEFAULT_STRAND_CLUSTER_SIZE} and rejecting values Optimystic cannot honour. The
 * control network does not route through here — it uses the fixed
 * {@link CONTROL_REPLICATION_BREADTH}.
 *
 * Leaving the value unset is NOT the same as passing the default: Optimystic's own fallback
 * is 10, so every strand node-creating path must route through here.
 *
 * Every node on the same strand should resolve to the same value: the membership admission
 * gate's *confident* path compares a coordinator's declared set against the member's own
 * cohort view, and that view is bounded by this number, so a member configured much higher
 * can reject a smaller declared set as a downsize. Divergence is a live hazard whenever FRET
 * has a confident network-size estimate — not the unconditional refusal earlier revisions of
 * this comment described. See `docs/architecture.md` → "Replication cluster size".
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
