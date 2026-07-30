----
description: When a node hands a fresh seed to a new peer it then waits for that peer's reply with no time limit and no size limit, so a broken or hostile new peer can hang the giver forever or flood it out of memory; put a bounded, cancellable wait around that reply.
prereq:
files: packages/cadre-core/src/seed-bootstrap.ts, packages/cadre-core/src/control-stream.ts, packages/cadre-core/src/strand-wake-protocol.ts, packages/cadre-core/test/seed-bootstrap.spec.ts, packages/cadre-core/test/wake-stream-helpers.ts, docs/architecture.md
difficulty: medium
----

## Background

Three of the four cadre control-stream read surfaces are already hardened against a peer that
opens a stream and never half-closes its write end (`control-protocol-stream-read-timeouts`):

- seed receiver (`SeedBootstrapService.handleSeedStream`) — read timeout + concurrency cap
- wake receiver (`StrandWakeService.handleStream`) — read timeout + concurrency cap
- wake sender (`sendWake`) — per-attempt `AbortController`, so a dial timeout resets the live stream

The **seed sender** — `SeedBootstrapService.deliverSeed` (`packages/cadre-core/src/seed-bootstrap.ts:823`)
— is the remaining gap. After `writeFrame` + `stream.close()` it reads the ack with a bare,
unbounded loop (~line 852):

```ts
const chunks: Uint8Array[] = [];
for await (const chunk of stream) {        // no timeout, no size cap, no abort
  chunks.push(...);
}
```

Both vectors are driven by the **seed target**, which during onboarding is a *not-yet-trusted*
node the instigator chose to dial — arguably more exposed than the membership-gated receiver paths:

- **Hang:** the target accepts the stream, never writes the ack, never half-closes → `deliverSeed`
  parks on the `for await` indefinitely. Nothing at the dial layer bounds a read on an
  already-open stream.
- **Unbounded memory:** unlike the receiver path (capped at `MAX_SEED_SIZE`), the sender's
  ack-read has no size cap, so a target can stream arbitrary bytes as a fake "ack" and OOM
  the instigator.

## Design

Mirror the wake sender (`strand-wake-protocol.ts` → `dialWake` / `sendWake`) exactly; the shared
primitives (`withTimeout`, `readStreamToEnd`) already exist in `control-stream.ts` and need no
change.

### Timeout source

Add a sender-side config knob alongside the existing receiver knobs on `SeedBootstrapConfig`:

```ts
/** Default time the sender waits for a seed delivery (dial + ack read) before aborting (ms). */
const DEFAULT_SEED_DELIVER_TIMEOUT_MS = 10_000;

export interface SeedBootstrapConfig {
  // ...
  /**
   * Time `deliverSeed` waits for the whole exchange — dial, write, ack read —
   * before aborting (ms). Defaults to DEFAULT_SEED_DELIVER_TIMEOUT_MS.
   */
  seedDeliverTimeoutMs?: number;
}
```

Resolved in the constructor into `private readonly seedDeliverTimeoutMs`, same shape as
`seedReadTimeoutMs` / `maxConcurrentSeeds`.

**Decided tradeoff:** config-only, no per-call `options` argument on `deliverSeed`. The receiver
knobs are config-only and are not plumbed through `CadreNodeConfig` either (`CadreNode.deliverSeed`
at `cadre-node.ts:3792` just forwards); a per-call override would be new public API with no caller
asking for it. Tests set it on the directly-constructed service. If a caller later needs per-dial
control, add the override then.

`deliverSeed`'s public signature stays `(targetMultiaddr: string, seed: ControlNetworkSeed):
Promise<SeedAckMessage>` — `docs/api.md:14` and `CadreNode.deliverSeed` are unchanged.

### Shape

```ts
async deliverSeed(targetMultiaddr: string, seed: ControlNetworkSeed): Promise<SeedAckMessage> {
  if (!this.libp2pNode) {
    throw new Error('Service not initialized');
  }
  const node = this.libp2pNode;            // capture: no non-null assertion inside the closure
  const addr = multiaddr(targetMultiaddr);
  log('Delivering seed to: %s', targetMultiaddr);

  // One controller for the attempt: on timeout, withTimeout's onTimeout aborts it,
  // which aborts the in-flight dialProtocol (via the dial `signal`) and the live
  // stream — so neither the connect nor the ack-read leaks.
  const controller = new AbortController();
  return await withTimeout(
    this.seedDeliverTimeoutMs,
    `Seed delivery to ${targetMultiaddr}`,
    () => this.sendSeed(node, addr, seed, controller.signal),
    () => controller.abort(),
  );
}
```

and a private `sendSeed` mirroring `sendWake`:

```ts
private async sendSeed(
  node: Libp2p,
  addr: Multiaddr,
  seed: ControlNetworkSeed,
  signal: AbortSignal,
): Promise<SeedAckMessage> {
  const rawStream = await node.dialProtocol(addr, SEED_PROTOCOL, { signal });
  const stream = rawStream as unknown as ControlStream;

  const abortErr = new Error('Seed delivery aborted by timeout');
  const onAbort = (): void => stream.abort(abortErr);
  // If the timeout already fired during connect, release the freshly-opened stream now.
  if (signal.aborted) {
    onAbort();
    throw abortErr;
  }
  signal.addEventListener('abort', onAbort, { once: true });

  try {
    const message: SeedMessage = { partyId: seed.partyId, peers: seed.peers, signature: seed.signature, signerKey: seed.signerKey };
    writeFrame(stream, message);
    // close() half-closes the write end (EOF) while the read end stays open for the ack.
    await stream.close();

    const data = await readStreamToEnd(stream, {
      maxBytes: MAX_SEED_SIZE,
      timeoutMs: this.seedDeliverTimeoutMs,
      label: 'Seed ack',
    });
    const ack = JSON.parse(new TextDecoder().decode(decodeLengthPrefixedFrame(data))) as SeedAckMessage;
    log('Seed delivery response: accepted=%s', ack.accepted);
    return ack;
  } catch (err) {
    stream.abort(err instanceof Error ? err : new Error(String(err)));
    throw err;
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}
```

Notes the implementer should keep in the code as comments (they are the non-obvious parts):

- The `readStreamToEnd` timeout is a **backstop**, not the primary bound — the outer `withTimeout`
  starts first and therefore fires first; the inner one covers the case where an abort does not
  propagate (a stream double whose `abort()` is a no-op). Same reasoning as `sendWake`.
- `readStreamToEnd`'s size-cap path deliberately does NOT abort the stream (see its doc comment);
  `sendSeed`'s `catch` is what resets the stream on an oversized ack.
- Do **not** add `runOnLimitedConnection` here. Wake sets it because a wake is a tiny frame over a
  relay; a seed is up to 1MB and today's delivery path does not dial relay addresses. Changing that
  is a separate decision, not part of this hardening.

This also deletes the last hand-rolled chunk-accumulation loop in the package — every control-stream
read now goes through `readStreamToEnd`.

## Edge cases & interactions

- **Timeout fires during connect.** `dialProtocol` may still resolve with a live stream (mock
  doubles, and real libp2p races). The `signal.aborted` pre-check must reset that stream and throw,
  or it leaks. Covered by the `if (signal.aborted)` branch — keep it.
- **Double abort.** The timeout path (`onAbort`) and the `catch` can both call `stream.abort()` on
  the same stream. Must be harmless; libp2p's abort is a reset and the test doubles tolerate it.
  Same shape as `sendWake`.
- **`dialProtocol` rejects** (unreachable target): no stream exists, the listener was never
  registered, and the rejection propagates through `withTimeout` unchanged. Existing
  `deliver-seed-cross-network` integration expectations must not change.
- **Late rejection of the inner op after the outer timeout already rejected.** `withTimeout` does
  `op().then(resolve, reject)`, so the handler is attached — the second settle is a no-op, not an
  unhandled rejection. Verify no `PromiseRejectionHandledWarning`/unhandled-rejection noise in the
  vitest run.
- **Empty ack** (target closes without writing): `readStreamToEnd` returns 0 bytes,
  `decodeLengthPrefixedFrame` throws `Seed frame too short` — the stream is aborted and the error
  surfaces. Do not swallow it into a synthetic `{accepted:false}`.
- **Malformed / over-declared ack frame**: declared length > `MAX_SEED_SIZE` → the existing
  `decodeLengthPrefixedFrame` guard throws (distinct path from the streamed-bytes cap; both need
  a test).
- **Non-JSON ack body**: `JSON.parse` throws inside the `try`, so the stream is aborted and the
  error propagates — do not leave the parse outside the `try`.
- **Timer hygiene.** Both `withTimeout` and `readStreamToEnd` clear their timers in `finally`; a
  test whose inner read never settles must still leave no timer alive past the outer deadline. Keep
  the test timeouts short (~50ms) so a leak shows as a slow/hanging suite, not a silent pass.
- **Receiver interaction unchanged.** `handleSeedStream` still writes the ack then closes in its
  `finally`; the round-trip test below is the regression guard that framing survives the refactor.
- **`CadreNode.deliverSeed`** passes through untouched — no signature or return-shape change.

## Tests

Add to `packages/cadre-core/test/seed-bootstrap.spec.ts`, in a new
`describe('SeedBootstrapService.deliverSeed — ack read timeout + size cap')`. Reuse
`duplexPair` / `PausableStream` / `CapturingStream` / `decodeFrames` from
`test/wake-stream-helpers.ts` (already imported by this spec) and inject a mock node via the
existing `serviceInternals(service).libp2pNode = ...` seam, mirroring
`strand-wake-protocol.spec.ts`'s `loopbackNode`:

- **Times out and aborts the stream when the target never replies.** Mock node whose
  `dialProtocol` returns a `PausableStream`; service constructed with `seedDeliverTimeoutMs: 50`.
  `await expect(service.deliverSeed(addr, seed)).rejects.toThrow(/timed out/i)` and
  `expect(stream.aborted).toBeTruthy()`.
- **Same, with `NeverEndingStream`** (whose `abort()` does not release the read) — proves the
  helper settles at the deadline on its own rather than because the abort happened to unblock
  the iterator.
- **Rejects an oversized streamed ack.** `dialProtocol` returns a `CapturingStream` scripted with
  9 × 128KB chunks (1,179,648 bytes > the 1MB `MAX_SEED_SIZE`); give the service a comfortable
  `seedDeliverTimeoutMs` (e.g. 5000) so it is provably the size cap and not the clock that trips.
  Expect `rejects.toThrow(/too large/i)` and the stream aborted.
- **Rejects an over-declared ack frame.** A 8-byte "ack" whose 4-byte prefix declares 2,000,000
  bytes → `rejects.toThrow(/exceeding max/i)` (the `decodeLengthPrefixedFrame` guard, a distinct
  path from the streamed-bytes cap).
- **Happy-path round trip still works.** `dialProtocol` returns `duplexPair().clientStream` and
  drives the receiver's `handleSeedStream` on `serverStream` (the same private seam
  `runHandleSeedStream` in the existing describe uses). Assert `deliverSeed` resolves with the
  receiver's `SeedAckMessage` — this is the regression guard that the framing/half-close sequence
  survived the rewrite.

Expected output shape: the timeout rejection message is exactly
`Seed delivery to <addr> timed out after 50ms` (outer) or `Seed ack read timed out after 50ms`
(inner backstop) — assert on `/timed out/i`, not the full string, so either ordering passes.

## Docs

`docs/architecture.md` — the seed-delivery bullet list currently ends with
**"Receiver hardening (within-membership DoS)"** (search for `seedReadTimeoutMs`). Add a
companion **sender hardening** sentence to that same bullet area: `deliverSeed` bounds the whole
exchange with `seedDeliverTimeoutMs` (default 10s) and caps the ack it will buffer at
`MAX_SEED_SIZE`, because the seed target is a not-yet-trusted node. Don't add a new doc file.

## Validation

- `yarn workspace @serfab/cadre-core test` (vitest/esbuild) — scope assertions to the seed specs.
- `yarn lint`.
- **Known pre-existing break, not yours:** the full cadre-core `tsc` typecheck fails on the linked
  `@optimystic/quereus-plugin-crypto` `digest()` API drift (4-arg → 1-3 arg, no `'utf8'` output
  encoding), tracked by backlog `migrate-cadre-to-variadic-digest-api`. The vitest run executes
  regardless. Don't chase it, don't skip tests around it.

## TODO

Phase 1 — sender hardening

- Add `DEFAULT_SEED_DELIVER_TIMEOUT_MS` + `SeedBootstrapConfig.seedDeliverTimeoutMs`, resolve into
  `private readonly seedDeliverTimeoutMs` in the constructor.
- Import `withTimeout` from `control-stream.js` (`readStreamToEnd` / `writeFrame` are already
  imported) and `type Multiaddr` from `@multiformats/multiaddr`.
- Rewrite `deliverSeed` as the `withTimeout` + `AbortController` wrapper; extract `sendSeed` with
  the abort-listener lifecycle and the `readStreamToEnd` + `decodeLengthPrefixedFrame` ack read.
- Delete the hand-rolled chunk-accumulation loop.

Phase 2 — tests + docs

- Add the `deliverSeed` describe block with the five cases above.
- Extend the `docs/architecture.md` hardening bullet with the sender side.
- Run the cadre-core vitest suite and `yarn lint`; report any failure honestly in the review handoff.
