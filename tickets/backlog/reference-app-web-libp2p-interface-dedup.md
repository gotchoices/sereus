----
description: The web reference app's type checker fails because two copies of a libp2p package at different versions disagree about a type; the duplicate copy needs to be de-duplicated.
files: packages/reference-app-web/src/lib/cadre-web.ts, packages/reference-app-web/package.json, package.json, ../optimystic/packages/db-p2p-storage-web/package.json
difficulty: medium
----

### Symptom

`svelte-check` fails at HEAD with 2 type errors:

**Command:** `cd packages/reference-app-web && yarn exec svelte-check`

**File:** `src/lib/cadre-web.ts` — errors at `286:3` and `323:34`.

**Error (286:3, 323:34 share the same root):**
```
Type 'PrivateKey' is not assignable to type 'PrivateKey | undefined'.
  Type 'RSAPrivateKey' is not assignable to type 'PrivateKey | undefined'.
    Type 'import("C:/projects/optimystic/packages/db-p2p-storage-web/node_modules/@libp2p/interface/.../keys").RSAPrivateKey'
      is not assignable to type
    'import("C:/projects/sereus/node_modules/@libp2p/interface/.../keys").RSAPrivateKey'.
      The types of 'publicKey.verify' are incompatible ...
        Type 'Uint8ArrayList' is not assignable to type 'Uint8ArrayList<ArrayBufferLike>'.
          Property '[symbol]' is missing in type 'Uint8ArrayList' but required in type 'Uint8ArrayList<ArrayBufferLike>'.
```

### Root cause

Two different copies of `@libp2p/interface` are resolved in the same type graph:

- `C:/projects/sereus/node_modules/@libp2p/interface` (top-level, used by
  `reference-app-web`)
- `C:/projects/optimystic/packages/db-p2p-storage-web/node_modules/@libp2p/interface`
  (nested inside the linked optimystic workspace package)

The two versions disagree on the `Uint8ArrayList` generic: the newer one is
`Uint8ArrayList<ArrayBufferLike>` (carries a required `[symbol]` brand) while the
nested copy is the un-parameterized `Uint8ArrayList`. A `PrivateKey` produced by
the nested copy (via `db-p2p-storage-web`) is therefore not assignable to the
`PrivateKey` parameter typed by the top-level copy, which is what `cadre-web.ts`
references at lines 286 and 323.

This is a dependency-deduplication / version-alignment problem in the linked
workspace, not a logic bug in `cadre-web.ts`.

### Why this is not a tightly-scoped triage fix

The mismatch lives in `node_modules` layout across two linked repos, not in
Sereus source. Resolving it means aligning `@libp2p/interface` versions so a
single copy is hoisted — e.g. adjusting `resolutions` in the root
`package.json`, bumping/aligning `@libp2p/interface` in
`../optimystic/packages/db-p2p-storage-web`, or de-duping the install. That is a
dependency-management change with install-graph-wide consequences (and a
re-install), out of scope for an in-place test triage. A source-level cast in
`cadre-web.ts` would only paper over a genuine version skew and is the wrong
layer to fix it.

### Ruled out

- **Not** caused by the `svelte-check-gate` ticket that surfaced it — that ticket
  touches no files under `reference-app-web`.
- **Not** a `cadre-web.ts` logic error: the values are correct at runtime; the
  failure is purely the type checker seeing two `@libp2p/interface` identities.
- Reproduces deterministically at HEAD (`6d79439`): `svelte-check` reports
  exactly these 2 errors in 1 file out of 839 checked.

### Suggested approach (for the implementer)

1. `yarn why @libp2p/interface` in both `sereus` and
   `../optimystic/packages/db-p2p-storage-web` to identify the divergent versions.
2. Align the versions (root `resolutions` and/or the optimystic package's dep)
   so a single `@libp2p/interface` is shared, then re-install and re-run
   `svelte-check`.

---

## Second instance: the same duplication ships to browsers in the plugin bundle

Found while investigating the browser bundle of `@serfab/quereus-plugin-sereus` (ticket `browser-bundle-doubled-and-its-shape-test-times-out`, now closed out into `tickets/implement/`). Same root cause as above — several physical copies of the same libp2p packages resolved from the nested `node_modules` of the `link:`ed sibling repositories — but the symptom here is shipped bytes rather than a type error, so it is worth recording against the same fix.

**Measured** at `00c731bc` with esbuild's own metafile (`metafile: true`, then rolling `bytesInOutput` up by the `node_modules` directory each module came from; the probe scripts were temporary and are not in the tree). The bundle is 4,890,394 bytes from 1,566 input modules, and **1,636 KiB of that — 34% — is copies beyond the first of a package already in the graph**:

| package | total in bundle | physical copies |
|---|---|---|
| `multiformats` | 641 KiB | 23 |
| `@noble/curves` | 285 KiB | 4 |
| `@libp2p/crypto` | 239 KiB | 11 |
| `@libp2p/utils` | 166 KiB | 5 |
| `@multiformats/multiaddr` | 158 KiB | 8 |
| `@noble/hashes` | 116 KiB | 6 |
| `protons-runtime` | 88 KiB | 3 |

The copies come from `../optimystic/packages/*/node_modules/` and `../Fret/packages/fret/node_modules/`. Yarn cannot hoist across a `link:` boundary, so each linked sibling keeps its own tree and esbuild faithfully bundles every one it reaches.

**Why this reaches users and not just the type checker.** `scripts/publish-package.mjs:190` runs `yarn build` in this linked tree and publishes `dist/`, and `dist/plugin-browser.js` is a pre-built artifact inside the tarball. So the duplicates are baked in at pack time and downloaded by every browser that loads the plugin. `yarn smoke:published` installs from the registry and is described in `docs/releasing.md` as "the only gate that can see a defect which exists solely in the published dependency graph", but it cannot see inside an artifact that was already built — by the time the tarball exists, the bundle's dependency graph is frozen. A size cap in `packages/quereus-plugin-sereus/test/browser-bundle.spec.ts` is the only thing watching it; ticket `browser-bundle-shape-test-transform-and-size-guard` tightens that cap and records the gap as a `NOTE:` at the site.

**What this adds to the ticket above:** aligning the versions so a single copy hoists is worth roughly 1.6 MiB of unminified browser payload on top of clearing the two `svelte-check` errors. If the alignment is only partial, the bundle benefits proportionally — this is not all-or-nothing.

**Not a substitute for this ticket:** turning on minification (ticket `browser-bundle-minify-published-payload`) shrinks each copy but does not merge them; the duplication survives minification at roughly 41% of its unminified weight.
