----
description: Fixed a safety check that could make a shared workspace's data permanently unrepairable — workspaces now decline to declare a machine count instead of declaring the wrong one, and the plumbing was renamed so the wrong number is hard to pass again.
files: packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/strand-instance-manager.ts, packages/cadre-core/src/enrolled-machine-store.ts, packages/quereus-plugin-sereus/src/cluster-size.ts, packages/cadre-core/test/cadre-node-strand-yardstick.spec.ts, packages/cadre-core/test/strand-instance-manager-cluster-size.spec.ts, packages/quereus-plugin-sereus/test/plugin.spec.ts, docs/architecture.md, docs/cadre-consistency.md
----

# Review: strand nodes declare no repair yardstick

## What the defect was

Commit `5321d6c` made every strand node declare
`clusterPolicy.repairCorroborationClusterSize` from `CadreNode.enrolledMachineCount()` — the
count of machines enrolled in the **party**. A strand runs only on machines whose embedding
app registered its sApp config (`CadreNode.addStrand`), so a strand shared by two machines of
a three-machine party is served by two. Optimystic's repair corroboration floor
(`corroboratorCapacity` in `db-p2p/src/cluster/quorum-restore.ts`) is
`max(1, min(2, max(visible peers, N - 1)))`: at `N >= 3` it pins at two corroborators, so a
strand that can only field one peer can **never repair a block** — `cluster-fetch:no-quorum`,
surfacing as reads failing with `Missing block`. Over-declaring also makes the commit
freshness window (`CoordinatorRepo.commitQuorumRulesOutRivals`) demand approvals a smaller
serving set cannot supply.

## What landed

**Strand nodes declare nothing.** `launchStrand` and `resumeStrandRuntime` no longer pass a
machine count, so `strandClusterPolicy` returns the frozen `STRAND_CLUSTER_POLICY` itself —
exactly the pre-`5321d6c` behavior, whose exposure is the known, upstream-tracked single-voter
one (`backlog/debt-read-repair-single-voter-corroboration`) and is strictly better than
"cannot repair at all". `CadreNode.enrolledMachineCount()` is deleted; the party count now has
exactly one consumer, the control-network record written by `refreshAuthorizedControlPeers`.

**The plumbing was renamed, not removed.** `StartStrandConfig.enrolledMachines` and
`ResumeStrandOverrides.enrolledMachines` are now `servingMachines`; `resolveRepairYardstick`
and `strandClusterPolicy` take `servingMachines`. `controlClusterPolicy` keeps
`enrolledMachines` — for the control network every enrolled machine runs the node, so the two
quantities are the same set by construction, and the docs now say so. The field docs state
positively that the party count is not this number and must never be passed, and point at
`backlog/feat-strand-yardstick-from-serving-machines` as the feature that will feed it.

**Docs restated.** `docs/architecture.md` → "Replication cluster size": the yardstick is
derived for the control network only; strands declare nothing and keep the single-voter
exposure. `docs/cadre-consistency.md` had one sentence claiming the derivation "re-derives on
every strand rebuild" — corrected (not in the ticket's `files:`, but it was left stating the
removed behavior as fact).

## How to validate

Commands run, all green, foreground, no redirection:

- `yarn workspace @serfab/cadre-core test` — 109 files, 1777 passed, 1 skipped
- `yarn workspace @serfab/quereus-plugin-sereus test` — 9 files, 108 passed, 1 todo
- `yarn lint` — clean
- `yarn workspace @serfab/cadre-core build`, `yarn typecheck` (whole monorepo) — clean

### The new test, and the mutation check behind it

`packages/cadre-core/test/cadre-node-strand-yardstick.spec.ts` is the `CadreNode` arm that had
no coverage and is where the wrong quantity entered. It uses the same fake-strand-manager seam
as `cadre-node-strand-launch-key.spec.ts`, extended with a `resumeStrand` arm, and asserts
**absence** of `servingMachines` on both the launch config and the resume overrides — with the
node's `authorizedControlPeers` snapshot seeded to 3 peers, so the number the old code would
have produced (4) genuinely exists at the moment of the assertion. Each arm checks the value
*and* `'servingMachines' in ...`, so a later `servingMachines: undefined` spread from a
party-derived helper does not pass silently.

Verified this is not a vacuous test: temporarily reintroduced `servingMachines` at both sites
and both arms failed with `expected 4 to be undefined`; the source was restored from a backup
and the full suite re-run green afterwards. `git status` is clean of stray files.

### Behavior a reviewer can check by hand

- A strand launched on a node with a populated membership snapshot must reach
  `createLibp2pNode` with `clusterPolicy === STRAND_CLUSTER_POLICY` (identity, not a
  look-alike). Pinned in `strand-instance-manager-cluster-size.spec.ts` → "passes the frozen
  STRAND_CLUSTER_POLICY BY IDENTITY when no machine count is known", whose comment now says
  this is the production path.
- The control network is untouched: `controlClusterPolicy` still derives from the remembered
  enrolled-machine count. `cadre-node-control-node-options.spec.ts` and
  `enrolled-machine-store.spec.ts` cover that and still pass.
- The `servingMachines` threading still works end to end (retention across
  quiesce/resume, the breadth cap, the `MIN_CLUSTER_SIZE` floor) — those tests were kept and
  renamed, because `feat-strand-yardstick-from-serving-machines` depends on the seam being
  live. Their comments now say they are plumbing coverage, not a production path.

## Known gaps — read these before signing off

- **No integration-level proof.** The claim "a strand node now declares nothing" is pinned at
  two unit seams (what `CadreNode` hands the manager, and what the manager hands
  `createLibp2pNode`) with a mocked `createLibp2pNode`. Nothing exercises a real strand mesh
  and observes the resulting corroboration behavior. The original failure mode
  (`cluster-fetch:no-quorum` on a two-machine strand of a three-machine party) was established
  statically at fix stage and was **never reproduced live**, so the fix is likewise not
  live-verified. `packages/integration-tests` has a `control-divergent-repair-yardstick`
  scenario for the control side; there is no strand analogue and this ticket did not add one.
- **The absence assertions are structural, not semantic.** They pin that no count is passed.
  They do not pin *why* — nothing fails if someone later adds a differently-named field that
  reaches `strandClusterPolicy`. The rename plus the field docs are the guard there, and a
  rename is weaker than a type.
- **Nothing prevents an embedder from passing `servingMachines` itself.** It is a public field
  on `StartStrandConfig`, and an embedder driving `StrandInstanceManager` directly could pass
  the party count into it. The docs forbid it; no type or runtime check enforces it. Whether
  that deserves a guard is a fair review question — the field exists precisely so a future
  feature can fill it, so it cannot simply be made private.
- **`resumeStrandRuntime`'s test reaches it by cast.** `Object.keys(overrides)` is asserted to
  be exactly `['bootstrapNodes']`, which is a tight assertion that will need updating (not
  relaxing) when the backlog feature adds the count back. That is intentional, but it means
  the test is coupled to the override object's exact shape.
- **Doc edit outside the ticket's file list.** `docs/cadre-consistency.md` was touched for one
  sentence that had become false. Flagging it explicitly rather than burying it.
- **`STRAND_CLUSTER_POLICY`'s `assumedClusterSize` now carries both jobs on the strand path**
  (admission gate *and* repair floor, since nothing is declared). The comment there was
  rewritten to say so. Worth a second reading — it is the subtlest consequence of the change
  and the easiest thing for a future editor to "fix" wrongly by raising the 2.

## Review findings

_(reviewer fills in)_
