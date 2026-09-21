description: The plugin's browser build ships unminified, so every browser downloads and parses about two and a half times more text than it needs to. Turn minification on and re-tighten the size limits to match.
prereq: browser-bundle-shape-test-transform-and-size-guard
architecture: docs/testing.md
files:
  - packages/quereus-plugin-sereus/scripts/build-browser.mjs
  - packages/quereus-plugin-sereus/test/browser-bundle.spec.ts
difficulty: easy
----

# Minify the browser bundle

`scripts/build-browser.mjs` builds `dist/plugin-browser.js` with `minify: false`. That artifact is a browser payload: it is listed under the package's `browser` export condition, published to npm inside the tarball, and fetched by Quoomb-web's worker through `dynamicLoadModule(url, ...)` before the plugin does anything at all. There is no reason for it to ship as readable source.

Measured at `00c731bc`, same esbuild options as the real build, only `minify` varied:

| | raw | gzipped | brotli |
|---|---|---|---|
| `minify: false` (what ships today) | 4,890,394 B — 4.66 MiB | 1,162,304 B — 1.11 MiB | 646,169 B — 0.62 MiB |
| `minify: true` | 2,005,086 B — 1.91 MiB | 592,843 B — 0.57 MiB | 329,567 B — 0.31 MiB |

Raw drops 59%, gzipped 49%. Gzipped is what crosses the wire on most hosts; raw is what the browser's parser has to chew through after decompression, and on a cold cache that parse is the larger share of the cost. Both halves improve.

Debuggability is not the trade it looks like. `sourcemap: true` is already set and `dist/plugin-browser.js.map` is already emitted, so a minified bundle still resolves to original sources in devtools. The map is 12.7 MB today and will not shrink much — that is fine, it is fetched only when devtools is open.

The existing artifact assertions were run against a minified build and all hold: it parses as ESM under acorn at `ecmaVersion: 2022`, and none of the nine forbidden Node-only specifiers (`@libp2p/tcp`, `node:fs`, `node:net`, …) appear — the regexes in `test/browser-bundle.spec.ts` use `\s*` between `from` and the quote, so removing whitespace does not smuggle anything past them.

One thing to confirm rather than assume: the build sets `banner.js` to `/* <name> <version> — browser bundle */`, which is how you tell which version of the plugin a deployed artifact is. esbuild normally prepends banners verbatim after minifying, but check the first line of the output is still there. If it is not, `legalComments: 'inline'` with a `/*! ... */` banner keeps it.

Then re-tighten `MAX_RAW_BYTES` and `MAX_GZIPPED_BYTES` in `test/browser-bundle.spec.ts` — the prerequisite ticket sets them against the unminified artifact, and they will be roughly two and a half times too loose once this lands. Re-measure and update the recorded byte count, date and command in the comment beside them.

## What this does not address

About 1.60 MiB of the unminified 4.66 MiB — 34% — is duplicate physical copies of shared dependencies, pulled in from the nested `node_modules` of the sibling repositories the root `package.json` `resolutions` block `link:`s to. Twenty-three copies of `multiformats`, eleven of `@libp2p/crypto`, eight of `@multiformats/multiaddr`. Minifying shrinks each copy but does not merge them. That is a dependency-deduplication problem, recorded as an arm on `tickets/backlog/reference-app-web-libp2p-interface-dedup.md`, which shares its root cause.

A further ~270 KiB is `@libp2p/autonat` and `@libp2p/dcutr`, NAT-traversal services a browser cannot use, imported unconditionally by `@optimystic/db-p2p`'s `libp2p-node-base.js`. Dropping them needs an upstream change in `../optimystic`, not a change here.

Neither is a reason to hold this ticket. Minification is independent of both and is the single largest lever available inside this repository.

## TODO

- Set `minify: true` in `packages/quereus-plugin-sereus/scripts/build-browser.mjs`.
- Rebuild and confirm the first line of `dist/plugin-browser.js` still carries the name-and-version banner; if it does not, switch the banner to `/*! ... */` and set `legalComments: 'inline'`.
- Confirm `dist/plugin-browser.js.map` is still emitted and still resolves original sources.
- Re-measure raw and gzipped (the build script prints both), then re-tighten `MAX_RAW_BYTES` / `MAX_GZIPPED_BYTES` in `test/browser-bundle.spec.ts` to roughly 20% above the new numbers, updating the recorded measurement comment.
- Run the package's full unit suite, including `browser-shape.spec.ts` and `browser-bundle.spec.ts`.
- Note the new published payload size in `docs/testing.md` where the bundle checks are described.
