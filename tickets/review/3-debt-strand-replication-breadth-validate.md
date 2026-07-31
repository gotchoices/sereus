description: The tests proving that shared workspace data now keeps four copies instead of two had never been run; they were run and they all pass, with no code changes needed.
prereq:
files: packages/quereus-plugin-sereus/test/e2e/networked.e2e.spec.ts, packages/quereus-plugin-sereus/src/cluster-size.ts, packages/integration-tests/src/scenarios/strand-formation-e2e.integration.ts, packages/integration-tests/src/harness/control-cohort.ts, packages/cadre-core/test/strand-instance-manager-cluster-size.spec.ts, tickets/.pre-existing-known.md, tickets/.pre-existing-error.md
difficulty: medium
----

# Review: breadth-4 strand replication, validated end to end

The predecessor ticket (`debt-strand-replication-breadth-ignores-party-count`) raised
`DEFAULT_STRAND_CLUSTER_SIZE` from 2 to 4 and wrote tests for it, but ran out of budget before
running any of them. This ticket ran them.

**Outcome: everything the predecessor wrote passes, unmodified.** No product code changed here.
The only edit is a measured-timing NOTE added to one test comment (below). Two unrelated
integration scenarios fail at HEAD; they are reported as pre-existing, not fixed here.

## What was run, and what it cost

Full workspace build first (`yarn build`, 38 s) — the suites are guarded against a stale `dist`.

| suite | result |
|---|---|
| `yarn test` (root, all workspaces) | everything green except `@serfab/integration-tests` — see "Pre-existing failures" |
| `@serfab/cadre-core` | 83 files, 1313 passed, 1 skipped |
| `@serfab/cadre-host` | 58 files, 508 passed, 4 skipped |
| `@serfab/cadre-cli` | 13 files, 161 passed |
| `@serfab/quereus-plugin-sereus` (both `unit` and `e2e` projects) | 7 files, 74 passed, 1 todo |
| `reference-app-*` | 19 files, 126 passed |
| `check-dep-ranges` | 9/9 |
| `@serfab/integration-tests` | 34/36 files passed; 2 pre-existing failures |
| `yarn lint` | 0 errors, 6 warnings (all pre-existing, all in `zz-scratch-delete-alone.integration.ts`) |

## The four new mesh tests — the risky part — all pass

`packages/quereus-plugin-sereus/test/e2e/networked.e2e.spec.ts`, suite
**"strand sizes under the default breadth"**. These start real `createLibp2pNode` peers and dial
them into a full mesh; nothing like them existed before, and the `startMesh` helper had never
run above 2 peers. Run **three times** (twice via `-t 'strand sizes under the default breadth'`,
once inside the whole-package `yarn test`). **12 of 12 test executions green.** Per-test
wall-clock across the three runs:

| test | run 1 | run 2 | run 3 | budget |
|---|---|---|---|---|
| 1-node strand commits | 2.5 s | 2.4 s | 3.9 s | 60 s |
| 2-node strand commits | 5.4 s | 5.5 s | 7.3 s | 60 s |
| 3-node strand commits | 8.1 s | 8.6 s | 7.3 s | 60 s |
| 4-node strand commits after one holder stops | 44.3 s | 47.8 s | 43.4 s | 120 s |

**The 3-node unanimity case is not slow and was not flaky.** The ticket flagged it as the likely
problem child — its cohort is now all three peers and `ceil(3 x 0.75) = 3` means every holder
must vote, where at breadth 2 only two of the three did. It landed at 7-9 s against a 60 s
budget, three for three, with no retries and no `Failed to get super-majority` anywhere. The
availability cost of unanimity at three nodes is real in principle, but it did not show up as
either slowness or flakiness on a quiet loopback mesh with all three peers healthy — which is
the only case this test exercises. **A reviewer should not read this as "unanimity at 3 is
free".** What is untested is a 3-node strand with a peer degraded or stopped, which by the
arithmetic cannot commit at all. See "Gaps" below.

**The 4-node test is the slow one**, and consistently so: ~45 s, essentially all of it in the
second insert while the coordinator waits out the dial to the peer that was stopped (its
advertised protocols linger in the peerStore, so it can still be selected into the cohort, and
`collectPromises` uses `Promise.all`). That is the behaviour the ticket predicted. The 120 s
budget carries ~2.5x headroom on this box; a slower CI machine could narrow that. I added a
`NOTE:` comment at the site recording the measured range and saying to raise the budget rather
than weaken the assertion if it ever trips — that comment is the only file change in this
ticket.

## The other unproven assertions

- **`strand-formation-e2e.integration.ts` → "should form a strand with three parties"** —
  passes, 1.2 s standalone / 1.5 s with debug on, well inside its 60 s budget. The new
  `waitUntil` on `readCohort(aliceStrand.libp2pNode!, ...) >= 3` is **not vacuous**: with
  `DEBUG='sereus:integration:cohort'` the very first probe returns three distinct peer ids
  (`12D3KooWQVpM…`, `12D3KooWB3y7…`, `12D3KooWAY3U…`). This is the assertion that would catch the
  default silently dropping back to 2, and it is now known to observe a real 3-member cohort
  rather than passing on an empty or self-only result.
- **`readCohort` / `resolveKeyNetwork(libp2p, label)` refactor in
  `packages/integration-tests/src/harness/control-cohort.ts`** — exercised by the three-party
  test above (the strand path, which is the new capability) and by every control-cohort scenario
  in the suite that uses `readControlCohort` / `waitForControlCohort`, all of which pass.
- **`packages/cadre-core/test/strand-instance-manager-cluster-size.spec.ts`** — 5/5, including
  the new `resumeStrand` re-resolves-the-default test and the override cases moved from 4 to 6.
- **`packages/quereus-plugin-sereus/test/plugin.spec.ts`** — 34/34, including the new
  `DEFAULT_STRAND_CLUSTER_SIZE` describe.

## Pre-existing failures (reported, not fixed)

Two `integration-tests` scenarios fail at HEAD on the same gate — node B never resolves node C's
signed `CadrePeer` address record within 45 s:

- `control-write-degraded-cohort-member.integration.ts` — fails in `beforeAll`, all 6 tests skipped
- `control-cohort-three-node-isolation.integration.ts` — second test fails in `bootTrio`

Deterministic: reproduced in the full suite, in a two-file run, and with the degraded scenario
running entirely alone. Neither scenario creates a strand, neither imports the harness file this
ticket's predecessor touched, and the rest of that commit's `src/` changes are comment-only — so
this is not the breadth change. Written up in `tickets/.pre-existing-error.md` with the exact
commands, stack frames, and the reasoning. Note that the code at the failing poll
(`control-cohort-three-node-isolation.ts:305-312`) already carries a comment predicting exactly
this recurrence and explicitly asking that the timeout **not** be widened — the triage pass
should honour that.

## Gaps a reviewer should push on

- **No negative test for the 3-node case.** The 3-node test proves a healthy 3-node strand
  commits. It does not prove the flip side that motivates breadth 4 — that a 3-node strand with
  one peer down *cannot* commit, because `ceil(3 x 0.75) = 3`. The 4-node test proves the
  positive at 4. A `it.todo`-style counterpart at 3 would make the argument symmetric, and its
  absence means the suite would still be green if the super-majority threshold silently changed
  to something below 0.75.
- **The 4-node test's ~45 s is unexplained in detail.** I confirmed the magnitude and its
  consistency, but did not instrument where inside the second insert it goes. The comment
  attributes it to the dead peer's dial; that is the predecessor's hypothesis, corroborated only
  by the fact that the first insert on the same mesh is fast.
- **`startMesh` waits on connection count, not on cohort.** `peers.every(p =>
  p.node.getConnections().length >= count - 1)` proves the TCP mesh formed, not that FRET has
  classified every peer as serving the strand. It happened to be sufficient at 1-4 peers on
  loopback; it is the assertion most likely to become the flaky one on slower hardware or at
  larger sizes. Waiting on `readCohort` (as the integration-tests three-party test now does)
  would be the stronger gate — the plugin package would need its own way to reach the key
  network, which it does not currently have.
- **Single machine, single OS.** All timings are win32 on one dev box, sequential runs. No CI
  numbers, no contention numbers.
- **Read repair was not directly tested.** The "correctness floor" half of the justification for
  4 (that at breadth 2 a stale node's single corroborator can be stale too) is argued in the
  docblock and pinned arithmetically in `plugin.spec.ts`, but no test drives the stale-read path.
  That remains `backlog/debt-read-repair-single-voter-corroboration` plus
  `plan/14-debt-strand-replication-vs-visibility-proof`.

## Changes in this ticket

- `packages/quereus-plugin-sereus/test/e2e/networked.e2e.spec.ts` — added a `NOTE:` comment
  recording the measured 43-48 s range of the 4-node test against its 120 s budget, and the
  instruction to raise the budget rather than weaken the assertion. No assertion or timeout changed.
- `tickets/.pre-existing-known.md` — rewrote the closing sentence of the `strand-formation-e2e …
  three parties` entry, which still claimed strand breadth never adds copies as parties grow.
  It now records that a three-party strand replicates to all three, cites the measured
  first-probe cohort of 3, and states plainly that breadth is a fixed target so parties larger
  than 4 remain partially replicated by design.
- `tickets/.pre-existing-error.md` — new, see above.

## Review findings

- The 4-node mesh test consumes ~45 s of its 120 s budget, consistently across three runs. Fine
  today; if it starts tripping on slower hardware the fix is a bigger budget, not a weaker
  assertion. Parked as a `NOTE:` at the site in `networked.e2e.spec.ts`.
