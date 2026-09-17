---
description: A read of the shared party settings can end up waiting for a slow settings change to finish, because the check that is meant to send reads around in-progress writes does not notice a write that is still waiting for its turn. When one machine in the party is slow, that wait is tens of seconds, which is what made the degraded-machine integration test time out on a read.
files: packages/cadre-core/src/control-database.ts, packages/cadre-core/src/cadre-node.ts, packages/integration-tests/src/scenarios/control-write-degraded-cohort-member.integration.ts, ../quereus/packages/quereus/src/core/database.ts, ../quereus/packages/quereus/src/core/database-transaction.ts, docs/architecture.md, tickets/.pre-existing-known.md
difficulty: medium
repro: verified
---

# A control read queues behind a write that is waiting for the database

## Where this came from

Filed from the fix pass on `degraded-cohort-member-scenario-times-out-at-varying-steps`. That ticket reported `control-write-degraded-cohort-member.integration.ts` failing at a different step on each of two runs and asked whether the scenario's deadlines were too tight. The fix pass settled all three observed failures:

| Failure seen | What it is | Owner |
| --- | --- | --- |
| `Timeout waiting for B resolves C's signed address record after 45000ms` (suite setup) | The known boot wait. Already tracked. Both tickets say not to raise the 45 s: it measures how long a peer's address row takes to reach a third node. | `blocked/control-peer-row-refresh-invisible-to-third-node`, `backlog/debt-control-trio-boot-wait-is-contention-sensitive` |
| `pending conflict: block … held by unresolved action(s)` cascade: the delayed case failed at 20.5 s, then 4 more cases failed (fix-pass run, 2026-09-17 02:31Z, `tickets/.logs/degraded-cohort-varying.run1.log`) | The known wedge: one abandoned pend blocks the block for later writes. Already tracked. | `blocked/control-write-hears-zero-approvals-from-healthy-trio` |
| `degraded-cohort control op isMember (post-authorize, delayed) timed out after 15000ms` | **Not tracked before. This ticket.** | here |

So this is not one moving failure. It is three separate failures, and two already have tickets. The third one is a real defect, not a deadline that is too tight.

## The defect

`ControlDatabase.readRowsOnce` (`packages/cadre-core/src/control-database.ts`, ~line 674) chooses between two read paths:

```ts
if (this.db!.getAutocommit()) {
  iterator = this.db!.eval(sql, params);                                   // serialized: waits for the exec mutex
} else {
  iterator = this.db!.eval(sql, params, { readConcurrency: 'committed' }); // runs without the mutex, reads committed state
}
```

The comment above it says this check "races that writer harmlessly in both directions". That is only true for a race lasting a few microtasks. It is false for a write that is **queued on Quereus's exec mutex**:

- `Database.exec` takes the exec mutex before it does anything else (`../quereus/packages/quereus/src/core/database.ts`, `exec` → `_withMutex`).
- `isAutocommit` only becomes `false` when the implicit transaction begins. That happens inside the DML emitter (`_ensureTransaction`), after the write has acquired the mutex, planned the statement, and awaited `connection.begin()` on every connection (`database-transaction.ts`, `beginTransaction`).
- So while a write waits for the mutex (because another statement, such as a read, holds it), `getAutocommit()` still reports `true`. A read that arrives in that window picks the serialized path, queues on the mutex behind the write, and does not answer until the write finishes.

**Verified against the engine directly** (in-memory Quereus table, no network): a reader holds the mutex with a partly consumed iterator, then an `insert` is queued, then `getAutocommit()` is sampled. It returns `true`. A second read, routed by that sample, finished 1 ms after the write, which proves it had queued behind the write. The probe script was deleted afterwards. Its steps are: `eval` + `next()` to hold the mutex, `exec(insert)` without awaiting it, sleep 20 ms, sample `getAutocommit()`, start the read, release the holder after 500 ms, then compare finish times.

### Why it bites the degraded-cohort scenario

- Node A (the owner, and the pinned coordinator) runs `reconcileControlCohort` every 15 s (`DEFAULT_CONTROL_COHORT_RECONCILE_MS`, `cadre-node.ts` `startRecordRefresh`). While connected, that pass issues control writes: `reapRevokedRows`, `openRevocationLedgerIfDue`, and the self-record republish. The fix-pass run logged `[revocation-ledger-open]` and `[self-record-update]` writes during the degraded cases.
- While member C is degraded, every control write takes about 20 to 55 s (the header of the scenario file measures this).
- The case's `A.isMember(target)` read runs under `READ_TIMEOUT_MS` = 15 s. If it lands while one of those background writes is queued, it waits for that write and exceeds 15 s.
- Load on the machine makes this more likely but does not cause it. On a busy CPU, statements hold the mutex longer, so writes spend longer queued with `autocommit` still `true`. That fits the report that the failure only showed up with two other agents running.

**Repro status of the scenario link:** static. The engine-level mechanism is verified. The fix pass did not catch the scenario failing on this read: its one run died on the wedge cascade first, and failed writes finish fast, so they do not hold the mutex long. To confirm the link, run the scenario with `DEBUG=sereus:cadre:control-db`. When the read times out, check whether a `Control write [...]` line from A was in progress during it, and whether the read never logged `read-eval: a write is in flight`.

## Deadline question from the original ticket: answered

`READ_TIMEOUT_MS` (15 s) is a real claim, not a round number picked at random. A control read answers from local state plus at most a 1 s per-peer freshness query (`LATEST_QUERY_TIMEOUT_MS`, sync protocol, which the degradation does not touch) and a 1.5 s retry budget. **Do not raise it.** It caught this defect. The 45 s boot wait is also a real claim, and its tickets are listed above.

## Fix direction

The read has to notice a write that has **started but not yet opened its transaction**, not only one that has opened it. Options, best first:

1. **Track in-progress local writes in `ControlDatabase`.** Every Quereus write this class makes goes through `withWriteLock` (via `lockedWithRetry` / `execWrite` / `inTransaction`, plus `loadSchema`'s distributed DDL). Keep a counter of running write bodies: increment when `fn` starts, decrement in `finally`. Unlocked reads then take the committed path when `counter > 0 || !getAutocommit()`.
   - **Catch:** reads issued *inside* a locked body (the `retry = false` callers: `queryStampId`, `assertSeatRemains`, `queryCadrePeers(false)`, `revocationLedgerFiled`, etc.) must NOT switch to committed. The committed path uses a pinned snapshot that never refreshes from the network, and those guards need a fresh read. The `retry` flag already marks exactly those callers (see the NOTE on `readRows` about why `this`-state cannot tell them apart). So gate the new condition on the unlocked path only, and pass the flag down into `readRowsOnce`.
   - Also check any `this.db` writes that bypass `withWriteLock` (grep `this.db!.exec` / `this.db!.eval` outside `readRowsOnce`). A write that bypasses the lock would still be missed. Either route it through the lock or document why it cannot reach this case.
2. **Ask Quereus for the right signal.** Add something like `Database.hasPendingWriter()` / an exec-mutex depth that counts queued writers. This is more exact (it would also cover writers outside `ControlDatabase`), but it is an upstream change in `../quereus`. It also touches the same design area as `../quereus/tickets/*/feat-concurrent-reads-database-default.md`. Use it only if option 1 turns out to be leaky.

Whichever you choose, rewrite the doc comment on `readRowsOnce` so it no longer claims the race is harmless, and state the queued-writer window explicitly.

## Freshness cost (say it in the handoff)

With option 1, an unlocked read gets committed (non-refreshing) data whenever any local write is running, including the 15 s reconcile writes, which can each take tens of seconds when a member is slow. Today that only happens while a transaction is open. It is the same tradeoff the existing gate already accepts, but it now covers more time. The integration suite showed once that reads opted in unconditionally miss a sibling's `CadrePeer` publish and break suite setup (see the `readRowsOnce` comment). Re-run the degraded-cohort file and `control-cohort-three-node-isolation` to check the widened window does not bring that back.

## TODO

- Add a cadre-core spec reproducing the queue: hold the exec mutex (for example a partly consumed read), start a locked control write, then issue an unlocked control read. The read must answer without waiting for the write. Model it on the engine probe above. It should fail on HEAD.
- Implement option 1 (write-body counter, gated to unlocked reads). Thread the "unlocked" bit from `readRows` into `readRowsOnce`.
- Audit direct `this.db!` writes that bypass `withWriteLock`.
- Rewrite the `readRowsOnce` doc comment (drop "harmlessly in both directions" and describe the queued-writer window). Update the committed-read paragraph in `docs/architecture.md` if it repeats that claim (grep `readConcurrency` / `committed read`).
- Run `yarn workspace @serfab/cadre-core test` and `yarn typecheck`.
- Run `control-write-degraded-cohort-member.integration.ts` with `DEBUG=sereus:cadre:control-db`, at least 3 isolated runs. Record per run whether any `isMember`/read step timed out, and which failures were the tracked wedge or boot gate. Also run `control-cohort-three-node-isolation.integration.ts` once to check the freshness regression described above.
- Add a line to `tickets/.pre-existing-known.md` under the degraded-cohort family: the `isMember (… delayed)` 15 s read timeout is this ticket's mechanism, not contention, and the other two fingerprints from the original report are the wedge and the boot gate.
