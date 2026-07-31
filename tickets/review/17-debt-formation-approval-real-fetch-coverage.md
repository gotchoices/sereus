description: Added tests that check the invite-approval network client against a real local web server instead of only a fake one, so behaviors that depend on how real networking actually works (redirects, timeouts, capping oversized responses) are now verified for real.
files: packages/integration-tests/test/formation-approval-real-fetch.spec.ts (new), packages/cadre-core/src/formation-approval.ts (unchanged, read only), packages/cadre-core/test/formation-approval.spec.ts (unchanged, read only)
----

# Real-network coverage for the formation approval client

## What landed

New file `packages/integration-tests/test/formation-approval-real-fetch.spec.ts`, following the
plain-spec shape of `test/block-store-probe.spec.ts` (no scenario harness, no libp2p). Each test
spins up its own throwaway `node:http` server on an OS-assigned port (`listen(0, '127.0.0.1')`)
and drives `createHttpFormationApprover()` with **no `fetchImpl`** — the real
`globalThis.fetch` (Node's undici-backed fetch) does the asking. A `startServer()` helper tracks
every accepted socket and destroys them all in `close()`, called from a `try { ... } finally {
await server.close() }` in every test, so a handler that never calls `res.end()` (the timeout and
oversized-body cases) cannot leak an open listener into the next test.

No changes to `packages/cadre-core/src/formation-approval.ts` or the existing stub-based suite —
this is additive coverage only, per the ticket's explicit "don't duplicate the stub suite"
instruction.

## Six cases, all passing against Node's real `fetch`

1. **Baseline valid approval** — real server signs and returns a real `200` JSON body; asserts
   the client resolves it and `verifyFormationApproval` accepts it.
2. **`403` refusal** — asserts `failure === 'refused'`.
3. **`500` unavailable** — asserts `failure === 'unavailable'`.
4. **Redirect** — server answers `302 Location: /redirect-target` to a second path on the *same*
   server (which itself answers `200`, in case some runtime path follows the redirect rather than
   rejecting). Asserts only `failure === 'unavailable'` — deliberately not asserting on the error
   message or on whether Node's real `fetch` rejected the `redirect: 'error'` request vs.
   resolved with `redirected: true`. (Observed in this run: Node's undici-backed `fetch` rejects
   outright — the client's `catch` branch handles it, not the `response.redirected` belt-and-braces
   check in `assertApprovingStatus`. Both branches stay covered by the existing stub suite; this
   test only pins that whichever way it happens for real, the client still lands on
   `unavailable`.)
5. **Timeout mid-body** — server writes headers + `flushHeaders()`, then never writes a body or
   calls `res.end()`. Approver built with `timeoutMs: 50`. Asserts `failure === 'unavailable'` and
   the message names the timeout. The stalled connection is torn down by `startServer()`'s socket
   tracking in the test's `finally`.
6. **Oversized undeclared body** — server responds `200` with `content-type: application/json`
   and **no** `content-length` (chunked transfer-encoding, forcing the streaming-cap code path
   `readCappedStream` rather than the declared-length short-circuit), then paces
   `res.write()` calls (backpressure-aware: waits for `'drain'` when `write()` returns `false`,
   `setImmediate` otherwise) up to 320 KiB planned — five times the 64 KiB cap. Asserts
   `failure === 'malformed'`, and — after racing a `res`-`'close'` promise against a 2s fallback so
   the assertion isn't a foot-race with the async socket teardown — that the server-side write
   loop was cut off early (`wroteAllChunks === false && chunksWritten < PLANNED_CHUNKS`), proving
   the client actually hung up mid-stream rather than reading everything and measuring after.

## Validation run

- `yarn workspace @serfab/cadre-core build` — clean (needed so `@serfab/integration-tests`'s
  `global-setup.ts` freshness guard doesn't trip on a stale `dist`).
- `npx vitest run test/formation-approval-real-fetch.spec.ts` (in `packages/integration-tests`) —
  **6/6 passed**, ~17s wall (mostly transform/import overhead; actual test time 317ms).
- `yarn workspace @serfab/integration-tests typecheck` — clean (this package's typecheck config
  already includes `test/**/*.spec.ts`).
- `yarn eslint packages/integration-tests/test/formation-approval-real-fetch.spec.ts` — clean.
- Full `npx vitest run` in `packages/integration-tests` (all 38 files, ~547s) — **2 failures, both
  pre-existing and already tracked** in `tickets/.pre-existing-known.md` as `blocked`, unrelated
  to this diff:
  - `control-cohort-three-node-isolation.integration.ts` → tracked under
    `transactor-key-network-ignores-network-scoping`.
  - `zz-scratch-delete-alone.integration.ts` → tracked under
    `forked-control-collection-sync-livelocks`.
  Both are documented in that file as load-dependent (pass alone, fail under the full parallel
  suite) — consistent with what was observed here. No new `.pre-existing-error.md` filed since
  both are already tracked with an in-flight `blocked/` slug.

## Gaps / things the reviewer should know

- **Windows-only validation.** This run was on Windows (win32); the ticket's platform-dependent
  behaviors (specifically case 4's redirect handling) could differ on Linux CI. The assertion is
  deliberately loose (`unavailable` only, no message/mechanism pinning) specifically to stay
  correct across that variance, per the ticket spec — but it hasn't been observed running on
  Linux in this session.
- **No stress/flake pass.** Each test ran once. Case 5 (timeout) and case 6 (oversized body) both
  depend on real elapsed time / real socket backpressure over loopback; `timeoutMs: 50` and the
  8 KiB/`setImmediate`-or-`drain` pacing in case 6 held up in this run, but neither was repeated
  N times to rule out rare loopback-jitter flakiness. If either shows up flaky in CI, the first
  things to widen are case 5's `timeoutMs` (currently tight at 50ms) and case 6's `PLANNED_CHUNKS`
  margin (currently 5x the cap).
- **fileParallelism: false** in this package's `vitest.config.ts` means this new file always runs
  alone relative to the other integration-tests files (no port-collision risk with a stray
  listener), but it still shares the OS port range with whatever else is running on the CI
  machine — `listen(0, ...)` (OS-assigned ephemeral port) avoids fixed-port collisions but not a
  theoretical port exhaustion under heavy parallel CI load. Not something this ticket's cases
  could trigger on their own.
