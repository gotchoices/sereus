description: The approval-request client used to be able to hang for up to five minutes waiting on an unresponsive outside approval service instead of giving up after its intended ten-second budget; the fix is in, and this pass adds tests that fail if it's ever reverted plus the paperwork (docs, known-failure log) to match.
files: packages/cadre-core/src/formation-approval.ts, packages/cadre-core/test/formation-approval.spec.ts, packages/integration-tests/test/formation-approval-real-fetch.spec.ts, tickets/.pre-existing-known.md, docs/api.md
difficulty: easy
----

# Formation approval client: timeout bound now covered + documented

## What this ticket did

The client-side fix itself landed in an earlier `fix/` pass (`formation-approval-timeout-not-enforced`, commit `046e13d`) and was **not touched here** beyond reading the diff to write correct tests against it. This pass:

1. Added a deterministic repro to `packages/cadre-core/test/formation-approval.spec.ts` — no more depending on the ~1-in-10 real-socket race the previous coverage relied on.
2. Deleted the now-stale "known intermittent failure" comment in `packages/integration-tests/test/formation-approval-real-fetch.spec.ts` (test itself untouched).
3. Moved the tracked-failure entry in `tickets/.pre-existing-known.md` from **Open** to **Resolved in place**, with root cause + evidence.
4. Sharpened one sentence in `docs/api.md` (hook-author operational notes) to say the exchange is *abandoned* after 10s (headers + body read), not just "aborted".

## The defect, for context

`createHttpFormationApprover()` used to enforce its timeout by starting a timer, calling `AbortController.abort()`, and trusting `fetch` to reject. Node's `fetch` (undici) sometimes drops an abort that lands while the response *body* is being read: the pending read then neither rejects nor resolves until undici's own 300-second body timeout. A hook that accepts the connection, sends headers, and goes quiet could hold a formation responder for ~5 minutes on a 10-second budget. Same weakness applied to the caller's own cancellation signal (relayed through the same `AbortController`).

## The fix (already landed, summarized for the reviewer)

One per-request **budget** (`startBudget` / `ApprovalBudget` in `formation-approval.ts`) — a deadline covering the whole exchange — races every await that can outlive it: the `fetch` call itself, each `reader.read()` in `readCappedStream`, and `response.text()` on the readerless (React Native) path. `AbortController.abort()` is still called (it's what releases the socket where the runtime does honor it) but is no longer the sole bound.

Two details are load-bearing and will look like tidy-up bait to a reviewer — **flagging so they aren't "simplified" away**:

- `fire()` in `startBudget` rejects the deadline **before** calling `controller.abort()`. Both rejections queue in the same microtask turn; first-queued wins the race. Swap the order and a `fetchImpl` that rejects synchronously on abort (three existing stub tests do this) would make the caller see "could not be reached" instead of the correct timeout/cancellation message — those three tests catch a reordering.
- `void deadline.catch(() => {})` right after the deadline promise is constructed, guarding against an unhandled rejection when the budget fires between two raced awaits with nothing currently attached to it.

**Accepted tradeoff, already signed off**: a timeout/cancellation rejection no longer carries `cause` (it used to be the abort error, which said nothing beyond `AbortError`). Nothing asserts on it; `cause` is still set on the genuine transport-failure path.

Constraint that still holds: global `fetch` + `AbortController` only, no `node:` imports, no `AbortSignal.any` — this client runs in browsers and React Native too.

## Test coverage added — how to exercise it

`packages/cadre-core/test/formation-approval.spec.ts` gained a `stallingFetch()` helper: a `fetchImpl` returning a `200` whose body stream `start()`s and never enqueues, never closes, and has no abort listener at all — so it can't accidentally "cooperate" the way every pre-existing stub does. Three new tests use it:

- **Timeout bound**: `timeoutMs: 50`, no caller signal → rejects `unavailable`, message contains `50ms`, asserted to complete in well under 2s (elapsed-time assertion, not just failure-category — a revert that waits out undici's 300s would fail this on time, not just on category).
- **Caller-abort bound**: `timeoutMs: 30_000` with the caller's signal aborted at ~25ms → rejects `unavailable`, message contains `cancelled`, same sub-2s bound. The 30s budget is deliberately large so a fast rejection can only have come from the caller's abort, not the timer.
- **Reject-before-abort ordering pinned directly**: a `fetchImpl` that rejects synchronously from its own abort listener with a distinctive error string must still surface the budget's own `within 25ms` message — guards the ordering note above with an assertion, not just a comment.

Both timing tests carry an explicit 10s per-test `timeout` so a regression fails fast and legibly rather than sitting on the suite's default.

## Known gaps / things the reviewer should decide on, not assume are covered

- **No test exercises the abandoned-response cleanup path** (`fetchWithinBudget`'s `void pending.then(...)` that discards a body / logs a late rejection arriving *after* the budget already fired). `stallingFetch()`'s stream never settles at all, so that cleanup code never actually runs in the new tests — it's exercised only implicitly by the real-socket integration test. If this needs its own coverage, it isn't here yet.
- The real-socket integration test (`formation-approval-real-fetch.spec.ts`, "times out a real socket that answers headers and then never sends a body") is the one that used to be racy; it was **not modified** except deleting the stale comment. It was re-verified 20/20 green across whole-file runs (steady ~11s each, previously ~1-in-10 hit a 60s timeout) — see Verification below — but it's still the real-`fetch`/real-socket path, not the deterministic stub, so residual flakiness (however rare) would surface there first, not in the new unit tests.
- No attempt was made to test the fix under `vi.useFakeTimers()` — the two existing timer-clearing tests (success/failure path) still use fake timers for their own purpose (asserting `vi.getTimerCount()`), and that was left as-is.

## Verification performed

- `packages/cadre-core`: `yarn typecheck` exit 0, `yarn build` exit 0, full suite **83 files / 1318 passed, 1 skipped** (the skip is the pre-existing win32 `skipIf` in `key-store.spec.ts`, unrelated). `formation-approval.spec.ts` alone: 47/47.
- `packages/integration-tests`: `formation-approval-real-fetch.spec.ts` run whole-file **20/20 times, all green**, ~11s each (previously ~1 failure in 10 as a 60s timeout).
- Root `yarn lint`: exit 0, no output.
