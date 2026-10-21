description: One control-write test occasionally reports a different, equally correct reason for a write that is supposed to fail, so the whole test suite goes red about once in several runs even though nothing is broken.
files: packages/integration-tests/src/scenarios/control-write-degraded-cohort-member.integration.ts (~918-930; the file's afterEach abandoned-write check), packages/cadre-core/src/control-database.ts (updateSelfPeerRecord's in-body read, second arm), packages/cadre-core/src/control-write-retry.ts (LOST_UPDATE_RETRY_POLICY, second arm)
repro: intermittent
severity: noise
likelihood: unusual
----
# Degraded-member scenario sometimes fails on a lost conflict race instead of a super-majority shortfall

Seen 2026-09-30 in a full `yarn check` at 96231022 and later commits, on optimystic 1.8.0. "fails with a named super-majority error when a member stalls past the response deadline" received:

```
Transaction commit failed: Pend failed for collection default/cadrecontrol/CadrePeer: Conflict race lost: 1/3 member(s) hold a conflicting winner (0/3 approvals)
```

The assertion expects `Failed to get super-majority: N/3 approvals (needed 3, 0 rejections)`. The file alone then passed 3 of 3 runs (7 of 7 tests each). It had passed in the full suite at a1c0a8f0 the same day.

The write still fails, cleanly and with a named error, which is what the scenario exists to prove. Only the cause differs. The comment above the assertion records an older mechanism with this fingerprint, fixed upstream on 2026-08-12 (`member-must-answer-a-lost-conflict-race`, optimystic `c7e3506d`) and "not seen since". Either that race has a remaining window under full-suite load, or 1.8.0's longer derived deadlines let an earlier attempt's pend still hold the block when the retry arrives.

To decide:
- whether a lost conflict race is an acceptable failure here (then widen the assertion to accept both named causes, keeping the admission-gate check below it);
- or whether it points at an optimystic window worth reporting upstream. If so, capture a debug trace (`DEBUG=optimystic:db-p2p:*`) of a failing full-suite run first.

## Second arm: a boot-time self-publish is abandoned on the retry budget (added 2026-10-21, review of `cadre-peer-lost-update-is-not-re-run`)

The same file's `afterEach` check (`a control write was abandoned while the cohort was healthy`) trips at about 1 boot in 18 on a different cause. While the three nodes start, machine C's own publish of its address record and the owner's re-touch of C's row race on that row. The loser is now re-run (`LOST_UPDATE_RETRY_POLICY`), and in 8 of the first 10 reproduce boots that re-run committed. In the one failing boot, C's losing attempt itself ran 14.7 s, past the 10 s retry budget, so the write was abandoned with no retry: `[abandoned-write C] [self-record-update] budget after 1/3 attempt(s) in 14699ms: concurrent modification`. In this harness C cannot reach B, so every phase of C's attempt that waits on B pays the 7 s per-peer read deadline, and two such waits exceed the budget. It did not recur in 8 further boots logged with `DEBUG=sereus:cadre:*`, so which phases paid the two deadlines is unknown. The abandoned publish is redone by the next reconcile pass or heartbeat, as every abandoned self-publish is, so the production effect is a delayed address record, not a lost one.

To decide, after capturing a failing boot with `DEBUG=sereus:cadre:*,optimystic:*`:
- whether the budget should bound a lost-update re-run differently from a re-presentation (the policy keeps the default 10 s on purpose; the tradeoff is recorded on `LOST_UPDATE_RETRY_POLICY`), or
- whether the losing attempt's own reads can be made cheaper (the `NOTE:` in `ControlDatabase.updateSelfPeerRecord`'s body says what cannot simply move out of the locked body), or
- whether the `afterEach` check should treat a budget abandonment of a boot-time self-publish as the known residual it is, keeping the check strict for a `declined` lost update, which would mean the retry did not engage.
