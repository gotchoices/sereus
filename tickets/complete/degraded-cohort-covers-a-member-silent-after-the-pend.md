description: The degraded-machine test scenario now covers a machine that answers the first step of a shared-database write and then goes silent: the write fails with a clear error after about 189 s, and once the machine is back the next write to the same table commits.
architecture: docs/cadre-consistency.md#deadlines-over-optimystics-reads-and-commits
files: packages/integration-tests/src/scenarios/control-write-degraded-cohort-member.integration.ts (`silenceAfterPend`, `actionIdsOf`, `TRANSACTION_COMMIT_ATTEMPTS`, `SILENT_AFTER_PEND_*` constants, the case "fails in its commit when a member goes silent after answering the pend…"), docs/cadre-consistency.md, tickets/.pre-existing-known.md
----
# The degraded-cohort scenario covers a member that goes silent after answering the pend

## What landed

The sixth of eight cases in `control-write-degraded-cohort-member.integration.ts` lets cohort member C answer a control write's pend (the first consensus phase), then silences C from that write's commit onward. `silenceAfterPend` replaces `processOperation` on C's db-p2p `ClusterService`: it records the action ids of pends whose serialized message contains the target peer id, and holds unanswered the first commit for one of those actions and every request after it, until `restore()` makes the held requests throw, which aborts their streams. Because the method is looked up per request, no pre-swap stream abort is needed.

The case asserts that C saw that commit (so the write did not fail in its pend instead), that the write fails with `Failed to get super-majority: \d+/3 approvals (needed 3, 0 rejections)` between one round (21 s) and 210 s after C went silent, that the forced 3-peer cohort was consulted, that the target is not a member afterwards, and that after C returns the same `authorizePeer` commits and reads back.

The time is nine response-deadline rounds, 189 s: `authorizePeer` writes two trees (`CadrePeer` and its unique index), so the Quereus plugin commits them through Optimystic's `TransactionCoordinator`, whose `commitCollection` makes three attempts on a thrown commit, each two rounds; then three cancel rounds. The cancel also misses the bar, stays owed, and is re-sent before the next pend (Optimystic 1.14.0). `docs/cadre-consistency.md` gives the 189 s figure and the longer write-lock hold.

Landing commit: `ticket(implement): degraded-cohort-covers-a-member-silent-after-the-pend`, plus this review's edits.

## Review findings

**Checked:**
- The implement diff, read before the handoff.
- The db-p2p seam. `ClusterService.processOperation` is public, typed against `ClusterRequest`, and called per request from `handleIncomingStream`. A throw from the replacement goes to that method's catch, which calls `stream.abort`. That catch is separate from the one inside `processOperation` that wraps errors in an envelope, so the "restore aborts the held streams" claim holds.
- The timing derivation against upstream source:
  - `db-core/src/transaction/coordinator.ts` `commitCollection` loops `attempt < 3` and retries only on a throw.
  - `quereus-plugin-optimystic/src/optimystic-adapter/txn-bridge.ts` `commitDirtyTreesLegacy` sends one tree through `tree.sync()` (a single attempt) and several trees through the coordinator.
  - So the doc's qualifier "a write that spans several collections" is accurate.
- The bounds philosophy. The floor matches `FAILURE_FLOOR_MS`'s purpose: an instant failure means the response-deadline path never ran.
- The second cancel-round `NOTE` on `STALLED_CANCEL_ROUNDS` (a slow box can run two cancel rounds, not three) applies here too. It would give 168 s, which still passes, so nothing is pinned from below.
- The marker scoping. Background writes go through the same coordinator, but only a pend that carries the random target id arms the silence.
- Docs: the header, the measured table, the fingerprint list, `docs/cadre-consistency.md`, and the `.pre-existing-known.md` delta. No other doc mentions the old 137 s figure or the old "not covered" wording.
- `releaseOptimysticPlugin`'s `dispose()` path is unchanged.

**Ran:**
- `yarn workspace @serfab/integration-tests typecheck`: clean.
- ESLint on the file: clean.
- The case alone (`vitest run control-write-degraded-cohort-member -t "silent after answering"`): every assertion in the case body passed. C went silent 204 ms after the call, the write failed 189.39 s later with `2/3 approvals`, and the write after C returned committed in 406 ms. The run still went red, in the case's `afterEach`, on B's and C's boot-time `[self-record-update]` `concurrent modification` on `CadrePeer`. That failure is tracked: the `in-flight` entry for `cadre-peer-lost-update-is-not-re-run` in `.pre-existing-known.md`. With a `-t` filter that skips the healthy case, the first selected case reports those boot losses. That record only named the healthy case, so I added this to it. Not re-reported.
- The whole file was not re-run (about 8.6 minutes, close to the agent limit). The implement pass's whole-file run had the new case passing.

**Fixed inline (minor):**
- The comment before the post-failure `isMember` check said "No member signed the commit". A and B did sign (`2/3 approvals`). It now says the commit never reached the unanimity bar, so no member applied it.

**Considered, no change:**
- *Ceiling headroom over nine rounds* (the handoff's question). The case's ceiling is 21 s above the expected 189 s. Measured overrun is about 0.4 s across nine rounds (189.34–189.5 s over five measurements), roughly 0.05 s per round, against about 2.3 s per round of allowance. That is ample, so the bound is unchanged.
- *The test does not prove whether the owed-cancel re-send or its timer cleared the pending record.* The case asserts the property users see, that the next write commits, and upstream's mesh spec pins the re-send path. Correct as written.
- *`TRANSACTION_COMMIT_ATTEMPTS` restates a private upstream literal.* Same treatment and comment pattern as `CANCEL_BUDGET_MS`. A higher upstream count trips the ceiling with the measured time. A lower one would pass silently, which is acceptable because the assertion is about the outcome, not the round count.
- *Structural cast to `services.cluster`.* It fails loudly at the start of the case if db-p2p renames the key. Same pattern as the registrar cast.
- *`restore()` assigns the bound original back as an own property instead of deleting the override.* Behaves the same, so left alone.
- *File size: 1491 lines* (`wc -l`), up from about 1320. The file is one scenario with shared boot and helpers, and the new code is a helper plus one case. Splitting would duplicate the 240 s boot. No ticket.

**Not traced, not ticketed:**
- *The 10.5 s wait before the pend in 2 of 3 of the implement pass's filtered runs.* A background `CadrePeer` write held A's write lock after a `commit-not-durable` refusal. This review's run waited 204 ms. It falls outside the bounds, which start at the silence, and it happens during boot-time background writes on `CadrePeer`, the area `fix/cadre-peer-lost-update-is-not-re-run` is working on. Recorded here only. If it ever grows past one round, it would show up as the case's hang deadline (231 s) firing.

**Tests:**
- The one new integration case pins a named behaviour: a commit-phase failure against a silent member, then recovery through the owed cancel. It does not restate the implementation. No tests cut, none added.

**Tripwires added:** none. The conditional concerns above already have `NOTE:`s on `STALLED_CANCEL_ROUNDS` and `CANCEL_BUDGET_MS`.
