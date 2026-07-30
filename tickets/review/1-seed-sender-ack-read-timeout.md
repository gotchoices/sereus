description: The code that hands a fresh seed to a new peer used to wait forever for that peer's reply and would buffer any amount of data it sent back; it now gives up after a deadline and refuses an oversized reply. Review the change.
prereq:
files: packages/cadre-core/src/seed-bootstrap.ts, packages/cadre-core/test/seed-bootstrap.spec.ts, packages/cadre-core/test/wake-stream-helpers.ts, docs/architecture.md
difficulty: medium
----

## What changed

The seed **sender** (`SeedBootstrapService.deliverSeed`) was the last control-stream read
surface with no time or size bound. The three other surfaces (seed receiver, wake receiver,
wake sender) were hardened earlier; this closes the gap using the same primitives.

The exposure: the seed target is a *not-yet-trusted* node the instigator dials during
onboarding. Before this change a target could accept the stream and never reply (parking
`deliverSeed` on a bare `for await` forever), or stream unlimited bytes as a fake ack
(the receiver path capped at 1MB; the sender path capped at nothing).

### `packages/cadre-core/src/seed-bootstrap.ts`

- New `DEFAULT_SEED_DELIVER_TIMEOUT_MS = 10_000` and `SeedBootstrapConfig.seedDeliverTimeoutMs`,
  resolved into `private readonly seedDeliverTimeoutMs` in the constructor — same shape as the
  existing `seedReadTimeoutMs` / `maxConcurrentSeeds` receiver knobs.
- `deliverSeed` is now a thin `withTimeout` + `AbortController` wrapper around a new private
  `sendSeed`, mirroring `dialWake`/`sendWake` in `strand-wake-protocol.ts`. The signal goes into
  `dialProtocol` (so a timeout during connect aborts the dial) and an abort listener resets the
  live stream (so the ack read is released).
- `sendSeed` reads the ack through the shared `readStreamToEnd` (`maxBytes: MAX_SEED_SIZE`,
  `label: 'Seed ack'`) instead of the hand-rolled chunk-accumulation loop. That loop was the
  last one in the package — every control-stream read now goes through the shared helper.
- `JSON.parse` and `decodeLengthPrefixedFrame` stay inside the `try`, so a malformed ack resets
  the stream rather than leaking it.

Public API unchanged: `deliverSeed(targetMultiaddr, seed): Promise<SeedAckMessage>`.
`CadreNode.deliverSeed` (`cadre-node.ts:3796`) and `docs/api.md:14` are untouched. Config-only,
no per-call override — matching the receiver knobs, which are also not plumbed through
`CadreNodeConfig`.

### `packages/cadre-core/test/wake-stream-helpers.ts`

`CapturingStream.abort()` was a bare no-op; it now records into a new `aborted: Error | null`
field (same field name/shape as `NeverEndingStream` / `PausableStream`). Behaviour is otherwise
identical — it still does not release the read, which is fine because its inbound script is finite.

### `packages/cadre-core/test/seed-bootstrap.spec.ts`

`runHandleSeedStream` (the private inbound-handler seam) was hoisted from inside the
`handleSeedStream` describe to module scope so both describes share it.

### `docs/architecture.md`

Added a **Sender hardening (untrusted delivery target)** bullet next to the existing
**Receiver hardening** bullet in the seed-delivery validation list.

## Use cases to exercise / validate

Five new cases in `describe('SeedBootstrapService.deliverSeed — ack read timeout + size cap')`.
All inject a mock node via `serviceInternals(service).libp2pNode = { dialProtocol: ... }`.

- **Target never replies** — `PausableStream`, `seedDeliverTimeoutMs: 50`. Rejects `/timed out/i`,
  stream aborted.
- **Abort does not release the read** — `NeverEndingStream` (whose `abort()` records but does not
  unblock the iterator). Proves the bound comes from the timer race, not from abort incidentally
  freeing the read.
- **Oversized streamed ack** — `CapturingStream` scripted with 9 x 128KB (1,179,648 bytes > 1MB
  `MAX_SEED_SIZE`), `seedDeliverTimeoutMs: 5000` so it is provably the size cap and not the clock.
  Rejects `/too large/i`; the stream is aborted by `sendSeed`'s catch (`readStreamToEnd`'s size-cap
  path deliberately does not abort).
- **Over-declared ack frame** — 8-byte "ack" whose 4-byte prefix claims 2,000,000. Rejects
  `/exceeding max/i` — the `decodeLengthPrefixedFrame` guard, a distinct path from the streamed
  cap.
- **Happy-path round trip** — `duplexPair()` client stream, receiver's `handleSeedStream` driven on
  the server stream with a `pinnedKeyTrustPolicy` for the signer. Asserts `accepted: true`. This is
  the regression guard that the write / half-close / read-ack framing survived the rewrite.

## Validation run

- `yarn workspace @serfab/cadre-core test` — **67 files, 1043 passed, 1 skipped**. Clean; no
  unhandled-rejection or `PromiseRejectionHandledWarning` noise in the output.
- `yarn lint` — clean.
- `npx tsc --noEmit` in `packages/cadre-core` — **exit 0, no errors**. Note: the implement ticket
  warned this typecheck was pre-existing-broken on the `@optimystic/quereus-plugin-crypto`
  `digest()` API drift (backlog `migrate-cadre-to-variadic-digest-api`). It is not broken at this
  SHA — either already resolved or the drift no longer reaches this package. Worth a second look
  if the reviewer expected that failure.

No `tickets/.pre-existing-error.md` was written — nothing failed.

## Known gaps / where to push

- **No real-libp2p coverage of the new path.** Every new test uses in-memory stream doubles. The
  `dialProtocol(addr, SEED_PROTOCOL, { signal })` third argument in particular is only exercised
  against a mock that ignores it. `packages/integration-tests/src/scenarios/deliver-seed-cross-network.integration.ts`
  exercises the real round trip and asserts nothing about error messages, so it should be
  unaffected — but it was **not run** as part of this ticket (real-network integration suite).
  Running it is the highest-value verification left.
- **`{ signal }` on `dialProtocol` is unverified against the real libp2p type.** `sendWake` passes
  `{ runOnLimitedConnection: true, signal }` so the option exists, and tsc is clean, but no test
  proves libp2p actually honours the abort mid-dial. The `if (signal.aborted)` pre-check in
  `sendSeed` is the belt-and-braces path if it does not.
- **Double abort is untested directly.** The timeout listener and the `catch` can both call
  `stream.abort()` on the same stream (the `PausableStream` test does exactly this in passing, but
  nothing asserts on it). Same shape as `sendWake`, so it inherits that risk profile rather than
  introducing a new one.
- **No test asserts the exact rejection string.** Assertions use `/timed out/i` so either the outer
  (`Seed delivery to <addr> timed out after 50ms`) or the inner backstop (`Seed ack read timed out
  after 50ms`) passes. Intentional — the ordering is a race in principle — but it means a
  regression that swapped which bound fires would go unnoticed.
- **Empty-ack behaviour is only incidental.** A target that closes without writing produces
  `Seed frame too short` from `decodeLengthPrefixedFrame`; that is the designed behaviour (do not
  swallow it into a synthetic `{accepted:false}`) but there is no dedicated test pinning it.
- **`runOnLimitedConnection` deliberately NOT set** on the seed dial, unlike wake. Reasoning is in
  a code comment on `sendSeed`: a wake is a tiny frame over a relay, a seed is up to 1MB, and this
  path does not dial relay addresses today. If a reviewer disagrees that is a design call, not a
  bug in this diff.
- **Timer hygiene.** Both `withTimeout` and `readStreamToEnd` clear their timers in `finally`. With
  `NeverEndingStream` the inner backstop timer outlives the outer rejection by ~50ms before
  self-clearing. Test timeouts are short (50ms) so a genuine leak would surface as a hanging suite
  rather than a silent pass — but nothing asserts on timer counts.
