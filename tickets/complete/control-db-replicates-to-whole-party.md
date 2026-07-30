----
description: The shared settings and membership database now copies every block to every machine in the party instead of just two, so a machine that missed an update can no longer be stuck out of date forever. Reviewed and shipped.
files: packages/quereus-plugin-sereus/src/cluster-size.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/types.ts, packages/cadre-core/test/cadre-node-control-replication.spec.ts, packages/integration-tests/src/harness/test-party.ts, docs/architecture.md, docs/cadre-consistency.md
----

# Control database replicates to the whole party

## What shipped

The control (cadre membership / settings) database used to replicate each block to two nodes. It
now replicates to `CONTROL_REPLICATION_BREADTH` (16) — deliberately above any real party's node
count, so Optimystic's cohort cap and downsizing make the effective cohort **the whole party**.

Why it had to change: every control node reads the *whole* control database, so a member left out
of a block's cohort may never learn the fact. The catch-up mechanism for that — read repair —
cannot converge at a cohort of two, because the single peer it can ask may be the same member that
missed the write. Measured on the control-DB replication scenario: 4 failures in 10 runs at breadth
2, 0 in 20 at full-party breadth.

Alongside it, the one knob that used to serve both populations was split: the control breadth is a
fixed constant, and the strand knob was renamed `CadreNodeConfig.strandClusterSize` /
`resolveStrandClusterSize` (default `DEFAULT_STRAND_CLUSTER_SIZE` = 2). Strand breadth is unchanged
in behaviour and its own open question stays tracked separately.

Canonical explanation lives in `docs/architecture.md` → "Replication cluster size".

## Review findings

### Checked, nothing wrong

- **Eight upstream Optimystic assumptions the design rests on**, each re-read in
  `../optimystic` source: the cohort cap and downsizing (`libp2p-key-network.ts`,
  `libp2p-node-base.ts`), `assumedClusterSize` really defaulting to 2, the impossibility of
  `MEMBERSHIP_NOT_ADMITTED` returning at breadth 16 (`cluster-repo.ts`), the absence of a
  read-repair deadlock via `CoordinatorRepo` (its `assumedClusterSize` resolves to 2, not 16 — had
  it resolved to 16, a two-node party would have had permanently dead read repair), churn work not
  scaling with 16, the `membershipOverfetch` tripwire's arithmetic, and enterprise deployment being
  7 nodes. All hold.
- **`corroboratorCapacity` semantics**, re-verified directly against
  `quorum-restore.ts` before writing them into the docs: `Math.max(cohortPeerCount,
  assumedClusterSize - 1)`, `CORROBORATION_FLOOR = 2`.
- **The `strandClusterSize` rename's blast radius.** Both external `CadreNodeConfig` construction
  sites are type-annotated, so a stale key is a compile error. No JSON / `Record` / spread path
  builds one. No shipping references to the removed `DEFAULT_CLUSTER_SIZE` / `resolveClusterSize`.
- **`docs/STATUS.md`** — its cluster-size mention is historical narrative about an already-fixed
  Optimystic bug and stays accurate. No edit.
- **Shipped-vs-speculative fencing in `docs/cadre-consistency.md`** — the blockquote and status
  pointer read clearly.

### Minor — fixed in this pass

- **An overstated doc claim.** `cadre-consistency.md` said replicating to everyone "removes the need
  for read repair on the control path entirely". False: a member offline at write time is never in
  the cohort, so it still catches up by read repair or by the write-while-alone re-replication queue
  (`CadreNode.drainPendingControlReplication`, fires on the control node's 0→≥1 connection edge).
  Softened to *routine* dependence, with both remaining catch-up paths named.
- **`assumedClusterSize`'s second consumer was undocumented.** All three sites described it only as
  the admission gate's yardstick; it is also an unconditional input to the read-repair/reconcile
  corroboration floor. Since read repair is the mechanism this change exists to route around, that
  consumer now appears — one clause per site.
- **The change also *strengthens* read repair, which was undocumented and is the more interesting
  half of the result.** With the cohort now the whole party, `corroboratorCapacity` rises from 1 to
  N-1 in a party of three or more, so the corroboration floor rises from 1 to 2 and a lone stale (or
  lying) peer can no longer pass as the cluster's truth. Documented, together with the narrow flip
  side: in a party of three where two members were offline for a write, the returning majority sees
  only one peer holding the new revision — below the floor of 2, where at breadth 2 it sat at a floor
  of 1. The re-replication queue, not read repair, is the backstop there.
- **Three copies of the same reasoning.** The `CONTROL_REPLICATION_BREADTH` docblock,
  `docs/architecture.md`, and `docs/cadre-consistency.md` each explained the read-repair argument at
  length — three places to keep in sync, a cost already visible in having to apply the three findings
  above to all of them. `docs/architecture.md` is now the canonical explanation and says so; the
  other two state the decision and link. Mechanism detail was moved, not dropped.
  `resolveStrandClusterSize`'s docblock got the same treatment for the divergence-hazard paragraph.
- **A sibling backlog ticket had a claim this change falsified.**
  `backlog/debt-read-repair-single-voter-corroboration` said Sereus would have no reachable path into
  the defect once this landed. Not true — strand networks still default to breadth 2. Scope narrowed
  to strand data explicitly rather than closed blind, per the review ticket's instruction.
  `backlog/debt-strand-replication-breadth-ignores-party-count` also carried the pre-rename symbol
  names and described the two-populations split as still to do; both corrected.

### Major — filed as new tickets

- **`backlog/debt-control-write-availability-degraded-cohort-member`** — the cost side of this whole
  change is untested. A member that is *connected but slow or flaky* now sits inside the cohort and
  counts against the super-majority, where at breadth 2 it would have been outside and ignored.
  Nobody has measured whether the write then succeeds slowly, fails cleanly, or hangs. The ticket
  states explicitly how it differs from `debt-control-db-offline-peer-no-hang-coverage`
  (unreachable peers, which never enter the cohort) and from
  `control-cohort-three-node-reconcile-isolation-test` (dial formation).
- **`backlog/debt-harness-supermajority-threshold-diverges-from-production`** — the integration
  harness sets `superMajorityThreshold: 0.51` where production leaves Optimystic's 0.75, i.e. 2-of-3
  versus 3-of-3 in a three-node cohort. Pre-existing, but the whole-party cohort is what makes it
  bite: a commit-availability regression can pass CI and fail in a real party. The implement pass
  parked it as a `NOTE:` and deferred the ticket-or-comment call to review; filed, with the `NOTE:`
  left in place now pointing at the ticket.

### Tripwires — recorded, deliberately not ticketed

- **Cohort-selection overfetch scales with the breadth constant.** At 16 the selection asks FRET for
  a 64-peer proximity band with a peerStore lookup per candidate. Free today because the result is
  bounded by the peers FRET actually knows. Parked as the `NOTE:` already on
  `CONTROL_REPLICATION_BREADTH` in `cluster-size.ts` — kept through the docblock trim.
- **16 is headroom, not a supported ceiling.** A party genuinely running more than 16 nodes silently
  returns to partial replication for its control database. Stated at the constant and in
  `docs/architecture.md`.

### Also updated

`tickets/blocked/replication-breadth-two-signoff.md` had become misleading for the human it is
waiting on: it asked "is two copies the right default?" as though one setting governed everything.
Rewritten to scope the question to shared-workspace (strand) data only, to say plainly which half is
now decided, and to point at
`backlog/debt-strand-replication-breadth-ignores-party-count` for the engineering side of the
adaptive option. Left in `blocked/` — still a human decision, just a narrower one.

## Validation

Run from a clean tree at `acf380e`, after rebuilding the sibling `@quereus/quereus` package (the
integration suite's build-freshness guard correctly refused to run against its stale `dist`):

| Command | Result |
|---|---|
| `yarn lint` (root) | pass |
| `yarn typecheck` (root) | pass |
| `yarn build` (root) | pass |
| `packages/cadre-core` `yarn test` | 64 files, 978 pass, 1 skipped |
| `packages/quereus-plugin-sereus` `yarn test` | 7 files, 68 pass, 1 todo |
| `packages/integration-tests` `yarn test` | 131 pass, 1 fail — the known pre-existing `push-wake-e2e` circuit-relay failure listed in `tickets/.pre-existing-known.md` against in-flight `fix/bug-strand-node-relay-reservation-denied-by-membership-gate`. Not re-reported. |

`../optimystic` was **not** rebuilt: it had another agent's uncommitted edits in flight
(`cluster-coordinator.ts`, `coordinator-repo.ts`, `network-transactor.ts`), and building those into
the `dist` Sereus consumes would have produced test results that say nothing about this change. Its
source was read directly instead to verify the corroboration arithmetic quoted above.

## Deliberately out of scope

`backlog/debt-strand-replication-breadth-ignores-party-count` (the strand path's own breadth
question) and the control commit sweep's non-atomicity across trees.
