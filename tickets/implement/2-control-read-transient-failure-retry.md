description: Writes to the shared party database already survive a brief network hiccup by being retried; reads do not, so a momentary blip makes an ordinary lookup fail outright. Give reads the same bounded second chance, with a shorter deadline and a narrower idea of which failures are worth repeating.
files: packages/cadre-core/src/control-database.ts, packages/cadre-core/src/control-write-retry.ts, packages/cadre-core/src/membership-connection-gater.ts, packages/cadre-core/src/index.ts, packages/cadre-core/test/control-write-retry.spec.ts, packages/cadre-core/test/control-write-lock.spec.ts
difficulty: hard
----

# A retry seam for control-database reads

## What is true today (measured, 2026-09-01)

Every control **write** funnels through `ControlDatabase.lockedWithRetry` →
`retryControlWrite` (`control-write-retry.ts`), which re-presents a transiently-failed write
up to 3 times inside a 10 s budget.

Every control **read** funnels through `ControlDatabase.readEval` (line ~597) — all 15 read
call sites in the class are `for await (const row of this.readEval(...))` — and that funnel
has no retry at all. One failure ends the read.

Confirmed by a throwaway spec run against a real `CadreNode` on 2026-09-01: with the
underlying Quereus `Database.eval` rigged to reject once during iteration,
`queryRevokedStamps('CadrePeer')` rejected after **exactly one** `eval` call, while the same
injected failure against `exec` was absorbed and `execWrite` committed on its **second**
attempt. The harness recipe is at the bottom of this ticket — it works and should be the
basis of the new spec.

**`readEval` is already the one seam.** The architectural fix is to make that seam own the
policy, not to retry any individual query.

## The shape the seam must take

`readEval` returns a lazy `AsyncIterableIterator`, so the failure happens during *iteration*,
not at call time. A retry has to own the drain — you cannot retry a half-consumed iterator
without re-yielding rows the caller already saw.

So replace the iterator seam with a collecting one:

```ts
/** Drain a control read to rows, retried per CONTROL_READ_RETRY_POLICY. */
private readRows(sql: string, params?: SqlParameters, label?: string): Promise<Record<string, SqlValue>[]>

/** Drain a control read with NO retry — for reads inside an already-retried write body. */
private readRowsOnce(sql: string, params?: SqlParameters): Promise<Record<string, SqlValue>[]>
```

Both keep `readEval`'s existing committed-read opt-in (the `getAutocommit()` check and the
`readConcurrency: 'committed'` argument) — and that check must be re-evaluated **inside each
attempt**, because a write can finish between attempts and change the right answer.

Materializing is safe: every existing call site either drains to an array already, or
`return`s on the first row of a statement that yields at most one row (a primary-key lookup
or a `count(1)`). Nothing streams.

## Which read failures are worth repeating

This is the question the fix ticket left open, and it is **not** "the write classifier minus
its commit veto". It is a different set in both directions.

**The error text is all that survives.** `quereus-plugin-optimystic`'s
`OptimysticVirtualTable` catches every scan-path error and rethrows
`new Error('Query failed: ' + message)` **with no `cause`**
(`../optimystic/packages/quereus-plugin-optimystic/src/optimystic-module.ts` ~1153). Quereus
then wraps that as `Error during query on table '<T>': …` preserving `cause`
(`../quereus/packages/quereus/src/runtime/emit/scan.ts:227`). So the typed
`BlockUnavailableError` and its `reason` field are destroyed before they reach this repo —
classify by **text**, walking the `cause` chain with `unwrapError`, exactly as the write
classifier does. Like every matcher there, this fails **closed**: an upstream rewording stops
the retry engaging, it never makes it unsafe.

### Retriable

- **The transactor's read-phase aggregate.** `Some peers did not complete: <peer>[block:<id>](<status>)`.
  This is `isUncommittedTransactorAggregate` from `control-write-retry.ts`, reusable verbatim:
  a `get` batch formats the single-block `[block:` token, and a read can never produce the
  commit-phase `[blocks:` token that `reportsIndeterminateCommit` vetoes. This is the class
  that killed `CadreNode.registerSelf`'s own-row read in 23–28 ms.
- **`Block <id> is unavailable (peers-unreachable)`.** Upstream's own definition: part of the
  cohort answered and part could not be asked, **and other coordinators are reachable, so
  asking one of them can still settle it** (`../optimystic/packages/db-core/src/network/struct.ts` ~208).
  A second attempt is exactly what that reason invites.
- **`Block <id> is unavailable (cohort-unreachable)`.** Weaker case, include it anyway. Upstream
  says the answer will not improve until the node's connectivity does — but during bring-up
  connectivity *does* improve within a second, which is the boot-time failure shape recorded in
  `blocked/control-read-over-fresh-edge-stream-resets`. The cost of being wrong is bounded by
  the read budget below, and that bound is the whole reason it is safe to include. Note in the
  code that this is the marginal member of the set.

### NOT retriable

- **`Block <id> is unavailable (claimed-elsewhere)`.** A cohort peer positively claims the block
  exists and nobody could corroborate or acquire it. **Measured not to clear**: reissuing the
  same call every second for 60 s returned the identical error every time (fix ticket, 2026-08-20).
  Retrying spends the whole budget and fails anyway. Root cause is upstream and already tracked
  by `blocked/block-held-by-only-one-machine-is-unreadable` — do not chase it here, and do not
  let the new retry paper over it.
- **`Block <id> is unavailable (unmaterializable)`.** Records are held locally but cannot be
  reassembled. A local data problem; a second read reads the same records.
- **`Block <id> may be stale` (`BlockPossiblyStaleError`).** About currency, not existence. A
  cohort claim no reachable coordinator could confirm or refute will not resolve inside a few
  hundred milliseconds of backoff.
- Anything unmatched. Default is no retry.

## Where the budget lives — 2 seconds is the number, and it is a fail-open deadline

The tightest caller deadline over a control read is
`membership-connection-gater.ts` → `ADMISSION_DECISION_TIMEOUT_MS = 2_000`: one inbound
admission decision, which reads the control DB via `CadreNode.listAuthorizedMembers` →
`ControlDatabase.queryCadrePeers`. That gate is **fail-open on both throw and timeout** — it
*admits* the connection either way (`membership-connection-gater.ts` ~406, ~457).

Two consequences, and they point the same direction:

- Retry **helps** here rather than threatening anything: today a transient blip on that read
  throws and the gate admits an unplaced peer; a read that succeeds on its second attempt lets
  the gate make the real decision instead.
- But the read budget **must fit inside 2 s with headroom**, or the gate's own deadline fires
  first and admits anyway — spending the retry for nothing. So the write's 10 s budget is the
  wrong ceiling to reuse.

Proposed policy, sized against the measured ~25 ms failure:

| knob | value | why |
| --- | --- | --- |
| `CONTROL_READ_ATTEMPTS` | 3 | attempts are cheap when the failure surfaces in ~25 ms |
| `CONTROL_READ_RETRY_DELAYS_MS` | `[100, 400]` | worst case ~750 ms of sleep after ±50% jitter |
| `CONTROL_READ_RETRY_BUDGET_MS` | 1_500 | under `ADMISSION_DECISION_TIMEOUT_MS` with room for the attempts themselves |

The budget carries the same safety property the write budget does: it is checked after a failed
attempt, **before** sleeping, so one slow attempt (a `cohort-unreachable` read that burns the
transactor's own timeout) terminates the loop rather than compounding.

`queryCadrePeers` and `queryPeerRecord` each issue **two** network reads now (the
`queryRevokedStamps` filter plus the row scan), and both must succeed. The budget is per
`readRows` call, so a membership read can spend up to two budgets back to back — still inside
2 s only if each stays well under it. Keep the numbers above; do not raise them without
re-checking against `ADMISSION_DECISION_TIMEOUT_MS`.

## Reads inside a locked write body must NOT retry

`retryControlWrite`'s contract is that its backoff sleeps happen with **no lock held**. Several
`ControlDatabase` reads run *inside* a locked, already-retried write body, and giving them their
own retry breaks that contract twice over: the sleeps would happen holding the write lock
(stalling every other local writer), and the write funnel already re-runs those reads when it
re-runs the body.

The reads reachable from inside a locked body:

| read | locked callers |
| --- | --- |
| `queryStampId` (private) | `deleteGuardedRow` (via `deleteStrand` / `deleteValidationKey` / `deleteDeviceToken`), the `insertCadrePeer` insert-if-absent guard, `reauthorizeCadrePeer`, `reapRevokedRow` |
| `queryFormationInvite` | `assertSeatRemains`, inside the `redeemInvitation` / `recordFormationUsage` locked bodies |
| `countFormationUsage` | same |

All three also have callers *outside* any lock, so the split cannot be per-method — it has to be
per-call. **Do not** reach for an ambient flag: a plain `this.inLockedBody` boolean is wrong
because unlocked reads run concurrently with a locked body and would wrongly see it set, and
`AsyncLocalStorage` is not available on every target this package ships to (browser, React
Native — see the cross-platform rule in `AGENTS.md`). Pass it explicitly instead — an internal
`retry: boolean` parameter (or a private unretried twin) on those three, defaulting to retried,
with the locked call sites opting out by name. Explicit and greppable, matching the convention
this class already uses on the write side (`execWrite` outside a lock, bare
`getDatabase().exec` inside one).

## DRY: one loop, two policies

`retryControlWrite`'s loop body is generic apart from its log prefix. Extract it (shared module,
e.g. `control-retry.ts`) and put both `control-write-retry.ts` and a new `control-read-retry.ts`
on top of it. The extracted loop takes the log prefix as an option defaulting to
`'Control write'` so **existing log lines stay byte-identical** —
`control-write-degraded-cohort-member.integration.ts` asserts on `Control write [<label>] …`
lines per operation. Read lines get their own prefix (`Control read`) and carry a `label` for
the same reason writes do: several reads are in flight concurrently in a real party, and an
unlabelled line cannot be attributed.

Export the read policy's constants and classifier from `packages/cadre-core/src/index.ts`
alongside the write ones.

## Out of scope

- **`blocked/control-reads-blocked-by-stalled-write`** is a read *waiting* behind an in-flight
  write on the same node — a different site, already served by `readEval`'s committed-read
  opt-in, which this change must preserve as-is. The standing `it.fails` case in the
  degraded-cohort scenario belongs to that ticket, not this one.
- **`blocked/block-held-by-only-one-machine-is-unreadable`** owns the `claimed-elsewhere`
  root cause and the untested "a relay-only node converges once the owner authorizes it"
  half. This ticket only has to make sure the new retry does not disguise it.

## TODO

- Extract `retryControlWrite`'s loop into a shared module parameterised by log prefix, policy and
  pacing; re-express `retryControlWrite` on top of it and confirm every existing log line is
  byte-identical (`control-write-degraded-cohort-member.integration.ts` asserts on them).
- Add `control-read-retry.ts`: `CONTROL_READ_ATTEMPTS`, `CONTROL_READ_RETRY_DELAYS_MS`,
  `CONTROL_READ_RETRY_BUDGET_MS`, `isRetriableControlReadFailure`, `retryControlRead`. Document
  at the classifier why `claimed-elsewhere` / `unmaterializable` / possibly-stale are excluded,
  citing the 60 s measurement, and why `cohort-unreachable` is the marginal inclusion.
- Replace `ControlDatabase.readEval` with `readRows` (retried) and `readRowsOnce` (unretried),
  both keeping the committed-read opt-in and re-evaluating `getAutocommit()` per attempt. Carry
  `readEval`'s existing doc comment across — it is the only place the committed-read opt-in is
  explained.
- Convert all 15 read call sites in `control-database.ts` to the new seam, each with a `label`.
- Route `queryStampId`, `queryFormationInvite` and `countFormationUsage` through the unretried
  path when called from inside a locked write body; leave their unlocked callers retried. Add a
  `NOTE:` at the seam stating why (the no-lock-during-backoff contract on `withWriteLock`).
- Add `packages/cadre-core/test/control-read-retry.spec.ts`: classifier table over the exact
  message texts (both `Error during query on table …: Query failed: …` shapes and the bare
  ones), positive and negative, plus loop cases for attempt count, budget cut-off and label.
- Add a `ControlDatabase`-level spec that inverts the repro below — a read that fails once now
  succeeds on its second attempt, and a read inside a locked write body does **not** retry on
  its own. Give it the same `controlWriteRetryPacing`-style pacing seam so no test waits out a
  real backoff.
- Assert the budget relationship in a test rather than only in prose:
  `CONTROL_READ_RETRY_BUDGET_MS < ADMISSION_DECISION_TIMEOUT_MS`, so a future edit to either
  constant reddens instead of silently reintroducing a fail-open admit.
- Run `yarn workspace @serfab/cadre-core test`, `yarn lint`, `yarn typecheck`, `yarn build`.
- Re-run `packages/integration-tests/src/scenarios/control-write-degraded-cohort-member.integration.ts`
  and `relay-only-control-addr.integration.ts` and report what moved. `registerSelf` may now
  survive the read half of the failure the fix ticket describes; if it does, the note in
  `control-write-degraded-cohort-member` about having to drive `updateSelfPeerRecord` directly
  rather than `registerSelf` can be revisited.

## Repro harness that worked

Against a real `CadreNode` (`profile: 'transaction'`, empty `bootstrapNodes`), disarm the
self-registration timer, then monkeypatch the inner Quereus database:

```ts
const inner = db.getDatabase();
const realEval = inner.eval.bind(inner);
let evalCalls = 0;
(inner as unknown as { eval: unknown }).eval = (sql, params, opts) => {
  evalCalls++;
  if (evalCalls === 1) {
    // Fail during ITERATION, the way a real transactor failure surfaces.
    return (async function* () { await Promise.resolve(); throw transientClusterFailure(); })();
  }
  return realEval(sql, params, opts);
};
await expect(db.queryRevokedStamps('CadrePeer')).rejects.toThrow(/Some peers did not complete/);
expect(evalCalls).toBe(1);   // ← becomes 2 once this ticket lands
```

`transientClusterFailure()`, the timer-disarm cast and the `controlWriteRetryPacing` cast are all
already written in `packages/cadre-core/test/control-write-lock.spec.ts` — lift them rather than
re-deriving.
