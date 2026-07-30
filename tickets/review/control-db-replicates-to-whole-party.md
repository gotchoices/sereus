description: The shared party database now copies every piece of data to every machine in the party instead of only two. This makes members reliably learn about each other, at the cost of needing more machines online to approve a write.
files: packages/quereus-plugin-sereus/src/cluster-size.ts, packages/quereus-plugin-sereus/README.md, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/types.ts, packages/cadre-core/src/strand-instance-manager.ts, packages/cadre-core/test/cadre-node-control-replication.spec.ts, packages/integration-tests/src/harness/test-party.ts, docs/architecture.md, docs/cadre-consistency.md
difficulty: medium
----

# Review: control database replicates to the whole party

Two implement tickets produced this: `control-db-replicates-to-whole-party` (the code, committed
as `e3a41af`) and `control-db-replicates-to-whole-party-validation` (validation + the remaining
docs + a test guard, uncommitted at the time of writing). Reviewing them together — the split was
a token-budget artifact, not a design boundary.

## What changed, in one paragraph

Optimystic replicates each block of a database to a **cohort** — a subset of the network — and the
embedder supplies the target size. Cadre used one number, 2, for both the control (party
membership) database and strand (application) databases. Two is too narrow for the control
database, because every control node reads *all* of it, so a member left out of a cohort may never
learn a fact; the catch-up mechanism (read repair) provably cannot converge at a cohort of two.
The two paths are now separate constants: control uses a fixed `CONTROL_REPLICATION_BREADTH` of 16
— above any real party's node count, and Optimystic shrinks a cohort it cannot fill, so in practice
the cohort is the whole party — and strands keep `DEFAULT_STRAND_CLUSTER_SIZE` of 2 behind a
renamed resolver.

## Public surface changed

| Before | After |
|---|---|
| `DEFAULT_CLUSTER_SIZE` | **gone** → `CONTROL_REPLICATION_BREADTH` (16) and `DEFAULT_STRAND_CLUSTER_SIZE` (2) |
| `resolveClusterSize(n?)` | **gone** → `resolveStrandClusterSize(n?)`, strand-only |
| — | `MIN_CLUSTER_SIZE` (2), validation floor only |
| `CadreNodeConfig.clusterSize` | **renamed** `CadreNodeConfig.strandClusterSize`, re-documented strand-only |

Exported from `@serfab/quereus-plugin-sereus`, re-exported by `@serfab/cadre-core`. This is a
breaking rename for embedders; the repo has no back-compat policy yet (AGENTS.md), so no aliases
were kept.

## Validation actually run

Everything below was run at the validation ticket's HEAD, after rebuilding `@quereus/quereus`, the
whole `../optimystic` workspace, and the full sereus workspace.

| Check | Result |
|---|---|
| `yarn lint` (root) | clean |
| `yarn typecheck` (root) | clean |
| `yarn build` (root) | clean |
| `packages/cadre-core` unit suite | **978 passed, 1 skipped** (was 974 before the 4 new tests) |
| `packages/quereus-plugin-sereus` unit suite | **68 passed, 1 todo** |
| Target scenario, 20 consecutive runs alone via `-t` | **20 pass / 0 fail** (baseline to beat: 4 failures in 10 at breadth 2; a later measurement had 6 in 20) |
| Full `packages/integration-tests` suite, run twice | **131 passed / 1 failed**, both times — the same single already-tracked failure |

The one failure is
`push-wake-e2e.integration.ts > … > delivers a wake to a NAT'd receiver over a circuit-relay
(signaling-first) dial`. It is listed in `tickets/.pre-existing-known.md` against the in-flight
`fix/bug-strand-node-relay-reservation-denied-by-membership-gate`, whose root cause is confirmed
and unrelated (a strand node's derived transport peerId is denied by the relay's membership gater
during `libp2p.start()`). Reproduced deterministically 5/5 in isolation here. Not re-reported, not
skipped, not touched.

`tickets/.pre-existing-known.md` was updated: the target scenario's entry moved to "Resolved in
place" with the 20/20 evidence, and a dated observation was added to the three-party
strand-formation entry (it passed in both full-suite runs — not a clearance, it was always
intermittent, and this change did not touch the strand path).

### One validation trap worth knowing about

The first 20-run loop reported 12 failures starting at run 9. None were real: a **concurrent editor
in the sibling `../quereus` checkout** touched `src` mid-loop, and `build-freshness.ts` correctly
aborted every subsequent run with `Stale build detected`. Rebuilding quereus and re-running gave
20/20. If you re-measure, distinguish a `Stale build detected` abort from a test failure — a bare
exit code conflates them and silently corrupts the count.

## What a reviewer should attack

Ranked by where this is most likely to be wrong.

- **Is 16 the right number, and is "any value ≥ party size behaves identically" actually true?**
  The whole design rests on Optimystic capping a cohort at real serving peers
  (`Libp2pKeyPeerNetwork.findCluster` keeps `min(serving peers, clusterSize - 1)` non-self members)
  and downsizing what it cannot fill (`allowDownsize: true`). Verify that claim in
  `../optimystic/packages/db-p2p/src/libp2p-key-network.ts` rather than trusting the doc comment.
  If it is false, 16 is not "harmless headroom", it is a target no real party can satisfy. Note
  there is a related human decision parked in `blocked/replication-breadth-two-signoff.md`.
- **Write availability is the cost side and is NOT covered by any test.** A commit needs a
  super-majority of its cohort. With the cohort now the whole party rather than two nodes, one
  flaky or slow member counts against that threshold where before it sat outside the cohort and was
  ignored. Nothing in the suite exercises a party with a degraded member under the new breadth. If
  you want one test written, this is the one.
- **The harness is more permissive than production on exactly this axis.** `test-party.ts` passes
  `clusterPolicy.superMajorityThreshold: 0.51`; `CadreNode` leaves Optimystic's default of `0.75`.
  So a commit-availability regression can pass the harness and fail in a real party — which is
  precisely the risk the previous bullet describes. Pre-existing, but it interacts badly with this
  change. Recorded as a `NOTE:` at the override site in `test-party.ts`; consider whether it should
  become a ticket rather than a comment.
- **The `strandClusterSize` rename is the kind of thing TypeScript catches only if every caller is
  typed.** `yarn typecheck` is clean and the strand path's own spec was updated, but a config object
  built loosely (from JSON, a `Record`, a spread) would drop the old `clusterSize` key silently and
  fall back to the default rather than erroring. Worth a grep for config construction that does not
  flow through `CadreNodeConfig`.
- **`assumedClusterSize` was deliberately left at Optimystic's default of 2.** Confirm that is
  right. The reasoning: it means "the smallest cohort this deployment can genuinely field", the
  membership admission gate runs it through `admissionFloor` on its low-confidence path
  (`../optimystic/packages/db-p2p/src/cluster/cluster-repo.ts`), and asserting 16 would demand
  `ceil(0.75 × 16) = 12` declared peers and refuse every real party's writes. This is also why
  raising `clusterSize` does not reintroduce `MEMBERSHIP_NOT_ADMITTED` — the gate never measures
  against `clusterSize`. A new unit test pins the `undefined`.

## New test coverage added by the validation pass

`packages/cadre-core/test/cadre-node-control-replication.spec.ts` gained a
`CadreNode control-network node options` block (4 tests). To make it possible, `createControlNode`
in `cadre-node.ts` was split: the config→options mapping is now a private
`buildControlNodeOptions()` that `createControlNode` calls, so the mapping is assertable on a bare
`new CadreNode(config)` with no libp2p node started. The tests assert that control gets
`CONTROL_REPLICATION_BREADTH`, that `strandClusterSize` does **not** reach it, that
`allowDownsize` is on and `assumedClusterSize` is left unset, and that the network name is
control-scoped.

Honest limits: this pins four options out of a dozen; the rest of the control-network wiring is
still trusted rather than verified, which is what
`backlog/debt-cadre-node-control-network-wiring-test` covers. It also asserts what
`buildControlNodeOptions` *returns*, not what `createLibp2pNode` *receives* — a future refactor
that stops calling the builder would not fail these tests.

## Docs updated

- `docs/architecture.md` § "Replication cluster size" — rewritten for the two-constant split
  (landed in `e3a41af`).
- `docs/cadre-consistency.md` — new section "What Ships Today: The Control Database Replicates to
  the Whole Party", explicitly fenced off as shipped behaviour because the rest of that file is an
  unimplemented design exploration. The status line at the top now points at it. **Check the fencing
  reads clearly** — mixing shipped fact into a speculative doc is the thing most likely to mislead a
  later reader.
- `packages/quereus-plugin-sereus/README.md` — the `clusterSize` row's default of 2 was right but
  its justification was wrong (it claimed a peer configured higher than its cohort "refuses to vote
  and the write fails"; the admission gate keys on `assumedClusterSize`, not `clusterSize`).
  Rewritten to match `cluster-size.ts` and `architecture.md`.

## Tripwires parked (index only — the analysis lives at each site)

- `membershipOverfetch()` scales with the constant: 16 asks FRET for a 64-peer proximity band with
  a peerStore protocol lookup per candidate. Free today (bounded by peers FRET actually knows).
  → `NOTE:` on `CONTROL_REPLICATION_BREADTH` in `cluster-size.ts`.
- Harness/production super-majority mismatch (see the attack list above).
  → `NOTE:` at the `superMajorityThreshold` override in `test-party.ts`.

## Explicitly not in scope

`backlog/debt-read-repair-single-voter-corroboration` (Optimystic accepting a single voter at
two-member cohorts), `backlog/debt-strand-replication-breadth-ignores-party-count` (the strand
path's own breadth question), and the commit sweep's non-atomicity across trees.
