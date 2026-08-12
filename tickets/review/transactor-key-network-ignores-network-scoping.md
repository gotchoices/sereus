----
description: The database layer used to build its own second copy of the peer-discovery component, so writes forgot which network they were on and how many machines to copy to. That is fixed and shipped; this pass rebuilt everything, re-ran the tests, updated the docs, and found that a three-machine test which was blamed on the same bug is actually failing for a different, still-unsolved reason.
prereq:
files: ../optimystic/packages/quereus-plugin-optimystic/src/optimystic-adapter/collection-factory.ts, ../optimystic/packages/quereus-plugin-optimystic/test/collection-factory-key-network.spec.ts, ../optimystic/packages/db-p2p/src/libp2p-key-network.ts, packages/cadre-core/src/cadre-node.ts, packages/integration-tests/src/harness/forced-cluster.ts, docs/architecture.md, tickets/fix/control-peer-row-refresh-invisible-to-third-node.md, tickets/backlog/debt-strand-write-breadth-observed-end-to-end.md
difficulty: medium
----

# Review: transactor and node now share one key network

## What the fix is

A **key network** answers two questions for a given piece of data: *which peers should hold it*
(`findCluster`) and *which peer coordinates this write* (`findCoordinator`). `createLibp2pNode`
builds exactly one per node, with that node's configured cluster size, network mode, persistence,
reputation and the protocol prefix that scopes discovery to peers serving this network, and
attaches it as `node.keyNetwork`.

The Quereus collection factory used to ignore that and construct a **second** one from Optimystic's
defaults. Every database write therefore ran against a 16-wide cohort with network scoping off —
a different peer set and a different coordinator than the same node's own consensus path derived
for the same key. `resolveKeyNetwork` in
`../optimystic/packages/quereus-plugin-optimystic/src/optimystic-adapter/collection-factory.ts` now
prefers the attached instance. The no-attached-key-network fallback (a node injected by a host that
did not build it through `createLibp2pNode`) still constructs one, but passes the protocol prefix
through so discovery stays scoped; the rationale is in a comment at the site.

**Both halves of the fix are committed upstream in `../optimystic` (clean at `f02be8e`).** Nothing
in this repository implements the fix — Sereus consumes it. What this repo carries is validation,
documentation, and the permanent debug instrumentation described below.

## Changes in THIS repo

- `packages/cadre-core/src/cadre-node.ts` — **already committed** by an earlier run of this ticket
  (the ticket text called it uncommitted; it is not, the working tree is clean here). Permanent,
  debug-gated instrumentation, kept deliberately: the `resolvePeerAddrs` signature-verification failure log now carries the
  row's `updatedAt`, `addrs` and a signature prefix, and both `registerSelf` success logs carry a
  signature prefix. This is what makes the stale-read failure below diagnosable at all. Do not
  strip it.
- `packages/integration-tests/src/harness/forced-cluster.ts` — header rewritten. It documented at
  length that every node has TWO key networks and that only a prototype patch covers both. That is
  no longer true: there is one instance per node, so an instance patch would now suffice. The
  prototype patch stays and the header now says why honestly — it is a **simplicity** argument
  (the helpers accept three different node shapes, only some of which expose the key network), not
  a necessity one. The two-seams explanation for `pinCoordinator` (`consolidateCoordinators` uses
  `findCluster`, not `findCoordinator`) was preserved, because that reason is unchanged.
- `docs/architecture.md` → "Replication cluster size" — new bullet, "One key network per node, so
  one cluster size and one network scope", stating what is shared, by whom, what the old behaviour
  was, and what the injected-node fallback does.
- `tickets/fix/control-peer-row-refresh-invisible-to-third-node.md` — new (see below).
- `tickets/backlog/debt-strand-write-breadth-observed-end-to-end.md` — new (see below).
- `tickets/implement/control-write-retry-scenario-coverage.md` — arm appended for a second,
  distinct failure found in a scenario that ticket already owns.
- `tickets/.pre-existing-known.md` — three boot-gate entries re-attributed away from this ticket.

`packages/cadre-core/test/control-revocation-replay.spec.ts` is also modified in the working tree.
**That is not this ticket's edit** — it was already modified at session start.

## The headline finding: the regression this ticket was blocked on is NOT fixed

This ticket sat in `blocked/` waiting on an Optimystic defect — a node that picked itself as
coordinator before its first dial completed cached that pick for 30 minutes and then served its own
stale replica. The garden pass unblocked it because that fix landed upstream.

**It landed, it is live, and the failure it was supposed to explain is unchanged.** Verified with a
captured failing run: `coordinator-cache:self-write-ignored` fires **3771** times, so no node ever
caches itself as a coordinator, and `control-cohort-three-node-isolation` still fails 2 of 3 plain
runs with the byte-identical fingerprint. The cache was not the cause.

What the failure actually looks like: node C successfully publishes its signed address record
(the harness step that waits for that **passes**), and node B then reads the *previous* revision of
C's row — the address-less owner-vouch one — for the full 45 s, with **no error raised anywhere**.
Ruled out by measurement: the coordinator cache, network scoping (cohorts measured at 1/2/3 wide
with the membership filter dropping foreign peers, not 16), and every known failure fingerprint
(zero header-absent, peers-unreachable, sync-retry, no-quorum or grace-period occurrences in the
failing run). The leading hypothesis — B answers its own read from a replica that missed the write
— is stated with its supporting counts and, explicitly, as **not proven**, together with the two
experiments that would settle it. All of that is in
`tickets/fix/control-peer-row-refresh-invisible-to-third-node.md`.

A reviewer should treat that ticket's hypothesis as the weakest thing in this handoff. It is a
reading of log counts, not a demonstration.

## Test results (both sibling repos clean and rebuilt, whole sereus workspace rebuilt)

`../optimystic` at `f02be8e`, rebuilt. `yarn build` at the sereus root succeeded. `yarn lint` and
`packages/integration-tests` `typecheck` both exit 0.

| suite | result |
| --- | --- |
| `control-db-two-node-convergence` | pass |
| `control-cohort-auto-convergence` | pass |
| `control-cohort-cold-start-retry` | pass |
| `control-write-while-alone-convergence` | pass (2 tests) |
| `happy-path` | pass (2 tests) |
| `control-cohort-three-node-isolation` ×3 | **1 pass, 2 fail** (boot gate) |
| `control-write-degraded-cohort-member` ×3 | **1 pass, 1 boot-gate fail, 1 super-majority fail** |
| `cadre-core` unit suite | 92 files, 1506 passed, 1 skipped |
| `quereus-plugin-sereus` suite | 76 passed, **1 failed**, 1 todo |

The one plugin failure is `test/e2e/networked.e2e.spec.ts` dying with `Missing block`, which is the
~1-of-9-per-run routing race already recorded in `tickets/.pre-existing-known.md`. Worth flagging
for a gardener, not for this ticket: that entry points at
`control-coordinator-answers-absent-without-asking-cohort`, which now sits in `complete/`, so the
entry names an owner that no longer exists.

`control-write-degraded-cohort-member` produced a **second, unrelated** failure in the run that got
past its boot gate: `Failed to get super-majority: 0/3 approvals (needed 3, 0 rejections)` on both
the healthy-cohort and delayed-member cases. Nobody voted at all — this is not the degraded member
refusing — and it hits the scenario's control case, so when it strikes the suite proves nothing
either way. Cause not established. Recorded as an arm on
`tickets/implement/control-write-retry-scenario-coverage.md`, which already owns that scenario and
`forced-cluster.ts`.

## Decisions a reviewer should push on

**Strand cohort-width coverage — chose the upstream unit spec, did not add a Sereus-level test.**
The ticket asked to pick one and say which. Picked: the unit-level spec already in
`../optimystic/packages/quereus-plugin-optimystic/test/collection-factory-key-network.spec.ts`,
reinforced by `Libp2pKeyPeerNetwork`'s constructor now taking `clusterSize` as a **required**
argument — a caller that silently defaults the width is now a compile error, which is a stronger
guard than any test. The Sereus-level alternative (write on a three-machine strand configured at
breadth 2, then count how many machines physically hold the block) is the honest end-to-end check
and it is **not** implemented; two known confounds make it real work — reads pull blocks into the
reading node, and `strand-backfill.ts` copies blocks to every connected peer and must be disabled —
and the comparable physical test in this suite passed 1 of 4 runs when last measured. Filed as
`tickets/backlog/debt-strand-write-breadth-observed-end-to-end.md` with that design and those
confounds. **If the reviewer thinks defence-in-depth here is worth the flakiness budget, that
backlog ticket is the thing to promote.**

**`NO_NETWORK_COORDINATOR` / coordinator error codes — confirmed clean.** Repo-wide, Sereus
pattern-matches Optimystic coordinator errors in exactly one place:
`packages/cadre-core/src/control-write-retry.ts:216`, a regex on
`Self-coordination blocked: grace-period-not-elapsed. No coordinator available for key.` That
string is still emitted verbatim upstream (`libp2p-key-network.ts:746`), so the classifier still
matches. Nothing matches on `NO_NETWORK_COORDINATOR` or `NO_COORDINATOR_AVAILABLE` — those symbols
do not appear anywhere in this repo.

**Unit suites against a node without `keyNetwork` — checked, nothing broken.** The only Sereus code
constructing the network transactor path is `packages/cadre-core/src/control-database.ts` and
`packages/quereus-plugin-sereus/src/compose-strand.ts`, and both register nodes built by
`createLibp2pNode`, so both take the attached-key-network branch. `cadre-core`'s 1506 tests pass.

## Known gaps, stated plainly

- The three-node boot gate fails 2 of 3 runs and this pass did not fix it. It is now owned by a
  `fix/` ticket with an unproven hypothesis.
- The degraded-cohort super-majority failure has no cause at all, only a recorded fingerprint.
- No test in this repository observes the cohort width a strand write actually used.
- The `control-peer-row-refresh-invisible-to-third-node` diagnosis rests on aggregate log counts
  from a single captured failing run. The optimystic debug lines carry no peer id and all three
  nodes share one vitest process, so no captured line attributes a coordinator decision to node B
  specifically. Everything downstream of that is inference.
