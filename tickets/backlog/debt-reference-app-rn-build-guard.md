---
description: The phone app's tests run real compiled code from a neighbouring package, but nothing checks that code was rebuilt after its last edit — so those tests can quietly pass against a months-old build. Every other test suite in the repo already has that check.
files: packages/reference-app-rn/vitest.config.ts, packages/reference-app-rn/test/node-local-slots.spec.ts, packages/reference-app-rn/test/secure-key-store.spec.ts, packages/reference-app-web/test/global-setup.ts, test-harness/build-freshness.ts, test-harness/build-targets-spec.ts
difficulty: easy
---

# `reference-app-rn` runs compiled `cadre-core` with no stale-build guard

## What is wrong

Six suites in this repository fail up front when a package they run compiled code
from has not been rebuilt since its sources changed (`test-harness/build-freshness.ts`,
called from each suite's vitest `globalSetup`). `packages/reference-app-rn` is not
one of them, and it needs to be.

Its unit tests import **runtime values** — not just types — from
`@serfab/cadre-core`, which resolves through a `node_modules` symlink to that
package's `dist`:

- `test/node-local-slots.spec.ts` → `PersistentTrustedOwnerStore`,
  `PersistentBootstrapPeerStore`, `DEFAULT_IDENTITY_KEY_ID`
- `test/secure-key-store.spec.ts` → `KeyStoreAccessError`
- `test/push-wake.spec.ts` → reaches `STRAND_WAKE_TYPE` through `src/push-wake.ts`

(`test/react/use-cadre.spec.ts` mocks the package out, so it is not affected.)

So an edit to `cadre-core/src` with no following `yarn build` is invisible here:
the run exercises the previous build and reports green. That is the exact failure
this guard exists to prevent, and it has bitten this repository three times
before.

## Expected behaviour

`yarn workspace @serfab/reference-app-rn test` should abort before any test runs
when a package it loads compiled code from is stale, naming the package and the
build command to run — the same message every other suite already produces.

## Notes for whoever picks this up

- `reference-app-rn` sets `installConfig.hoistingLimits: "workspaces"`, so its
  `@optimystic/*` and `@quereus/*` copies live in
  `packages/reference-app-rn/node_modules` rather than the repository root. The
  guard already handles that — it walks the `node_modules` chain up from the
  calling setup module — so this is wiring, not new guard behaviour.
- The vitest config declares **two** projects (`node`, `react`). Vitest 4 does not
  inherit a sibling project's `globalSetup`; each project block must set it
  itself. `packages/quereus-plugin-sereus/vitest.config.ts` is the precedent.
- Whether the target list should also cover the `@optimystic`/`@quereus` siblings
  reached transitively through `cadre-core` is a judgement call for that ticket —
  `reference-app-web` is going through the same question in
  `debt-web-app-build-guard-targets`, so land that one first and copy its answer.
- `test-harness/build-targets-spec.ts` provides the shared `describeBuildTargets`
  helper if a manifest cross-check spec is wanted alongside.
- `reference-app-ns` has the same exposure but no unit-test harness at all; that
  is covered separately by `debt-ns-unit-test-harness`.
