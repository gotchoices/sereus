description: Shared-settings control writes now automatically retry after certain transient replication failures instead of failing the whole operation on the first hiccup; ready for review.
prereq:
files: packages/cadre-core/src/control-write-retry.ts, packages/cadre-core/src/control-database.ts, packages/cadre-core/src/index.ts, packages/cadre-core/test/control-write-retry.spec.ts, packages/cadre-core/test/control-write-lock.spec.ts, docs/architecture.md, docs/cadre-consistency.md, packages/quereus-plugin-sereus/src/cluster-size.ts
difficulty: easy
----

# Bounded retry for transient control-write failures

## What changed

Control-database writes (`ControlDatabase` in `packages/cadre-core/src/control-database.ts`)
go through a shared Optimystic transactor across cadre peers. Two failure shapes are
transient rather than real conflicts:

- transactor aggregate error `Some peers did not complete:` (a straggler/timeout, not a
  content conflict)
- a super-majority shortfall where the rejection count is exactly zero (nobody actually
  voted against the write — the round just didn't reach quorum in time)

Previously either failure surfaced immediately and failed the caller's write. Now every
write path retries up to 3 attempts inside a 10 s elapsed budget (checked after each
failed attempt, before sleeping), backoff 250 ms → 1 s jittered ±50%, capped at 1 s. The
last error is rethrown by identity on exhaustion (not re-wrapped), so callers see the
real failure.

## Where

- `control-write-retry.ts` — pure classifier `isRetriableControlWriteFailure` (message-
  based, walks `cause` chains via Quereus's `unwrapError`) + `retryControlWrite` loop.
  Injectable `sleep` / `now` / `delaysMs` seams for deterministic tests.
- `control-database.ts` — new private `lockedWithRetry` wraps
  `retryControlWrite(() => this.withWriteLock(fn), this.controlWriteRetryPacing)`. All
  six former direct `withWriteLock` callers (`execWrite`, `mutateCadrePeer`, the three
  `deleteGuardedRow` wrappers, `withUseNumberRetry`'s inner lock) now go through it.
  `withWriteLock` itself is untouched as the bare primitive — retry wraps *outside* the
  lock so a retried attempt re-acquires fresh, not spinning inside a stale hold.
  `controlWriteRetryPacing` is a private field = the spec injection seam.
- `index.ts` — new exports: `CONTROL_WRITE_ATTEMPTS`, `CONTROL_WRITE_RETRY_BUDGET_MS`,
  `isRetriableControlWriteFailure`, `retryControlWrite`, `type ControlWriteRetryOptions`.
- Docs: `docs/architecture.md` "Replication cluster size" section gained the retry
  rationale plus the full no-viable-threshold arithmetic for why cluster size can't just
  be shrunk instead (super-majority threshold fraction 0.75 isn't embedder-settable;
  lowering it buys nothing at 4 machines and is impossible at 2).
  `docs/cadre-consistency.md` "What it costs" got one clause pointing at that section.
  `cluster-size.ts` doc comment on `CONTROL_CLUSTER_POLICY` notes the absent
  `superMajorityThreshold` is a researched decision, not an oversight.

## Most load-bearing behavior — read this first

The classifier's zero-vs-non-zero-rejection split in `control-write-retry.ts` is the
crux: a super-majority shortfall with rejections > 0 means a peer actually disagreed
(real conflict, must NOT retry — retrying would mask a legitimate rejection). Shortfall
with rejections == 0 means nobody voted no, the round just didn't complete in time
(transient, safe to retry). Get this split wrong in either direction and it either masks
real conflicts or stops retrying transient failures. Review this line first.

Second-most load-bearing: classifier disjointness with `isLostUseNumberRace`. That
existing error also has its own retry loop (`withUseNumberRetry`) wrapping
`lockedWithRetry`'s single-shot lock. The two classifiers must never both claim the same
error, or a lost-use-number race retries the *outer* loop 3× while the *inner* budget
retries 3× more each time — the composed test pins this at exactly 3 total attempts,
never 9.

## Known gap — flag for follow-up, don't block on it

The classifier matches on literal engine error text (`Some peers did not complete:` and
the super-majority-shortfall wording) rather than typed error codes, because that's what
the Quereus transactor currently surfaces. All test coverage constructs these strings by
hand — there is no test that runs the retry path against a real Optimystic transactor
producing the error organically. If the real engine ever changes that wording, the
classifier silently stops matching (fails closed — no retry, not a false retry — so the
failure mode is "back to old immediate-fail behavior," not corruption). Real-engine
coverage is intentionally deferred to a separate follow-up ticket,
`control-write-retry-real-error-coverage`, which does not yet exist — reviewer or next
agent should file it if it's still missing.

## Test coverage (47/47 passing at handoff)

`yarn vitest run test/control-write-retry.spec.ts test/control-write-lock.spec.ts
test/control-database-solo.spec.ts test/control-database-offline-peers.spec.ts
test/control-formation-use-number-retry.spec.ts` from `packages/cadre-core` — all green
(re-confirmed this run, 111s).

- `control-write-retry.spec.ts` (new, pure unit, no I/O): classifier table incl. 3-level
  nested `cause` chains, both retriable messages, non-zero-rejection shortfall (must NOT
  retry), constraint failures, non-`Error` throws; classifier/`isLostUseNumberRace`
  disjointness both directions; loop success-on-attempt-2; exhaustion rethrows by
  identity; budget-exhausted-in-one-attempt (degraded-member case, zero sleeps calls);
  non-retriable fails on first attempt; jitter floor/cap verified via recorded sleep
  calls; composed use-number-outer-loop simulation pins total attempts at 3.
- `control-write-lock.spec.ts` (+2 cases): head-of-line — a write queued while attempt 1
  is asleep in backoff commits during that backoff window (deterministic via a manually-
  released injected sleep on `controlWriteRetryPacing`); notification count — exactly one
  membership notification across a retried `mutateCadrePeer`, zero on exhaustion,
  exhaustion error surfaces by identity to the caller.
- `control-database-solo.spec.ts` / `control-database-offline-peers.spec.ts` /
  `control-formation-use-number-retry.spec.ts` — pre-existing specs, pass unedited
  (confirms the refactor didn't change behavior for the paths they cover).

**Not run**: `integration-tests` package (real multi-peer network scenarios) — out of
scope per the original ticket, left to `control-write-retry-real-error-coverage` or a
dedicated integration follow-up.

## Suggested review focus

1. Classifier zero/non-zero-rejection line — is the split actually correct against the
   transactor's real semantics, or just internally consistent with itself?
2. `lockedWithRetry` placement — retry wraps outside `withWriteLock`, confirm no call
   site still calls `withWriteLock` directly and skips retry unintentionally.
3. Whether `control-write-retry-real-error-coverage` needs filing now vs. already exists
   under a different slug — check `tickets/` before creating a duplicate.
