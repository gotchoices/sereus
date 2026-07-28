---
description: The command that checks for unused and missing package dependencies has been failing ever since the NativeScript reference app was added. Register that app with the checker, clean up a handful of genuinely unused dependencies, and declare two packages the app imports but never listed.
prereq:
files: knip.ts, package.json, packages/reference-app-ns/package.json, packages/reference-app-ns/src/shims/noise-crypto.js, packages/cadre-core/package.json, packages/integration-tests/package.json, docs/STATUS.md
difficulty: medium
---

# Make `yarn dep-check` green again

Every change below was applied to a scratch working tree and verified end to end:
`yarn dep-check` goes from **exit 1** to **exit 0**, with `packages/reference-app-ns`
genuinely analysed (not excluded) and **zero** knip configuration hints. The tree was
restored afterwards, so this ticket is the transcription of a proven fix, not a guess.

## What was actually wrong

The original bug report said `reference-app-ns` is "absent from knip's `workspaces` key,
so knip finds no entry points for it". Half right, and the distinction matters for the fix:

knip auto-detects every Yarn workspace from the **root** `package.json` `workspaces` globs.
The `workspaces` key in `knip.ts` is only for *per-package overrides*. So knip **was**
analysing `reference-app-ns` — it just found exactly one entry point, `app/app.ts` (from the
package's `main`), and that import chain reaches only the polyfill barrel. Everything else
in the package looked dead:

- **NativeScript page modules are loaded by string, not by import.** `app/app-root.xml`
  says `defaultPage="chat/chat-page"`, and `settings-page` is reached by a runtime
  `Frame.navigate({ moduleName: … })`. No static import exists for knip to follow, so
  `app/chat/chat-page.ts` and `app/settings/settings-page.ts` were unreachable — and with
  them the entire `src/` tree they pull in (`cadre-vm` → `cadre-phone` → the whole
  cadre/db-p2p/Quereus/Optimystic graph). That single gap is what made **13** real
  dependencies report as unused.
- Four more files are reachable only through **webpack**, never through an import:
  `src/polyfills/node-{os,crypto,tty,cluster}.ts` are `resolve.fallback` targets, and
  `src/shims/{libp2p-user-agent,noise-crypto}.js` are `NormalModuleReplacementPlugin`
  targets. All are wired up in `webpack.config.js`.
- `nativescript.config.ts` is read by the `ns` CLI; `src/solo-smoke.ts` is a manual
  out-of-band device helper with no importer (directly analogous to `strand-proto`'s
  already-declared `test/manual/*.ts` entry).

## The real defect the gate was hiding

Once the entry points are declared and knip can finally see `src/shims/noise-crypto.js`,
it reports two **unlisted (phantom) dependencies**:

```
@noble/ciphers/chacha.js  packages/reference-app-ns/src/shims/noise-crypto.js:22:34
@noble/curves/ed25519.js  packages/reference-app-ns/src/shims/noise-crypto.js:23:24
```

The shim imports `@noble/ciphers` and `@noble/curves` directly, but
`packages/reference-app-ns/package.json` declares neither. It only builds today because both
happen to be installed transitively (`@chainsafe/libp2p-noise@17.0.0` depends on
`@noble/ciphers@^2.0.1` and `@noble/curves@^2.0.1`). That is exactly the kind of
undeclared-import fragility `dep-check` exists to catch, and it is the one genuine code
defect in this ticket — the rest is config and dead-entry cleanup. `@noble/hashes`, imported
on the two adjacent lines of the same file, *is* properly declared; these two were missed.

Note `packages/reference-app-ns/package.json` sets `installConfig.hoistingLimits:
"workspaces"`, so this package deliberately does **not** rely on root hoisting for its own
deps — which makes the omission more than cosmetic.

## Verified `knip.ts` block

Insert between the `packages/quereus-plugin-sereus` and `packages/reference-app-rn`
entries (workspace keys are kept alphabetical, and `-ns` sorts before `-rn`). Comments
below are the intended final prose — match the explain-the-why density of the neighbouring
`reference-app-rn` / `reference-app-web` blocks:

```ts
'packages/reference-app-ns': {
	// NativeScript resolves page modules by string, not by import: app-root.xml
	// names `chat/chat-page` and Settings is reached via a runtime
	// `Frame.navigate({ moduleName })` — no static import exists for knip to
	// follow, so each page (and the whole `src/` graph behind it) needs to be an
	// entry. The polyfill/shim files are reached only through webpack
	// (`resolve.fallback` for the node-* polyfills,
	// `NormalModuleReplacementPlugin` for the shims — see webpack.config.js),
	// `nativescript.config.ts` is read by the `ns` CLI, and `solo-smoke.ts` is a
	// manual on-device helper with no importer (cf. strand-proto's test/manual).
	entry: [
		'app/**/*-page.ts',
		'nativescript.config.ts',
		'src/polyfills/node-*.ts',
		'src/shims/*.js',
		'src/solo-smoke.ts',
	],
	// The NativeScript CLI is a globally-installed tool, like `ncu` / `eas`.
	ignoreBinaries: ['ns'],
	ignoreDependencies: [
		// NativeScript toolchain: `@nativescript/android` is the native platform
		// runtime consumed by `ns prepare android`, never imported.
		'@nativescript/android',
		// webpack-config-implicit: `esbuild-loader` is named by string in a
		// webpack-chain `.loader()` call, which knip's webpack plugin can't read;
		// `util` resolves straight to the npm package for transitive deps that
		// import it (externalsPresets.node:false).
		'esbuild-loader',
		'util',
		// Node built-in name, so knip won't treat the bare `buffer` import in
		// src/polyfills/buffer-global.ts as a package — same ignore as the rn and
		// web apps carry.
		'buffer',
	],
},
```

Deliberately **not** ignored: `@nativescript-community/sqlite`. It looks unused (nothing
imports it) but knip resolves it as satisfying `@optimystic/db-p2p-storage-ns`'s
peer-dependency requirement and does not flag it. Adding an ignore for it produces a
`Remove from ignoreDependencies` hint.

## Stale `ignoreDependencies` to delete

Five entries no longer suppress anything; knip emits a "Remove from ignoreDependencies"
hint for each. Delete the array element **and** update the surrounding comment prose so it
stops describing entries that are gone:

| workspace | entry to delete |
| --- | --- |
| `packages/cadre-host` | `svelte-check` |
| `packages/reference-app-web` | `svelte-check`, `@multiformats/multiaddr`, `@quereus/quereus` |
| `packages/reference-app-rn` | `@optimystic/db-p2p` |

The three "Add entry and/or refine project files" hints (for `reference-app-ns`,
`reference-app-rn`, `cadre-provider`) all clear on their own once the `reference-app-ns`
entries land — no action needed for `reference-app-rn` or `cadre-provider`. Confirmed:
the final verified run emits **no** configuration hints at all.

## Genuinely-unused dependencies to remove

All three verified to have zero references anywhere outside their own `package.json`:

- **root `package.json` → `svelte-eslint-parser`** (devDep). `eslint.config.mjs` never
  imports it; it arrives through `svelte.configs.recommended`, and `eslint-plugin-svelte@3.19.0`
  declares `svelte-eslint-parser` as a real `dependency` (not a peer), so dropping the
  redundant top-level entry cannot break the svelte lint pass.
- **`packages/cadre-core/package.json` → `@libp2p/peer-id-factory`** (devDep).
- **`packages/integration-tests/package.json` → `@noble/hashes`** (dependency).

## Docs

`docs/STATUS.md` → "Dependency-check coverage" (~line 387) currently carries an unchecked
box stating the gate is red and pointing at this ticket. Replace it with the true post-fix
state: the gate is green, `reference-app-ns` is analysed via declared entry points, and the
two phantom `@noble/*` deps found in the process were added — that last point belongs in the
existing "Phantom deps fixed" bullet, which is the running list of exactly this kind of find.

## Known remaining (expected, non-blocking)

The green run still prints one `warn`-class item:

```
Duplicate exports (1)
pureJsCrypto|nodeCrypto|asCrypto|defaultCrypto  packages/reference-app-ns/src/shims/noise-crypto.js
```

That is intentional — the shim binds all four of upstream's export names to the same
pure-JS object so it can stand in for `@chainsafe/libp2p-noise`'s `crypto/index.js`
module surface. `duplicates` is `warn` in `knip.ts` `rules`, so it does not fail the gate.
Leave it. The pre-existing dead-code backlog (unused files / exports / types) is likewise
`warn` and explicitly out of scope.

## TODO

- Add the verified `packages/reference-app-ns` block to `knip.ts` (entry, ignoreBinaries,
  ignoreDependencies), placed alphabetically before `packages/reference-app-rn`.
- Delete the five stale `ignoreDependencies` entries listed above and fix up the
  surrounding comment prose in the `cadre-host`, `reference-app-web`, and
  `reference-app-rn` blocks.
- Add `"@noble/ciphers": "^2.1.1"` and `"@noble/curves": "^2.0.1"` to
  `packages/reference-app-ns/package.json` `dependencies` (keep the block
  alphabetical — they sort immediately before the existing `@noble/hashes`). Versions
  match what is installed today and satisfy `@chainsafe/libp2p-noise`'s own
  `^2.0.1` ranges, so no resolution change is expected.
- Remove `svelte-eslint-parser` (root), `@libp2p/peer-id-factory` (cadre-core), and
  `@noble/hashes` (integration-tests) from their `package.json` files.
- Run `yarn install` and commit the resulting `yarn.lock` change.
- Verify `yarn dep-check` exits **0** and prints no configuration hints.
- Verify the removals broke nothing: `yarn lint` (covers the `svelte-eslint-parser`
  removal), plus build + tests for `cadre-core` and `integration-tests`.
- Confirm `reference-app-ns` still typechecks and bundles after the `package.json`
  additions: `yarn workspace @serfab/reference-app-ns typecheck` and `test:bundle`.
  (`test:bundle:native` / `test:e2e` need an Android toolchain or device — skip those
  here and note the deferral in the handoff.)
- Update the `docs/STATUS.md` "Dependency-check coverage" section as described above.
