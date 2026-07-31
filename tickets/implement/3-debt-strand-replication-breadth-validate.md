description: We raised how many machines keep a copy of shared workspace data from two to four, but the new tests that prove it works have never actually been run. Run them and fix whatever they turn up.
prereq:
files: packages/quereus-plugin-sereus/test/e2e/networked.e2e.spec.ts, packages/integration-tests/src/scenarios/strand-formation-e2e.integration.ts, packages/integration-tests/src/harness/control-cohort.ts, packages/cadre-core/test/strand-instance-manager-cluster-size.spec.ts, packages/quereus-plugin-sereus/src/cluster-size.ts
difficulty: medium
----

# Validate the breadth-4 change end to end

Continuation of `debt-strand-replication-breadth-ignores-party-count`, which hit the run's
token budget after the code and docs landed but **before the test suite was ever run**. The
source ticket is deleted; this is the remainder.

## What already landed (do not redo)

- `DEFAULT_STRAND_CLUSTER_SIZE` is 4 in `packages/quereus-plugin-sereus/src/cluster-size.ts`,
  with a rewritten docblock carrying the super-majority table and the
  first-breadth-that-tolerates-one-absence reasoning.
- One source of truth confirmed: `resolveStrandClusterSize` is the only place the default is
  applied, and both `cadre-core`'s `strand-instance-manager.ts` and the SQL plugin's
  `connectToStrand` / `connectToStrandBrowser` route through it. No second literal exists.
- Docs and comments updated: `docs/architecture.md` ("Replication cluster size" — the strand
  paragraph, a new "Why the strand default is 4 and not 2" paragraph, and the two-member-cohort
  bullet), `docs/cadre-consistency.md`, `packages/cadre-core/src/types.ts`,
  `packages/cadre-core/src/strand-instance-manager.ts`,
  `packages/quereus-plugin-sereus/src/types.ts`,
  `packages/quereus-plugin-sereus/README.md`.
- `tickets/plan/14-debt-strand-replication-vs-visibility-proof.md` premise updated;
  `tickets/backlog/debt-read-repair-single-voter-corroboration.md` scope narrowed (not closed —
  the upstream Optimystic defect is unfixed and an explicit `clusterSize: 2` still hits it).
- `yarn lint` — 0 errors (6 pre-existing warnings in
  `packages/integration-tests/src/scenarios/zz-scratch-delete-alone.integration.ts`, unrelated).
- `typecheck` clean on `@serfab/quereus-plugin-sereus`, `@serfab/cadre-core` and
  `@serfab/integration-tests`.

## What is unvalidated

**No test was executed.** Every assertion below is written but unproven. The new real-network
tests are the risky part — they build meshes that did not exist before.

- `packages/quereus-plugin-sereus/test/e2e/networked.e2e.spec.ts`, new suite
  **"strand sizes under the default breadth"**:
  - `startMesh(count)` starts N peers on a fresh strand (peer 0 authors the schema and is the
    bootstrap; the rest bootstrap off it and then dial each other into a full mesh) and waits
    for every peer to see `count - 1` connections. This helper has never run at 3 or 4 peers.
  - Parameterised tests at 1, 2 and 3 nodes assert a write commits below the breadth-4 target.
    The 3-node case is a genuine behaviour change: its cohort is now all three and the 0.75 bar
    is unanimity (`ceil(3 × 0.75) = 3`), where at breadth 2 only two of the three voted. If any
    case is going to be slow or flaky, expect it here.
  - The 4-node test inserts, waits for the fourth peer to see the row, stops that peer, waits
    for the author to drop to ≤ 2 connections, then inserts again and asserts both rows. Budget
    is 120 s because the stopped peer may still be selected into the cohort (its advertised
    protocols linger in the peerStore) and the coordinator's `collectPromises` uses
    `Promise.all` — it waits out the dead peer's dial before counting 3 of 4. If that wait turns
    out to be longer than the budget, raise the budget rather than weakening the assertion; the
    commit itself is the claim.
- `packages/integration-tests/src/scenarios/strand-formation-e2e.integration.ts`, the
  three-party test: a new `waitUntil` asserts Alice's strand cohort reaches all three members
  before the replication waiters. It replaces a stale comment that claimed a three-party strand
  uses breadth 2.
- `packages/integration-tests/src/harness/control-cohort.ts`: new exported `readCohort(libp2p,
  label)` reads any Optimystic node's current cohort (control **or** strand — a strand node is a
  bare libp2p node, not a `TestCadreNode`). `readControlCohort` and `waitForControlCohort` were
  refactored onto it; `resolveKeyNetwork` now takes `(libp2p, label)` instead of a
  `TestCadreNode`. Typechecks, but no cohort test has run since.
- `packages/cadre-core/test/strand-instance-manager-cluster-size.spec.ts`: the override cases
  moved from `clusterSize: 4` to `6` (4 now equals the default, which would have made them
  vacuous), and a new test asserts `resumeStrand` re-resolves the default rather than replaying
  a cached value.
- `packages/quereus-plugin-sereus/test/plugin.spec.ts`: new `DEFAULT_STRAND_CLUSTER_SIZE`
  describe pins the two properties the number exists for — `ceil(n × 0.75) < n` at 4 and `= n`
  at every smaller legal value, and `> 2` so read repair has more than one corroborator.

## TODO

- Run the full suite: `yarn test 2>&1 | tee /tmp/test.log`. Note the plugin package's `test`
  script is plain `vitest run`, so it executes the `e2e` project too — the new mesh tests are
  in the default run, not behind `test:e2e`.
- Fix whatever the new tests turn up. Two failure shapes are expected and mean different
  things: a *timeout* is a budget/convergence problem (raise the budget, or wait on the cohort
  rather than on connection count); a `Failed to get super-majority: N/M approvals` is the real
  claim failing and must not be papered over — it would mean breadth 4 does not in fact commit
  in that topology, which is the whole basis of the change.
- If the 3-node unanimity case proves slow or flaky, say so plainly in the review handoff
  rather than loosening it. It is a real availability cost of the change and the reviewer needs
  to see it.
- If `packages/integration-tests` has a way to run one scenario file, iterate on
  `strand-formation-e2e` alone before the whole suite — it is a 60 s test inside a long suite.
- Anything failing that is clearly pre-existing goes in `tickets/.pre-existing-error.md` per the
  workflow rules; check `tickets/.pre-existing-known.md` first (its entry for
  `strand-formation-e2e … three parties` is already resolved upstream and mentions this ticket's
  predecessor by name — update that entry's closing sentence, which still says strand breadth
  never adds copies as parties grow).
- Hand off to `review/` with an honest account of which of the four new mesh tests actually
  passed and how long each took.
