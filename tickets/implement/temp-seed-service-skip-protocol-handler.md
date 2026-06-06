description: Stop CadreNode's temp `SeedBootstrapService` (built by `applySeed`/`dialInvite` when no persistent service exists) from registering the shared `/sereus/seed/1.0.0` inbound handler. Add a `registerHandler` option to `SeedBootstrapService.initialize` (default true) and pass `false` from the two temp-service sites, so repeated `applySeed`/`dialInvite` on a service-less node is idempotent — no handler leak, no `DuplicateProtocolHandlerError` unhandled rejection.
prereq:
files: packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/seed-bootstrap.ts, packages/cadre-core/test/cadre-node-seed-trust.spec.ts

## Root cause (confirmed)

`SeedBootstrapService.initialize(libp2pNode, controlDatabase)` (seed-bootstrap.ts:199)
does two unrelated things:

1. stores `libp2pNode` + `controlDatabase` (the temp service genuinely needs these
   for dial / peerStore / known-key lookup), and
2. calls `registerProtocolHandler()` (seed-bootstrap.ts:204), which registers the
   inbound `/sereus/seed/1.0.0` handler on the **shared** control libp2p node.

`CadreNode.applySeed` (cadre-node.ts:1332-1339) and `CadreNode.dialInvite`
(cadre-node.ts:1462-1469) build a **temporary** service and call `initialize(...)`
on the shared `this.controlNode`, then discard the service. That means:

- **Handler leak.** The discarded temp service's handler closure stays bound to the
  shared node — a throwaway service owns the node's inbound seed trust decision.
- **Duplicate-handler unhandled rejection.** `registerProtocolHandler` does
  `void this.libp2pNode.handle(SEED_PROTOCOL, ...)` (seed-bootstrap.ts:646) —
  fire-and-forget. libp2p's registrar throws `DuplicateProtocolHandlerError`
  ("Handler already registered for protocol ...") on a second `handle()` of the
  same protocol unless `opts.force === true`
  (node_modules/libp2p/dist/src/registrar.js:66-67). A second temp-service call
  (two `applySeed`s, `applySeed` then `dialInvite`, etc. on a service-less node)
  therefore rejects — swallowed by the `void` from the caller's view, surfacing as
  an **unhandled promise rejection**.

Validated by inspection: `handle()` is the throwing path; `void` makes it a silent
unhandled rejection; `applySeed` (temp) applies the seed but `dialInvite` (temp)
only dials — it never applies a seed, so its handler registration was pure leak.

## Fix shape

The temp service needs the stored fields (1) but NOT the handler (2). Give
`initialize` an option to skip handler registration, default-on so persistent
services (`initializeSeedBootstrap`, `enableSeedListener`) are unchanged:

```ts
// seed-bootstrap.ts
initialize(
  libp2pNode: Libp2p,
  controlDatabase: ControlDatabase,
  options?: { registerHandler?: boolean }
): void {
  this.libp2pNode = libp2pNode;
  this.controlDatabase = controlDatabase;
  if (options?.registerHandler ?? true) {
    this.registerProtocolHandler();
  }
  log('SeedBootstrapService initialized');
}
```

Then at the two temp sites in cadre-node.ts pass `{ registerHandler: false }`:

```ts
tempService.initialize(this.controlNode, this.controlDatabase, { registerHandler: false });
```

This makes repeat temp calls genuinely safe (no second `handle()` happens at all),
rather than loudly broken — satisfying the constraint that we must not turn the
previously-"working" double-`applySeed` into a hard throw.

### Notes / things to get right

- **Preserve trust-policy precedence.** The temp-service constructors already pass
  `trustPolicy: this.config.seedTrustPolicy`; keep them. `applySeed`'s precedence
  (`options.trustPolicy ?? config.trustPolicy ?? dbAnchoredTrustPolicy()`) is
  unchanged — the temp `applySeed` service still applies seeds with the configured
  default, it just no longer owns the wire handler.
- **Correct the stale comments.** The `dialInvite` temp-service comment
  (cadre-node.ts:1457-1461) claims `initialize()` registers the inbound handler and
  that policy forwarding exists to feed that handler. With this fix the temp
  `dialInvite` service registers no handler and never applies a seed, so rewrite the
  comment: the temp service only dials; a node that wants to **receive** an inbound
  seed back must have a persistent service (`enableSeedListener` /
  `initializeSeedBootstrap`) own the handler. The `trustPolicy` arg on that temp
  constructor is now effectively dead for `dialInvite` (it only dials) — keep it for
  symmetry with the `applySeed` site or drop it; document whichever you choose.
- **Don't regress the legitimate handler owners.** `initializeSeedBootstrap`
  (cadre-node.ts:1163) and `enableSeedListener` (cadre-node.ts:1265) must still call
  `initialize` with handler registration ON (i.e. leave those call sites as the
  two-arg form so the default `registerHandler: true` applies). `deliverSeed`,
  authority, and listener paths are untouched.
- **`initialize` is two-arg elsewhere.** The handler-ack unit test
  (cadre-node-seed-trust.spec.ts:250) calls `service.initialize(libp2p, db)` — adding
  an optional third arg is backward compatible; that test still registers the handler
  (it asserts on the captured handler) and must keep passing.

## Tests (add to packages/cadre-core/test/cadre-node-seed-trust.spec.ts)

- **Idempotent temp `applySeed`.** Two consecutive `node.applySeed(...)` calls on a
  started, service-less cold node both return a result with **no** unhandled
  rejection and **no** `DuplicateProtocolHandlerError`. Use a configured
  `pinnedKeyTrustPolicy([authorityPublicKey])` cold node (see existing
  `makeColdNode` / `startClean` helpers) so both calls succeed. To catch the
  rejection, register a `process.on('unhandledRejection', ...)` (or
  `unhandledrejection`) listener for the duration of the test and assert it never
  fired; remove the listener in `finally`. (The existing override test at
  cadre-node-seed-trust.spec.ts:104-127 dodges this by routing through
  `enableSeedListener` — once temp calls are safe, that workaround comment is stale;
  optionally simplify that test back to the temp-service path, but at minimum add the
  dedicated two-call test.)
- **No leaked handler after a temp call.** After a temp-service `applySeed` (or
  `dialInvite`) on a service-less node, the shared control libp2p node has no
  lingering `/sereus/seed/1.0.0` handler owned by a discarded service. Assert via the
  registrar (e.g. `node.getControlNode()`/equivalent libp2p accessor — check what
  CadreNode exposes; `getControlDatabase`/`getSeedBootstrapService` exist, find or
  add a control-node getter) `getProtocols()` not containing `SEED_PROTOCOL`, **or**
  the equivalent assertion that a subsequent `node.enableSeedListener()` registers
  cleanly without throwing / without an unhandled rejection. The
  `enableSeedListener`-registers-cleanly form is the most robust and avoids needing a
  new public accessor.
- **Regression.** Keep the existing persistent-path tests green: `enableSeedListener`
  forwarding (spec.ts:129), idempotent listener (spec.ts:158), authority path
  (spec.ts:175), and the inbound handler ack test (spec.ts:205). These confirm the
  persistent listener/authority paths still register and apply seeds correctly.

## Validation commands (cadre-core)

- `yarn workspace @serfab/cadre-core typecheck`
- `yarn workspace @serfab/cadre-core test 2>&1 | tee /tmp/cadre-core-test.log`
  (stream output; full suite. To iterate faster first:
  `yarn workspace @serfab/cadre-core test cadre-node-seed-trust 2>&1 | tee /tmp/seed-trust.log`)

## TODO

- [ ] Add `options?: { registerHandler?: boolean }` to `SeedBootstrapService.initialize`
      (seed-bootstrap.ts:199); gate `registerProtocolHandler()` on
      `options?.registerHandler ?? true`.
- [ ] Pass `{ registerHandler: false }` from the temp-service `initialize` calls in
      `CadreNode.applySeed` (cadre-node.ts:1337) and `CadreNode.dialInvite`
      (cadre-node.ts:1467).
- [ ] Rewrite the stale `dialInvite` temp-service comment (cadre-node.ts:1457-1461)
      and the `applySeed` temp-service comment (cadre-node.ts:1328-1335) to reflect
      that temp services no longer own the wire handler.
- [ ] Add the two-consecutive-`applySeed` no-unhandled-rejection test and the
      no-leaked-handler test to cadre-node-seed-trust.spec.ts; consider simplifying the
      existing override test (spec.ts:104) back to the temp-service path.
- [ ] Run typecheck + the cadre-core test suite; confirm green with no unhandled
      rejections.
