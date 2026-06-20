description: Stop a misbehaving cadre node from hanging the seed-delivery and push-wake handlers forever by adding read timeouts (and a concurrency cap) to the control-network stream readers.
files: packages/cadre-core/src/strand-wake-protocol.ts, packages/cadre-core/src/seed-bootstrap.ts, packages/cadre-core/src/strand-formation-protocol.ts, packages/cadre-core/src/index.ts, packages/cadre-core/test/strand-wake-protocol.spec.ts, packages/cadre-core/test/seed-bootstrap.spec.ts, packages/cadre-core/test/wake-stream-helpers.ts
difficulty: medium
----

## Problem (reproduced)

Both control-network request/response handlers read an inbound stream **to EOF with no
timeout**, so a peer that opens a stream and never half-closes its write end pins the
handler indefinitely:

- `StrandWakeService.handleStream` → `readFrame` (`strand-wake-protocol.ts:71`) iterates
  `for await (const chunk of stream)` until EOF.
- `SeedBootstrapService`'s seed handler — the inline `for await` loop inside
  `registerProtocolHandler` (`seed-bootstrap.ts:709`) — same pattern.

Neither handler caps the number of concurrent inbound streams, so a single own-cadre node
could also open many such streams.

**Reproduction (conceptual, do not commit a hanging test):** the existing `ByteQueue`
double in `test/wake-stream-helpers.ts` models a libp2p 3.x stream; a `ByteQueue` that is
never `end()`ed yields a read iterator that never returns. Driving `handleStream` with such
a stream never resolves — exactly the hang. The fix is verified by a test that asserts the
handler **rejects/returns within a bounded timeout** instead of hanging (passes only after
the fix; a pre-fix run would hang, so it must be written against the timeout, not committed
as an unbounded await).

Both handlers are membership-gated (only this party's `CadrePeer`s connect), so exposure is
a buggy/compromised own-cadre node, not the open internet — which is why
`hibernation-push-wake` deferred this. Worth hardening both protocols together now.

Sender-side gap: `dialWake`'s `withTimeout` (`strand-wake-protocol.ts:254`) rejects on
timeout but never aborts the in-flight `dialProtocol`/`sendWake`, leaking a dangling stream
(and `sendWake`'s own `readFrame<WakeAck>` ack-read is itself unbounded — covered once the
dial is abortable).

## Design

`FormationListener` (in `strand-formation-protocol.ts`, NOT the stale `formation-listener.ts`
path in the source ticket) already implements the target shape: `sessionTimeoutMs` /
`stepTimeoutMs` / `maxConcurrentSessions`, an active-session counter, and a `withTimeout`
wrapper. The `LibP2PStream` interface, `writeFrame`, and `withTimeout` are currently
**triplicated** across `strand-wake-protocol.ts`, `seed-bootstrap.ts`, and
`strand-formation-protocol.ts`.

### New shared module: `packages/cadre-core/src/control-stream.ts`

Lift the duplicated primitives into one place and add a timeout-bounded, abort-on-timeout
read-to-EOF helper:

```ts
/** Minimal libp2p 3.x stream surface: AsyncIterable reads + send()/close()/abort(). */
export interface ControlStream extends AsyncIterable<Uint8Array> {
  send(data: Uint8Array): boolean;
  close(): Promise<void>;
  abort(err: Error): void;
}

/** Write a JSON object as one 4-byte big-endian length-prefixed frame. */
export function writeFrame(stream: ControlStream, obj: unknown): void;

/**
 * Reject if `op` does not settle within `ms`. On timeout, invoke `onTimeout`
 * (used by the sender to abort the in-flight dial/stream) before rejecting.
 */
export function withTimeout<T>(
  ms: number, label: string, op: () => Promise<T>, onTimeout?: () => void,
): Promise<T>;

/**
 * Read a stream to EOF, capped at `maxBytes`, bounded by `timeoutMs`.
 * Implemented as Promise.race([readLoop, timeout]); on timeout it ALSO calls
 * stream.abort(err) to release the hung read. The race guarantees the helper
 * settles at the deadline even if abort() does not immediately unblock the
 * iterator. Returns the assembled bytes (caller decodes via decodeLengthPrefixedFrame).
 */
export function readStreamToEnd(
  stream: ControlStream,
  opts: { maxBytes: number; timeoutMs: number; label: string },
): Promise<Uint8Array>;
```

Notes:
- `readStreamToEnd` returns **raw bytes**, not a decoded frame, so the module has **no**
  dependency on `decodeLengthPrefixedFrame` (which stays in `seed-bootstrap.ts`). This keeps
  the import graph acyclic: `control-stream` ← `seed-bootstrap` ← `strand-wake-protocol`.
- The size-cap (`maxBytes`) path throws synchronously inside the read loop as today — do
  **not** abort on over-size (a well-behaved peer sent a real-but-large frame and may still
  be reading for the ack). Abort is reserved for the **timeout** path (the true hang).

### Wake receiver (`strand-wake-protocol.ts`)

- Replace the local `LibP2PStream`/`writeFrame`/`withTimeout` with imports from
  `control-stream.js`.
- Rewrite `readFrame` to call `readStreamToEnd(stream, { maxBytes: MAX_WAKE_SIZE, timeoutMs, label })`
  then `decodeLengthPrefixedFrame(data, MAX_WAKE_SIZE)` + `JSON.parse`.
- Add `readTimeoutMs` and `maxConcurrent` to `StrandWakeServiceOptions` (optional;
  defaults `DEFAULT_WAKE_READ_TIMEOUT_MS = 10_000`, `DEFAULT_MAX_CONCURRENT_WAKES = 100`).
- `StrandWakeService` gains an `activeStreams` counter. In `handleStream`: if
  `activeStreams >= maxConcurrent`, best-effort `writeFrame` a non-accepting
  `{ accepted: false, reason: 'Too many concurrent wake requests' }`, close, and return
  without incrementing. Otherwise `activeStreams++` in a `try`/`finally` that decrements.
- On read timeout the existing `catch` already writes a non-accepting `WakeAck` (best-effort,
  on the still-open write side) and the `finally` closes — this satisfies the ticket's "reply
  with a non-accepting ack where the protocol allows (wake)". The abort happens inside
  `readStreamToEnd`.

### Seed receiver (`seed-bootstrap.ts`)

- Replace the local `LibP2PStream` with `ControlStream` from `control-stream.js`; use the
  shared `writeFrame` for the ack writes (drops the hand-rolled length-prefix writes).
- **Extract** the inline handler closure body in `registerProtocolHandler` into a private
  `handleSeedStream(stream: ControlStream, remotePeerId: string)` method (mirrors wake's
  testable `handleStream` seam — the seed handler currently has no unit-test seam, only the
  registration closure). The registration closure just delegates to it.
- Inside, replace the inline `for await` accumulation with
  `readStreamToEnd(stream, { maxBytes: MAX_SEED_SIZE, timeoutMs, label })`.
- Add optional `seedReadTimeoutMs` / `maxConcurrentSeeds` to `SeedBootstrapConfig`
  (defaults `DEFAULT_SEED_READ_TIMEOUT_MS = 10_000`, `DEFAULT_MAX_CONCURRENT_SEEDS = 100`)
  and an `activeStreams` counter on the service, same cap shape as wake. Per the ticket,
  seed's timeout path **just aborts** (abort lives in `readStreamToEnd`); the existing error
  `catch` still emits a non-accepting `SeedAckMessage` best-effort, which is harmless.
- Leave `deliverSeed` (the sender ack-read to EOF) for a follow-up note only if time allows —
  it is bounded by the dial context, not the receiver hang this ticket targets. Do NOT
  expand scope into it unless trivial; document if deferred.

### Sender abort (`dialWake` / `sendWake` in `strand-wake-protocol.ts`)

- Give `sendWake` an `AbortSignal` parameter; pass it to
  `node.dialProtocol(addr, protocolId, { runOnLimitedConnection: true, signal })` so a
  timeout during connect aborts the dial. After the stream opens, register
  `signal.addEventListener('abort', () => stream.abort(timeoutErr), { once: true })` (and
  handle the already-aborted case); remove the listener in `finally`.
- In `dialWake`, create one `AbortController` per attempt and call the new
  `withTimeout(timeoutMs, label, () => sendWake(..., controller.signal), () => controller.abort())`.
  On timeout the controller fires → the listener aborts the live stream → no leak; the
  unbounded `readFrame<WakeAck>` ack-read is released the same way.

### `strand-formation-protocol.ts` / `index.ts`

- Optionally re-point `FormationListener` at the shared `ControlStream`/`writeFrame`/
  `withTimeout` to retire the triplication — **only if** it stays a pure no-behavior-change
  refactor (formation's `withTimeout` has no `onTimeout`, which the shared signature makes
  optional, so it is compatible). If it adds any risk, leave formation untouched and just
  note the remaining duplication.
- Export the new `control-stream` symbols from `index.ts` if any consumer outside cadre-core
  needs them; otherwise keep them module-internal (no consumer is known — default to NOT
  exporting, to avoid widening the public surface).

## Testing

- Add a **never-ending** stream double to `test/wake-stream-helpers.ts` (a stream whose async
  iterator awaits a never-resolved promise; `abort()` may stay a no-op since
  `readStreamToEnd` uses `Promise.race`). Construct it so tests run fast.
- Wake: a test that drives `handleStream` with the never-ending stream under a short
  `readTimeoutMs` (e.g. 50ms) and asserts it settles within the deadline (and emits a
  non-accepting ack). A test for the concurrency cap: hold `maxConcurrent` streams open, then
  assert the next stream gets the "too many concurrent" non-accepting ack without invoking
  `wake`.
- Seed: with the new `handleSeedStream` seam + `createMockLibp2p`, assert the same
  timeout-bounded settle and concurrency-cap rejection.
- `dialWake`: a `loopbackNode` whose receiver never replies (server stream never written/
  closed) under a short `timeoutMs`, asserting the dial rejects on timeout AND that the
  client stream was aborted (extend the mock to record `abort`).
- Keep existing wake/seed specs green (the framing round-trip, decision matrix, and
  oversized/malformed-frame ack paths must be unchanged).

## TODO

- [ ] Add `packages/cadre-core/src/control-stream.ts` with `ControlStream`, `writeFrame`,
      `withTimeout(ms, label, op, onTimeout?)`, and `readStreamToEnd(stream, opts)`
      (Promise.race read-loop-vs-timeout, abort-on-timeout, size cap).
- [ ] Wake receiver: import shared primitives, rewrite `readFrame` over `readStreamToEnd`,
      add `readTimeoutMs`/`maxConcurrent` options + `activeStreams` counter + cap rejection.
- [ ] Wake sender: thread an `AbortSignal` through `sendWake`, pass it to `dialProtocol`,
      abort the live stream on signal, and wire `dialWake`'s `withTimeout` `onTimeout` to
      `controller.abort()`.
- [ ] Seed receiver: import `ControlStream`/`writeFrame`, extract `handleSeedStream`, read via
      `readStreamToEnd`, add `seedReadTimeoutMs`/`maxConcurrentSeeds` + `activeStreams` cap.
- [ ] Optionally retire the triplicated `LibP2PStream`/`writeFrame`/`withTimeout` in
      `strand-formation-protocol.ts` via the shared module — only as a zero-behavior-change
      refactor; otherwise leave it and note the residual duplication.
- [ ] Tests: never-ending stream double; wake + seed timeout-settle and concurrency-cap
      tests; `dialWake` timeout-aborts-stream test; keep all existing specs green.
- [ ] `cd packages/cadre-core && yarn build 2>&1 | tee /tmp/build.log` and
      `yarn test 2>&1 | tee /tmp/test.log` (stream output; never silent-redirect). Run
      `yarn lint` for the touched files.
