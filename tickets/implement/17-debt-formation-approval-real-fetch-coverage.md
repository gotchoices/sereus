description: The code that calls an outside approval service over the network is only tested against a fake network. Test it against a real one, because the real network behaves differently in exactly the places the code guesses at.
files: packages/cadre-core/src/formation-approval.ts, packages/cadre-core/test/formation-approval.spec.ts, packages/integration-tests/test/formation-approval-real-fetch.spec.ts (new), packages/integration-tests/test/global-setup.ts, packages/integration-tests/vitest.config.ts
difficulty: easy
----

# Real-network coverage for the formation approval client

## Background

`createHttpFormationApprover()` in `packages/cadre-core/src/formation-approval.ts` is the client
that asks an invite's `ValidationUrl` hook whether a redemption may proceed (wire contract
documented in `docs/api.md` under "Validate Strand Formation (approval hook)"). Every existing
test in `packages/cadre-core/test/formation-approval.spec.ts` injects a `fetchImpl` stub built to
behave the way we *believe* a real `fetch` behaves. That leaves three behaviours entirely
unverified against a real runtime, because the client branches on all three and the stub was
written to hit both branches by construction rather than by observation:

- **Redirects.** Client sends `redirect: 'error'`. Depending on runtime, that either makes
  `fetch` reject, or resolve with `response.redirected === true`. `assertApprovingStatus` (line
  ~371 of `formation-approval.ts`) handles both; nothing today tells us which one Node's real
  `fetch` (undici) actually does.
- **Aborting mid-body.** The abort timer (`formation-approval.ts` line ~461) must stay armed
  while the body is being read, not just while headers are pending. Whether a real abort during
  streaming surfaces as an `AbortError` the code's `catch` block classifies as `unavailable`
  is unverified against a real socket.
- **Response body capping.** `readCappedStream` (line ~287) is supposed to stop *reading* at 64
  KiB, not buffer-then-measure. Against a stub `ReadableStream` fed synchronously this is
  trivial; against a real socket streaming from a Node HTTP server it depends on the runtime's
  own buffering and backpressure.

## What to build

New file `packages/integration-tests/test/formation-approval-real-fetch.spec.ts`. This suite's
`test/**/*.spec.ts` glob (see `vitest.config.ts`) already runs plain unit-style specs that need
none of the multi-party network harness — `test/block-store-probe.spec.ts` is the existing
example of that pattern; follow its shape (plain `describe`/`it`, no scenario harness, no libp2p).

Stand up a throwaway `node:http` server per test (`http.createServer(...).listen(0)`, read the
assigned port off `server.address()`, build `validationUrl` as `http://127.0.0.1:<port>/hook`),
and drive `createHttpFormationApprover()` with **no `fetchImpl` passed** — the real
`globalThis.fetch` (Node's built-in undici-backed fetch) is what does the asking. Close the
server in an `afterEach`/`finally` for every test, including the ones that error/timeout, so a
failing test doesn't leak a listening socket into the rest of the run.

Reuse `signFormationApproval` / a `baseRequest`-style helper the way
`packages/cadre-core/test/formation-approval.spec.ts` does, importing from `@serfab/cadre-core`
(the package's built `dist`, already a tracked target in
`packages/integration-tests/test/global-setup.ts` — no global-setup change needed since
`@serfab/cadre-core` is already listed there).

### Cases to cover

1. **Baseline valid approval.** Server answers `200` with a real signed
   `{ validationKey, validationSignature }` JSON body. Assert the client resolves it and
   `verifyFormationApproval` accepts it. This is the "the real path works at all" case — the stub
   suite already exercises the shape, but never through a real socket.
2. **`403` refusal.** Server answers `403`. Assert `failure === 'refused'`.
3. **`500` unavailable.** Server answers `500`. Assert `failure === 'unavailable'`.
4. **Redirect.** Server answers `302` to another path on the same server. Assert
   `failure === 'unavailable'` — do NOT assert on the specific error message or on whether `fetch`
   rejected vs. resolved with `redirected: true`; the point of this case is pinning that *whichever*
   way Node's real `fetch` reports a rejected redirect, the client still lands on `unavailable`.
5. **Timeout mid-body.** Server writes response headers (`res.writeHead(200, {...}); res.flushHeaders()`)
   and then never writes body or calls `res.end()`. Build the approver with a short `timeoutMs`
   (25-50ms is enough given loopback). Assert `failure === 'unavailable'` and the error message
   names the timeout (mirrors the existing stub test `'times out a hook that answers headers
   instantly and then dribbles the body'`, but through a real socket this time). In the server's
   request handler, destroy the response socket once the test's `afterEach` runs (or on a short
   fallback timer) so the process doesn't hold an open connection past the test.
6. **Oversized undeclared body.** Server answers `200` with `content-type: application/json` and
   NO `content-length` header (so the client can't reject on the declared-size hint and must
   actually be streaming-capped), then writes well over 64 KiB — e.g. repeated `res.write()` calls
   of a few KiB each, up to several hundred KiB total — pacing the writes (e.g. one write per
   `setImmediate`/short `setTimeout`, or awaiting `res.write()`'s backpressure signal) rather than
   firing them all synchronously, so the client's early cancellation has a chance to land before
   every chunk is already queued in the OS socket buffer. Track on the server side how many
   chunks/bytes were actually written before the connection closed (listen for the response's
   `'close'` event, which node fires when the underlying connection is torn down before
   `res.end()` was called). Assert:
   - the client's rejection is `failure === 'malformed'`
   - the server-side write loop was cut off early — i.e. it did NOT get to write everything it
     planned to (`bytesWritten < totalPlannedBytes` or `wroteAllChunks === false`) — proving the
     client actually hung up rather than reading the full oversized body and measuring after the
     fact.

## Edge cases & interactions

- **Server cleanup on every path.** Timeout and abort-mid-read tests leave the server holding an
  open, unfinished response. Make sure `afterEach` (or a per-test `finally`) actually closes the
  listening server AND destroys any still-open sockets — `server.close()` alone waits for
  in-flight connections to end, which they won't if the handler never called `res.end()`.
- **Test flakiness from real timers.** Don't `vi.useFakeTimers()` in this file — these tests
  depend on real elapsed time against a real socket. Keep the timeout-based cases' `timeoutMs`
  small (tens of ms) so the suite stays fast, but not so small that normal loopback jitter
  produces a false timeout in cases 1-4 (those use the default/generous timeout since they
  resolve promptly; only case 5 uses a short one).
- **Port collisions.** Use `listen(0)` (OS-assigned ephemeral port) per test, not a fixed port —
  `vitest.config.ts` already runs this suite with `fileParallelism: false`, so no cross-file port
  race, but a fixed port would still collide with a stray leftover listener from a previous failed
  run.
- **Redirect target must itself resolve inside the same throwaway server** (don't reach out to
  any real external host) — point the `302 Location` at another path on the same
  `http.createServer` instance, and give that second path a handler (even a trivial `200`) in
  case some runtime path actually follows it rather than rejecting.
- **Chunked-transfer vs content-length for the oversized case.** Explicitly omit `content-length`
  (default Node behavior when you don't set it and call `res.write()` before `res.end()` is
  chunked transfer-encoding) — this is what forces the client down the streaming-cap code path
  (`readCappedStream`) instead of the declared-content-length short-circuit
  (`assertUnderCap`/`readCappedText`'s `content-length` check), which is already covered by the
  stub suite and is not the point of this ticket.
- **Don't duplicate the stub suite.** This file is additive real-network coverage for the three
  platform-dependent behaviours above, not a rewrite of
  `packages/cadre-core/test/formation-approval.spec.ts` — leave that file as-is.

## TODO

- Add `packages/integration-tests/test/formation-approval-real-fetch.spec.ts` with the six cases
  above, following `test/block-store-probe.spec.ts`'s plain-spec style (no scenario harness).
- Run `yarn workspace @serfab/integration-tests test` (build `@serfab/cadre-core` first if
  `global-setup.ts`'s freshness guard complains) and confirm all six cases pass against Node's
  real `fetch`.
- Run `yarn workspace @serfab/integration-tests typecheck` (this package's typecheck already
  includes `test/**/*.spec.ts` per its `tsconfig.typecheck.json`).
