----
description: Run the not-yet-executed test suites for the newly written two-node strand-join network test, fix any failures the runs surface, and hand the work off to review. The test code itself is already written and passes lint and type checks.
prereq:
files: packages/integration-tests/src/scenarios/strand-addr-seed-convergence.integration.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/strand-instance-manager.ts, packages/cadre-core/src/types.ts, packages/cadre-core/src/strand-cohort.ts
difficulty: hard
----

Continuation of `strand-addr-seed-convergence-scenario` (itself phase 2 of
`strand-addr-seed-convergence-integration-test`). The prior run hit its token
budget after WRITING the scenario but before EXECUTING it. This ticket is
execution + fixes + review handoff only — do not rewrite the test unless a run
failure demands it.

## Already done — do not redo

- **Phase 1 (landed two commits back, verified):** `StrandInstance.mode: StrandMode`
  observable field in cadre-core (`types.ts`), assigned in
  `StrandInstanceManager.buildStrandRuntime` + seeded in `startStrand`; all 19
  test-double constructions updated. cadre-core build + typecheck green.
- **Phase 2 (this pipeline's prior run):** the full scenario file
  `packages/integration-tests/src/scenarios/strand-addr-seed-convergence.integration.ts`
  is written, complete per the original spec: single-owner {A founder/bootstrap,
  B joiner/networked} topology, both-gates assertions, direct
  `collectStrandAddrs` RPC assertions (subset of A's strand addrs, disjoint from
  control addrs, no control peerId), no-explicit-mode joiner asserting the
  Phase-1 `mode` field, auto-dial-only convergence both directions, negative
  control-peerId assertion, 120 s test timeout, tabs, helpers copied from
  push-wake with the `NOTE:` naming `integration-test-harness-helper-consolidation`.
  **Never hand-dial strand nodes** — if convergence fails, that is a finding to
  report, not a dial to add.
- `yarn lint` — clean (covers the Phase 1 diff and the new file).
- `yarn workspace @serfab/integration-tests typecheck` — clean.

## Environment learning from the prior run (READ FIRST)

The linked sibling repo `C:\projects\quereus` was being actively edited by its
OWN ticket runner during the prior run. The stale-build guard
(`test-harness/build-freshness.ts`, invoked from vitest `globalSetup`) blocks
every sereus test run while the sibling's `dist` predates its `src`. Remedy that
worked: `cd C:\projects\quereus\packages\quereus && yarn build` (plain `tsc`;
`yarn workspace` from the quereus root also works). The last poll showed the
build compiling CLEAN, with 2 uncommitted src files still in the sibling's tree
(its runner mid-ticket — do NOT touch that tree, and do not wait for it to be
committed; a clean compile is sufficient). If the guard trips again, rebuild and
retry — it is a race against the sibling runner, not a sereus defect.

## TODO

- Confirm the stale-build guard passes (rebuild quereus as above if not).
- `yarn workspace @serfab/cadre-core test 2>&1 | tee /tmp/cadre-core-test.log` —
  deferred since Phase 1 (its five touched unit-spec files got a mechanical
  `mode: 'networked'` stub field; failures there should be trivial).
- Run ONLY the new scenario, streaming:
  `yarn workspace @serfab/integration-tests test src/scenarios/strand-addr-seed-convergence.integration.ts 2>&1 | tee /tmp/strand-addr-seed.log`
  Do NOT run the whole integration suite inline (>10 min; out-of-band/CI).
- Fix failures the runs surface. Likely areas if the scenario fails:
  - Empty seed from the direct RPC → responder-side gate failure; the explicit
    `isAuthorizedMember` assertions before it distinguish gate vs addr-lookup.
  - Auto-dial convergence timeout → report observed timings as a real
    seeding/discovery gap in the handoff; do NOT add a manual dial.
  - Control-DB write failures around the two `authorizePeer` calls → the known
    optimistic-concurrency territory documented in push-wake's scenario 4 notes.
- If the run is green, run it once or twice more to gauge stability; record
  timings.
- Write the review/ handoff ticket and delete this one.

## Handoff notes to carry into the review ticket

- Whether auto-dial convergence was stable across runs, with timings.
- Data replication A↔B deliberately NOT asserted: a `bootstrap`-mode founder
  commits through a purely local transactor; connection + seed content is the
  claim. A data-convergence scenario needs both nodes `networked` (third node or
  explicit mode on the founder) — flag as possible follow-up, don't build it.
- Push-wake helpers copied, not shared — consolidation tracked in
  `integration-test-harness-helper-consolidation`; `NOTE:` comment at the copy
  site in the new file.
- Phase 1 (observable `mode`) landed earlier in this pipeline run; its unit-spec
  stub updates were mechanical.
- Prior run's validation state: lint green, integration-tests typecheck green,
  cadre-core unit tests and the scenario itself NOT yet executed (this ticket's
  job).
