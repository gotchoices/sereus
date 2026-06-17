description: Reviewed and finalized the live two-party browser end-to-end test that proves an invitation forms a shared chat and a message crosses between the two parties; added the missing wiring that lets the build catch type errors in those tests.
prereq:
files: packages/reference-app-web/e2e/distributed/formation-convergence.spec.ts, packages/reference-app-web/e2e/fixtures/formation-responder.ts, packages/reference-app-web/e2e/fixtures/state.ts, packages/reference-app-web/e2e/global-setup.ts, packages/reference-app-web/e2e/global-teardown.ts, packages/reference-app-web/src/lib/cadre-web.ts, packages/reference-app-web/package.json, packages/reference-app-web/tsconfig.e2e.json, packages/cadre-core/src/types.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/strand-instance-manager.ts
----

# Complete: formation→convergence e2e wire + spec (reviewed)

The live Tier-2 formation→convergence e2e tier ships **green** (full suite: 27 passed,
~41s) and the implementation is sound. Review confirmed the two deliberate divergences
from the original ticket (responder boots in the worker, permissive connection gater) are
correct and well-documented. One minor gap — the e2e typecheck was orphaned from every
npm script — was fixed inline.

## Review findings

### Checked — and clean

- **Implement diff, read fresh.** All 22 touched files reviewed before reading the handoff:
  the new spec, both fixtures (`formation-responder.ts`, `state.ts`), `global-setup`/`-teardown`,
  the cadre-web debug hooks, the cadre-core `connectionGater` threading, and the README rewrite.
- **`__cadre` hook surface parity.** The spec's hand-maintained `CadreHooks` interface
  (`getFormedStrands`/`dialStrandPeer`/`getStrandConnectionCount`/`readChatMessages`/`writeChatMessage`)
  matches the real `exposeDebugHook` shape and the `FormedStrand` `{ strandId, memberKey, type }`
  return shape in `cadre-web.ts`. (Inherent to `page.evaluate`, the interface is a structural
  cast and won't catch hook drift at compile time — accepted; it's the standard e2e constraint.)
- **Test independence / ordering.** The happy path and expired-token tests use *distinct*
  invitations (valid single-use vs. a separate deliberately-expired one), each test gets a fresh
  browser context, and `usageBefore`/`usageAfter` deltas are captured per-test — so neither test
  depends on run order, and the shared `beforeAll` responder is safe.
- **Resource cleanup.** `startFormationResponder` tears the node down on bring-up failure;
  `stop()` removes the `connection:open` listener before `node.stop()`; the spec's `afterAll`
  stops + nulls the handle. Single-flight seed (`seedPromise`) does not cache rejections, so an
  early pre-cohort attempt is retried rather than poisoning the seed.
- **No dangling references.** Grepped the whole `reference-app-web` package for every deleted
  symbol/file (`reference-peer`, `optimystic-detect`, `_helpers`, the 7 retired specs,
  `spawnReferenceMesh`, `TIER2_CONVERGENCE_DEFERRED`, `__referencePeer`, `__formationResponder`):
  zero matches. The retirement is clean.
- **Docs reflect reality.** README Tier-2 section, the in-scope/deferred callouts, and the
  fixture/state doc comments all match the shipped design (in-worker responder, no-relay
  initiator, hand-wired cohort dial). No stale deferral language remains.
- **Gater scope (production safety).** The permissive `{ denyDialMultiaddr: () => false }` is set
  **only** in `reference-app-web/src/lib/cadre-web.ts`. The new `NetworkConfig.connectionGater`
  field is opt-in passthrough; cadre-host, cadre-cli, and cadre-provider never set it, so no
  production runtime inherits loopback-dialing. db-p2p's `createLibp2pNode` honours the option
  (`libp2p-node-base.ts:321`), and cadre-core threads it to **both** the control node
  (`cadre-node.ts`) and every strand cohort node (`strand-instance-manager.ts`).
- **Divergence 1 (responder in worker, not global-setup) — correct.** Playwright workers are
  separate child processes that don't share `globalThis`; the responder's in-memory read methods
  must live where the node booted. The fail-soft (`skipReason` → `test.skip`) is in the right place.
- **Divergence 2 (connection gater) — accepted.** A real production-code change, but correctly
  scoped, opt-in, and matching the README's framing of the reference app as a dev/validation
  surface. Gating it behind a dev-only flag was considered and rejected as needless complexity
  for a non-production app. The side-effect noted by the implementer is confirmed: pre-fix the
  expired-token test passed for the wrong reason (gater denial before the expiry check); post-fix
  the dial succeeds and the test genuinely exercises the expiry branch.

### Found and fixed inline (minor)

- **e2e typecheck was orphaned from the build.** `tsconfig.e2e.json` (the only config that
  typechecks `e2e/**`) was wired into **no** script — `yarn build`/`yarn typecheck` ran
  `tsc --noEmit` against `tsconfig.json`, which includes only `src/**`. So a type regression in
  any spec or fixture would pass the build silently. Fixed: added a `typecheck:e2e` script and
  chained it into `build` (`yarn typecheck && yarn typecheck:e2e && vite build`). Verified
  `yarn workspace @serfab/reference-app-web build` is green with the new gate.

### Found — deferred (not blocking; already tracked)

- **Closed-strand membership asserted at metadata level only** (`type:'c'` + member-key present).
  The deeper "a read is unauthorized WITHOUT the minted member key" assertion depends on the
  control schema's "member key only if closed" CHECK, tracked in the existing backlog ticket
  `control-strand-closed-member-key-constraint` (`control-schema.ts:56`). Documented inline in
  the spec. No new ticket needed.
- **Bidirectional (browser→responder) tail rides the happy path** rather than being isolated,
  because the valid invite is single-use. It's the most likely flake point under CI/load; the
  spec documents the `test.fixme` downgrade path inline. No regression observed locally.
- **Manual `dialStrandPeer` cohort wiring** stands in for control-network strand discovery
  (still TODO upstream); when discovery lands, the hand-wiring step drops. Pre-existing scope.

No **major** findings — nothing warranting a new fix/plan ticket.

### Validation (all green)

- `yarn lint` (root) ✓
- `tsc -p tsconfig.e2e.json --noEmit` (e2e typecheck) ✓ — now also reachable via `yarn typecheck:e2e`
- `yarn workspace @serfab/reference-app-web build` ✓ (now includes both typechecks)
- `yarn workspace @serfab/reference-app-web test:e2e` → **27 passed (~41s)**: 2 convergence
  (happy path ~2.9s, expired ~1s) + 25 solo. No regressions.

## What shipped (unchanged from implement)

- New two-party tier `e2e/distributed/formation-convergence.spec.ts` (happy path + expired-token).
- In-process headless cadre responder `e2e/fixtures/formation-responder.ts`, booted in the
  spec's `beforeAll` (the worker).
- `global-setup`/`global-teardown`/`state.ts` reduced to a coarse availability gate.
- Retired the obsolete membership-free distributed suite (7 specs + 3 helper/fixture files).
- `NetworkConfig.connectionGater` threaded through cadre-core to the control + strand nodes;
  reference app supplies a permissive gater so the browser can dial the loopback responder.
- README + fixture doc comments rewritten to the new reality.
