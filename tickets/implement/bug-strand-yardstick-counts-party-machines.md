----
description: A safety check that decides whether a machine can trust a repair answer for a shared file currently counts every machine in the group, including ones that never joined that workspace, which can make a stale copy permanently unrepairable. Fix by having workspaces stop declaring a count at all (restoring the previous safe behavior) and renaming the plumbing so the wrong count is hard to pass again.
files: packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/strand-instance-manager.ts, packages/quereus-plugin-sereus/src/cluster-size.ts, packages/cadre-core/test/strand-instance-manager-cluster-size.spec.ts, packages/quereus-plugin-sereus/test/plugin.spec.ts, docs/architecture.md
repro: static
----

# Strand repair yardstick: stop declaring the party count; rename so it can't recur

## The defect (established at fix stage)

`feat-repair-yardstick-strand-nodes` (commit `5321d6c`) made every strand node declare
`clusterPolicy.repairCorroborationClusterSize` from `CadreNode.enrolledMachineCount()` — the
count of machines enrolled in the **party**. But a strand runs only on machines whose
embedding app registered its sApp config (`CadreNode.addStrand`); a closed strand shared by
two machines of a three-machine party is served by two. Optimystic's repair floor
(`corroboratorCapacity` in `db-p2p/src/cluster/quorum-restore.ts`) is
`max(1, min(2, max(visible peers, N - 1)))`: declaring `N >= 3` pins it at two corroborators,
so a strand that can only ever field one peer can **never repair a block**
(`cluster-fetch:no-quorum`, surfacing as reads failing with `Missing block`). Over-declaring
also makes the commit freshness window (`CoordinatorRepo.commitQuorumRulesOutRivals`) demand
approvals a smaller serving set cannot supply.

The wrong number enters at exactly two sites, both in `packages/cadre-core/src/cadre-node.ts`:

- `launchStrand` (~line 4334): `enrolledMachines: this.enrolledMachineCount()`
- `resumeStrandRuntime` (~line 3833): same field in the resume overrides

Everything below those sites is correct *given the right number*: `StrandInstanceManager`
threads and retains the count properly, and `strandClusterPolicy` /
`resolveRepairYardstick` (`packages/quereus-plugin-sereus/src/cluster-size.ts`) clamp it
properly. The defect is purely the **quantity the caller feeds in**.

## Chosen correction (researched; the alternatives are parked in backlog)

No authenticated per-strand serving-machine count exists anywhere in the system today:

- The strand database's `MemberPeer` table (`schemas/strand.qsql`) is exactly the right
  record — machine-level, member-signed — but the `registerMemberPeer` writer has **no
  production caller** (only tests and integration scenarios write it), and open strands
  (`Type = 'o'`) cannot carry it at all (`OnlyClosed` constraints).
- A participation record on the control database means a new signed, authorization-gated
  table in `schemas/control.qsql` — design work, not a fix.
- A high-water mark of observed serving machines cannot come DOWN, and over-declaring is the
  unsafe direction — that shape is rejected, it recreates this bug after a machine leaves.

So: **strand nodes stop declaring a repair yardstick entirely** until a genuine per-strand
serving count exists (`backlog/feat-strand-yardstick-from-serving-machines`, filed alongside
this ticket). Handed no count, `strandClusterPolicy` already returns the frozen
`STRAND_CLUSTER_POLICY` itself — the exact pre-`5321d6c` behavior, whose exposure is the
known, upstream-tracked single-voter one (`backlog/debt-read-repair-single-voter-corroboration`),
strictly better than "cannot repair at all". The CONTROL network's derivation
(`controlClusterPolicy` + `enrolled-machine-store.ts`) is untouched and correct: every
enrolled machine runs the control node by construction, so there the party count IS the
serving count.

Keep the strand-side plumbing (manager retention, builder, clamps) — it is tested, correct,
and is the seam the backlog feature will feed — but **rename it so the type states the
required quantity**: the value is "machines serving THIS strand", never the party count.

## TODO

- In `packages/cadre-core/src/cadre-node.ts`:
  - `launchStrand`: stop passing `enrolledMachines` into `startStrand`.
  - `resumeStrandRuntime`: stop passing `enrolledMachines` in the resume overrides.
  - Delete `enrolledMachineCount()` — after the two sites above it has zero callers
    (the control path records via `enrolledMachineStore.record(...)` directly in
    `refreshAuthorizedControlPeers`). Fold anything still worth keeping from its doc
    comment (the "exact for control, upper bound for a strand" distinction) into the
    record-site comment in `refreshAuthorizedControlPeers` or the new field docs.
- In `packages/cadre-core/src/strand-instance-manager.ts`: rename
  `StartStrandConfig.enrolledMachines` and `ResumeStrandOverrides.enrolledMachines` to
  `servingMachines`; rewrite the field docs to say: machines serving THIS strand, an
  authenticated per-strand count — the party's enrolled-machine count is NOT this number
  and must never be passed (cite this ticket's slug for why). Note that no production
  source exists yet and the field is fed by nothing until
  `feat-strand-yardstick-from-serving-machines` lands.
- In `packages/quereus-plugin-sereus/src/cluster-size.ts`:
  - Rename `resolveRepairYardstick`'s first parameter and `strandClusterPolicy`'s second
    parameter to `servingMachines`; doc them as "machines that serve this network".
    `controlClusterPolicy`'s parameter may keep its name (for the control network,
    enrolled = serving by construction — say so).
  - Update the long doc comments: drop the "today one caller does not" defect paragraph and
    the `fix/bug-strand-yardstick-counts-party-machines` references; state the contract
    positively (callers pass a serving count or nothing) and point the strand gap at
    `backlog/feat-strand-yardstick-from-serving-machines`.
- Update `docs/architecture.md` → "Replication cluster size": the "Two yardsticks" bullet and
  the ones citing the fix slug (~lines 71, 76, 82, 90) currently say the yardstick is derived
  for both networks with a known strand-side over-declaration. Restate: derived for the
  control network only; strand nodes declare nothing until a per-strand serving count exists
  (point at the backlog feature); a strand therefore keeps the single-voter exposure rather
  than the no-repair failure.
- Tests:
  - `packages/cadre-core/test/strand-instance-manager-cluster-size.spec.ts`: rename the
    field in the existing plumbing tests (they stay valid — they pin retention/threading of
    whatever count is handed in, which the future feature relies on). The
    identity-of-frozen-policy test is now the production path — say so in its comment.
  - `packages/quereus-plugin-sereus/test/plugin.spec.ts`: parameter renames only; behavior
    assertions unchanged.
  - NEW — the `CadreNode` arm, which has no test today and is where the wrong quantity
    entered: pin that the config `launchStrand` hands to `StrandInstanceManager.startStrand`
    (and the overrides `resumeStrandRuntime` passes) carry **no** `servingMachines`, even
    when the node's authorized-peer snapshot is non-empty. Suggested seam: spy on
    `StrandInstanceManager.prototype.startStrand` / `.resumeStrand`, or mock the module as
    the manager specs do — whichever lets a `CadreNode` unit test reach `launchStrand`
    without a real network. If standing up `CadreNode` far enough proves disproportionate,
    an integration-free compromise is acceptable, but document what was and wasn't pinned in
    the review handoff.
- Run `yarn workspace @serfab/cadre-core test`, `yarn workspace @serfab/quereus-plugin-sereus test`,
  `yarn lint`, and the type check; foreground, no output redirection.
