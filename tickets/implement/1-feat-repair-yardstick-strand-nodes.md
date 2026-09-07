description: A safety check that decides whether one machine's word can be trusted about a piece of shared data is currently pinned at the two-machine setting no matter how many machines the user has enrolled; teach it the real number and apply it to each shared workspace's network every time that network is built, which already happens on every wake from sleep.
files: packages/quereus-plugin-sereus/src/cluster-size.ts, packages/quereus-plugin-sereus/test/plugin.spec.ts, packages/cadre-core/src/strand-instance-manager.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/test/strand-instance-manager-cluster-size.spec.ts, docs/architecture.md
difficulty: medium
----

# Declare the repair yardstick from enrolled machines — shared policy builders + strand networks

Optimystic's block repair asks a block's cohort for the newest revision and only trusts an answer
enough independent peers agree on. "Enough" is measured against a **declared** number, not the peers
currently visible — deliberately, because the visible set comes from unauthenticated routing and a
partition (or an attacker with routing influence) can shrink it. Cadre pins that declared number at 2
for every party at every size, so the corroboration floor relaxes to a single voter whenever routing
shows a node one peer — the exposure `backlog/debt-read-repair-single-voter-corroboration` describes
for a genuinely two-machine strand, extended to every party size whenever the view shrinks.

This ticket lands the shared policy builders and applies them to **strand** networks. The control
network's cold-start problem (it needs the number before the database holding the membership rows
exists) is the second ticket, `feat-repair-yardstick-control-node`, which depends on the builders
here.

## The upstream field this uses — already shipped

`clusterPolicy.repairCorroborationClusterSize` (Optimystic `packages/db-p2p/src/cluster/cluster-policy.ts`)
declares the repair yardstick **alone**, leaving `assumedClusterSize` — which also feeds the write
admission gate's low-confidence floor — untouched. Landed as
`../optimystic/tickets/complete/1-feat-declare-repair-yardstick-alone-apply-by-rebuild.md`; the field
is present in the linked workspace's built types, so no Optimystic change is needed here. Resolution
chain, if nothing is declared: `repairCorroborationClusterSize -> assumedClusterSize -> clusterSize`.
A value that is not a positive integer falls **through** to the next term rather than being clamped.

## What the number must be, and why — the arithmetic, checked

Three consumers read the resolved yardstick `N`. Their behaviour across `N`, with `p` = cohort peers
currently visible (self excluded) and `CORROBORATION_FLOOR = 2`:

- **Repair corroboration floor** (`corroboratorCapacity` / `quorumSize` in
  `db-p2p/src/cluster/quorum-restore.ts`): `capacity = max(p, N - 1)`, and the floor is
  `max(1, min(2, capacity))`. So:
  - `N = 1` and `N = 2` are **identical at every `p`** — both leave the floor at 1 whenever `p <= 1`.
    This is the relaxation the pin causes today.
  - `N >= 3` puts the floor at 2 corroborators unconditionally, including when the view has shrunk to
    one peer. **This is the whole fix.**
  - `N` above 3 raises nothing further — the `min(2, …)` caps it. So there is no repair benefit to
    declaring a larger number than 3, only the honesty of the declaration.
- **Commit freshness window** (`CoordinatorRepo.commitQuorumRulesOutRivals`, `repo/coordinator-repo.ts`):
  `fullCohortSize = max(observedCohortSize, N)`, and a local commit arms the lazy read-repair window
  only when `approvals > fullCohortSize / 2`. Here a larger `N` is **not** free: a commit that reaches
  fewer than half of `N` machines stops arming the window, and the next read of each such block
  consults the cohort instead of trusting the local commit.
- **The `repair-fault-tolerance` startup advisory** — log text only.

### The formula

```
repairYardstick = max(MIN_CLUSTER_SIZE, min(enrolledMachines, replicationBreadth))
```

Two clamps, each for a stated reason:

- **Capped at the replication breadth**, because a block only ever lives on `min(breadth, machines
  serving)` machines. A party of eight running strands at the default breadth of four has a cohort of
  four; declaring eight would leave `approvals > 4` unsatisfiable (a super-majority of four is three),
  so the freshness window would **never** arm for any strand commit, forever, and buy nothing on
  repair (the floor is already at its `min(2, …)` cap at four). Declare the machines that can hold the
  block, not the machines that exist.
- **Floored at `MIN_CLUSTER_SIZE` (2)**, so the change can only ever *raise* the declared number
  relative to today. A node that authorizes nobody — a genuine founder-alone party, but equally a
  freshly seeded node whose membership rows have not replicated yet, or one whose trusted-owner anchor
  is empty — would otherwise declare 1, and this node cannot tell those cases apart. Declaring 1 is
  safety-neutral for repair (identical to 2 at every peer count, per the table above) but it *would*
  let a solo commit arm the freshness window, which is wrong if the "solo" reading came from stale
  local records. That is left as a separate opportunity, filed as
  `backlog/feat-solo-node-arms-its-own-freshness-window`.

### The cost this accepts, stated plainly

On a party of `N >= 3` machines where fewer than half are awake, a strand commit reaches a downsized
cohort and no longer arms the freshness window; each such block's next read costs one cohort consult
per read-repair window instead of trusting the local commit. That is not a regression to engineer
around — it is the correct reading of the honest number, because a commit that reached two of five
machines genuinely does not rule out a rival quorum. Arming it today is a consequence of
under-declaring. The cost is bounded at one consult per block per window by the read path's
solo-self-skip exit. **Not measured under load** — record it as a `NOTE:` tripwire at the builder in
`cluster-size.ts`, naming the condition (a large mostly-hibernating party whose read path shows up as
slow) rather than filing a ticket.

## Where the count comes from

`CadreNode.listAuthorizedMembers` — the owner-voucher-verified `CadrePeer` rows the wake and
strand-address gates already judge against, self excluded — plus one for this node:

```
enrolledMachines = (authorized CadrePeer rows, self excluded).length + 1
```

A machine enters that set by a signed enrollment and leaves it by a signed removal, so this is a
declaration from authenticated application state, never a network observation. `queryCadrePeers`
already drops rows whose `StampId` is retired in `CadreControl.Revocation`, so a **removed** peer
leaves the count at revocation rather than at reap — the earlier of the two events, which is the one
we want (the over-declare window is zero rather than the reap delay). `CadreNode` already maintains
this set as `authorizedControlPeers`, refreshed by `refreshAuthorizedControlPeers` after every
committed membership write; read it there rather than issuing a second query.

## Interfaces

In `packages/quereus-plugin-sereus/src/cluster-size.ts`, alongside the existing frozen constants
(which stay, as the "count unknown" base):

```ts
/**
 * The repair yardstick to declare for a network, from the machines enrolled in this party and the
 * breadth that network replicates to. See the arithmetic note in this module.
 */
export function resolveRepairYardstick(enrolledMachines: number, replicationBreadth: number): number;

/** CONTROL_CLUSTER_POLICY with the repair yardstick declared; the base object itself when the count is unknown. */
export function controlClusterPolicy(enrolledMachines?: number): NonNullable<NodeOptions['clusterPolicy']>;

/** STRAND_CLUSTER_POLICY with the repair yardstick declared; the base object itself when the count is unknown. */
export function strandClusterPolicy(clusterSize: number, enrolledMachines?: number): NonNullable<NodeOptions['clusterPolicy']>;
```

Rules the builders hold to:

- `enrolledMachines` `undefined`, non-integer, or `< 1` means **unknown** — return the frozen base
  constant *by identity*, so every existing consumer and every identity assertion keeps working and
  the cold path is provably today's behaviour.
- A returned derived object is `Object.freeze`d, spreads the base, and adds only
  `repairCorroborationClusterSize`. `assumedClusterSize` stays 2 and `superMajorityThreshold` stays
  absent — both for the reasons already written on the constants.
- `resolveStrandClusterSize` already rejects a breadth below `MIN_CLUSTER_SIZE`, and
  `CONTROL_REPLICATION_BREADTH` is 16, so the formula's two clamps can never cross.

`StartStrandConfig` and `ResumeStrandOverrides` in `packages/cadre-core/src/strand-instance-manager.ts`
each gain:

```ts
  /**
   * Machines enrolled in this party, for the strand node's repair yardstick. Volatile: re-resolved
   * on every resume beside the cohort seed. Omitted means unknown, which declares nothing.
   */
  enrolledMachines?: number;
```

`ResumeStrandOverrides`' doc comment currently says the discovery seed "is the only one" volatile
input — that sentence is now wrong and must be rewritten, not merely appended to.

## Edge cases & interactions

- **Count unknown / not started.** No control database, or `authorizedControlPeers` never populated:
  pass `undefined`, get the frozen base, get today's behaviour. Assert the identity.
- **Party of one.** `enrolledMachines = 1` floors to 2 — byte-identical policy to today. Assert it.
- **Party larger than the strand breadth.** Eight machines, breadth 4 → declares 4, not 8. Assert it;
  this is the case that would silently break the freshness window if the cap were dropped.
- **Strand configured at `clusterSize: 2`** (`CadreNodeConfig.strandClusterSize`) in a five-machine
  party → declares 2, i.e. the relaxed floor, which is the honest declaration for a cohort of two.
  Assert it, so a future reader does not "fix" the cap.
- **Membership change during a strand's `starting` window.** The build runs on the value it started
  with; the retained launch config is updated on the *next* resume. `resumeStrand` must write the
  resolved count into the retained `launchConfigs` entry exactly as it already does for
  `bootstrapNodes`, or a later resume that passes no overrides silently reverts to the launch-time
  number. Assert the retention.
- **Resume with no overrides.** Must reuse the retained value, not `undefined`.
- **Hibernation check-in cycles** rebuild a strand many times a day. The count read must be a local
  field read, not a fresh `CadrePeer` query and never a network round-trip; `timing('[resumeStrand:%s]')`
  already measures this path.
- **Two members disagreeing** (one has replicated a new row, one has not) is harmless *by construction*
  for repair — the yardstick is per-node and protects only that node's own reads; no node refuses
  another anything over it. Worth one comment, not a mechanism.
- **`compose-strand.ts`** (the plugin's standalone strand path) and the networked e2e harness have no
  membership records at all. They keep passing `STRAND_CLUSTER_POLICY` unchanged. Do not thread a
  count through them.
- **Existing identity assertions** —
  `packages/cadre-core/test/strand-instance-manager-cluster-size.spec.ts:128` and
  `packages/quereus-plugin-sereus/test/plugin.spec.ts:399` assert `clusterPolicy` *is*
  `STRAND_CLUSTER_POLICY`. Under a threaded count the strand manager's assertion must become a
  structural one; the plugin's must stay an identity assertion (its path has no count).

## TODO

- Add `resolveRepairYardstick`, `controlClusterPolicy`, `strandClusterPolicy` to
  `packages/quereus-plugin-sereus/src/cluster-size.ts`; export from that package's `index.ts` and
  re-export from `packages/cadre-core/src/types.ts` alongside the existing constants.
- Record on `CONTROL_CLUSTER_POLICY` / `STRAND_CLUSTER_POLICY` that `assumedClusterSize` is now
  deliberately the **admission** yardstick only, with the availability tradeoff named (a party of
  phones cannot promise `ceil(0.75 x N)` awake machines), so the next reader does not "fix" it to
  match the repair yardstick. Correct the now-stale claim on `DEFAULT_STRAND_CLUSTER_SIZE` that
  "what lifts the floor off a single voter is a third machine, not a wider target" — a *declaration*
  now lifts it too.
- Add the `NOTE:` tripwire for the freshness-window consult cost at the builder.
- Thread `enrolledMachines` through `StartStrandConfig`, `ResumeStrandOverrides`,
  `buildStrandRuntime` (which calls `strandClusterPolicy(resolveStrandClusterSize(config.clusterSize),
  config.enrolledMachines)`), and `resumeStrand`'s retained-config update.
- Add a small private `enrolledMachineCount()` on `CadreNode` returning
  `authorizedControlPeers.size + 1`, or `undefined` before the first refresh; pass it at the strand
  launch site (`cadre-node.ts` around line 4152) and in `resumeStrandRuntime` beside the resolved
  cohort seed.
- Unit tests for `resolveRepairYardstick`: `(1, 16) -> 2`, `(2, 16) -> 2`, `(5, 16) -> 5`,
  `(8, 4) -> 4`, `(5, 2) -> 2`, and non-integer / `0` / negative / `NaN` -> the builders return the
  base by identity.
- Unit tests for the builders: derived object is frozen, keeps `assumedClusterSize: 2`, still has no
  `superMajorityThreshold`, and `controlClusterPolicy(5).repairCorroborationClusterSize === 5`.
- Strand-manager tests: the resolved policy reaches `createLibp2pNode`; an unknown count passes the
  base object by identity; a resume with no overrides reuses the retained count; a resume with a
  larger count updates the retained config.
- Update `docs/architecture.md` -> "Replication cluster size": the two yardsticks (admission vs
  repair), the formula and both clamps, the freshness-window cost, and the fact that a strand picks
  the new number up on its next wake. The section currently claims whole-party breadth "strengthens
  the read repair that remains" by raising `cohortPeerCount` — true only while the cohort view is
  intact, which is the condition the declared yardstick exists not to rely on. Fix that sentence.
- (Already filed by the plan pass: `backlog/feat-solo-node-arms-its-own-freshness-window`.)

- Append one line to `tickets/backlog/debt-read-repair-single-voter-corroboration.md` recording the
  further scope narrowing: a strand in a party of three or more machines now *declares* its way out
  of the relaxed branch, so what remains is a strand explicitly configured at `clusterSize: 2`, an
  honest two-machine party, and other Optimystic embedders. Do not close it.
- Validate: `yarn workspace @serfab/quereus-plugin-sereus test`,
  `yarn workspace @serfab/cadre-core test`, then `yarn lint` and `yarn typecheck` from the root.
