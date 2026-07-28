----
description: The command that checks for unused and missing package dependencies has been failing ever since the NativeScript reference app was added, because that app was never registered with the checker. It reports the app's real dependencies as unused, so the check gives no useful signal.
prereq:
files: knip.ts, packages/reference-app-ns/package.json, package.json, packages/cadre-core/package.json, docs/STATUS.md
difficulty: medium
----

# `yarn dep-check` exits 1 — `reference-app-ns` missing from the knip config

## Symptom

From the repo root:

```
yarn dep-check      # exits 1
```

The failure is entirely pre-existing — it does not depend on any uncommitted work.

## Cause

`knip.ts` enumerates workspaces explicitly under its `workspaces` key. It lists nine:
`cadre-cli`, `cadre-core`, `cadre-host`, `cadre-provider`, `integration-tests`,
`quereus-plugin-sereus`, `reference-app-rn`, `reference-app-web`, `strand-proto`.

`packages/reference-app-ns` is absent. It landed in the `v0.9.0` release commit, which is
*after* the commit that last touched `knip.ts` (`build-health-dep-check`), so it was never
registered. With no workspace entry knip finds no entry points for that package, so:

- all **13** of its real dependencies report as **unused dependencies** (`@nativescript/core`,
  `@nativescript-community/sqlite`, `@libp2p/*`, `@optimystic/*`, `@quereus/quereus`,
  `@serfab/cadre-core`, `@noble/hashes`, `@ungap/structured-clone`, …), and
- ~19 of its source files report as **unused files** (the whole `src/` tree, the
  `app/*-page.ts` NativeScript page modules, `nativescript.config.ts`, the `polyfills/` and
  `shims/` trees).

Dependency-class issues are `error` in `knip.ts`'s `rules`, so the gate fails.

Two smaller pre-existing unused-dependency hits ride along and also need a disposition
(genuinely remove, or ignore with rationale):

- root `svelte-eslint-parser`
- `packages/cadre-core` → `@libp2p/peer-id-factory`

knip also emits eight **configuration hints** worth acting on in the same pass — three
"add entry / refine project files" for `reference-app-ns`, `reference-app-rn`, and
`cadre-provider`, and five `ignoreDependencies` entries that are now stale (`svelte-check` in
`cadre-host` and `reference-app-web`, `@multiformats/multiaddr` and `@quereus/quereus` in
`reference-app-web`, `@optimystic/db-p2p` in `reference-app-rn`).

## Expected behaviour

`yarn dep-check` exits 0 on a clean checkout, with `reference-app-ns` genuinely analysed
rather than excluded — its NativeScript entry points (page modules, `app/` bootstrap, the
polyfill and shim trees loaded by the bundler rather than by an import) declared as entries,
and any framework-implicit dependency ignored *with a written rationale* the way the existing
Expo/Metro and Vite ignores are. Excluding the package wholesale would make the gate green
while giving up the coverage, and is not the outcome wanted here.

While fixing, re-check the stale hints above so the config does not accumulate a second layer
of drift.

## Why it matters

`dep-check` is one of the four build-health gates. A permanently-red gate is one nobody reads,
so real phantom or unused dependencies in *any* workspace now land unnoticed. It also means new
work cannot use `dep-check` to confirm it introduced no dependency issue — the reviewer of
`solo-control-node-dep-floor-and-regression-test` had to reason about knip's output by hand
instead.

`docs/STATUS.md` → "Dependency-check coverage" has been corrected to record that the gate is
currently red and to point at this ticket; update it to reflect reality again once this lands.
