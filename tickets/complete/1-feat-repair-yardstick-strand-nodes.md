----
description: A safety check that decides whether one machine's word can be trusted about a piece of shared data used to be stuck at the two-machine setting no matter how many machines were enrolled; it now uses a real count, and each shared workspace picks it up every time it wakes from sleep. Review found the count used for workspaces is the wrong one and filed a fix.
files: packages/quereus-plugin-sereus/src/cluster-size.ts, packages/quereus-plugin-sereus/src/index.ts, packages/quereus-plugin-sereus/test/plugin.spec.ts, packages/cadre-core/src/types.ts, packages/cadre-core/src/strand-instance-manager.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/test/strand-instance-manager-cluster-size.spec.ts, docs/architecture.md, docs/cadre-consistency.md, tickets/fix/bug-strand-yardstick-counts-party-machines.md
----

# Repair yardstick declared from enrolled machines, applied to strand networks

## What landed

Optimystic trusts a block-repair answer only when enough independent cohort peers agree, and
"enough" is measured against a **declared** number rather than the peers currently visible —
the visible set comes from unauthenticated routing, so a partition (or routing influence) can
shrink it. Cadre pinned that declared number at 2 everywhere, which relaxed the corroboration
floor to a single voter for *any* party size whenever routing showed a node one peer.

Cadre now derives the number and hands it to every strand libp2p node. The control network is
deliberately not done here — that is `implement/2-feat-repair-yardstick-control-node`.

- `packages/quereus-plugin-sereus/src/cluster-size.ts` — `resolveRepairYardstick(machines, breadth)`
  = `max(2, min(machines, breadth))`, plus `controlClusterPolicy()` / `strandClusterPolicy()`
  builders that return their frozen base constant *by identity* when the count is unknown and a
  frozen spread carrying `repairCorroborationClusterSize` when it is known. `assumedClusterSize`
  stays 2 and `superMajorityThreshold` stays absent in both branches. A count that is not a
  positive integer is treated as unknown, not clamped — Optimystic itself falls through a
  degenerate declaration.
- `packages/cadre-core` — `StartStrandConfig.enrolledMachines` and
  `ResumeStrandOverrides.enrolledMachines`; `buildStrandRuntime` binds the resolved breadth once
  and passes `strandClusterPolicy(breadth, config.enrolledMachines)`; `resumeStrand` writes the
  resolved count back into the retained launch config beside `bootstrapNodes`, so a later
  no-override wake does not revert to the launch-time value. `CadreNode.enrolledMachineCount()`
  (a field read of the already-materialized `authorizedControlPeers` snapshot, `+ 1` for self,
  `undefined` when empty) feeds both `launchStrand` and `resumeStrandRuntime`.
- Docs — `docs/architecture.md` → "Replication cluster size" gained a "Two yardsticks, not one"
  bullet, and two stale claims about breadth strengthening read repair were rewritten.

## Validation

From the repo root, after the review's edits:

- `yarn lint` — exit 0.
- `yarn typecheck` — clean.
- `yarn workspace @serfab/quereus-plugin-sereus test` — 9 files, 108 passed, 1 todo.
- `yarn workspace @serfab/cadre-core test` — 107 files, 1723 passed, 1 skipped.

Editing `cluster-size.ts` (comments only) makes the plugin's `dist` stale and the cadre-core
suite's build-freshness guard refuses to run; `yarn workspace @serfab/quereus-plugin-sereus build`
clears it. Same guard fires against the linked `@optimystic/db-p2p` workspace in
`C:\projects\optimystic` if that one is stale — also a build, not a defect here.

## Review findings

### Major — filed

- **The strand yardstick counts party machines, not the machines that joined that strand.**
  `enrolledMachineCount()` is the party's authorized `CadrePeer` rows plus self, and a strand
  launches only on machines whose embedder registered its sApp config (`addStrand`;
  `handleStrandAdded` emits `strand:discovered` and returns otherwise — the RN reference app
  auto-joins only *open* strands). So the count is an upper bound for a strand, and
  over-declaring is unsafe in the availability direction, not merely wasteful: with `N >= 3`
  declared the corroboration floor pins at two peers, so a strand actually served by two
  machines (one visible peer) can never meet it and the block becomes unrepairable
  (`cluster-fetch:no-quorum`, surfacing as `Missing block`) where a declaration of 2 previously
  converged. A three-machine party with a two-machine closed strand is an ordinary
  configuration. Derived from the code and the upstream arithmetic, not observed on a running
  party. Filed as `fix/bug-strand-yardstick-counts-party-machines` (the ticket also carries the
  missing-coverage arm below, and states that the control network is unaffected so
  `2-feat-repair-yardstick-control-node` is not blocked by it). Comments at both entry points —
  `resolveRepairYardstick`'s docblock and `CadreNode.enrolledMachineCount()` — now say the
  quantity is only an upper bound for a strand and name the ticket.

### Minor — fixed in this pass

- `packages/quereus-plugin-sereus/src/cluster-size.ts`: the breadth-cap rationale claimed the
  formula declares "the machines that can hold the block" when its input is the party count.
  Corrected, with the precondition that both arguments must be positive integers (a degenerate
  value propagates as `NaN` rather than being clamped — the builders sanitize, direct callers
  of the public export do not).
- `docs/architecture.md`: the `assumedClusterSize` bullet still described that field as the
  read-repair corroboration floor's declaration; it is now that floor's *last* fallback, behind
  `repairCorroborationClusterSize`. Rewritten. The "a declaration lifts the floor too" and
  "the count comes from …" passages now also state the too-high trap and the strand upper-bound
  gap.
- `docs/cadre-consistency.md`: same stale claim ("feeds both the admission gate and the
  read-repair corroboration floor"), plus it implied nothing about cluster sizing tracks a
  growing party — the repair yardstick now does, by rebuild. Rewritten with a pointer to
  `architecture.md`.

### Verified, no change needed

- **The arithmetic.** Re-derived against the upstream source rather than the handoff:
  `corroboratorCapacity = max(p, N - 1)` and `quorumSize`'s floor `max(1, min(2, capacity))`
  (`db-p2p/src/cluster/quorum-restore.ts`) confirm `N = 1` and `N = 2` are identical at every
  `p`, `N >= 3` pins the floor at 2, and `N > 3` buys nothing. The freshness-window cost is real
  and as described: `commitQuorumRulesOutRivals` is `approvals > max(observed cohort, N) / 2`
  (`db-p2p/src/repo/coordinator-repo.ts:1111`).
- **Both directions of the breadth cap.** `strandClusterPolicy(4, 8)` → 4 and
  `strandClusterPolicy(2, 5)` → 2, both asserted. The cap at breadth keeps the freshness window
  satisfiable: at breadth 4 the super-majority is 3 and `approvals > 4/2` needs 3.
- **`undefined` for an empty peer snapshot.** `resolveRepairYardstick(1, …)` is 2 and declaring
  2 resolves identically to declaring nothing, so the two answers differ only at the freshness
  window, where `undefined` is the conservative one. Correct as written.
- **The resume retention path.** `overrides?.enrolledMachines ?? launchConfig.enrolledMachines`
  with the result written back into `launchConfigs`; both the retain and the refresh-then-retain
  cases are asserted.
- **`authorizedControlPeers` never contains self** (`listAuthorizedMembers` filters it), so the
  `+ 1` cannot double-count.
- **The relaxed policy assertion** in `strand-instance-manager-cluster-size.spec.ts` (identity →
  `expect.objectContaining({ ...STRAND_CLUSTER_POLICY })`) is sound: the unknown-count path's
  identity is pinned by a separate test immediately below it, and the derived path is pinned by
  a whole-object equality against `strandClusterPolicy(...)`, which would catch an added key.
- **`compose-strand.ts` and the plugin's networked e2e mesh** left on the bare
  `STRAND_CLUSTER_POLICY` — correct, neither has membership records to derive from.
- **`controlClusterPolicy` has no production caller.** Deliberate: it is
  `implement/2-feat-repair-yardstick-control-node`'s to wire, it is exported and unit-tested, and
  that ticket is open on the board. No action.

### Tripwires (recorded, not filed)

- The freshness-window cost on a large, mostly-hibernating party is a `NOTE:` at
  `resolveRepairYardstick` in `cluster-size.ts`, naming the condition to watch. Left as the
  implementer parked it — still unmeasured, still conditional.

### Not re-filed

- `cadre-node.ts` is 5772 lines. `backlog/debt-cadre-node-single-file-size` already owns this;
  the change adds 9 lines.
- The single-voter acceptance a two-machine cohort still takes is upstream and already owned by
  `backlog/debt-read-repair-single-voter-corroboration`.

### Gaps left open deliberately

- **No integration or e2e coverage anywhere in this change.** Every assertion is unit-level
  against a mocked `createLibp2pNode`, so what is pinned is "the right object reaches the
  constructor", never "repair behaves differently on a real mesh". Whether a three-machine party
  actually refuses a lone stale corroborator now is unverified end to end. Not filed separately
  because the filed fix ticket will change what the right object *is*; its coverage arm asks for
  the property test rather than more plumbing assertions.
- **A party that shrinks to zero authorized peers keeps its old declaration** (empty snapshot →
  `undefined` → `resumeStrand`'s `??` keeps the retained larger count). Unasserted. Same
  over-declaration direction as the filed finding and subsumed by it.
- **`refreshAuthorizedControlPeers` failure semantics are inherited**: a failed refresh keeps the
  previous snapshot, so a stale count can outlive a membership change until the next timed
  reconcile or membership write. Bounded staleness, not newly introduced here.
