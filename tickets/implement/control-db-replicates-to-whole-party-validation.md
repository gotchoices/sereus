description: The shared party database was changed to copy every piece of data to every machine in the party instead of only two. The change is written but not yet proven to work, and two documents still describe the old behavior.
files: packages/quereus-plugin-sereus/src/cluster-size.ts, packages/quereus-plugin-sereus/README.md, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/types.ts, packages/integration-tests/src/harness/test-party.ts, packages/integration-tests/src/scenarios/push-wake-e2e.integration.ts, docs/cadre-consistency.md, docs/architecture.md
difficulty: medium
----

# Finish `control-db-replicates-to-whole-party`: validate + remaining docs

Continuation of `implement/control-db-replicates-to-whole-party`, which hit the runner's soft
token budget after the code change landed but before validation and two of the three doc
updates. **The code work is done and in the working tree (uncommitted at the time of writing).**
This ticket is the unfinished tail: build, test, two docs, and one optional test guard.

## What already landed

Shape **(a)** from the original ticket — a generous constant on the control path, with the strand
path's sizing kept separate.

`packages/quereus-plugin-sereus/src/cluster-size.ts` was rewritten. `DEFAULT_CLUSTER_SIZE` and
`resolveClusterSize` are **gone**, replaced by four exports:

| Export | Value | Meaning |
|---|---|---|
| `MIN_CLUSTER_SIZE` | 2 | Optimystic's `minAbsoluteClusterSize`; validation floor only, not a default |
| `CONTROL_REPLICATION_BREADTH` | 16 | Fixed breadth for the control (membership) database. Not configurable |
| `DEFAULT_STRAND_CLUSTER_SIZE` | 2 | Default for a strand network (unchanged behavior) |
| `resolveStrandClusterSize(configured?)` | — | Strand-only resolver; applies the default, rejects non-integers and values `< MIN_CLUSTER_SIZE` |

Call-site changes:

- `packages/cadre-core/src/cadre-node.ts` — control node now passes `clusterSize: CONTROL_REPLICATION_BREADTH`
  (no resolver call, no config read). Strand start-up forwards `this.config.strandClusterSize`.
- `packages/cadre-core/src/types.ts` — `CadreNodeConfig.clusterSize` **renamed** to
  `strandClusterSize` and re-documented as strand-only. Re-exports updated.
- `packages/cadre-core/src/strand-instance-manager.ts` — `resolveStrandClusterSize`; doc comment
  points at the new config field.
- `packages/quereus-plugin-sereus/src/compose-strand.ts`, `index.ts`, `types.ts` — renamed resolver
  and export list.
- `packages/integration-tests/src/harness/test-party.ts` — the harness builds **control**-network
  nodes (`networkName = control-<partyId>`), so it now uses `CONTROL_REPLICATION_BREADTH`.
- Specs updated for the renames: `packages/cadre-core/test/strand-instance-manager-cluster-size.spec.ts`,
  `packages/quereus-plugin-sereus/test/plugin.spec.ts` (plus a new `CONTROL_REPLICATION_BREADTH`
  describe block asserting it exceeds the documented 7-node maximum party), and
  `packages/quereus-plugin-sereus/test/e2e/networked.e2e.spec.ts`.
- `docs/architecture.md` § "Replication cluster size" rewritten for the two-constant split.

### Why 16

Optimystic caps a cohort at the peers that actually serve the network
(`Libp2pKeyPeerNetwork.findCluster` keeps `min(serving peers, clusterSize - 1)` non-self members)
and downsizes what it cannot fill (`allowDownsize: true`, already passed). So **any** value at or
above the party's node count behaves identically — cohort = whole party. 16 is ~2x the largest
deployment `docs/architecture.md` documents ("Enterprise (Multi-Node Mixed)": phone + laptop + 3
cloud + 2 NAS = 7 nodes). The original ticket measured 8 green; 16 is behaviorally identical for
any party below 8 nodes, since the cohort is bounded by real serving peers, not by the constant.

### Decision recorded: do NOT set `clusterPolicy.assumedClusterSize`

The original ticket asked for this decision either way. **Leave it at Optimystic's default of 2.**

`assumedClusterSize` means "the smallest cohort this deployment can genuinely field", and the
membership admission gate runs it through `admissionFloor` on its low-confidence path
(`../optimystic/packages/db-p2p/src/cluster/cluster-repo.ts`). Asserting 16 there would demand
`ceil(0.75 x 16) = 12` declared peers and refuse every real party's writes. A Cadre party
legitimately runs one or two nodes, so 2 is the honest assertion. This is also why raising
`clusterSize` to 16 does **not** reintroduce `MEMBERSHIP_NOT_ADMITTED` — the gate never measures
against `clusterSize`. Reasoning is recorded in the `CONTROL_REPLICATION_BREADTH` doc comment.

## What is left

### Build + validate (the bulk of this ticket)

Nothing has been built or run since the edits. `resolveClusterSize` no longer exists, so any
consumer still importing it is a compile error — TypeScript diagnostics during the edit session
were reading stale `dist/` output from the sibling packages, so treat a clean editor as no
evidence.

Do not weaken `packages/integration-tests/src/harness/build-freshness.ts`. Rebuild
`@quereus/quereus`, `@optimystic/db-core`, `@optimystic/db-p2p`, `@serfab/quereus-plugin-sereus`,
`@serfab/cadre-core`, `@serfab/cadre-host` before running anything in `integration-tests`.

- [ ] Rebuild the packages above; `yarn lint`; typecheck.
- [ ] `packages/cadre-core` and `packages/quereus-plugin-sereus` unit suites.
- [ ] From `packages/integration-tests`, the target scenario **20 consecutive runs**, streaming
      output (`... 2>&1 | tee <log>`, never silent redirection):
      `npx vitest run src/scenarios/push-wake-e2e.integration.ts -t 'learned by control-DB replication'`
      Baseline to beat: 4 failures in 10 at the old breadth of 2.
- [ ] Full `packages/integration-tests` suite — the change alters cohort breadth for **every**
      scenario, not only this one, so whole-package coverage is the real acceptance gate.
- [ ] Record both numbers in the review handoff.

If the 20-run loop is not green, the fallback is shape **(b)** from the original ticket (track the
party's live member count), which needs an Optimystic change to accept
`clusterSize: number | (() => number)` on `Libp2pKeyPeerNetwork`.

### Docs still describing the old behavior

- [ ] `docs/cadre-consistency.md` — state the control database's replication rule (every member
      holds every control block) and why it differs from strand data. Note this file is currently
      a *design exploration* doc for a not-yet-implemented consistency model; the replication rule
      is shipped fact, so keep the two clearly separated rather than folding it into the
      speculative sections.
- [ ] `packages/quereus-plugin-sereus/README.md` around line 282 — the `clusterSize` row's default
      of 2 is still correct (it is the strand option), but its justification is wrong: it claims a
      peer "configured higher than the cohort it is shown refuses to vote and the write fails."
      The admission gate keys on `assumedClusterSize`, not `clusterSize`. Rewrite to match the
      corrected explanation now in `cluster-size.ts` and `docs/architecture.md`.

### Optional test guard

- [ ] Nothing asserts that `CadreNode`'s **control** node receives `CONTROL_REPLICATION_BREADTH` —
      today only the shared constant reference keeps `cadre-node.ts` and `test-party.ts` aligned,
      and `createControlNode` is private. `packages/cadre-core/test/cadre-node-control-replication.spec.ts`
      already stubs the control node, so there may be a cheap seam. Skip if it needs contrived
      plumbing; the constant is referenced directly at both call sites, which is most of the value.

## Observations worth carrying into the review handoff

Not defects, and not work — record them where noted, then index them in `## Review findings`:

- **Harness/production super-majority mismatch.** `test-party.ts` passes
  `clusterPolicy.superMajorityThreshold: 0.51` while `CadreNode` leaves Optimystic's default of
  0.75. The harness is therefore more permissive than production about how many cohort members
  must approve a write, so a commit-availability regression can pass the harness and fail in a
  real party. Pre-existing, unrelated to this change.
- **Broader cohorts trade write availability for convergence.** With cohort = whole party, a
  super-majority now counts every reachable member instead of two, so a flaky member can fail a
  commit where a two-member cohort would have ignored it. Deliberate — the control database has to
  converge — but it is the cost side of this change and worth one line in the handoff.
- **`membershipOverfetch()` scales with the constant.** It returns
  `max(clusterSize * 4, clusterSize + 16)`, so 16 asks FRET for a 64-peer proximity band and does
  a peerStore protocol lookup per candidate. Bounded by peers FRET actually knows (2 in a 3-node
  party), so free today. Tripwire, not work: if control-network cohort selection ever shows up as
  slow on a large mesh, this is the first place to look.

## Not in scope

Unchanged from the original ticket: Optimystic's single-voter corroboration at two-member cohorts
(`backlog/debt-read-repair-single-voter-corroboration`), the strand path's own breadth question
(`backlog/debt-strand-replication-breadth-ignores-party-count`), and the commit sweep's
non-atomicity across trees.
