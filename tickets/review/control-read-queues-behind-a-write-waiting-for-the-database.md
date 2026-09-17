description: A read of the shared party settings could wait for a slow settings change to finish, because the check meant to send reads around in-progress writes missed a write still waiting for its turn at the database. Reads issued outside a write now also take the non-blocking path whenever a locked write is running.
files: packages/cadre-core/src/control-database.ts, packages/cadre-core/test/control-read-routing.spec.ts, docs/architecture.md, tickets/.pre-existing-known.md, tickets/backlog/bug-control-read-waits-behind-an-explicit-transaction-commit.md, packages/integration-tests/src/scenarios/control-write-degraded-cohort-member.integration.ts, packages/integration-tests/src/scenarios/control-cohort-three-node-isolation.integration.ts
----

# Control read no longer queues behind a write waiting for the database

## The defect (recap)

`ControlDatabase.readRowsOnce` chose the committed-read path (`readConcurrency: 'committed'`, runs off Quereus's exec mutex) only when `getAutocommit()` was false. A write that is still *waiting* for the exec mutex has not opened its implicit transaction yet, so it reports autocommit. A read arriving in that window took the serialized path, queued on the mutex behind the write, and answered only after the write's whole commit. Against a degraded cohort member that is 20 to 55 s. That matches the `isMember (post-authorize, delayed) timed out after 15000ms` failure in the degraded-cohort scenario.

## What changed

All in `packages/cadre-core/src/control-database.ts`:

- `runningWriteBodies`: a counter, incremented and decremented by the new `runWriteBody` wrapper that `withWriteLock` now runs each body through (decrement in `finally`, so a throwing body is uncounted).
- `writeInFlight(underWriteLock)`: true when a transaction is open, or, for a read issued **outside** a locked body, when any locked body is running.
- `readRowsOnce(sql, params, underWriteLock)`: routes on `writeInFlight`. `readRows` passes `underWriteLock = !retry`, because `retry: false` already marks exactly the reads issued inside a locked body. Those reads keep the old transaction-only test, since they need the refreshing path and they are the body being counted.
- The debug line now names which signal fired: `read-eval: a write is in flight (transaction open | locked body running, no transaction open yet), asking for a committed read: …`. Use it to confirm the scenario link on a failing run.
- The doc comment on `readRowsOnce` is rewritten. It drops the "races harmlessly in both directions" claim, describes the queued-writer window, explains why the sample-then-`eval` ordering is race-free (eval claims its mutex slot in the same tick), lists the residual gaps, and adds a `NOTE:` tripwire on the widened freshness window.
- `docs/architecture.md`: the committed-read paragraph now defines "in flight" and names the two remaining gaps.

## Audit: writes that bypass `withWriteLock`

Every direct `this.db!.exec` in `control-database.ts` runs inside a locked body. The call sites are `deleteStrandAndPartyKey`, `insertCadrePeer`, `reauthorizeCadrePeer`, `deleteGuardedRow`, the `mutateCadrePeer` reap, `reissueRevocations`, `openRevocationLedger`, the redemption body, and `execFormationUsageInsert`; `loadSchema` goes through `lockedWithRetry`. Outside the class, the only production raw write on the control `Database` is `reference-app-web/src/lib/cadre-web.ts` `attemptUnauthorizedStrandWrite`, a diagnostics probe that is expected to be rejected. It is not counted, and the doc comment says so. Nothing was rerouted.

## Tests

New `packages/cadre-core/test/control-read-routing.spec.ts` (4 cases, real `CadreNode` control DB):

1. **The repro.** A serialized read holds the exec mutex, `insertStrand` is started and reaches `exec` (asserts `getAutocommit()` is still true), then `getOwnerKeys()` must answer within 2 s while the mutex is still held. Without the fix it fails with `'queued-behind-write'`.
2. A `withWriteLock` body parked before any statement: an unlocked read asks for `committed`. Without the fix it fails with `['serialized']`.
3. After a body **throws**, an unlocked read is back on the serialized path. This pins the `finally` decrement.
4. `insertCadrePeer`'s in-body stamp guard stays serialized. It fails if `underWriteLock` is ignored (checked by temporarily removing the flag).

Each of cases 1, 2 and 4 was confirmed to fail with its part of the fix disabled, then restored.

## Validation run

- `yarn workspace @serfab/cadre-core test`: 133 files passed, 1 failed (2175 passed, 1 skipped). The one failure is `control-start-storage-op-budget.spec.ts`, which is **pre-existing and tracked** in `.pre-existing-known.md` under `blocked/warm-restart-into-declared-schema-diverges-from-declaration`. It fails identically with this ticket's change disabled. Its fingerprint changed today after `../optimystic` `06a938ed` was built (warm restart is now 13 ops, below the spec's lower floor of 22); a note was added to that entry.
- `yarn workspace @serfab/cadre-core typecheck` and eslint on the changed files: clean. The root `yarn typecheck` was not run; only the cadre-core workspace was checked.
- `control-write-degraded-cohort-member.integration.ts` with `DEBUG=sereus:cadre:control-db`, 3 isolated runs: **7/7 green all three times** (328 s, 314 s, 292 s). No `isMember`/read timeout, no boot-gate failure, no `pending conflict` wedge. The delayed case took 110 to 130 s and passed. Logs: `tickets/.logs/control-read-queues-behind-a-write.degraded.run{1,2,3}.log` (about 400 committed-read lines per run; these runs predate the log-line reason, so they cannot show which signal fired).
- `.pre-existing-known.md` gained an entry saying the `isMember … delayed` 15 s timeout is this mechanism, and that the other two fingerprints are the boot gate and the abandoned-pend wedge.

## Known gaps: reviewer, please treat these as open

- **`control-cohort-three-node-isolation.integration.ts` was NOT run.** The ticket asked for one run to check that the wider stale-read window does not bring back the "misses a sibling's `CadrePeer` publish" failure. The stale-build guard refused: another session had uncommitted, unbuilt edits in `../optimystic` (`db-core` network-transactor, `quereus-plugin-optimystic` collection-factory) at the time. Rebuilding someone else's in-progress work was not appropriate. Run it once when `../optimystic` builds clean. Note that the file is already listed as failing on the boot gate (`control-peer-row-refresh-invisible-to-third-node`), so compare fingerprints, not pass/fail. `packages/cadre-core` was rebuilt after the final source change, so integration runs will pick it up.
- **The scenario link is still not proven.** The three green runs were on a lightly loaded machine, and the original failure needed contention. They show no regression, not that the timeout is gone. On any future failing run, look for a `(locked body running, no transaction open yet)` line from node A around the read.
- **Freshness cost.** Unlocked reads now serve committed, non-refreshing state for the whole of a locked body: its time before the transaction opens, plus its post-commit tail (a `CadrePeer` write's membership-listener read). Previously that only applied while a transaction was open. The slow part of a degraded write, its commit, was already in the old window. A `NOTE:` at `readRowsOnce` says what to narrow if polling for replicated rows ever starves behind back-to-back local writes.
- **Explicit transactions are still a gap**, filed as `backlog/bug-control-read-waits-behind-an-explicit-transaction-commit`. Quereus refuses committed reads while an explicit transaction is open, so a read overlapping an `inTransaction` commit (guarded deletes, revocation reissue, redemption) still waits. The same ticket records a static-only suspicion that an unlocked read landing between an explicit transaction's statements sees its uncommitted rows.
- Option 2 from the implement ticket (a Quereus "queued writer" signal) was not pursued. The counter covers every writer in this repo except the diagnostics probe above.
