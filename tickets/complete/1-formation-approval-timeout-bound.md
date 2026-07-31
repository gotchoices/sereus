description: The approval-request client used to hang for up to five minutes on an unresponsive outside approval service instead of giving up after its ten-second budget; the fix was already in, and this pass locked it in with tests that fail if it is ever reverted and brought the docs in line.
files: packages/cadre-core/src/formation-approval.ts, packages/cadre-core/test/formation-approval.spec.ts, packages/integration-tests/test/formation-approval-real-fetch.spec.ts, tickets/.pre-existing-known.md, docs/api.md, docs/STATUS.md
difficulty: easy
----

# Formation approval client: timeout bound covered + documented (complete)

## What shipped

The client-side fix landed earlier in `fix/formation-approval-timeout-not-enforced` (commit
`046e13d`) and was not modified by this ticket. `createHttpFormationApprover()` had enforced
`timeoutMs` by starting a timer, calling `AbortController.abort()`, and trusting `fetch` to
reject. Node's `fetch` (undici) sometimes drops an abort that lands while the response *body* is
being read, so the pending read stayed pending until undici's own 300-second body timeout: a hook
that answered headers and went quiet could hold a formation responder ~5 minutes on a 10-second
budget. The fix is one per-request budget (`startBudget` / `ApprovalBudget`) whose deadline is
raced against every await that can outlive it — the `fetch` itself, each `reader.read()` in
`readCappedStream`, and `response.text()` on the readerless (React Native) path. Aborting is still
attempted, because it hands the socket back where the runtime honours it, but it is no longer the
bound.

The implement pass (`8c05682`) added the deterministic coverage, deleted the now-stale
"KNOWN INTERMITTENT FAILURE" comment in the integration spec, moved the tracked-failure entry in
`tickets/.pre-existing-known.md` from **Open** to **Resolved in place**, and sharpened the
hook-author sentence in `docs/api.md` ("abandoned after 10 s, headers and body read included,
whether or not the runtime honours the abort").

This review pass added the items under *Review findings* below.

## Two load-bearing details, for whoever reads this code next

Both look like tidy-up bait and neither is:

- `fire()` in `startBudget` rejects the deadline **before** calling `controller.abort()`. Both
  rejections queue in the same turn and the first queued wins the race. Swap the order and a
  `fetchImpl` that rejects synchronously on abort would make the caller see "could not be reached"
  instead of the timeout/cancellation wording. Pinned by an assertion, not only a comment
  ("settles on the budget expiring, not on a fetch that rejects synchronously…").
- `void deadline.catch(() => {})` right after the deadline promise is constructed — the budget can
  fire between two raced awaits with nothing attached to it, which would otherwise be an unhandled
  rejection.

Accepted tradeoff (signed off earlier): a timeout/cancellation rejection no longer carries `cause`
(it used to be the abort error, which said nothing beyond `AbortError`). `cause` is still set on
the genuine transport-failure path. Constraint that still holds: global `fetch` +
`AbortController` only, no `node:` imports, no `AbortSignal.any` — this client runs on browsers
and React Native too.

## Review findings

**Checked**: the whole fix diff (`046e13d`) re-read line by line — budget construction, the
reject-before-abort ordering, the unhandled-rejection guard, `dispose()` on every exit path, and
each cleanup site (`readCappedStream`'s `finally`, `discardBody`, `fetchWithinBudget`'s abandoned
response); the implement diff (`8c05682`); every test in `formation-approval.spec.ts` and the
real-socket integration spec; and every doc mentioning the approval hook's timeout
(`docs/api.md`, `docs/architecture.md`, `docs/STATUS.md`, `tickets/.pre-existing-known.md`).

**Minor — fixed in this pass:**

- `docs/STATUS.md` (the "operator can enroll the approver key" entry) still described the defect
  as open, naming `fix/formation-approval-timeout-not-enforced` as in flight and warning that its
  test case fails ~1 run in 10 "until that lands". Rewritten to record the fix, what replaced the
  abort-only bound, and where it is covered. `docs/api.md` and the timeout-ladder paragraph in
  `docs/architecture.md` (approval hook 10 s < provisioning 12 s < await-response 15 s < session
  30 s) were re-read and are both still accurate — no edit needed.
- The two new bound tests asserted only that the call gave up in time, not that it let go of the
  stalled body — the other half of the fix's claim. `stallingFetch()` now reports whether its body
  stream was cancelled, and both tests assert it was. (Also: the caller-abort test leaked its
  `setTimeout`; now cleared.)
- The gap the implementer flagged — nothing exercised `fetchWithinBudget`'s abandoned-response
  cleanup — is now covered: a new test holds the `fetch` promise open, lets the 25 ms budget
  expire, then delivers the response and asserts its body is discarded rather than left checked
  out.

**Major — none.** No new tickets filed. The fix's control flow holds up under adversarial reading:
every await reachable after the deadline is either raced against it or is a cleanup call that
cannot block on the hook, and no path leaves the timer or the caller's abort listener attached.

**Tripwire — parked in code, not filed:** `readApproval` awaits `discardBody(response)`, which
awaits `body.cancel()`, and that await sits outside the budget — a runtime whose `cancel()` never
settles would hold the caller past `timeoutMs` even though the deadline fired. Every runtime this
ships on settles it promptly, so this is conditional, not a defect. Recorded as a `NOTE:` at
`discardBody` in `packages/cadre-core/src/formation-approval.ts`, including what to do if it ever
trips (stop awaiting it; two tests that assert the body is released by the time the rejection
surfaces would then need to poll).

**Deliberately not done:** no test drives the fix under `vi.useFakeTimers()`. The two existing
timer-clearing tests still use fake timers for their own purpose (asserting `vi.getTimerCount()`);
the bound tests want real elapsed time, which is the point of their assertions.

## Verification

- `packages/cadre-core`: `yarn typecheck` exit 0, `yarn build` exit 0, full suite **83 files /
  1319 passed, 1 skipped** (the skip is the pre-existing win32 `skipIf` in `key-store.spec.ts`,
  unrelated). `formation-approval.spec.ts` alone: **48/48**.
- `packages/integration-tests`: `formation-approval-real-fetch.spec.ts` run whole-file **6 times,
  6/6 green**, steady ~11 s each (previously ~1 failure in 10 as a 60 s timeout). This is on top of
  the implement pass's 20/20.
- Root `yarn lint`: exit 0, no output.
- No pre-existing failures surfaced, so `tickets/.pre-existing-error.md` was not written.
