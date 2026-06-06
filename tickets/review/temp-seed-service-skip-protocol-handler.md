description: REVIEW — CadreNode's throwaway temp `SeedBootstrapService` (built by `applySeed`/`dialInvite` when no persistent service exists) no longer registers the shared `/sereus/seed/1.0.0` inbound handler. `SeedBootstrapService.initialize` gained an `options?: { registerHandler?: boolean }` third arg (default true); the two temp-service sites pass `{ registerHandler: false }`. Result: repeated `applySeed`/`dialInvite` on a service-less node are idempotent — no handler leak onto the shared control node, and no `DuplicateProtocolHandlerError` unhandled rejection on the second call. Persistent owners (`initializeSeedBootstrap`, `enableSeedListener`) keep the two-arg form so the default-on registration is unchanged. cadre-core typecheck green; full test suite 340 passed (was 338 — 2 new tests added, 1 existing override test simplified back to the temp-service path).
prereq:
files: packages/cadre-core/src/seed-bootstrap.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/test/cadre-node-seed-trust.spec.ts
----

# Review: temp seed service skips the shared protocol handler

## Root cause (recap)

`SeedBootstrapService.initialize(libp2pNode, controlDatabase)` did two unrelated
things: (1) stash `libp2pNode` + `controlDatabase` (which the temp service
genuinely needs for dialing / known-key lookup), and (2) call
`registerProtocolHandler()`, which binds the inbound `/sereus/seed/1.0.0` handler
on the **shared** `this.controlNode`.

`CadreNode.applySeed` and `CadreNode.dialInvite` build a **temporary** service,
`initialize(...)` it on the shared node, use it once, and discard it. So the
discarded service's handler closure leaked onto the shared node, and — because
`registerProtocolHandler` does `void this.libp2pNode.handle(SEED_PROTOCOL, …)`
(fire-and-forget) — a **second** temp call (two `applySeed`s, or `applySeed`
then `dialInvite`, on a service-less node) hit libp2p's registrar guard
(`node_modules/libp2p/dist/src/registrar.js:66` throws
`DuplicateProtocolHandlerError` unless `opts.force === true`). The throw became
an **unhandled promise rejection** (swallowed by the caller's `void`).

## What changed

### `packages/cadre-core/src/seed-bootstrap.ts`

- `initialize` now takes an optional third arg
  `options?: { registerHandler?: boolean }` and gates the
  `registerProtocolHandler()` call on `options?.registerHandler ?? true`.
  Field assignment (`libp2pNode`, `controlDatabase`) is unconditional. Default-on
  keeps every persistent caller unchanged. The doc comment explains why temp
  services pass `false`.

### `packages/cadre-core/src/cadre-node.ts`

- **`applySeed` temp site (~1337)** — `initialize(..., { registerHandler: false })`.
  Comment rewritten: the temp service still applies *this* seed but no longer owns
  the wire handler; receiving inbound seeds requires a persistent service.
- **`dialInvite` temp site (~1467)** — `initialize(..., { registerHandler: false })`.
  Stale comment (which claimed `initialize()` registers the inbound handler and
  that policy forwarding feeds it) **rewritten**: this temp service only dials and
  never applies a seed, so its handler registration was pure leak; `trustPolicy`
  is now effectively dead on this dial-only path and is kept only for symmetry
  with the `applySeed` site (documented as such).
- The two legitimate owners are **untouched** (still two-arg, default registration
  ON): `initializeSeedBootstrap` (~1163) and `enableSeedListener` (~1265).
  `deliverSeed`, authority, and listener paths are untouched.

### `packages/cadre-core/test/cadre-node-seed-trust.spec.ts`

- Imports `SEED_PROTOCOL`.
- **New:** *two consecutive temp-service `applySeed` calls are idempotent* — both
  apply (pinned-key default), the shared control node's `getProtocols()` does NOT
  contain `SEED_PROTOCOL`, and a scoped `process.on('unhandledRejection', …)`
  listener captures nothing (specifically no `/already registered for protocol/`
  rejection) after a 50ms drain window.
- **New:** *temp `applySeed` leaves the handler free for a later persistent
  listener* — after a temp apply, `getProtocols()` lacks `SEED_PROTOCOL`; a
  subsequent `enableSeedListener()` registers it cleanly (`getProtocols()` now
  contains it) with no unhandled rejection.
- **Simplified:** the existing per-call-override test (was routed through
  `enableSeedListener` purely to dodge the double-`handle()` bug) now runs both
  `applySeed` calls through the temp-service path directly — which is exactly the
  scenario the fix makes safe.
- The handler-ack unit test (`spec.ts:~250`, now in the second describe) still
  calls the two-arg `service.initialize(libp2p, db)`; default registration keeps
  it green (it asserts on the captured handler).

## How to validate (use cases)

### Automated (ran green)

```
yarn workspace @serfab/cadre-core typecheck          # clean
yarn workspace @serfab/cadre-core test cadre-node-seed-trust   # 9 passed
yarn workspace @serfab/cadre-core test               # 27 files, 340 passed
```

Reviewer focus — re-run the two new tests and confirm they actually exercise the
bug. The strongest check is to **temporarily revert** the
`{ registerHandler: false }` on the `applySeed` site and re-run
`cadre-node-seed-trust`: the *idempotent two-call* test should then fail (an
`/already registered for protocol/` rejection surfaces and/or `getProtocols()`
contains `SEED_PROTOCOL`). If it still passes, the test is not pinning the
regression — worth scrutinizing.

### Behavioral expectations to verify

- A started, **service-less** cold node can `applySeed` repeatedly with no
  unhandled rejection; both calls return a result.
- After any temp-service `applySeed`/`dialInvite`, the shared control node owns
  **no** `/sereus/seed/1.0.0` handler — confirmed via `getControlNode().getProtocols()`.
- A node that later wants to **receive** inbound seeds still works: a persistent
  `enableSeedListener()` / `initializeSeedBootstrap()` registers the handler
  cleanly afterward.
- Trust-policy precedence is unchanged: temp `applySeed` still applies seeds under
  `options.trustPolicy ?? config.seedTrustPolicy ?? dbAnchoredTrustPolicy()`.

## Known gaps / honesty for the reviewer

- **Timing-based negative assertion.** The "no unhandled rejection" test waits a
  fixed 50ms (`setTimeout`) for a deferred rejection to surface, then asserts the
  capture array is empty. This is the standard way to observe Node's
  `unhandledRejection` (it fires on a later macrotask), but it is a *timing*
  assertion: if a future change defers the rejection past 50ms it could pass
  spuriously. The companion `getProtocols()` assertion is the deterministic
  backstop — both must agree. The `expect(rejections).toEqual([])` is strict and
  could in principle catch an *unrelated* benign rejection during the applySeed
  window; the listener is scoped to start after `startClean` to minimize this, but
  it is not bulletproof.
- **`dialInvite` temp path is not directly unit-tested** for the no-leak property
  (it requires a dialable invite target). The no-leak guarantee for `dialInvite`
  rests on it sharing the identical `initialize(..., { registerHandler: false })`
  call as `applySeed`; the tests cover the `applySeed` path explicitly and the
  `enableSeedListener`-after-temp path. A reviewer wanting belt-and-suspenders
  could add a `dialInvite`-specific no-leak assertion, but it needs a mock dial
  target.
- **Dead `trustPolicy` arg on the `dialInvite` temp constructor** was *kept* for
  symmetry (documented in the comment) rather than dropped. If the reviewer
  prefers removing dead config over symmetry, that is a one-line cleanup — no
  behavior change either way since the dial-only temp service never applies a seed.
- No integration/network test was added (the original bug is a single-process
  handler-registration concern; two real networked nodes are not needed to
  reproduce or guard it).
