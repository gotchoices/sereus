description: The safeguard that lets a second person's join survive when two people accept the same invitation at the same moment is only tested by faking the collision on one machine. A first experiment suggests that when a genuine second writer is involved, the second join can be reported as successful and then silently disappear — which would be worse than the problem the safeguard was built for. Finish the investigation and decide what to build.
files: packages/cadre-core/src/control-database.ts, packages/cadre-core/src/control-write-retry.ts, packages/cadre-core/test/control-formation-use-number-retry.spec.ts, packages/integration-tests/src/scenarios, packages/integration-tests/src/harness/node-fixtures.ts, packages/integration-tests/src/harness/fixtures/approval-hook-server.ts
difficulty: hard
----

## Status

Continuation of the original plan ticket of the same slug. A prior plan run ran ONE experiment
and hit its token budget before running the second. Everything it learned is written down below
so this run does not have to rediscover it. Remaining work is in the TODO section.

## Background (unchanged from the original ticket)

An invitation to join a strand can allow several people to use it. Each acceptance is stamped
with a sequence number — first acceptance, second acceptance, and so on — and that number is
computed by looking at what has already been recorded. If two acceptances are processed at the
very same moment, both can pick the same number, and only one of them can be stored.

An invitation can also require outside approval before an acceptance is allowed: the inviting
party's node calls a web hook, which may be a queue a **human** works through. If the node
throws away an approval it already obtained just because it lost the race for a sequence
number, that person is asked to approve the very same join a second time.

`debt-formation-approval-retry-lost-race` (complete) fixed that. The node now re-uses the
approval it already holds and simply takes the next free sequence number, up to three tries.
Approvals are deliberately not tied to the sequence number, so re-using one is safe.

## What is missing

Every test of that fix stages the collision **artificially, inside a single node** — one test
replaces the "what is the next sequence number?" lookup with a stub returning a number already
taken; another replaces the write with a stub that throws an error captured earlier from a real
collision. Both prove the recovery *loop* behaves correctly once a collision has occurred. What
neither does is produce the collision the way production produces it.

That matters because the recovery only exists for writers the node's own internal write queue
cannot see. Two acceptances handled by one node are already serialized by that queue and never
collide. The recovery is there for **a second node of the same cadre**, or a second database
handle over the same store, committing a sequence number in the window between this node
reading one and writing it.

So the untested question is not "does the retry loop work" — it does — but "does a genuine
two-writer race actually surface as one of the two errors the node recognises, and does the
recovery actually converge?"

## Findings so far

### Experiment 1 — two database handles over one store (RUN, and the result is alarming)

Recipe (a temporary spec under `packages/cadre-core/test/`, since deleted):

- boot one `CadreNode` with an empty bootstrap list and the `transaction` profile;
- take its own `ControlDatabase` as handle A (`node.getControlDatabase()`);
- build handle B as a SECOND `ControlDatabase` over the *same* libp2p node and the *same*
  `coordinatedRepo`, with the same `partyId`, and `initialize()` it. (`coordinatedRepo` is read
  off the control libp2p node the same way `CadreNode` reads it — see `cadre-node.ts` ~line 614.)
  The second `initialize()` succeeds: its hydrate-before-apply path finds the tables already
  present and re-emits no DDL;
- through A, insert a `Strand` and a strand-bound `FormationInvite` with `totalUses: 2`;
- confirm B sees both (it does — B read back the invite row and the strand's stamp id);
- start `A.recordFormationUsage(...)` and `B.recordFormationUsage(...)` in the same tick, each
  with its own freshly minted consent, and `Promise.allSettled` them.

Observed:

```
EXP: A FULFILLED useNumber=1
EXP: B FULFILLED useNumber=1
EXP: A view rows = [{"UseNumber":1,"UsageStampId":"e7i8ry02HRAzP7yGZF_qpN4XtLUcEGmsHEXh-gjAjqw"}]
EXP: B view rows = [{"UseNumber":1,"UsageStampId":"e7i8ry02HRAzP7yGZF_qpN4XtLUcEGmsHEXh-gjAjqw"}]
```

Both writers were told they succeeded, **both under use number 1**, and afterwards exactly ONE
`FormationUsage` row exists — the same one in both handles' views. One of the two joiners was
told it was seated and has no row.

Read that carefully before acting on it. It does not say the retry is broken; it says the retry
was never reached, because **no error was raised at all**. `isLostUseNumberRace` cannot classify
a failure that never happens. If this shape holds for two real nodes, the gap is not "a third
error the classifier does not recognise" (the risk the original ticket named) but a silent lost
update, which is strictly worse and is a different fix.

Two things this experiment does NOT establish, and which must not be assumed:

- **Which handle's row survived.** The recipe did not record A's and B's minted `UsageStampId`s
  before racing, so the surviving row cannot be attributed. Re-run with both stamp ids captured
  up front; "the later writer's row won" and "the earlier writer's row won" have different
  implications.
- **Whether the shape is representative of production.** Both handles share ONE `coordinatedRepo`
  instance and one libp2p node, so both commits go through the same local repo with a self-only
  cohort (`allowClusterDownsize`). A real second cadre node has its own repo and commits through
  the cluster coordinator against a ≥2-member cohort — a different code path, and the one
  production actually runs. Experiment 2 is what settles this.

### Experiment 2 — two real nodes (NOT YET RUN — this is the decisive one)

Not started. Everything needed to write it was gathered:

- `bootPair(tag)` in `packages/integration-tests/src/harness/node-fixtures.ts` boots node A
  (owner, `storage` profile) and node B (plain reader, `transaction` profile) on one fresh party,
  disconnected, with A already vouching B. `connectControlNodes(B, A)` then forms the cohort and
  waits for BOTH sides to report the connection.
- `waitForControlCohort(party, 2)` in `harness/control-cohort.ts` is the instrument for proving
  the cohort really spans two machines — a one-member cohort commits on the writer's own vote, so
  a passing write proves nothing about multi-machine consensus on its own. `bootPair` returns
  bare `CadreNode`s rather than a `TestParty`, so either build the wait off
  `readCohort(node.getControlNode()!)` directly or use the `TestParty` path instead.
- `ApprovalHookServer` (`harness/fixtures/approval-hook-server.ts`) is a real in-process HTTP
  approver with a `requestCount` — it is the counter the "asked exactly twice" assertion needs,
  over a real socket and a real signature, with no stubbing.
- `control-db-two-node-convergence.integration.ts` is the shortest worked example of the
  boot → connect → write-on-A → converge-on-B recipe.

### Background on why a lost update is plausible here

Optimystic's `Collection.sync` (`../optimystic/packages/db-core/src/collection/collection.ts`)
retries `StaleFailure` *return values* and, on conflict, calls `replayActions()` to re-stage
pending logical actions against the updated base. The SQL-layer constraint decision (the
`(Token, UseNumber)` primary key probe, and the deferred `Monotonic` CHECK that reads
`committed.FormationUsage`) was already made against the pre-replay snapshot. Whether that
decision is re-made after a replay was not traced to a conclusion, and tracing it through two
foreign repos is a poor use of time compared with just running experiment 2 and reading the
answer off the wire.

## What "done" looks like for THIS ticket

Not a test — a settled decision, expressed as implement ticket(s) (or, if a genuine question of
consequence has no defensible default, a `blocked/` ticket). Concretely: run experiment 2, then
pick one of these and write it up.

- **Case A — a real cross-node race raises one of the two recognised errors and the retry
  converges.** Then the original plan stands: emit ONE implement ticket for the integration
  scenario described under "The scenario to build" below.
- **Case B — it raises some third error.** The classifier needs a third arm. That is a
  `fix/` ticket (a reachable defect: the joiner is told to start over and the human approver is
  re-asked) plus the scenario that pins it, chained with `prereq:`.
- **Case C — no error at all, as experiment 1 showed.** This is a silent lost update and is
  the most serious outcome. Do not file it as a test-coverage ticket. Name the one site that must
  change (SQL layer? optimystic collection replay? the write path in `control-database.ts`?) and
  file a `fix/` ticket; if the site turns out to be in `../optimystic` rather than this repo, that
  is a dependency outside this repo and belongs in `blocked/` with the repro recipe attached.

### The scenario to build (Case A, and still the acceptance target in B and C once fixed)

A test in `packages/integration-tests` (real network, two real nodes — this cannot live in
`cadre-core`'s unit suite) where:

- one invitation permits at least two acceptances and requires approval from a hook that
  counts how many times it is asked;
- two nodes redeem it concurrently, without either being told to wait for the other;
- both acceptances end up recorded, numbered 1 and 2, with no gap and no duplicate;
- the approval hook was asked **exactly twice** — once per joiner. A third ask is the
  regression this whole line of work exists to prevent;
- each stored acceptance still carries the joining peer's own key, signature, and disclosure
  exactly as submitted.

And the negative case: an invitation permitting only ONE acceptance, redeemed concurrently by
two nodes, leaves exactly one acceptance recorded and refuses the other in a way the joiner is
not told to retry.

### On flakiness

If the race turns out to be hard to provoke reliably over a real network, say so in the implement
ticket rather than weakening the assertions — a flaky test here is worse than none. Note that
experiment 1 provoked it on the FIRST attempt with a plain same-tick `Promise.allSettled`, so a
naturally-occurring race looks easy to produce, not hard; the risk is the opposite one, that a
test written before the underlying behaviour is settled will be flaky *because the behaviour is*.

## Edge cases the eventual implement ticket must name

Carried forward so they are not lost — the implementer covers them and the reviewer checks them:

- **Cohort size.** A one-member cohort commits on the writer's own vote, so the scenario must
  establish a ≥2 cohort before racing or it proves nothing about two machines.
- **Which node observes the final state.** Both nodes' views must agree; asserting only on the
  writer's own view would miss exactly the lost update experiment 1 surfaced.
- **Attribution.** Assert on `UsageStampId` / `PeerKey`, not just on the set of use numbers —
  `[1, 2]` can hold while both rows belong to the same joiner.
- **The approval count is a hard equality, not a lower bound.** `>= 2` would pass the regression.
- **Retry-loop interaction.** `withUseNumberRetry` sits OUTSIDE `lockedWithRetry`, so a transient
  cluster failure retries inside a use-number attempt. The two classifiers are documented as
  disjoint; a real cross-node failure is the first thing that can test that claim against a live
  cluster rather than against literals.
- **Bounded attempts.** `USE_NUMBER_ATTEMPTS` is 3. Two racing writers should converge well
  inside that; a scenario that needs more than 3 is reporting a real problem, not a flaky test.
- **Teardown on the failure path.** A wait that throws inside `beforeAll` leaves nodes running;
  the scenario must still stop both nodes and close the hook server.

## TODO

Phase 1 — settle the behaviour

- Re-run experiment 1 with both minted `UsageStampId`s captured BEFORE the race, so the surviving
  row can be attributed. (Recipe is in "Findings so far"; it took ~20 s to run.)
- Write and run experiment 2: two real `CadreNode`s via `bootPair` + `connectControlNodes`,
  cohort confirmed ≥2, one strand-bound invite with `totalUses: 2`, both nodes calling
  `recordFormationUsage` in the same tick. Record, for each writer: fulfilled/rejected, the use
  number, the exact error text and its `cause` chain, `isLostUseNumberRace(e)`,
  `isRetriableControlWriteFailure(e)`, and the final `FormationUsage` rows as seen from BOTH nodes.
- Note that vitest in this repo did not surface `console.log` from these specs; experiment 1 wrote
  its output to a file with `appendFileSync` instead. Do the same rather than losing a run.
- Delete the experiment spec(s) afterwards — they are instruments, not deliverables.

Phase 2 — write it up

- Decide Case A / B / C from the evidence and emit the corresponding ticket(s), chained with
  `prereq:` where a fix must land before the scenario that pins it.
- Carry the "Edge cases the eventual implement ticket must name" section into whatever implement
  ticket results, as its `## Edge cases & interactions`.
- If Case C lands in `../optimystic`, the `blocked/` ticket must be readable by a human with no
  context: state plainly that two machines accepting the same invitation at once can both be told
  they succeeded while only one is recorded, and attach the repro recipe.
