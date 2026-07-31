description: Tests for the invite-approval network client now run against a real local web server instead of only a fake one — and doing so uncovered that the client's ten-second give-up limit is not always honoured, which is now filed as its own bug.
files: packages/integration-tests/test/formation-approval-real-fetch.spec.ts, packages/cadre-core/src/formation-approval.ts (read only), packages/cadre-core/test/formation-approval.spec.ts (read only), docs/STATUS.md, tickets/.pre-existing-known.md, tickets/fix/1-formation-approval-timeout-not-enforced.md (new)
----

# Real-network coverage for the formation approval client — complete

## What landed

`packages/integration-tests/test/formation-approval-real-fetch.spec.ts` — a plain spec (no
scenario harness, no libp2p, following `test/block-store-probe.spec.ts`) that stands up a
throwaway `node:http` server per test on an OS-assigned port and drives
`createHttpFormationApprover()` with **no `fetchImpl`**, so the real `globalThis.fetch` does the
asking. `startServer()` tracks accepted sockets and destroys them in `close()`, so the cases whose
handler never calls `res.end()` cannot leak a listener into the next test.

Eight cases: valid approval (signature verified end to end), `403` → `refused`, `500` →
`unavailable`, redirect → `unavailable`, timeout mid-body, connection refused, caller abort
mid-flight, and an undeclared-length 1.25 MiB body → `malformed` with proof the server's write
loop was cut off early. No product code changed.

## Review findings

### Checked

Read the implement diff first, then the client (`packages/cadre-core/src/formation-approval.ts`),
the stub suite it must not duplicate, the package's `vitest.config.ts`, and the docs that mention
the approval hook (`docs/STATUS.md`, `docs/api.md`, `docs/architecture.md`). Ran the new spec ~25
times in total (whole file, and filtered to single cases), plus a standalone Node repro outside
vitest. `npx eslint` on the spec — clean. `yarn workspace @serfab/integration-tests typecheck` —
clean.

### Major — one, filed as a ticket

**The client's `timeoutMs` is not an actual bound** → `tickets/fix/1-formation-approval-timeout-not-enforced.md`.
The new timeout case failed ~1 whole-file run in 10 as a 60-second vitest timeout. It is not test
flakiness: reproduced with raw `fetch` and no Sereus code (win32 / Node v24.2.0, ~1 in 100–150
attempts), Node's `fetch` sometimes drops the abort that lands while a stalled response body is
being read — the read then stays pending for undici's own 300-second body timeout (measured:
abort at 59 ms, rejection at 306,850 ms). Because the client enforces its budget *only* by calling
`AbortController.abort()`, a hook that sends headers and goes quiet can hold a formation responder
~5 minutes on a 10-second budget, and the caller's cancellation signal rides the same path. This
is exactly the class of defect the ticket existed to surface — the stub suite cannot see it,
because its stub rejects on abort by construction.

The test was left asserting the intended contract (not skipped, not loosened, no longer timeout),
with a `KNOWN INTERMITTENT FAILURE` comment at the case naming the fix slug, and an entry in
`tickets/.pre-existing-known.md` so nobody re-triages it.

### Minor — fixed in this pass

- **Unhandled rejection in the baseline case's handler.** `void readRequestBody(req).then(...)`
  had no `.catch`, so a throw inside the handler (or a request-stream error) became an unhandled
  rejection and the client hung to its own timeout, hiding the real cause. Now answers `500` with
  the error text.
- **Oversized-body case had a thin margin.** 320 KiB planned against a 64 KiB cap left the
  "the server did not finish writing" assertion racing the OS socket buffer plus the client's
  receive buffer. Raised to 1.25 MiB (20x the cap); costs nothing in a passing run, since writes
  stop the moment the client hangs up.
- **Dangling 2-second timer.** The fallback in the oversized case (`Promise.race` against a bare
  `setTimeout`) was never cleared. Extracted as `settleOrGiveUp()`, which clears it.
- **`docs/STATUS.md` was stale.** It still said "the HTTP approver has never been run against a
  real server", and pointed at `backlog/debt-validation-url-redemption-e2e` which has since moved
  to `plan/`. Rewritten to say what this suite now covers, what remains uncovered (no test redeems
  a `ValidationUrl` invitation through a real node), and to record the timeout defect.

### Added coverage

Two cases beyond the plan's six, both real-transport paths that no stub can produce: a connection
that is never established (asserts `unavailable`, the "could not be reached" branch, and that the
transport error is carried as `cause`), and a caller's `AbortSignal` firing mid-flight through a
real `fetch` (asserts `unavailable` + "cancelled", with a 30 s client budget so the approver's own
timer cannot be the cause).

### Checked and found clean

- Resource cleanup: every test closes its server in a `finally`, sockets are destroyed first, and
  the redirect target lives on the same throwaway server (nothing reaches an external host).
- No duplication of the stub suite's status/shape decision table, per the ticket's instruction.
- File style matches the package (tabs, sibling spec shape); size and function length are fine.
- The redirect case's deliberately loose assertion (category only, no message or mechanism) is
  correct — it is what keeps the case valid if a runtime resolves with `redirected: true` instead
  of rejecting.

### Not fixed, deliberately

- `baseRequest` / `approverKeys` / `expectFailure` are duplicated from
  `packages/cadre-core/test/formation-approval.spec.ts`. They are ~30 lines across a package
  boundary, and `integration-tests` consumes `@serfab/cadre-core`'s built `dist`, not its test
  directory — sharing them would mean exporting test helpers from the package. Not worth it.

### Tripwires

- `NOTE`-style comment at the oversized-body case explains why the chunk margin is wide, so a
  future reader does not "tidy" it back down and reintroduce the buffer race.

### Not re-run

The full `packages/integration-tests` suite (~9 minutes) was not re-run in this pass — the
implement stage ran it, its two failures are already tracked in `tickets/.pre-existing-known.md`
as `blocked`, and this diff touches one self-contained spec file. The new file itself was run
~25 times.
