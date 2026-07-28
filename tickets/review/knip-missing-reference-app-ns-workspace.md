---
description: The command that checks for unused and missing package dependencies had been failing ever since the NativeScript reference app was added; it now passes, and two packages that app secretly relied on are properly declared.
prereq:
files: knip.ts, package.json, packages/reference-app-ns/package.json, packages/reference-app-ns/src/shims/noise-crypto.js, packages/cadre-core/package.json, packages/integration-tests/package.json, docs/STATUS.md, yarn.lock
difficulty: medium
---

# Review: `yarn dep-check` restored to a green, trustworthy gate

## What shipped

**`knip.ts`**

- New `packages/reference-app-ns` block, placed alphabetically before `packages/reference-app-rn`.
  It declares the entry points knip cannot infer, because NativeScript resolves page modules by
  *string* rather than by import (`app/app-root.xml` names `chat/chat-page`; Settings is reached by a
  runtime `Frame.navigate({ moduleName })`). Before this, knip's single auto-detected entry
  (`app/app.ts`, from the package `main`) reached only the polyfill barrel, so 13 real dependencies
  and most of `src/` looked dead. Entries added: `app/**/*-page.ts`, `nativescript.config.ts`,
  `src/polyfills/node-*.ts`, `src/shims/*.js`, `src/solo-smoke.ts`.
- Same block: `ignoreBinaries: ['ns']` (globally-installed CLI) and `ignoreDependencies` for
  `@nativescript/android`, `esbuild-loader`, `util`, `buffer` — each with rationale in-comment.
- Five stale `ignoreDependencies` entries deleted (knip was emitting a "Remove from
  ignoreDependencies" hint for each): `svelte-check` from `cadre-host`; `svelte-check`,
  `@multiformats/multiaddr`, `@quereus/quereus` from `reference-app-web`; `@optimystic/db-p2p` from
  `reference-app-rn`. Surrounding comment prose was rewritten so it no longer describes entries that
  are gone.

**The one genuine code defect** — `packages/reference-app-ns/src/shims/noise-crypto.js` imports
`@noble/ciphers/chacha.js` and `@noble/curves/ed25519.js`, but the package declared neither. It only
built because `@chainsafe/libp2p-noise@17` happens to install both. That package sets
`installConfig.hoistingLimits: "workspaces"`, so it deliberately does not rely on root hoisting —
making the omission a real fragility, not cosmetic. Both are now direct `dependencies`.

**Genuinely-unused deps removed** — root `svelte-eslint-parser`, `cadre-core`
`@libp2p/peer-id-factory`, `integration-tests` `@noble/hashes`. `yarn.lock` regenerated.

**`docs/STATUS.md`** — "Dependency-check coverage" rewritten to the true post-fix state: the
red-gate checkbox is now checked and explains what the NativeScript entry-point gap actually was;
the two `@noble/*` additions were appended to the running "Phantom deps fixed" list; the three
removals appended to "Truly-unused deps removed"; the reference-app-ns ignores documented; and a new
bullet records the expected `warn`-only residue on a green run.

## Deviation from the ticket — read this one

The ticket specified `"@noble/ciphers": "^2.1.1"` on the stated grounds that it "matches what is
installed today" and produces "no resolution change". That is **wrong**: what is installed today is
`2.1.1` via `@chainsafe/libp2p-noise`'s `^2.0.1` range, and a `^2.1.1` range does not dedupe onto it —
`yarn install` proved this, adding a *second* lock entry at `@noble/ciphers@npm:2.2.0`. Two copies of
a crypto package in a NativeScript bundle is bundle bloat for no gain.

Shipped `"@noble/ciphers": "^2.0.1"` instead, which dedupes onto the existing `2.1.1` entry and
matches both `@noble/curves`'s range and what `libp2p-noise` itself asks for. Verified: the final
`yarn.lock` diff contains **no** version changes and **no** new resolution entries — only the five
`package.json` membership edits and the narrowing of `svelte-eslint-parser@npm:^1.7.0, ^1.7.1` to
`^1.7.0`. This honours the ticket's actual stated intent.

## Validation performed — all green

| command | result |
| --- | --- |
| `yarn dep-check` | **exit 0**, **zero** configuration hints |
| `yarn lint` | exit 0 (covers the `svelte-eslint-parser` removal) |
| `yarn workspace @serfab/cadre-core build` | exit 0 |
| `yarn workspace @serfab/cadre-core test` | exit 0 — 54 files, 732 passed, 1 skipped |
| `yarn workspace @serfab/integration-tests build` | exit 0 |
| `yarn workspace @serfab/integration-tests typecheck` | exit 0 |
| `yarn workspace @serfab/reference-app-ns typecheck` | exit 0 |
| `yarn workspace @serfab/reference-app-ns test:bundle` | exit 0 — "whole import graph compiled with 0 errors, 0 warnings" |

Notably `reference-app-ns` source files no longer appear under knip's "Unused files", confirming the
entry points genuinely reach the `src/` graph rather than the package being excluded.

## What a reviewer should check

- **The entry globs actually match.** `app/**/*-page.ts` is the load-bearing one. Confirm every
  string-referenced page is covered — grep `app/**/*.xml` for `defaultPage=` and the `src/` tree for
  `Frame.navigate`/`moduleName`. A page named other than `*-page.ts` would silently fall outside the
  glob and re-open the same hole this ticket closed, without turning the gate red.
- **The `ignoreDependencies` are honest, not convenient.** Each of `@nativescript/android`,
  `esbuild-loader`, `util`, `buffer` is claimed to be framework/config-implicit. `esbuild-loader` and
  `util` are the two worth verifying against `packages/reference-app-ns/webpack.config.js` — the
  claim is that `esbuild-loader` is named by string in a webpack-chain `.loader()` call and `util`
  resolves to the npm package because `externalsPresets.node` is false.
- **Deliberately not ignored:** `@nativescript-community/sqlite`. Nothing imports it, but knip
  resolves it as satisfying `@optimystic/db-p2p-storage-ns`'s peer-dependency requirement and does
  not flag it. Adding an ignore for it produces a "Remove from ignoreDependencies" hint — don't.
- **The `@noble/*` versions.** Sanity-check that `chacha20poly1305` and `x25519` as used in
  `noise-crypto.js` are satisfied by the resolved `@noble/ciphers@2.1.1` / `@noble/curves@2.0.1`.
  `test:bundle` compiles the shim, and `typecheck` passes, but neither *executes* it.

## Known gaps — flagged, not papered over

- **The shim is compiled but never executed anywhere in CI.** `test:bundle` proves it bundles;
  nothing proves `chacha20poly1305`/`x25519` behave at runtime against the newly-declared versions.
  The real proof paths are `test:bundle:native` (`ns prepare android`) and `test:e2e`, both of which
  need an Android toolchain or a device — **not run here**, deferred to a human or CI with that
  hardware. If a reviewer has an Android environment, running those is the highest-value check
  available on this diff.
- **`yarn test` was not run repo-wide.** Only `cadre-core` (full suite) and `integration-tests`
  (build + typecheck) were exercised, matching the ticket's scope — those are the two packages whose
  `package.json` lost a dependency. `integration-tests`' vitest suite spins up real networking and was
  not run; its build and typecheck passing is the floor, not a guarantee.
- **`reference-app-ns` exports now show up in knip's `warn`-class dead-code list** (`applySeed`,
  `decodeSeed`, `getConnectionPaths`, `addStrand` in `src/cadre-phone.ts`; `getChatSAppConfig`,
  `joinChatStrand` in `src/chat-strand.ts`). These were invisible before because the whole package
  was unreachable — they are newly *surfaced*, not newly *dead*, and mirror the identical set already
  reported for `reference-app-rn`. `exports` is `warn`, so the gate stays green. Part of the
  pre-existing dead-code backlog, explicitly out of scope.
- **One expected `Duplicate exports` warning remains** on `noise-crypto.js`
  (`pureJsCrypto|nodeCrypto|asCrypto|defaultCrypto`). Intentional — the shim binds all four upstream
  export names to the same pure-JS object. `duplicates` is `warn`. Leave it.
- **Peer-dependency warnings from `yarn install` are pre-existing and untouched**
  (`@nano-sql/core` / `typeorm` unmet for `@nativescript-community/sqlite`, `webpack` unmet for
  `esbuild-loader`, `@react-native/gradle-plugin`). They predate this diff and `dep-check` does not
  gate on them.

## Tripwire recorded

The `app/**/*-page.ts` entry glob silently under-analyses if a page is ever named outside the
`*-page.ts` convention — fine today, a hole the moment naming diverges, and it would not turn the
gate red. Parked as a `NOTE:` comment on the `entry` array in `knip.ts`.
