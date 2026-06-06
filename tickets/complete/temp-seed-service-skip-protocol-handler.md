description: COMPLETE — CadreNode's throwaway temp `SeedBootstrapService` (built by `applySeed`/`dialInvite` when no persistent service exists) no longer registers the shared `/sereus/seed/1.0.0` inbound handler. `SeedBootstrapService.initialize` gained an `options?: { registerHandler?: boolean }` third arg (default true); the two temp-service sites pass `{ registerHandler: false }`. Repeated `applySeed`/`dialInvite` on a service-less node are now idempotent — no handler leak onto the shared control node, no `DuplicateProtocolHandlerError` unhandled rejection on a second call. Persistent owners (`initializeSeedBootstrap`, `enableSeedListener`) keep the two-arg form, default-on. Reviewed, verified, and accepted with no code changes.
files: packages/cadre-core/src/seed-bootstrap.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/test/cadre-node-seed-trust.spec.ts
----

# Temp seed service skips the shared protocol handler — COMPLETE

## Summary of the fix

`SeedBootstrapService.initialize(libp2pNode, controlDatabase)` previously did two
unrelated things: (1) stash `libp2pNode`/`controlDatabase` (needed by the temp
service for dialing and known-key lookup) and (2) call `registerProtocolHandler()`,
which fire-and-forget `void this.libp2pNode.handle(SEED_PROTOCOL, …)` binds the
inbound handler on the **shared** control node.

`CadreNode.applySeed` and `CadreNode.dialInvite` build a *temporary* service,
`initialize()` it on the shared node, use it once, and discard it. The discarded
service's handler closure leaked onto the shared node (which also kept the temp
service alive — a memory leak), and a **second** service-less temp call hit
libp2p's registrar guard and threw `DuplicateProtocolHandlerError` as an
**unhandled promise rejection** (swallowed by the caller's `void`).

The fix gates registration behind `options?.registerHandler ?? true`. Field
assignment is unconditional; default-on leaves every persistent caller unchanged;
the two temp sites pass `{ registerHandler: false }`. Receiving inbound seeds now
requires an explicit persistent listener (`enableSeedListener` /
`initializeSeedBootstrap`) — which matches the documented design (`--listen-for-seeds`,
`architecture.md` "New Node (listening on /sereus/seed/1.0.0)").

## Review findings

### What was checked

- **Implement diff, read first with fresh eyes** (`git show d1b89b8`): the
  `initialize` signature change, both temp sites (`applySeed` ~1339, `dialInvite`
  ~1471), and the two untouched persistent owners (`initializeSeedBootstrap` ~1163,
  `enableSeedListener` ~1265).
- **Regression-pinning (empirical).** Temporarily reverted `{ registerHandler:
  false }` on the `applySeed` site and re-ran `cadre-node-seed-trust`: **2 tests
  failed** with `DuplicateProtocolHandlerError: Handler already registered for
  protocol /sereus/seed/1.0.0` (the idempotent two-call test and the
  handler-free-for-listener test). Restored the fix; tree confirmed clean via
  `git status`. The tests genuinely pin the bug.
- **No-regression for live callers.** Traced every `dialInvite`/`applySeed`/
  `enableSeedListener` call site. `CadreNode.dialInvite` (public method) is **not
  invoked anywhere** in production — integration tests use `phoneService.dialInvite`
  on a *persistent* `SeedBootstrapService` (via `createReceiverService`, handler
  registered), and reference-app-rn's phone join uses `applySeed` with an
  out-of-band seed, never relying on a temp-service inbound handler. The accidental
  "handler from a temp applySeed" was never an intended feature, so removing it is a
  correctness improvement, not a regression.
- **Docs.** `docs/architecture.md` (seed-delivery sequence, `dialInvite` example)
  and `docs/reference-app-rn.md` (`--listen-for-seeds`) already frame inbound seed
  receipt as requiring an explicit listener. Consistent with the new reality — no
  doc edit required by this diff.
- **Lint** (`eslint` on the three changed files): 0 errors. 4 warnings, all
  pre-existing and off the changed lines (`no-explicit-any` at cadre-node.ts
  88/228; unused `PeerId`/`Multiaddr` imports in seed-bootstrap.ts 4/6).
- **Type + tests:** `yarn workspace @serfab/cadre-core typecheck` clean;
  `cadre-node-seed-trust` 9 passed; full suite **27 files / 340 passed**.

### Findings

- **Major:** none. The fix is minimal, correct, and aligned with the intended
  listener-based design.
- **Minor (observed, no change made):**
  - *Dead `trustPolicy` on the `dialInvite` temp constructor* — kept for symmetry
    with the `applySeed` site and clearly documented in the comment. The dial-only
    temp service never applies a seed, so this is inert. Left as-is; cleanup would
    be cosmetic with zero behavior change.
  - *Timing-based negative assertion* (50ms drain for a deferred
    `unhandledRejection`, plus a strict `expect(rejections).toEqual([])`). This is
    the standard way to observe Node's deferred rejection; the companion
    deterministic `getProtocols()` assertion is the backstop, and both must agree.
    The strict empty-array check could in principle catch an unrelated benign
    rejection, but the listener is scoped to the applySeed window to minimize that.
    Acceptable and already documented by the implementer.
  - *`dialInvite` temp path not directly unit-tested* for the no-leak property
    (needs a dialable invite target). The guarantee rests on it sharing the identical
    `initialize(..., { registerHandler: false })` call as the explicitly-tested
    `applySeed` path. Given `CadreNode.dialInvite` is unused in production, not worth
    a mock-dial test now.

### Disposition

All findings are minor and required no inline changes; no new fix/plan/backlog
tickets filed. Out of scope for this diff: `docs/api.md:19` shows a stale
`applySeed(seed)` signature missing the `{ trustPolicy }` options param — that
param predates this ticket and this diff did not alter the public `applySeed`
signature, so it is not this ticket's regression.

## Validation commands (re-ran green)

```
yarn workspace @serfab/cadre-core typecheck                    # clean
yarn workspace @serfab/cadre-core test cadre-node-seed-trust   # 9 passed
yarn workspace @serfab/cadre-core test                         # 27 files, 340 passed
npx eslint packages/cadre-core/src/seed-bootstrap.ts packages/cadre-core/src/cadre-node.ts packages/cadre-core/test/cadre-node-seed-trust.spec.ts   # 0 errors
```
