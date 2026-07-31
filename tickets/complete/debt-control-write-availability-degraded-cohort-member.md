----
description: Added a test suite that measures how much a slow or unresponsive machine slows down shared-settings changes made on another machine, and confirmed the numbers now written into the docs.
prereq:
files: packages/integration-tests/src/scenarios/control-write-degraded-cohort-member.integration.ts, packages/integration-tests/src/harness/forced-cluster.ts, packages/integration-tests/src/harness/index.ts, docs/architecture.md, docs/STATUS.md
----

# Control-write availability with a degraded cohort member — complete

## What shipped

A real three-node integration scenario that measures what a **connected but degraded** cadre member
costs a control write. The two existing cadre-core specs cover members that are *absent* from the
cohort (solo, and known-but-offline, where Optimystic downsizes the cohort). This is the third
flavour, and the expensive one: a member that is inside the cohort and therefore counted against
the 0.75 approval bar — at three nodes, `ceil(3 × 0.75) = 3`, so one degraded member is decisive.

Mechanism: three real `CadreNode`s over localhost websockets. Cohort discovery and coordinator
assignment are forced (`harness/forced-cluster.ts`) because FRET's routing table never warms inside
a test's lifetime — real discovery returns self-only cohorts that never reach the super-majority
branch at all. Everything below that seam stays real: cluster clients, response deadlines,
transports, `ClusterMember`s. Degradation is injected one layer down, by re-registering the third
node's cluster protocol handler behind a delay (or a never-answer hold), leaving the node otherwise
honest.

Measured, and now recorded in `docs/architecture.md` and `docs/STATUS.md`:

| case | outcome |
|---|---|
| healthy trio | commits, ~1.2 s (authorize + remove combined) |
| 2 s per-RPC delay (under the 10 s response deadline) | commits, ~55 s **each write** — one control write makes ~27 inbound cluster RPCs and pays the delay serially on each |
| never answers (past the deadline) | clean failure at ~20 s, `Failed to get super-majority: 2/3 approvals (needed 3, 0 rejections)` |
| after a failed write | next write commits normally, ~1.7 s |

Failed writes roll back, are not queued for re-replication (both write directions — INSERT via
`authorizePeer` and stamp-retiring DELETE via `removePeer`), and leave nothing wedged. So the
degradation costs latency and availability, not consistency.

## Review findings

### Run result

`yarn vitest run src/scenarios/control-write-degraded-cohort-member.integration.ts` in
`packages/integration-tests`: **5 passed + 1 expected fail, exit 0**, 183.5 s. Per-case measurements
matched the documented bounds (healthy 1162 ms; delayed 54717 / 55066 ms; both stall failures
20257 / 20378 ms, one pend round each). Typecheck (`tsc --noEmit -p tsconfig.typecheck.json`) and
`eslint` over the touched files: clean, both before and after the final comment-only edits.

### Fixed in this review

- **A doomed write leaked into the next case.** In the expected-failure case, the stalled
  `authorizePeer` was joined at the *end* of the `try` — a line the currently-expected failure path
  never reaches — so the write was still in flight, holding the control write lock, when the next
  case started. Now started outside the `try` and drained in the `finally`, after `restore()` aborts
  the held streams so it settles promptly.
- **The healthy baseline case had no proof the trio was real.** A self-only cohort also commits
  sub-second, so `forced.callCount()` alone could not distinguish them. Added a zero-delay variant of
  the degradation wrapper — a pure inbound-RPC counter — and the case now asserts the third node
  actually received cluster RPCs. It also logs its elapsed time, which the docs cite but nothing
  emitted.
- **Duplicated harness helpers.** The file re-implemented `makeOwnOwner`, `wsTransports` and
  `randomPeerId`, all of which already live in `harness/node-fixtures.ts` — the exact duplication
  `plan/10-integration-test-harness-helper-consolidation-remaining-files` exists to remove. Swapped
  to the shared versions; that ticket's table gained a row for this file. The local `nodeConfig`
  stays, because folding it in needs the `trustedOwners` option ticket 10 flags as an open decision;
  a comment says so.
- **Header comment duplicated `forced-cluster.ts`.** Trimmed the restated explanation to a pointer,
  keeping only what is unique to this scenario.
- **Stale measurements in three places.** The healthy-trio figure read ~0.5 s in `architecture.md`
  and the deadline table and ~0.8 s in the file header; the observer wrapper added in this review
  makes it ~1.2 s. All three now agree with the run.
- **`docs/STATUS.md` never learned about the scenario.** Its control-DB liveness checklist listed
  the solo and offline-peers specs but not this one, so the coverage section claimed less than the
  repo has. Added.
- Added a failure message to a previously bare cohort-size assertion.

### The uncovered coordinator branch — decision: softened the docs claim

`architecture.md` asserted that a write coordinated *by* the degraded node commits fast. Nothing
tests this. Of the three options (add the case / file a coverage ticket / soften the claim), the
first is not available and the second would be filing work that cannot be done: coordinator
assignment is also the read-routing seam, and only the founding node holds the control trees'
genesis-era blocks, so pinning the coordinator to the degraded node fails **every** case — writes
included, since the write path reads through the same seam — with `Missing block` in under 100 ms,
long before any degradation is reached. Making the third node hold those blocks is chicken-and-egg:
it can only join after the founder has already written them alone.

So the bullet now says explicitly that the branch is **observed, not asserted**, gives the
development-time measurement as such, and states why no test pins it. The scenario header carries
the same note at the code site.

### Filed as a new ticket

`fix/transactor-key-network-ignores-network-scoping` — a production concern surfaced by the
implement pass and verified here by reading the source: optimystic's Quereus collection factory
builds the transactor's key network with no arguments, one line before computing the correct
protocol prefix for `RepoClient`. Consequence: no network scoping on `findCluster`/`findCoordinator`,
and `clusterSize` defaults to 16 — harmless for control (16 is configured anyway) but wrong for
strands, whose default is 2.

### Checked and found fine

- Restore ordering (coordinator pin before cohort force, degradation before `node.stop()`), the
  abort plumbing in the delay/hold helpers, the no-unhandled-rejection handling in the degraded
  wrapper, and `afterAll` tolerating a `beforeAll` that threw part-way.
- The expected-failure case is `it.fails`, not `it.skip`, with unweakened assertions — correct per
  the pre-existing-failures rule, and it turns red the day
  `fix/control-reads-blocked-by-stalled-write` lands.
- The relaxed approval count (`\d+/3`) is right: the pend-round count genuinely varies run to run,
  and the parts that carry the claim — cohort of 3, `needed 3`, **0 rejections** — are still pinned
  literally, so the case still proves the write failed on silence rather than on a vote against.

### Tripwires

**None added.** The two the implementer parked were re-checked and both are correctly code comments
rather than tickets: the second-round-reports-zero-approvals `NOTE:` (benign for the assertion; a
starting point only *if* control-write retry latency ever needs tightening) and the
failed-write-poisoning `NOTE:` (a single pre-pin observation that has not reproduced; a pointer for
*if* it returns).

### No pre-existing failures

Nothing outside this ticket's diff failed. `tickets/.pre-existing-error.md` was not written.

## Follow-ups left open

- `fix/control-reads-blocked-by-stalled-write` — the defect the `it.fails` case reproduces.
- `fix/transactor-key-network-ignores-network-scoping` — filed by this review.
- `plan/10-integration-test-harness-helper-consolidation-remaining-files` — this file's `nodeConfig`
  is now a row in its table, pending the `trustedOwners` decision.
- `plan/13-debt-harness-control-cohort-never-multi-peer` — why this scenario had to force the cohort
  instead of using `createTestParty`.
