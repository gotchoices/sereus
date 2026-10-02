description: One control-write test occasionally reports a different, equally correct reason for a write that is supposed to fail, so the whole test suite goes red about once in several runs even though nothing is broken.
files: packages/integration-tests/src/scenarios/control-write-degraded-cohort-member.integration.ts (~918-930)
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
