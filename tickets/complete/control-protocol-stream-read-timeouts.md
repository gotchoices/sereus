description: Hardened the cadre control-network stream readers so a misbehaving same-cadre node can no longer hang the seed-delivery or push-wake handlers forever, by adding read timeouts and a concurrent-stream cap, and folded the previously-triplicated stream primitives into one shared module.
files: packages/cadre-core/src/control-stream.ts, packages/cadre-core/src/strand-wake-protocol.ts, packages/cadre-core/src/seed-bootstrap.ts, packages/cadre-core/src/strand-formation-protocol.ts, packages/cadre-core/test/wake-stream-helpers.ts, packages/cadre-core/test/strand-wake-protocol.spec.ts, packages/cadre-core/test/seed-bootstrap.spec.ts, docs/architecture.md
----

## What shipped

A misbehaving/compromised own-cadre node could open a control-network stream and never half-close
its write end, pinning the seed and push-wake receivers forever (both read `for await … EOF` with no
timeout), and could open unbounded concurrent streams. This hardens both, and folds the previously
**triplicated** stream primitives into one module (`control-stream.ts`).

- **New shared module `src/control-stream.ts`** — `ControlStream` interface, `writeFrame`,
  `withTimeout` (with optional abort-on-timeout `onTimeout`), and `readStreamToEnd` (size-capped,
  timeout-bounded, abort-on-timeout via `Promise.race([readLoop, timeout])`, returning raw bytes so
  the import graph stays acyclic). Not exported from `index.ts` (module-internal by design).
- **Wake receiver** — `readFrame` routes through `readStreamToEnd` (`'Wake'`, 64KB cap); new
  `readTimeoutMs` (default 10s) + `maxConcurrent` (default 100) with an `activeStreams` counter and
  `activeCount` getter; over-cap → non-accepting ack without touching the wake path.
- **Wake sender** — per-attempt `AbortController`; on dial timeout `onTimeout` aborts it, aborting
  the in-flight `dialProtocol` (via `signal`) and the live stream so neither the connect nor the
  ack-read leaks.
- **Seed receiver** — inline handler extracted to `handleSeedStream` (unit-test seam); reads via
  `readStreamToEnd` (`'Seed'`, 1MB cap); new `seedReadTimeoutMs` + `maxConcurrentSeeds`, same shape
  as wake.
- **Formation** — zero-behavior-change refactor onto the shared module; timeout messages preserved
  by folding the old `Formation ` prefix into the passed labels. Its multi-frame `FrameReader` is
  unchanged (intentionally not consolidated — different read pattern).

## How it was validated

Run from `packages/cadre-core`. Repo-wide pre-existing break (crypto `digest` drift) noted below;
vitest (esbuild) runs regardless of the `tsc` typecheck break.

- `yarn lint` (repo root) — **clean** (exit 0).
- `yarn test --run strand-wake-protocol` — **16/16 pass** (incl. timeout-settle, concurrency cap,
  dial-abort, plus pre-existing round-trip/oversized/accumulation-cap coverage).
- `yarn test --run strand-formation-protocol` — **16/16 pass** (refactor preserved behavior).
- `yarn test --run seed-bootstrap` — the **2 new** `handleSeedStream` tests (timeout-settle +
  concurrency cap) pass; the other **16 failures are pre-existing** crypto-`digest` failures (see
  below), all in signature/trust-policy/registerSelf tests this ticket never touched.

## Review findings

Adversarial pass over the implement diff (commit `5a797ca`), read before the handoff summary.
Scrutinized for correctness, DRY, modularity, type-safety, error handling, resource cleanup, and
test/doc coverage.

### Checked and clean

- **DRY / consolidation** — the three copies of `LibP2PStream`/`writeFrame`/`withTimeout` are gone;
  `grep` confirms no stale `LibP2PStream` references and all three protocol files import the shared
  module. Formation's `FrameReader` is rightly left separate (it reads frame-at-a-time, not read-to-
  EOF).
- **Concurrency cap atomicity** — the `>= cap` check and `activeStreams++` are synchronous with no
  intervening `await`, so single-threaded JS makes the gate race-free. Over-cap path neither
  increments nor decrements; the accept path balances `++`/`--` across `try`/`finally`. Verified for
  both wake and seed.
- **Resource cleanup** — `readStreamToEnd` clears its timer in `.finally`; `withTimeout` clears via
  `op().finally`; the wake sender removes its abort listener in `finally`; `activeStreams` is
  decremented in `finally`. The new test doubles (`PausableStream`) are released so no read-timeout
  timers linger past teardown.
- **No unhandled rejections** — in both `Promise.race` (`readStreamToEnd`) and `op().then(resolve,
  reject)` (`withTimeout`), the losing/late promise already has a handler attached, so a post-settle
  rejection is consumed, not surfaced.
- **Slow-drip-under-cap hang** — considered: a peer that streams bytes forever while staying under
  the size cap and never reaching EOF is still released by the timeout race (the cap alone would
  never trip). Covered by the design, not just the test double.
- **Error handling** — every `send`/`close`/`abort` on a reject/error path is wrapped best-effort; a
  throwing `onTimeout` is swallowed so it can't mask the timeout. Matches the "exceptions are
  exceptional" rule.
- **Type safety** — no `any` in `src`; `ControlStream` is shared; test-only `unknown` casts are
  confined to private-method test seams.
- **Test coverage** — happy-path round-trip, timeout-settle (never-half-closing), concurrency cap,
  oversized-declared-length and accumulated-byte caps, dial-abort, and no-dialable-addr are all
  exercised across the two suites.

### Fixed in this pass (minor)

- **Docs were stale.** `docs/architecture.md` described the seed and wake protocols and their
  membership-gated threat model but predated this hardening. Added a concise *receiver hardening
  (within-membership DoS)* note to the Seed Delivery validation list and a sentence to the push-wake
  mechanism paragraph, naming `readTimeoutMs`/`maxConcurrent`/`seedReadTimeoutMs`/`maxConcurrentSeeds`
  and pointing both at the shared `control-stream.ts`. (No other doc touched by the change needed
  edits.)

### Filed as follow-up (major → new ticket)

- **`backlog/seed-sender-ack-read-timeout`** — the seed **sender** (`deliverSeed`) is the one
  control-stream read left un-hardened: its ack-read (`seed-bootstrap.ts` ~591) is a bare unbounded
  `for await` with **no** timeout, **no** size cap, and no abort. A seed *target* (an un-onboarded,
  not-yet-trusted node the instigator dialed) can therefore hang `deliverSeed` forever, or stream
  unbounded bytes as a fake ack to OOM the instigator (the receiver path is `MAX_SEED_SIZE`-capped;
  this one is not). The implement handoff deferred it per the original scope and asserted it was
  "bounded by the dial context," but once the stream is open no dial-level deadline governs the read.
  Lower severity than the receiver hangs (sender-initiated), so deferred to a backlog ticket that
  mirrors the wake-sender `AbortController` + shared `readStreamToEnd` pattern.

### Accepted limitations (no action)

- **Timeout-path ack is best-effort and undeliverable in production.** On a read timeout,
  `readStreamToEnd` aborts the stream *before* the receiver's `catch` writes the non-accepting ack,
  so against a real (reset) libp2p stream that ack cannot reach the peer — the write throws and is
  swallowed. The test doubles' `send()` succeeds post-abort, so the timeout-settle tests assert ack
  *content* that a real peer would never receive. This is inherent: freeing the hung read *requires*
  resetting the stream, which forecloses replying on it. The primary goal — never hang, free the
  resource — is met, and a timed-out peer is misbehaving anyway. No code change; flagged so the test
  assertions aren't mistaken for a delivery guarantee.
- **New options aren't surfaced through `CadreNodeConfig`** — the four timeout/cap options are only
  settable on the service constructors directly, not via top-level node config. Defaults are sane and
  config plumbing was out of scope; noted in case a deployment later needs to tune them.
- **Counters are per-service, not per-peer** (carried over from the handoff) — the cap bounds total
  in-flight inbound streams, not a per-remote-peer quota. Acceptable for the single-buggy-own-cadre-
  node threat model.
- **Real-libp2p abort semantics unverified** — `readStreamToEnd`'s `stream.abort()` is what frees the
  read in production; tests cover the race-settles path and that abort is invoked, but not against a
  live libp2p stream. The blocked integration tests (`deliver-seed-cross-network`, `push-wake-e2e`)
  are the real-network coverage.

## Pre-existing failure (not this ticket)

The linked `@optimystic/quereus-plugin-crypto` workspace's `digest()` drifted (now 1-3 args; rejects
`'utf8'` output encoding) while all of Sereus calls the 4-arg `digest(data,algo,'utf8',out)` form.
This breaks `yarn build`/`yarn typecheck` and ~112 of 546 cadre-core tests (every one the
`Unsupported output encoding: utf8` crypto error), across spec files this ticket never touched —
including 16 of seed-bootstrap.spec.ts. This ticket's code calls no `digest`; `yarn lint` is clean
and the protocol specs validate under vitest. Already triaged by the runner into backlog
`migrate-cadre-to-variadic-digest-api`; not re-flagged here.
