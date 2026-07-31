description: A stalled outside approval service could hold up someone joining for five minutes instead of the intended ten seconds. The client now gives up on its own schedule instead of trusting the networking layer to cancel for it; what is left is to lock that in with tests that fail if it ever regresses.
files: packages/cadre-core/src/formation-approval.ts, packages/cadre-core/test/formation-approval.spec.ts, packages/integration-tests/test/formation-approval-real-fetch.spec.ts, tickets/.pre-existing-known.md, docs/api.md
difficulty: easy
----

# Lock in the approval client's timeout bound

## State when this ticket was written

The client-side fix **is already in the working tree**, in
`packages/cadre-core/src/formation-approval.ts` (landed by the `fix`-stage pass on
`formation-approval-timeout-not-enforced`). It is verified but under-tested: no test in the repo
fails if someone reverts it, because the only test that covers the defect
(`formation-approval-real-fetch.spec.ts`, the "never sends a body" case) depends on a race that
shows up roughly 1 whole-file run in 10.

Your job is the coverage, the bookkeeping, and the doc line — plus a re-verify of what landed.
Read the diff first; do not re-derive the fix.

## What the defect was

`createHttpFormationApprover()` enforced `timeoutMs` by starting a timer, calling
`AbortController.abort()`, and trusting `fetch` to reject. Node's `fetch` (undici) sometimes drops
an abort that lands while the response *body* is being read: the pending read neither rejects nor
resolves until undici's own 300-second body timeout fires. A hook that accepts the connection,
sends headers, and goes quiet could therefore hold a formation responder for ~5 minutes on a
10-second budget. The same weakness applied to the caller's cancellation signal, which is relayed
through the same `AbortController`.

Reproduced deterministically without any race, by injecting a `fetchImpl` that returns a `200`
whose body stream never enqueues, never closes, and ignores the abort entirely: before the fix
both the timeout case and the caller-abort case hung until vitest killed them at 10 s; after the
fix both reject `unavailable` in well under 2 s. That stub is the test this ticket asks you to add
— see *Tasks*.

## What landed

One per-request **budget** — a deadline covering the whole exchange (connect, headers, and body
read) that fires whether or not the runtime's `fetch` honours the abort. Aborting is still done,
because it is what hands the socket back where it works, but it is no longer the only bound.

- `startBudget(timeoutMs, origin, controller, signal)` returns `{ race, expired, dispose }`.
  `race(work)` is `Promise.race([work, deadline])`; the deadline rejects with the
  `unavailable` `FormationApprovalError` carrying the existing timeout / cancellation wording.
- Every await that can outlive the budget is raced: the `fetch` itself, each `reader.read()` in
  `readCappedStream`, and `response.text()` on the readerless (React Native) path.
- Cleanup on abandonment: `readCappedStream`'s existing `finally` cancels the reader (which is what
  releases a stalled connection); `fetchWithinBudget` attaches a handler to the abandoned fetch so a
  response that lands late gets its body discarded and a late rejection gets logged rather than
  becoming an unhandled rejection. `dispose()` clears the timer and the caller's abort listener on
  every exit path, as before.
- The `timedOut` / `callerAborted` flags are gone: the deadline's own rejection now carries the
  reason, so the outer catch only has to distinguish "a `FormationApprovalError` (pass through)"
  from "anything else (hook could not be reached)".

Two things in that code are load-bearing and look like tidy-up bait — **do not "simplify" either**:

- **`fire()` rejects the deadline BEFORE calling `controller.abort()`.** Both rejections are queued
  in the same turn and the first one queued wins the race. With the abort first, a `fetchImpl` that
  rejects synchronously on abort (which is what three existing stub tests do) wins, and the caller
  gets "could not be reached" instead of "did not answer within 25ms". Those three tests fail if the
  order is swapped back.
- **`void deadline.catch(() => {})` right after the deadline is constructed.** The budget can fire
  between two raced awaits with nothing attached to the deadline; without the bare handler that is
  an unhandled rejection.

Accepted tradeoff: a timeout/cancellation rejection no longer carries `cause`. It used to be the
abort error, which says nothing beyond `AbortError` / whatever the fetch chose. Nothing asserts on
it, and `cause` is still set on the genuine transport-failure path.

Constraint that still holds: global `fetch` + `AbortController` only — no `node:` imports, no
`AbortSignal.any` (this client runs on browsers and React Native as well as Node).

## Verified so far

- `packages/cadre-core` — `formation-approval.spec.ts` 44/44, `validation-key-enrollment.spec.ts` +
  `control-formation-invite.spec.ts` 60/60, `yarn typecheck` exit 0, `yarn build` exit 0.
- `packages/integration-tests` — `formation-approval-real-fetch.spec.ts` **10 whole-file runs,
  10/10 green**, test time steady at 250–300 ms (it was ~1 failure in 10 as a 60 s timeout before).
- `yarn lint` at repo root: no output, exit 0.

## Tasks

- Read the working-tree diff of `packages/cadre-core/src/formation-approval.ts`.

- Add to `packages/cadre-core/test/formation-approval.spec.ts` a `fetchImpl` helper that returns a
  `200` whose body stream never settles and which ignores the abort completely — the existing
  stubs all reject on abort by construction, so none of them can see this defect:

  ```ts
  /** A 200 whose body stream never enqueues, never closes, and ignores every abort. */
  function stallingFetch(): typeof fetch {
    return ((_input: RequestInfo | URL, _init?: RequestInit) =>
      Promise.resolve(
        new Response(new ReadableStream<Uint8Array>({ start() { /* never settles */ } }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
      )) as unknown as typeof fetch;
  }
  ```

- Cover both bounds with it, asserting on elapsed time as well as on the failure category — the
  point of these tests is the *bound*, so an assertion that only checks `unavailable` would pass
  again the moment someone reverts the fix and waits 300 s:
  - `timeoutMs: 50`, no caller signal → rejects `unavailable`, message contains `50ms`, elapsed
    well under a second (a 2 s assertion leaves ample headroom on a loaded CI box).
  - `timeoutMs: 30_000` with a caller signal aborted at ~25 ms → rejects `unavailable`, message
    contains `cancelled`, elapsed likewise bounded. The long budget is what proves the rejection
    came from the caller's abort and not from the timer.
  - Give both an explicit per-test `timeout` (10 s is plenty) so a regression fails fast and
    legibly instead of sitting on the suite's 30 s default.

- Add a test that pins the reject-before-abort ordering directly, so the trap above is guarded by an
  assertion and not only by a comment: a `fetchImpl` that rejects synchronously from its abort
  listener with a distinctive error must still surface the budget's `within <n>ms` message.

- In `packages/integration-tests/test/formation-approval-real-fetch.spec.ts`, delete the
  `KNOWN INTERMITTENT FAILURE` comment block above *"times out a real socket that answers headers
  and then never sends a body"* (it names this fix's ticket and is now stale). Leave the test itself
  exactly as it is — it asserts the intended contract.

- In `tickets/.pre-existing-known.md`, move that entry out of **Open** and into **Resolved in place**
  with the root cause and the evidence (10/10 whole-file runs, ~300 ms). Do not delete the entry:
  the whole point of that file is that a future agent seeing the old symptom finds out it was fixed.

- `docs/api.md` line ~152 tells hook authors "the request is aborted after 10 s by default". Sharpen
  it to say the exchange is **abandoned** after 10 s — headers and body read included — whether or
  not the runtime honours the abort. Keep it to the existing one-sentence register; the surrounding
  operational-notes paragraph is a list, not a design doc.

- Re-verify: `packages/cadre-core` `yarn typecheck` + full suite; `packages/integration-tests`
  `formation-approval-real-fetch.spec.ts` **~20 whole-file runs** (it is ~13 s each, so stream the
  loop's output rather than redirecting it); root `yarn lint`.
