description: Harden the cadre control-network stream readers so a misbehaving same-cadre node can no longer hang the seed-delivery or push-wake handlers forever, by adding read timeouts and a concurrent-stream cap.
files: packages/cadre-core/src/control-stream.ts, packages/cadre-core/src/strand-wake-protocol.ts, packages/cadre-core/src/seed-bootstrap.ts, packages/cadre-core/src/strand-formation-protocol.ts, packages/cadre-core/test/wake-stream-helpers.ts, packages/cadre-core/test/strand-wake-protocol.spec.ts, packages/cadre-core/test/seed-bootstrap.spec.ts
difficulty: medium
----

## What shipped

A misbehaving/compromised own-cadre node could open a control-network stream and never
half-close its write end, pinning the seed and push-wake receivers forever (both read
`for await … EOF` with no timeout), and could open unbounded concurrent streams. This
hardens both — and folds the previously **triplicated** stream primitives into one module.

### New shared module — `src/control-stream.ts`

Single home for the libp2p-3.x stream surface and framing, previously copy-pasted across
three protocol files:

- `ControlStream` — `AsyncIterable<Uint8Array>` + `send()/close()/abort()`.
- `writeFrame(stream, obj)` — one 4-byte big-endian length-prefixed JSON frame.
- `withTimeout(ms, label, op, onTimeout?)` — rejects `"<label> timed out after <ms>ms"`;
  the **new** optional `onTimeout` runs before the rejection (the sender uses it to abort
  the in-flight dial/stream). A throwing `onTimeout` is swallowed so it can't mask the
  timeout.
- `readStreamToEnd(stream, { maxBytes, timeoutMs, label })` → **raw bytes** (caller decodes).
  `Promise.race([readLoop, timeout])`. The **timeout** path also calls `stream.abort(err)`
  to release the hung read; the race guarantees the helper settles at the deadline even if
  `abort()` does not promptly unblock the iterator. The **size-cap** path throws synchronously
  inside the loop and does **NOT** abort (a well-behaved peer may have sent a real-but-large
  frame and still be reading for the ack). Returns raw bytes → no `decodeLengthPrefixedFrame`
  dependency, so the import graph stays acyclic: `control-stream ← seed-bootstrap ← strand-wake`.

### Wake receiver (`strand-wake-protocol.ts`)

- `readFrame` now goes through `readStreamToEnd` (label `'Wake'`, cap `MAX_WAKE_SIZE` 64KB).
- New `StrandWakeServiceOptions.readTimeoutMs` (default 10_000) and `maxConcurrent`
  (default 100); an `activeStreams` counter + `activeCount` getter.
- `handleStream`: over the cap → best-effort non-accepting ack `"Too many concurrent wake
  requests"`, close, return **without** incrementing or touching the wake path. Otherwise
  `activeStreams++` in `try`/`finally`. On read timeout the existing `catch` writes the
  non-accepting `WakeAck` (the ticket's "reply where the protocol allows"); abort happens
  inside `readStreamToEnd`.

### Wake sender (`dialWake` / `sendWake`)

- `dialWake` creates one `AbortController` **per attempt** and calls
  `withTimeout(timeoutMs, label, () => sendWake(…, signal), () => controller.abort())`.
- `sendWake` passes `signal` to `node.dialProtocol(addr, id, { runOnLimitedConnection: true,
  signal })` (timeout during connect aborts the dial), registers a once `abort` listener that
  resets the live stream (releases the otherwise-unbounded `readFrame<WakeAck>` ack-read),
  handles the already-aborted-during-connect case, and removes the listener in `finally`.
  `readFrame` still applies `timeoutMs` as a backstop for transports where abort doesn't
  propagate.

### Seed receiver (`seed-bootstrap.ts`)

- Local `LibP2PStream` dropped for shared `ControlStream`; ack/send go through `writeFrame`
  (including `deliverSeed`'s send).
- Inline handler closure **extracted** to a private `handleSeedStream(stream, remotePeerId)`
  (a unit-test seam the inline closure never had); registration just delegates.
- Reads via `readStreamToEnd` (label `'Seed'`, cap `MAX_SEED_SIZE` 1MB). New config
  `seedReadTimeoutMs` (default 10_000) and `maxConcurrentSeeds` (default 100) + `activeStreams`
  cap, same shape as wake; over the cap → `"Too many concurrent seed deliveries"`.

### Formation (`strand-formation-protocol.ts`) — zero-behavior-change refactor

Retired its triplicated `LibP2PStream`/`writeFrame`/`withTimeout` for the shared module. The
`FrameReader` (formation's frame-at-a-time reader) is unchanged. Timeout messages preserved
exactly by passing `"Formation …"`-prefixed labels (shared `withTimeout` drops the old hard-coded
`Formation ` prefix). No `control-stream` symbols exported from `index.ts` (no external consumer).

## How to validate

Run from `packages/cadre-core`. Note the repo-wide pre-existing break first (below).

- `yarn test --run strand-wake-protocol` — fully green, incl. new:
  - **timeout-settle**: `handleStream` on a never-half-closing stream under `readTimeoutMs: 50`
    settles, emits a non-accepting `/timed out/` ack, records `abort`, never wakes.
  - **concurrency cap**: hold 2 parked streams (cap 2) → next gets `/too many concurrent/`
    without invoking `wake`; `activeCount` stays 2.
  - **dialWake abort**: receiver never replies under `timeoutMs: 50` → dial rejects `/timed
    out/` AND the client stream was aborted.
- `yarn test --run strand-formation-protocol` — fully green (refactor preserved behavior).
- `yarn test --run seed-bootstrap` — the **new** `handleSeedStream` timeout-settle +
  concurrency-cap tests pass (the other 16 failures are pre-existing — see below).
- Test doubles added to `test/wake-stream-helpers.ts`: `NeverEndingStream` (read never
  completes; `abort()` is a no-op for the iterator, so the timeout-settle test proves the
  `Promise.race` deadline alone, not abort, releases it) and `PausableStream` (parked read,
  `release()`/`abort()` lets it reach EOF so held-stream timers clear before teardown).

## Known gaps / reviewer attention

- **PRE-EXISTING, BLOCKS FULL GREEN — see `tickets/.pre-existing-error.md`.** The linked
  `@optimystic/quereus-plugin-crypto` workspace's `digest()` drifted (now 1-3 args; rejects
  `'utf8'` output encoding) while all of Sereus calls the 4-arg `digest(data,algo,'utf8',out)`
  form. This breaks `yarn build`/`yarn typecheck` and 112 of 546 cadre-core tests — every one
  the `Unsupported output encoding: utf8` crypto error, across 17 spec files this ticket never
  touched. This ticket's code calls no `digest`; `yarn typecheck` shows **zero** non-`digest`
  errors and `yarn lint` is clean. vitest (esbuild) runs regardless, which is how the protocol
  specs above were validated.
- **`deliverSeed` sender ack-read** still reads to EOF without its own timeout (it's bounded by
  the dial context, not the receiver hang this ticket targets). Deliberately deferred per the
  ticket — a candidate follow-up if a sender-side bound is wanted (would mirror the wake
  sender's abort-on-timeout).
- **Abort vs. race in production.** `readStreamToEnd` settles at the deadline via the race; the
  `stream.abort()` is what actually frees the libp2p read in production. The tests cover the
  race-settles path and (in `dialWake`) that abort is invoked, but do not run against a real
  libp2p stream — worth a glance that `abort()` semantics match the assumption. The existing
  integration tests (`integration-tests/.../deliver-seed-cross-network`, `push-wake-e2e`) are
  the real-network coverage but are currently blocked by the same crypto drift.
- **Counters are per-service, not per-peer.** The concurrency cap bounds total in-flight inbound
  streams on a service; it is not a per-remote-peer quota. Acceptable for the membership-gated
  threat model (a single buggy own-cadre node), but note it.
- **No new public surface.** `control-stream` is intentionally module-internal.
