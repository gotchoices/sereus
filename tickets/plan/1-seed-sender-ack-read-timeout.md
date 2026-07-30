description: When a node hands a fresh seed to a new peer it then waits for that peer's acknowledgement with no time limit, so a broken or hostile new peer can hang the giver forever (or flood it out of memory); add a bounded, abortable wait like the wake protocol already has.
prereq:
files: packages/cadre-core/src/seed-bootstrap.ts, packages/cadre-core/src/control-stream.ts, packages/cadre-core/src/strand-wake-protocol.ts, packages/cadre-core/test/seed-bootstrap.spec.ts, packages/cadre-core/test/wake-stream-helpers.ts
difficulty: medium
----

## Background

The `control-protocol-stream-read-timeouts` ticket hardened three of the four control-stream
read surfaces against a peer that opens a stream and never half-closes its write end:

- **seed receiver** (`handleSeedStream`) — read timeout + concurrency cap (done)
- **wake receiver** (`handleStream`) — read timeout + concurrency cap (done)
- **wake sender** (`sendWake`) — per-attempt `AbortController`; on dial timeout the live
  stream is aborted so the otherwise-unbounded ack-read is released (done)

The **seed sender** — `SeedBootstrapService.deliverSeed` — was deliberately left out of scope and
is the remaining gap. After `writeFrame(stream, message)` + `stream.close()` it reads the ack with
a bare, unbounded loop (`seed-bootstrap.ts` ~line 591):

```ts
const chunks: Uint8Array[] = [];
for await (const chunk of stream) {        // no timeout, no size cap, no abort
  chunks.push(...);
}
```

Two concrete vectors, both driven by the **seed target** — which during onboarding is a
*not-yet-trusted* node the instigator chose to dial, so this is arguably a more exposed surface
than the membership-gated receiver paths:

- **Hang:** the target accepts the stream, never writes the ack, never half-closes → `deliverSeed`
  parks on the `for await` indefinitely. The implement handoff claimed this is "bounded by the dial
  context," but once the stream is open the read has no dial-level deadline governing it.
- **Unbounded memory:** unlike the receiver path (capped at `MAX_SEED_SIZE`), the sender's ack-read
  has **no** size cap, so a target can stream arbitrary bytes as a fake "ack" and OOM the instigator.

## What to build

Mirror the wake-sender pattern. `deliverSeed` should:

- Accept/derive a timeout (reuse the existing seed timeout convention; add a sender-side
  `seedDialTimeoutMs`-style option with the same 10s default if none fits).
- Pass an `AbortSignal` into `dialProtocol(addr, SEED_PROTOCOL, { signal })` so a timeout during
  connect aborts the dial.
- Once the stream is open, replace the hand-rolled ack-read loop with the shared
  `readStreamToEnd(stream, { maxBytes: MAX_SEED_SIZE, timeoutMs, label: 'Seed ack' })` so the read is
  both size-capped and abort-on-timeout, then decode via `decodeLengthPrefixedFrame` exactly as the
  receiver does. This also removes the last copy of the manual chunk-accumulation loop.
- Register a once `abort` listener that resets the live stream (and handle the already-aborted-during-
  connect case), removing the listener in `finally` — same shape as `sendWake`.

## Tests

Add to `seed-bootstrap.spec.ts`, reusing `PausableStream`/`NeverEndingStream` from
`wake-stream-helpers.ts`:

- target never replies under a short `timeoutMs` → `deliverSeed` rejects with `/timed out/i` and the
  client stream was aborted (mirrors the existing `dialWake` abort test).
- target streams past `MAX_SEED_SIZE` as a fake ack → rejects `/too large/i` without buffering it all.

## Notes

- Lower severity than the receiver hangs (sender-initiated, requires the instigator to have chosen to
  dial a malicious/buggy target), which is why it was deferred — but it is a real DoS/OOM vector and
  the only un-hardened control-stream read left.
- The full cadre-core suite currently has a pre-existing break unrelated to this work: the linked
  `@optimystic/quereus-plugin-crypto` `digest()` API drift (4-arg → 1-3 arg / no `'utf8'` output
  encoding), tracked by backlog `migrate-cadre-to-variadic-digest-api`. Validate via the vitest
  (esbuild) run, which executes regardless of the `tsc` typecheck break, and scope assertions to the
  seed-delivery tests.
