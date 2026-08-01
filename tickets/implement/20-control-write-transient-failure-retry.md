----
description: A change to a party's shared settings can fail outright when one machine hiccups at the wrong moment; make the write try again a couple of times before giving up, and write down why lowering the approval bar is not an option.
prereq:
files: packages/cadre-core/src/control-database.ts, packages/cadre-core/src/control-write-retry.ts, packages/cadre-core/src/index.ts, packages/cadre-core/test/control-write-lock.spec.ts, packages/quereus-plugin-sereus/src/cluster-size.ts, docs/architecture.md, docs/cadre-consistency.md
difficulty: hard
----

# Bounded retry for transient control-write failures

## The decision this ticket encodes

The planning pass looked at all three options the plan ticket listed and one of them is
arithmetically unavailable. Recording that here so the implementer does not re-open it.

### Lowering the approval bar is not available to Cadre

A control write commits when `ceil(cohortSize × superMajorityThreshold)` members approve. Cadre
names no threshold, which selects Optimystic's `DEFAULT_SUPER_MAJORITY_THRESHOLD` of `0.75`
(`../optimystic/packages/db-core/src/cluster/structs.ts:58`). At a three-machine party the cohort
is the whole party, so the bar is `ceil(3 × 0.75) = 3` — unanimous.

To make a three-machine party commit on two approvals you need `ceil(3 × T) <= 2`, i.e.
`T <= 2/3`.

Optimystic states a partition-safety condition on that same number
(`../optimystic/packages/db-p2p/src/cluster/cluster-repo.ts:991`): each side of a network split
must recruit `membershipAdmissionFraction × superMajorityThreshold × K` distinct honest members,
and two sides cannot both find them in one K-member cluster, which requires

```
2 × membershipAdmissionFraction × superMajorityThreshold > 1
```

`membershipAdmissionFraction` defaults to `0.75` (`cluster-repo.ts:262`), giving `T > 2/3`.

`T <= 2/3` and `T > 2/3` are disjoint. **No threshold both lets a three-machine party commit on
two approvals and satisfies the partition-safety condition at the shipped admission fraction.**
(That prose note in `cluster-repo.ts` cites the shipped defaults as "0.75 · 0.67"; the code says
both are `0.75`. The note's *numbers* are stale, its *inequality* is what matters here.)

The escape hatch would be raising `membershipAdmissionFraction` — at `0.9`, `T > 0.556` and
`T = 0.6` yields `ceil(3 × 0.6) = 2`. Cadre cannot do that: `membershipAdmissionFraction` lives on
Optimystic's `ClusterConsensusConfig` but is **not** among the embedder-facing
`ClusterPolicyOptions` fields, and `resolveClusterPolicy`
(`../optimystic/packages/db-p2p/src/cluster/cluster-policy.ts`) never forwards it, so
`ClusterRepo` always falls back to `0.75`. Changing that is an Optimystic change, not a Cadre one.

Two secondary points that make the trade even less attractive:

- Lowering the threshold buys nothing at four machines either. `ceil(4 × 0.75) = 3` and
  `ceil(4 × 0.7) = 3`; you have to reach `T <= 0.5` before four machines commit on two.
- Two machines need both for any `T > 0.5`, so unanimity at two is unavoidable no matter what.

**Do not set `superMajorityThreshold` in `CONTROL_CLUSTER_POLICY` as part of this ticket.**

### What we do instead

Absorb the transient case with a **bounded retry at the single control-write funnel**, and record
the arithmetic above in `docs/architecture.md` so the next person does not re-derive it.

Retry is the right shape because the failure the plan ticket actually observed is transient, and
because the existing measurements say retrying is both safe and effective:

- The observed one-shot failure was `registerSelf()` racing a connection that was still forming:
  `Some peers did not complete: … cause=The stream has been reset` /
  `Failed to get super-majority: 0/3 approvals (needed 3, 0 rejections)`. Zero approvals — the
  coordinator reached nobody. No threshold fixes that; a second attempt a moment later does.
- `docs/architecture.md` → "Replication cluster size" already records, from
  `packages/integration-tests/src/scenarios/control-write-degraded-cohort-member.integration.ts`,
  that a failed control write **rolls back**, is not queued for re-replication, and the **next
  write commits normally (~1 s)**. That is the measured evidence that a retry is safe (nothing
  half-committed) and effective (a fresh attempt succeeds).

## Where the retry goes

`ControlDatabase.withWriteLock` (`packages/cadre-core/src/control-database.ts:1413`) is the single
funnel every local control write passes through — `execWrite`, `mutateCadrePeer`, the
`deleteGuardedRow` wrappers, `withUseNumberRetry`'s locked body, and `SeedBootstrapService`'s
direct SQL. That is why the retry belongs here rather than at ~19 call sites: the plan ticket's
complaint is precisely that "callers are not uniformly written to retry".

**The retry wraps the lock, it does not live inside it.** Each attempt takes and releases
`withWriteLock`; the backoff sleep happens with the lock released. This is deliberate and mirrors
`withUseNumberRetry`, which re-takes the lock per attempt for the same reason —
`USE_NUMBER_ATTEMPTS`' own doc comment (`control-database.ts:116-127`) explicitly warns that
holding the write queue across a delay is the thing not to do. Sleeping under the lock would stall
every other local writer on this node for the whole backoff.

Concretely: keep `withWriteLock` as the bare primitive, add a private
`lockedWithRetry<T>(fn)` that loops `this.withWriteLock(fn)`, and repoint the public write
surface (`execWrite`, `mutateCadrePeer`, the three `withWriteLock(() => this.deleteGuardedRow(...))`
sites at lines 960 / 1021 / 1221, and `withUseNumberRetry`'s inner lock at line 1780) at
`lockedWithRetry`.

## Why retrying a whole locked body is safe

Every body that runs under the lock is atomic today — audited:

| site | body | atomic because |
|------|------|----------------|
| `execWrite` (7 callers + `SeedBootstrapService`) | one `db.exec` | single statement |
| `deleteStrand` / `deleteValidationKey` / `deleteDeviceToken` | `deleteGuardedRow` | wrapped in `inTransaction` (`control-database.ts:1318`) |
| `insertCadrePeer` | stamp probe + one `exec` | single write statement; the probe is a read |
| `reauthorizeCadrePeer` | one `exec` | single statement |
| `deleteCadrePeer` | `mutateCadrePeer` → `deleteGuardedRow` | `inTransaction` |
| `withUseNumberRetry` body | `inTransaction('redemption', …)` | explicit transaction |

So a failed attempt leaves nothing half-applied, and re-running the body re-runs its reads too —
which is what you want.

Signatures and stamp ids are minted *outside* the locked body and are deliberately **not**
re-minted per attempt: a retry re-presents the same signed message the first attempt presented,
which is exactly what the original attempt would have done. `insertCadrePeer`'s in-body
`queryStampId` probe keeps it idempotent if a prior attempt did in fact land remotely — it returns
`false` ("already a member") rather than colliding on the `PeerId` primary key.

**Extend `withWriteLock`'s and `mutateCadrePeer`'s doc comments with the retry contract**: a body
run under the lock must be atomic and re-runnable, in the same voice as the existing
"NOT re-entrant" contract those comments already carry.

## Classifying a retriable failure

Mirror `isLostUseNumberRace` (`control-database.ts:164-184`) exactly — same shape, same reasoning,
same kind of doc comment. Classify by MESSAGE, walking the `cause` chain with Quereus'
`unwrapError`, because neither surface is recognisable by type: the transactor throws a bare
`Error` (`../optimystic/packages/db-core/src/transactor/network-transactor.ts:243`) and the
coordinator throws a bare `Error`
(`../optimystic/packages/db-p2p/src/repo/cluster-coordinator.ts:374`), and by the time it reaches
`ControlDatabase` it is wrapped in a `QuereusError`.

Retriable — the cohort did not *answer*:

- `Some peers did not complete:` — transactor aggregate, the surface a reset stream produces.
- `Failed to get super-majority: N/M approvals (needed K, 0 rejections)` — **only with zero
  rejections.**

Not retriable — somebody actually disagreed, or the write is wrong:

- The same super-majority message with a **non-zero** rejection count. This is the branch that
  carries `membership-not-admitted` rejections, which the degraded-member scenario already asserts
  on separately (`…integration.ts:548`).
- Every constraint / authorization failure (`CHECK constraint failed:`,
  `UNIQUE constraint failed:`), which reach this seam through the same funnel.
- Anything that is not an `Error`.

Put the classifier and the loop in a new module
`packages/cadre-core/src/control-write-retry.ts` — `control-database.ts` is already 2016 lines,
and the classifier needs to be importable by the integration package (ticket
`control-write-retry-real-error-coverage`). Export it from `packages/cadre-core/src/index.ts`.

## Budget

```ts
/** First attempt plus two retries. */
export const CONTROL_WRITE_ATTEMPTS = 3;

/** Elapsed-time ceiling, measured from the START of the first attempt. */
export const CONTROL_WRITE_RETRY_BUDGET_MS = 10_000;

/** Backoff before retry N, jittered +/-50%. */
const CONTROL_WRITE_RETRY_DELAYS_MS = [250, 1_000];
```

The elapsed budget, not the attempt count, is what makes this policy safe — and it is sized off
measurements already in `docs/architecture.md`:

- A transient failure (stream reset while a connection is still forming) surfaces in well under a
  second, so it is retried, and the whole loop adds at most ~2.2 s.
- A genuinely silent cohort member fails at **~20 s** — two 10 s `ClusterClient` response-deadline
  attempts — which already exceeds the 10 s budget when attempt 1 returns. The budget is checked
  *after* attempt 1 fails and *before* sleeping, so that case is surfaced immediately and **retry
  adds zero latency to the case where it cannot help.** This is the whole point of an elapsed
  budget rather than a bare attempt count; say so in the constant's doc comment.

Cap any single sleep at the largest delay above so a `stop()` racing a backoff is never delayed by
more than ~1 s. There is no `AbortSignal` at this seam — note that in the doc comment rather than
plumbing one.

On exhaustion, throw the **last** error unchanged (do not wrap — the messages the degraded-member
scenario asserts on must survive), and `log()` the attempt count at the `sereus:cadre:control-db`
logger so an operator can see a write was retried.

## Docs

The reasoning goes in docs, not in a code comment — the plan ticket is explicit about this, and
`docs/architecture.md` → "Replication cluster size" already owns the replication-breadth /
write-availability trade.

- **`docs/architecture.md` → "Replication cluster size"** — add one bullet, next to the existing
  "Whole-party breadth makes one connected-but-degraded member decisive" bullet: the arithmetic
  above showing no threshold satisfies both constraints at the shipped admission fraction, that
  `membershipAdmissionFraction` is not embedder-settable so the escape hatch is an upstream
  Optimystic change, that lowering the threshold buys nothing at four machines and cannot help at
  two — and that Cadre therefore accepts unanimity at three and absorbs the *transient* half of it
  with the bounded retry described here, naming the budget and why it is sized to expire before a
  degraded-member timeout.
- **`packages/quereus-plugin-sereus/src/cluster-size.ts`** — one sentence in the
  `CONTROL_CLUSTER_POLICY` doc comment saying the absent `superMajorityThreshold` is now a
  *researched* decision rather than an inherited default, pointing at the architecture section.
  Do not restate the arithmetic there.
- **`docs/cadre-consistency.md`** — the "What it costs" paragraph ends on the write-availability
  cost; add a clause naming the retry as what covers the transient part, pointing at the
  architecture section. One clause, not a paragraph.

## Edge cases & interactions

Cover these; the reviewer will check for them.

- **Zero-rejection vs non-zero-rejection super-majority.** `(needed 3, 0 rejections)` retries;
  `(needed 3, 1 rejections)` does not. Both must be exercised — this is the single most
  load-bearing line of the classifier.
- **Constraint failures reach this funnel.** `CHECK constraint failed: Authorized`,
  `UNIQUE constraint failed: …` must be retried zero times. A retried authorization failure would
  re-present a spent signature.
- **Interaction with `withUseNumberRetry`.** Its locked body now carries the cluster retry inside
  its own use-number retry. A lost-use-number failure must NOT be classified retriable by the new
  classifier (it is a constraint failure) or the two loops multiply. Assert total attempt count is
  bounded when both conditions could fire.
- **Deeply nested cause chains.** The real error is `QuereusError` → `Error` → `Error`. The
  classifier must match at any depth via `unwrapError`; test with a three-level chain, not a flat
  message.
- **Non-`Error` throws.** A thrown string / `undefined` / a rejected promise with no `message` is
  not retried and propagates unchanged.
- **Head-of-line blocking.** A second writer queued while the first is in backoff must be able to
  run during the sleep — that is the property the "retry outside the lock" shape buys. Test it
  (queue two writes, make the first fail once, assert the second is not stalled for the full
  backoff).
- **`mutateCadrePeer` notification count.** Exactly one membership notification on eventual
  success; zero on exhaustion. The notify lives inside the locked body, so a retried body must not
  notify twice.
- **Idempotency when a prior attempt actually landed.** `insertCadrePeer` retried after the row
  exists returns `false` and does not throw.
- **Solo / no-cohort node.** A lone node writes to local storage without forming a cluster, so the
  classifier never fires and behaviour is unchanged. `control-database-solo.spec.ts` and
  `control-database-offline-peers.spec.ts` must stay green with no edits.
- **Write-while-alone drain.** `CadreNode.drainPendingControlReplication` → `reauthorizeCadrePeer`
  inherits the retry. It runs on a connection edge, which is exactly the racy moment — confirm it
  does not double-notify and does not re-queue.
- **Jitter must not produce a zero or negative delay.** `+/-50%` of 250 ms floors at 125 ms.
- **`Math.random` in product code** is fine here (jitter only), but keep the sleep helper testable
  — inject the delay list or the clock rather than making the spec wait 1.25 s of real time.

## Tests

`packages/cadre-core/test/control-write-retry.spec.ts` (new), plus additions to
`packages/cadre-core/test/control-write-lock.spec.ts`:

- Classifier table: each retriable and non-retriable message above, asserted from a **nested**
  error chain. Real error TEXT is the dependency here, same as `isLostUseNumberRace` — the real-
  engine version of this assertion is the follow-up ticket
  `control-write-retry-real-error-coverage`; this spec may use literals.
- Loop: succeeds on attempt 2 → one value returned, no throw, body ran twice.
- Loop: three failures → last error rethrown unchanged (identity, not just message), body ran
  exactly `CONTROL_WRITE_ATTEMPTS` times.
- Loop: a single attempt that consumes the whole budget → body ran exactly once (the
  degraded-member case; the assertion that retry adds no latency where it cannot help).
- Loop: non-retriable failure → body ran exactly once, error rethrown.
- Lock: a write in backoff does not stall a concurrently queued write.
- Lock: notification fired once across a retried `mutateCadrePeer`.

## TODO

Phase 1 — the retry

- Add `packages/cadre-core/src/control-write-retry.ts`: `CONTROL_WRITE_ATTEMPTS`,
  `CONTROL_WRITE_RETRY_BUDGET_MS`, retriable/non-retriable message patterns,
  `isRetriableControlWriteFailure(error: unknown): boolean` (via `unwrapError`), and
  `retryControlWrite<T>(attempt: () => Promise<T>, options?): Promise<T>` with an injectable delay
  list / sleep for testability.
- Export the classifier and the constants from `packages/cadre-core/src/index.ts`.
- Add `ControlDatabase.lockedWithRetry` and repoint `execWrite`, `mutateCadrePeer`, the three
  `deleteGuardedRow` wrappers and `withUseNumberRetry`'s inner lock at it. Leave `withWriteLock`
  as the bare primitive.
- Extend the `withWriteLock` / `mutateCadrePeer` doc comments with the "atomic and re-runnable"
  body contract and the reason the backoff sits outside the lock.

Phase 2 — tests

- `packages/cadre-core/test/control-write-retry.spec.ts` per the list above.
- Additions to `packages/cadre-core/test/control-write-lock.spec.ts` for the two lock-interaction
  cases.

Phase 3 — docs and validation

- `docs/architecture.md` → "Replication cluster size" bullet.
- `cluster-size.ts` `CONTROL_CLUSTER_POLICY` sentence; `docs/cadre-consistency.md` clause.
- `yarn build && yarn lint` at the repo root, then
  `yarn vitest run test/control-write-retry.spec.ts test/control-write-lock.spec.ts test/control-database-solo.spec.ts test/control-database-offline-peers.spec.ts test/control-formation-use-number-retry.spec.ts 2>&1 | tee /tmp/cadre-core-retry.log`
  from `packages/cadre-core`. Do not run the integration package here — that is the follow-up
  ticket, and its scenarios run for minutes.
