description: A safety check that decides whether one machine's word can be trusted about a piece of shared data used to be stuck at the two-machine setting no matter how many machines were enrolled; it now uses the real number, and each shared workspace picks it up every time it wakes from sleep.
files: packages/quereus-plugin-sereus/src/cluster-size.ts, packages/quereus-plugin-sereus/src/index.ts, packages/quereus-plugin-sereus/test/plugin.spec.ts, packages/cadre-core/src/types.ts, packages/cadre-core/src/strand-instance-manager.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/test/strand-instance-manager-cluster-size.spec.ts, docs/architecture.md, tickets/backlog/debt-read-repair-single-voter-corroboration.md
difficulty: medium
----

# Review: repair yardstick declared from enrolled machines, applied to strand networks

## What landed

Optimystic decides whether to believe a block-repair answer by counting how many independent cohort
peers agree, measured against a **declared** number rather than the peers currently visible — the
visible set comes from unauthenticated routing, so a partition (or routing influence) can shrink it.
Cadre pinned that declared number at 2 everywhere, which meant the floor relaxed to a single voter
for *any* party size whenever routing showed a node one peer.

Cadre now derives it from the party's own membership and hands it to every strand libp2p node.
The control network is deliberately **not** done here — it is `implement/2-feat-repair-yardstick-control-node`.

**`packages/quereus-plugin-sereus/src/cluster-size.ts`** — three new exports plus one private helper:

- `resolveRepairYardstick(enrolledMachines, replicationBreadth)` = `max(2, min(machines, breadth))`.
- `controlClusterPolicy(enrolledMachines?)` / `strandClusterPolicy(clusterSize, enrolledMachines?)` —
  each returns its frozen base constant **by identity** when the count is unknown, otherwise a frozen
  spread of the base plus `repairCorroborationClusterSize`. `assumedClusterSize` stays 2 and
  `superMajorityThreshold` stays absent in both branches.
- `asKnownMachineCount` (private): anything not a positive integer is *unknown*, not clamped —
  Optimystic itself falls through a degenerate declaration rather than rounding it.

**`packages/cadre-core`** — `StartStrandConfig.enrolledMachines` and
`ResumeStrandOverrides.enrolledMachines` added; `buildStrandRuntime` binds
`strandClusterSize = resolveStrandClusterSize(config.clusterSize)` once and passes
`strandClusterPolicy(strandClusterSize, config.enrolledMachines)`; `resumeStrand` writes the resolved
count back into the retained launch config alongside `bootstrapNodes`. `CadreNode` grew a private
`enrolledMachineCount()` (a field read of the already-materialized `authorizedControlPeers` snapshot,
`+ 1` for self, `undefined` when empty) wired into both strand sites — `launchStrand` and
`resumeStrandRuntime`.

**Docs** — `docs/architecture.md` → "Replication cluster size" gained a "Two yardsticks, not one"
bullet (admission vs repair, the formula, both clamps, where the count comes from, the freshness-window
cost, and the by-rebuild application), and two stale claims were rewritten: the one saying whole-party
breadth "strengthens the read repair that remains" (true only while the cohort *view* is intact —
the exact condition the declaration exists not to rely on) and the "a third machine, not a wider
target" claim on `DEFAULT_STRAND_CLUSTER_SIZE` (a declaration lifts it too now).

## Validation run

All green, from the repo root:

- `yarn workspace @serfab/quereus-plugin-sereus test` — 9 files, 108 passed, 1 todo.
- `yarn workspace @serfab/cadre-core test` — 107 files, 1723 passed, 1 skipped.
- `yarn typecheck` — clean.
- `yarn lint` — clean (exit 0).

One prerequisite worth knowing: the stale-build guard failed the first plugin run with
`@optimystic/db-p2p: dist is stale`. Fixed by running `yarn workspace @optimystic/db-p2p build` in
`C:\projects\optimystic` — a linked reference workspace, nothing in this repo. No source there was
touched. If a reviewer hits the same guard, that is the fix, not a defect in this change.

## What to check — the arithmetic is the whole ticket

The reasoning that justifies the formula is worth re-deriving rather than trusting. With `p` = cohort
peers currently visible (self excluded) and Optimystic's `CORROBORATION_FLOOR` = 2, the floor is
`max(1, min(2, max(p, N - 1)))`:

- `N = 1` and `N = 2` are **identical at every `p`** — both leave the floor at one voter when `p <= 1`.
  That equivalence is what makes the `MIN_CLUSTER_SIZE` floor safety-neutral for repair.
- `N >= 3` pins the floor at 2 unconditionally. This is the entire fix.
- `N > 3` raises nothing — the `min(2, …)` caps it.

And the cost, which is *not* free: `repairCorroborationClusterSize` also feeds
`CoordinatorRepo.commitQuorumRulesOutRivals`, where `fullCohortSize = max(observed cohort, N)` and a
local commit arms the lazy read-repair window only when `approvals > fullCohortSize / 2`. A larger
declaration therefore stops arming that window on a party where fewer than half the machines are
awake. Both clamps exist because of this consumer, not because of the repair floor.

Reviewer questions worth answering independently:

- **Does the breadth cap hold in both directions?** `strandClusterPolicy(4, 8)` must give 4, and
  `strandClusterPolicy(2, 5)` must give 2. Dropping the cap silently breaks the freshness window
  forever for any party larger than its strand breadth; "fixing" the second case to 5 re-declares a
  cohort that does not exist.
- **Is `undefined` really the right answer for an empty peer snapshot?** `enrolledMachineCount()`
  returns `undefined`, not 1. The argument in its comment is that empty is indistinguishable between
  a founder alone, a freshly seeded node whose rows have not replicated, and an empty trusted-owner
  anchor — and that `undefined` and `1` are equivalent for repair anyway. Check the second half:
  `resolveRepairYardstick(1, …)` is 2, and declaring 2 resolves identically to declaring nothing.
- **Does the resume path really retain?** `resumeStrand` uses
  `overrides?.enrolledMachines ?? launchConfig.enrolledMachines`. A `??` that leaked to `undefined`
  would let a later no-override wake silently revert to the launch-time number, reopening the relaxed
  floor with nothing failing. Two tests cover this; a third case is *not* covered — see gaps.

## Known gaps — treat the tests as a floor

- **No integration or e2e coverage.** Everything is unit-level against a mocked `createLibp2pNode`,
  so what is pinned is "the right object reaches the constructor", never "repair behaves differently
  on a real mesh". Whether a three-machine party actually refuses a lone stale corroborator now is
  **unverified end to end**. The existing `integration-tests` scenarios build their own nodes and were
  not touched.
- **The freshness-window cost is unmeasured.** The claim that it costs one cohort consult per block
  per read-repair window is read off the upstream code path, not observed under load. Parked as a
  `NOTE:` tripwire in `cluster-size.ts` (at `resolveRepairYardstick`) naming the condition — a large,
  mostly-hibernating party whose read path shows up as slow — rather than filed as a ticket.
- **A party that shrinks to zero authorized peers keeps its old declaration.** `enrolledMachineCount()`
  returns `undefined` for an empty snapshot, and `resumeStrand`'s `??` then keeps the retained
  (larger) count. It is the safe direction (over-declaring only costs the freshness window) and it is
  the same behaviour as a transient snapshot-refresh failure, which is why it was left alone — but it
  is not asserted by any test and a reviewer may reasonably want it pinned or reconsidered.
- **`refreshAuthorizedControlPeers` failure semantics are inherited, not re-examined.** A failed
  refresh keeps the previous snapshot, so a stale count can outlive a membership change until the next
  timed reconcile (15s) or membership write. Bounded staleness, same as the stream gate already
  accepts; not newly introduced here.
- **The `enrolledMachineCount()` cost claim is a code read.** It is a `Set.size` field read on a path
  `timing('[resumeStrand:%s]')` already measures, but no measurement was taken before/after.
- **`compose-strand.ts` and the plugin's networked e2e mesh were deliberately left on the bare
  `STRAND_CLUSTER_POLICY`** — neither has membership records. The plugin spec's identity assertion at
  `plugin.spec.ts` stays an identity assertion for that reason.
- **The cadre-core strand-manager's policy assertion was relaxed from identity to structural**
  (`expect.objectContaining({ ...STRAND_CLUSTER_POLICY })`), because a config carrying a count yields a
  derived object. The identity of the unknown-count path is pinned by a separate new test immediately
  below it, so nothing was lost — but this is exactly the kind of assertion weakening worth a second
  look.
- **Ticket 2 (`implement/2-feat-repair-yardstick-control-node`) is untouched and still needed.**
  `cadre-node.ts:1311` still passes the bare `CONTROL_CLUSTER_POLICY`; `controlClusterPolicy` ships
  here with unit tests but **no production caller**. That is by design (the control node's cold-start
  problem is that ticket's whole subject), but a reviewer should confirm the builder is not dead code
  in a way that outlives ticket 2.
