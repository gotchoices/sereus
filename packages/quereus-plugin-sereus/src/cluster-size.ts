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
 * on every member of the party. Cohort width alone only delivers that for blocks written
 * while the members were serving the network: a block committed while the writer was
 * alone (the founder's genesis above all — collection headers are written once and never
 * revised) has a cohort of one, and it reaches later joiners through cadre-core's
 * peer-join block catch-up (`peer-join-backfill.ts`, membership-gated on the control
 * network), not through this breadth.
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
 * A cadre is one party by construction, so the owner-blind cohort-selection question that
 * applies to strand networks (see {@link DEFAULT_STRAND_CLUSTER_SIZE} below) is not a question
 * here: "replicate to the whole party" already is the whole intent, and there is no party
 * diversity for this breadth to buy or fail to buy.
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
 * NOT for strand networks: {@link STRAND_CLUSTER_POLICY} is a structurally identical object
 * for a different network with different reasoning. The shape match is a coincidence; keep
 * them separate.
 *
 * `assumedClusterSize` is REQUIRED here, and 2 is not a guess — it is the smallest party we
 * support. The field feeds two Optimystic consumers with opposite failure modes, and only one
 * of them defaults to something workable for us:
 *
 * - The membership admission gate already defaults to 2 (`minAbsoluteClusterSize`), so naming
 *   it changes nothing there.
 * - The read-repair / reconcile corroboration floor does NOT. Absent this field it falls back
 *   to `clusterSize` — which for the control network is {@link CONTROL_REPLICATION_BREADTH},
 *   16. `corroboratorCapacity(peers, 16)` is then `max(peers, 15)`, so the floor of two
 *   distinct non-self corroborators binds. A two-node party fields exactly one, can never
 *   reach two, and so can never repair a block: `cluster-fetch:no-quorum` forever.
 *
 * Declaring 2 does NOT lower the replication factor — that stays at
 * {@link CONTROL_REPLICATION_BREADTH}. It states the cohort size we can genuinely field, which
 * is what the corroboration floor is asking. See Optimystic's `cluster/cluster-policy.ts`
 * ("Why two size yardsticks, not one") and `corroboratorCapacity` in `cluster/quorum-restore.ts`.
 *
 * **`assumedClusterSize` is now the ADMISSION yardstick.** Since Optimystic grew
 * `repairCorroborationClusterSize` (see {@link controlClusterPolicy}), the repair corroboration
 * floor prefers that separate declaration and reads this field only when nothing was declared —
 * the unknown-machine-count path, where the paragraph above still describes what it does. So on
 * every path where the count IS known, the 2 here governs one consumer: the membership admission
 * gate's low-confidence fallback path. Leaving
 * it at 2 is deliberate and must NOT be "fixed" to match the repair yardstick. Raising it would
 * make the gate demand `ceil(0.75 x N)` DECLARED peers before it admits a coordinator's peer
 * set on that path, and a Cadre party is phones and laptops: it cannot promise that three
 * quarters of its enrolled machines are awake at any moment, so a party of eight with three
 * awake would stop transacting entirely. The repair yardstick has no such cost (it gates only
 * whether this node believes a repair answer), which is exactly why the two are now separate
 * numbers rather than one.
 *
 * The `satisfies` is load-bearing: without it a mistyped or obsolete key would compile at both
 * this definition and every consumer, because TypeScript only excess-property-checks fresh
 * object literals, not a shared constant handed to `clusterPolicy`.
 */
export const CONTROL_CLUSTER_POLICY = Object.freeze({
	allowDownsize: true,
	sizeTolerance: 0.5,
	assumedClusterSize: 2,
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
 * **It is also a correctness floor, not only a durability one — but the floor is measured in
 * machines, not in this number.** A node that has fallen behind and can ask exactly one peer
 * whether it is current has Optimystic accept that single answer as the cluster's truth
 * (`corroboratorCapacity` in `db-p2p/src/cluster/quorum-restore.ts` lowers the corroboration
 * floor to one when the cohort cannot hold a second voter). If that peer is also behind it
 * honestly reports the stale revision, the reader concludes it is current, and re-arms its
 * repair window forever. Measured on the control-DB replication scenario: 4 failures in 10 runs
 * at breadth 2, 0 in 20 at breadth 3, 0 in 10 at breadth 8. What lifts the floor off a single
 * voter is a third machine **or a declaration that there are three** — not a wider target.
 * `corroboratorCapacity` takes the max of the cohort peers actually present and the declared
 * repair yardstick, so raising *this* number (the replication breadth) does nothing: the
 * yardstick is a separate declaration, and **a strand node makes no such declaration today**.
 * The control network derives one from the party's enrolled machines
 * ({@link controlClusterPolicy}), which is exact there because every enrolled machine runs the
 * control node. A strand has no equivalent count: it launches only on machines whose embedder
 * registered its sApp config, and reusing the party count over-declares — which is worse than
 * declaring nothing, because at a yardstick of three or more the corroboration floor is pinned
 * at two peers and a strand that can field only one could then never repair at all. So every
 * strand runs {@link STRAND_CLUSTER_POLICY} unchanged and takes the single-voter exposure
 * whenever its cohort view shrinks to one peer. The underlying Optimystic behaviour is unfixed
 * (`backlog/debt-read-repair-single-voter-corroboration`) and the per-strand serving count that
 * would let a strand declare honestly is `backlog/feat-strand-yardstick-from-serving-machines`
 * — its seam ({@link strandClusterPolicy}'s `servingMachines`, threaded through
 * `StartStrandConfig.servingMachines`) is already in place and fed by nothing. Raising this
 * number does not buy the way out; a machine, or an honest declaration of the machines actually
 * serving the strand, does.
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
 * **Four machines, not four parties.** This number counts machines, and today that is not the
 * same as counting independent holders. Cohort selection upstream is owner-blind — it
 * picks nodes by hash proximity with no concept of which peer belongs to which party
 * (`optimystic/tickets/backlog/feat-cohort-selection-owner-aware-placement`) — and on the
 * cadre-driven path, the one that resolves a seed for itself, a strand's libp2p mesh is seeded
 * from exactly one party's own control-database peer rows (`CadreNode.resolveCohortSeed`), so
 * the cohort actually formed is that one party's machines. Four copies are, on that path, four
 * machines belonging to one party — one failure domain, one witness. A cross-party mesh is not
 * forbidden, only undiscoverable: it takes hand-supplied addresses
 * (`StrandConnectionOptions.bootstrapNodes`) or a hand-written dial (see the doc). Tracked:
 * `backlog/feat-strand-party-identity`. Full reasoning: `docs/architecture.md` →
 * "Replication cluster size".
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
 * Cluster consensus policy every STRAND-network libp2p node runs — production
 * (`StrandInstanceManager.buildStrandRuntime`) and the plugin's own networked e2e mesh alike.
 * One definition so the two cannot drift; the literal used to be hand-copied at both sites.
 *
 * Structurally identical to {@link CONTROL_CLUSTER_POLICY} and deliberately separate from it:
 * that one is the control database's, whose breadth is fixed at
 * {@link CONTROL_REPLICATION_BREADTH} for reasons that do not apply to application data.
 *
 * `superMajorityThreshold` is ABSENT for the same reason it is absent there: omitting it is how
 * both the coordinator and the cluster member select Optimystic's
 * `DEFAULT_SUPER_MAJORITY_THRESHOLD` (0.75), the bar {@link DEFAULT_STRAND_CLUSTER_SIZE}'s
 * copies/approvals table is computed against.
 *
 * `sizeTolerance` only makes sense alongside `allowDownsize`: a {@link
 * DEFAULT_STRAND_CLUSTER_SIZE}-wide target is unsatisfiable by a strand of one, two or three
 * machines, so the cohort must be allowed to shrink to the mesh that actually exists.
 *
 * `assumedClusterSize` is REQUIRED, and {@link MIN_CLUSTER_SIZE} is not a guess — it is the
 * smallest strand that reaches the cluster path at all. Absent this field the read-repair /
 * reconcile corroboration floor falls back to `clusterSize`, so
 * `corroboratorCapacity(peers, 4)` is `max(peers, 3)` and two distinct non-self corroborators
 * become mandatory. A two-machine strand fields exactly one peer, can never reach two, and so
 * can never repair a block — `cluster-fetch:no-quorum` forever, which is a read that never
 * catches up and a `create table` that dies with `Missing block` on the joining node. Declaring
 * the honest floor does NOT lower the replication factor (that stays at
 * {@link DEFAULT_STRAND_CLUSTER_SIZE}) and does not relax anything a strand with three or more
 * machines does: `corroboratorCapacity` takes the MAX of the cohort actually present and this
 * number, so the relaxed branch is reachable only by a cohort that is genuinely that small. See
 * Optimystic's `cluster/cluster-policy.ts` ("Why two size yardsticks, not one").
 *
 * `assumedClusterSize` also carries the ADMISSION yardstick, and on the strand path it carries
 * BOTH jobs today. Optimystic prefers a separately declared
 * `repairCorroborationClusterSize` for the repair floor and falls back to this field only when
 * nothing was declared — which, for a strand, is always: no per-strand serving count exists yet,
 * so {@link strandClusterPolicy} declares nothing and the 2 here governs the repair floor
 * exactly as the paragraph above describes, alongside the membership admission gate's
 * low-confidence fallback. Do not raise it if a strand yardstick ever does get declared
 * (`backlog/feat-strand-yardstick-from-serving-machines`): a strand shared between phones cannot
 * promise that `ceil(0.75 x N)` of its machines are awake, and the admission gate would refuse
 * its writes. Same reason and same warning as {@link CONTROL_CLUSTER_POLICY}'s.
 *
 * The `satisfies` is load-bearing for the same reason as {@link CONTROL_CLUSTER_POLICY}'s.
 */
export const STRAND_CLUSTER_POLICY = Object.freeze({
	allowDownsize: true,
	sizeTolerance: 0.5,
	assumedClusterSize: MIN_CLUSTER_SIZE,
} satisfies NonNullable<NodeOptions['clusterPolicy']>);

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

/**
 * The repair yardstick to declare for a network, from the machines that SERVE that network and
 * the breadth it replicates to.
 *
 * ## What this number does
 *
 * Optimystic's block repair (read-repair and reconcile) asks a block's cohort for the newest
 * revision and trusts an answer only when enough independent peers agree on it. "Enough" is
 * measured against a **declared** number rather than the peers currently visible — deliberately,
 * because the visible set comes from unauthenticated routing, and a partition (or an attacker
 * with routing influence) can shrink it. `clusterPolicy.repairCorroborationClusterSize` is that
 * declaration; it moves the repair yardstick ALONE, leaving
 * {@link CONTROL_CLUSTER_POLICY}'s / {@link STRAND_CLUSTER_POLICY}'s `assumedClusterSize` — the
 * membership admission gate's yardstick — untouched. Optimystic resolves
 * `repairCorroborationClusterSize -> assumedClusterSize -> clusterSize`, and a value that is not
 * a positive integer falls THROUGH to the next term rather than being clamped, which is why the
 * builders below refuse to pass a degenerate count at all.
 *
 * ## The arithmetic, and why the formula is what it is
 *
 * Three consumers read the resolved yardstick `N`. With `p` = cohort peers currently visible
 * (self excluded) and Optimystic's `CORROBORATION_FLOOR` = 2:
 *
 * - **Repair corroboration floor** (`corroboratorCapacity` / `quorumSize` in
 *   `db-p2p/src/cluster/quorum-restore.ts`): capacity is `max(p, N - 1)` and the floor is
 *   `max(1, min(2, capacity))`. So `N = 1` and `N = 2` behave IDENTICALLY at every `p` — both
 *   leave the floor at a single voter whenever `p <= 1`. `N >= 3` pins the floor at two
 *   corroborators unconditionally, including when the view has shrunk to one peer. That is the
 *   entire point of declaring. `N` above 3 raises nothing further (the `min(2, ...)` caps it), so
 *   a larger declaration buys only honesty, never more repair.
 * - **Commit freshness window** (`CoordinatorRepo.commitQuorumRulesOutRivals`): `fullCohortSize`
 *   is `max(observed cohort, N)`, and a local commit arms the lazy read-repair window only when
 *   `approvals > fullCohortSize / 2`. Here a larger `N` is NOT free — see the NOTE below.
 * - The `repair-fault-tolerance` startup advisory — log text only.
 *
 * Hence `max(MIN_CLUSTER_SIZE, min(servingMachines, replicationBreadth))`, two clamps each for
 * a stated reason:
 *
 * - **Capped at the replication breadth**, because a block only ever lives on
 *   `min(breadth, machines serving)` machines. A party of eight running strands at
 *   {@link DEFAULT_STRAND_CLUSTER_SIZE} has a cohort of four; declaring eight would make
 *   `approvals > 4` unsatisfiable (a super-majority of four is three), so the freshness window
 *   would never arm for any strand commit, forever — and buy nothing on repair, whose floor is
 *   already at its cap at four. Declare the machines that can hold the block, not the machines
 *   that exist.
 * - **Floored at {@link MIN_CLUSTER_SIZE}**, so this can only ever RAISE the declared number
 *   relative to the un-derived constants. A node that authorizes nobody is a genuine
 *   founder-alone party, but it is equally a freshly seeded node whose membership rows have not
 *   replicated yet, or one whose trusted-owner anchor is empty — and this node cannot tell those
 *   apart. Declaring 1 is safety-neutral for repair (identical to 2 at every `p`, per the table
 *   above) but it WOULD let a solo commit arm the freshness window, which is wrong if the "solo"
 *   reading came from stale local records. Lifting that floor for a node that can prove it is
 *   genuinely alone is separate work: `backlog/feat-solo-node-arms-its-own-freshness-window`.
 *
 * The yardstick is per-node and protects only that node's own reads — no node refuses another
 * anything over it — so two members disagreeing (one has replicated a new `CadrePeer` row, one
 * has not) is harmless by construction, not a race to close.
 *
 * ## The contract: callers pass machines that SERVE this network, or nothing at all
 *
 * Over-declaring is not merely wasteful, it is unsafe in the availability direction: at
 * `N >= 3` the corroboration floor is pinned at two peers, so a cohort that can only ever
 * field one peer can never repair at all (`cluster-fetch:no-quorum`), where a declaration of
 * 2 would have let its single peer answer. So the number a caller passes must be the machines
 * that actually serve the network in question — never a broader population that merely bounds
 * it from above, and never a guess. A caller with no trustworthy count passes nothing, which
 * the builders below turn into "declare no yardstick at all".
 *
 * The CONTROL network satisfies this from the party's enrolled machines, because every enrolled
 * machine runs the control node by construction: there, enrolled IS serving
 * ({@link controlClusterPolicy}, fed by cadre-core's `enrolled-machine-store.ts`). A STRAND does
 * not — it launches only on machines whose embedder registered its sApp config
 * (`CadreNode.addStrand`), so a closed strand shared by two machines of a three-machine party is
 * served by two, and declaring three would be exactly the unsafe over-declaration above. No
 * authenticated per-strand serving count exists yet, so strand nodes declare NOTHING and run the
 * frozen {@link STRAND_CLUSTER_POLICY} — keeping the known, upstream-tracked single-voter
 * exposure (`backlog/debt-read-repair-single-voter-corroboration`) rather than risking the
 * cannot-repair-at-all failure. Building that count:
 * `backlog/feat-strand-yardstick-from-serving-machines`.
 *
 * Both arguments must be positive integers; the builders below sanitize before calling, and
 * a degenerate value here propagates (`NaN` in, `NaN` out) rather than being clamped.
 *
 * NOTE: on a party of three or more machines where fewer than half are awake, a commit reaches a
 * downsized cohort and no longer arms the freshness window, so each such block's next read costs
 * one cohort consult per read-repair window instead of trusting the local commit. That is the
 * correct reading of the honest number — a commit that reached two of five machines genuinely
 * does not rule out a rival quorum, and arming it today is a consequence of under-declaring — and
 * the cost is bounded at one consult per block per window by the read path's solo-self-skip exit.
 * NOT measured under load. If a large, mostly-hibernating party's read path ever shows up as
 * slow, this is the first thing to look at.
 */
export function resolveRepairYardstick(servingMachines: number, replicationBreadth: number): number {
	return Math.max(MIN_CLUSTER_SIZE, Math.min(servingMachines, replicationBreadth));
}

/**
 * A serving-machine count as a usable number, or `undefined` for "this node does not know".
 * Anything that is not a positive integer is unknown rather than clamped: Optimystic itself
 * treats a degenerate declaration as absent, so silently rounding one here would hide a caller
 * bug behind a number nobody chose.
 */
function asKnownMachineCount(servingMachines?: number): number | undefined {
	return servingMachines !== undefined
		&& Number.isInteger(servingMachines)
		&& servingMachines >= 1
		? servingMachines
		: undefined;
}

/**
 * {@link CONTROL_CLUSTER_POLICY} with the repair yardstick declared from `enrolledMachines`
 * (see {@link resolveRepairYardstick}); the frozen base object ITSELF when the count is unknown,
 * so the cold path is provably today's behaviour and identity assertions keep holding.
 *
 * The parameter keeps the name `enrolledMachines`, unlike {@link strandClusterPolicy}'s, because
 * for the CONTROL network the two quantities are one and the same by construction: every
 * enrolled machine runs the control node, so the machines enrolled in the party ARE the machines
 * serving this network.
 */
export function controlClusterPolicy(enrolledMachines?: number): NonNullable<NodeOptions['clusterPolicy']> {
	const known = asKnownMachineCount(enrolledMachines);
	if (known === undefined) {
		return CONTROL_CLUSTER_POLICY;
	}
	return Object.freeze({
		...CONTROL_CLUSTER_POLICY,
		repairCorroborationClusterSize: resolveRepairYardstick(known, CONTROL_REPLICATION_BREADTH)
	} satisfies NonNullable<NodeOptions['clusterPolicy']>);
}

/**
 * {@link STRAND_CLUSTER_POLICY} with the repair yardstick declared from `servingMachines` — the
 * machines that serve THIS strand — and this strand's own `clusterSize` (already resolved by
 * {@link resolveStrandClusterSize}, so it is at least {@link MIN_CLUSTER_SIZE} and the formula's
 * two clamps can never cross); the frozen base object ITSELF when the count is unknown.
 *
 * **The unknown path is the production path today.** No authenticated per-strand serving count
 * exists, and the party's enrolled-machine count is emphatically not one (see
 * {@link resolveRepairYardstick}'s contract section), so cadre-core passes nothing and every
 * strand node runs the frozen constant. The parameter and its threading through
 * `StartStrandConfig.servingMachines` stay in place as the seam that
 * `backlog/feat-strand-yardstick-from-serving-machines` plugs a real count into.
 */
export function strandClusterPolicy(
	clusterSize: number,
	servingMachines?: number
): NonNullable<NodeOptions['clusterPolicy']> {
	const known = asKnownMachineCount(servingMachines);
	if (known === undefined) {
		return STRAND_CLUSTER_POLICY;
	}
	return Object.freeze({
		...STRAND_CLUSTER_POLICY,
		repairCorroborationClusterSize: resolveRepairYardstick(known, clusterSize)
	} satisfies NonNullable<NodeOptions['clusterPolicy']>);
}
