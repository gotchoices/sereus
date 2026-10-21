description: The degraded-machine test scenario now covers a machine that answers the first step of a shared-database write and then goes silent: the write must fail with a clear error, and once the machine is back the next write to the same table must succeed. Review the new test case, its timing bounds, and the doc updates.
architecture: docs/cadre-consistency.md#deadlines-over-optimystics-reads-and-commits
files: packages/integration-tests/src/scenarios/control-write-degraded-cohort-member.integration.ts (`silenceAfterPend`, `actionIdsOf`, `TRANSACTION_COMMIT_ATTEMPTS`, `SILENT_AFTER_PEND_*` constants, the new `it` before the transient-reset case, header and comment tables), docs/cadre-consistency.md (~52 and ~56), tickets/.pre-existing-known.md (2026-10-12 delta), tickets/.pre-existing-error.md (new, unrelated boot-time failure)
----
# Review: the degraded-cohort scenario covers a member that goes silent after answering the pend

## What was built

A new case in `control-write-degraded-cohort-member.integration.ts`, sixth of eight: "fails in its commit when a member goes silent after answering the pend, and the next write commits once it returns".

**Injection (`silenceAfterPend`).** It replaces `processOperation` on C's db-p2p `ClusterService` (reached as `controlNode.services.cluster`, a test-only cast like the registrar one). Requests pass through until the first one carrying a commit operation for an action whose pend contained the target peer id (rows travel as JSON, so the pend's serialized message contains it). That request and every later one are held unanswered until `restore()`, which makes them throw, so the service aborts their streams. This seam was chosen over the protocol-handler swap the other cases use for two reasons. Deciding needs the decoded request, which is first visible here. And because the method is looked up per request, a stream prepared before the swap is held too, so `abortPreSwapStreams` is not needed. Matching on the target's pend scopes the silence to the write under test: the three nodes' background self-record writes go through the same coordinator, and a heartbeat (every 7.5 min) can land at any moment in an 8.6-minute file.

**Assertions.**
- C saw a commit for the write whose pend it answered (`silencedAt()` defined). This is the anti-vacuity check: without it the write could have failed in the pend, which is the stalled case's path.
- The write fails with `Failed to get super-majority: \d+/3 approvals (needed 3, 0 rejections)`.
- The time from C going silent to the failure is within [`STALLED_ROUND_MS`, `SILENT_AFTER_PEND_FAILURE_MS + STALLED_ROUND_MS`], i.e. [21 s, 210 s].
- The forced 3-peer cohort was consulted.
- The target is not a member afterwards.
- After `releaseDegradation()`, `authorizePeer` of the same target commits within `WRITE_TIMEOUT_MS`, and the target reads back as a member.

**The timing differs from the ticket's ~137 s.** On Optimystic 1.17.0, `authorizePeer` writes two collections (`CadrePeer` and its unique index), so the Quereus plugin commits them through `TransactionCoordinator`. Its `commitCollection` retries a thrown commit three times (a literal in db-core), and each attempt is two rounds (the one-round commit, then the tail). That gives six commit rounds, then three cancel rounds: 9 × 21 s = 189 s, measured at 189.34, 189.36 and 189.46 s. The 137 s figure came from the 1.13.0 report, where the write was a single-collection `Collection.sync` and C went silent in the middle of the pend. `TRANSACTION_COMMIT_ATTEMPTS = 3` restates the literal, with a comment pointing at `CANCEL_BUDGET_MS`'s reason. The bounds are measured from the moment C goes silent, not from the call, so the wait for the write lock and the pend fall outside them. The overall hang deadline is one more round above the ceiling (231 s).

**Docs and records.**
- Header: the "NOT covered" paragraph is gone. In its place, a paragraph naming `silenceAfterPend`, an outcome bullet, and a row in the measured table.
- New fingerprint bullet: C's background `[self-record-update]` gives up with `pending conflict … held by unresolved rival action(s) tx:<id>` inside this case's window. This is expected, because the write under test holds the block until its owed cancel lands. It was seen twice in the full run, both labelled "inside a deliberately degraded window".
- `docs/cadre-consistency.md`: the 137 s paragraph now gives the 189 s, three-attempt figure, and says the path is covered. The write-lock paragraph names the longer hold.
- `.pre-existing-known.md`: the 2026-10-12 delta now says what that wording means inside versus outside this case.

**Constraint check.** `releaseOptimysticPlugin`'s `dispose()` path still calls only `collectionFactory.dispose()`. Nothing calls `NetworkTransactor.stop()` there, and that code was not touched.

## Tests added

- The case above: one integration case for the named behaviour (a commit-phase failure against a silent member, then recovery through Optimystic 1.14.0's owed cancel). No unit tests. The helper is test plumbing.

## Validation

- `yarn workspace @serfab/integration-tests typecheck`: clean. ESLint on the file: clean.
- The new case alone (`yarn workspace @serfab/integration-tests exec vitest run control-write-degraded-cohort-member -t "silent after answering"`): run 1 hit the first-draft 147 s hang deadline, and run 2 failed the first-draft 126 s ceiling. Those failures exposed the three-attempt commit, and the bounds were re-derived. Run 3 passed: silent from 10.9 s, failed 189.3 s later, next write 458 ms. Its debug log, `tickets/.logs/degraded-cohort-silent-after-pend.debug2.log`, shows the next write's pend re-sending the owed cancel (`cancel:owed-discharged … attempts=1 stoodMs=309`, before the pend line), not the timer. The commit-round timeline is in `…debug.log`.
- Whole file in isolation, the same command without `-t`: **7 passed, 1 failed, 518 s** (`tickets/.logs/degraded-cohort-full.log`). The new case passed: silent from 0.6 s, failed 189.5 s later, next write 1.44 s. The transient-reset case after it passed. The failure was the first case, "commits with a healthy three-member cohort". Its `afterEach` reported two background writes lost during the trio's boot, before any new code runs: A's `[peer-reauthorize]` (the write-while-alone drain re-touching B's row) and C's `[self-record-update]`, both `concurrent modification` on `CadrePeer`. That is the class in `backlog/bug-owner-write-racing-a-machines-own-publish-fails`, and it is not in `.pre-existing-known.md`, so it is reported in `tickets/.pre-existing-error.md` for triage. It appeared in 1 boot of 4.
- The whole file takes about 8.6 minutes, close to the 10-minute agent tool limit. It was run detached (`nohup … &` writing to `tickets/.logs/`), and the log was followed in the foreground.

## Known gaps and things to look at

- **Only one whole-file run, and two passing runs of the case with its final bounds.** The case's ceiling has about 21 s of headroom over a 189.4 s measurement. A box whose rounds each overrun by about 2 s would exceed it. That is the same headroom rule as `FAILURE_CEILING_MS`, but over nine rounds rather than four. Consider whether nine rounds of per-exchange overhead warrant more.
- **The case does not prove the pend path rather than the timer cleared the record.** The debug log shows the pend did it, but if the write lock delayed the next write by more than about a second, the timer would get there first and the case would still pass. The assertion is the user-visible property (the next write commits). Upstream's mesh spec pins "lands on its first pend".
- **An unexplained 10.5 s wait before the pend, in 2 of 3 filtered runs.** Right after `beforeAll`, A's write lock was held by a background `CadrePeer` write (`nnE56L…`) whose commit came back `commit-not-durable`. Its cancel then took about one response deadline with all three members healthy, before `silenceAfterPend` was installed. It does not affect the bounds, which start at the silence, but the cause was not traced. In the full run the wait was 0.6 s.
- `TRANSACTION_COMMIT_ATTEMPTS` mirrors a private literal upstream. If Optimystic changes it, the ceiling assertion will report the new round count.
- `silenceAfterPend` reaches `services.cluster` by a structural cast. If db-p2p renames the service key, the helper throws on `undefined.processOperation` at the case's start, not silently.
