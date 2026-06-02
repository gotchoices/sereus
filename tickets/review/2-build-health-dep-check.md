description: review the real dependency-check gate (knip) — verify dep fixes are correct and false-positive ignores are justified
files: knip.ts, package.json, packages/cadre-cli/package.json, packages/cadre-core/package.json, packages/cadre-host/package.json, packages/cadre-provider/package.json, packages/integration-tests/package.json, packages/quereus-plugin-sereus/package.json, packages/strand-proto/package.json, packages/reference-app-rn/package.json, docs/STATUS.md
effort: medium
----

# Review: `yarn dep-check` is now a real gate (knip)

`yarn dep-check` was a no-op (root `foreach -A run dep-check` with no package defining the
script → exit 0 in ~0s). It now runs **knip 6** from the repo root via a single root config
(`knip.ts`, **Option A**) covering all nine workspaces. `yarn dep-check` exits **0**.

## What changed

**Tooling**
- Added `knip` as a root devDependency; root `dep-check` script is now `knip` (no foreach).
- Removed `esbuild` from root devDependencies (truly unused — only `quereus-plugin-sereus`
  uses esbuild and it lists its own).
- Authored `knip.ts` (TS config chosen over JSON so the ignore rationale is commented inline,
  as the ticket requested). All file discovery is config-driven — no shell globs on the CLI,
  so it runs identically on PowerShell and POSIX.

**Phantom/missing deps added** (code imports them, resolved only transitively before):
- `@multiformats/multiaddr` → cadre-core, integration-tests, reference-app-rn (production src).
- `@libp2p/crypto` + `@libp2p/interface` → cadre-cli, cadre-host (production src).
- `@libp2p/peer-id` → cadre-cli (test), cadre-host (production src).
- `@vitest/coverage-v8` → cadre-core, integration-tests, quereus-plugin-sereus, strand-proto
  (their vitest configs declare `coverage.reporter`). Aligned vitest + coverage-v8 to 4.1.8
  via `yarn up -R` to satisfy coverage-v8's exact-version peer requirement (was 4.0.17).

**Truly-unused deps removed**
- `aegir` from cadre-cli, cadre-core, cadre-provider (no `.aegir.*` config, no script uses it;
  build/test/clean run `tsc`/`vitest`/`rimraf` directly).
- `@serfab/cadre-core` from cadre-provider (grep: referenced only in its own package.json).

**Gate semantics** (`knip.ts` `rules`): dependency-class issues (`dependencies`, `unlisted`,
`binaries`, `unresolved`) are `error` and fail the gate. Dead-code classes (`files`, `exports`,
`types`, `nsExports`, `nsTypes`, `enumMembers`, `duplicates`) are `warn` — surfaced but
non-blocking.

## How to verify

- `yarn dep-check` → exits 0. Output shows only `warn`-level dead-code findings.
- `yarn install` → clean except the pre-existing `@react-native/gradle-plugin` peer warning
  (unrelated to this ticket).
- `yarn build` → exits 0 (all 9 workspaces; the optimystic dynamic-import vite warnings are
  pre-existing and from `../optimystic`, not this repo).
- `yarn typecheck` → exits 0.
- To confirm the gate actually bites: temporarily import an undeclared package in any `src/`
  file, or add a bogus dep to a package.json, and confirm `yarn dep-check` now exits 1.

## Reviewer focus / known gaps — treat this as a floor

- **Deferred dead-code backlog (intentional).** ~15 unused files, ~40 unused exports, ~29 unused
  exported types remain as `warn` (mostly reference-app-rn/web + cadre-host UI, plus two unused
  barrel files: `packages/cadre-provider/src/{server,service}/index.ts` — `index.ts` re-exports
  the leaf modules directly, bypassing these barrels). Cleaning these is a separate concern, not
  wired to fail the gate. **If the team wants a dead-code gate, that should be a new ticket** —
  flipping those rules to `error` today would fail on legitimate library/app public surface.
- **False-positive `ignoreDependencies` to scrutinize** (in `knip.ts`, each commented):
  - reference-app-rn: `@babel/core`, `@babel/runtime`, `@optimystic/db-p2p`, `buffer`,
    `@expo/vector-icons`, `expo-updates`, `@types/babel__core` — Expo/Metro framework-implicit.
    I did **not** add `@expo/vector-icons`/`expo-updates` as real deps to avoid Expo SDK 53
    version-pinning risk; verify they truly resolve at runtime (they're used in `app/_layout.tsx`
    + `app.json`). If a reviewer prefers correctness over the ignore, add them at the Expo-SDK-53
    pinned versions.
  - reference-app-web: `@multiformats/multiaddr` (vite dedupe), `buffer`/`readable-stream`
    (vite alias/optimizeDeps), `@optimystic/db-core`/`@quereus/quereus`/`idb` (transitive in the
    browser bundle). `db-core`/`quereus`/`idb` *may* be genuinely removable from the web manifest —
    I ignored rather than removed because they're app deps and removal risks a runtime break that
    the dep-check gate alone wouldn't catch. Worth a closer look.
  - integration-tests: `@optimystic/quereus-plugin-optimystic` — ignored (not statically imported;
    Quereus plugins load by name at runtime, and cadre-core pulls it transitively). Could arguably
    be removed; left as a documented ignore to be safe.
  - cadre-host: `@achingbrain/nat-port-mapper`, `qrcode-terminal` (dynamic `import()`/`require`),
    `@serfab/cadre-cli` (runtime `req.resolve('@serfab/cadre-cli/bin/cadre.js')`), `@tsconfig/svelte`,
    `svelte-check` (svelte toolchain). These are real uses knip can't see statically.
- **Flaky test note (NOT a regression).** Running `yarn test` across all workspaces in parallel,
  two cadre-host smoke tests (`cli.smoke.test.ts > prints help`, `cli-invite.smoke.test.ts > POSTs
  to /auth/invites`) timed out at the 5s vitest limit — cold libp2p child-process spawn under
  full-parallel CPU/IO contention. **In isolation `yarn workspace @serfab/cadre-host run test`
  passes 359/359 (3 skipped).** Changes here are dependency-manifest-only and can't affect that
  logic. If these prove chronically flaky under load, consider bumping the smoke-test timeout —
  separate from this ticket.
- **Version choices to sanity-check:** the added `@libp2p/*` ranges match sibling packages
  (crypto `^5.1.13`, interface `^3.1.0`, peer-id `^6.0.4`, multiaddr `^12.5.1`); `@vitest/coverage-v8`
  was bumped to track vitest `4.1.8`.
