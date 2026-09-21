description: The plugin's browser build is now minified, cutting the file browsers download from about 4.7 MB to about 1.9 MB (about 1.1 MB to 0.6 MB once compressed), and the size limits in the test were tightened to match.
architecture: docs/testing.md
files:
  - packages/quereus-plugin-sereus/scripts/build-browser.mjs
  - packages/quereus-plugin-sereus/test/browser-bundle.spec.ts
  - packages/quereus-plugin-sereus/README.md
  - docs/testing.md
difficulty: easy
----

# Review handoff — minify the browser bundle

The prerequisite (`browser-bundle-shape-test-transform-and-size-guard`) has landed; this ticket sits on top of it.

## What changed

- `scripts/build-browser.mjs`: `minify: false` → `minify: true`. Nothing else in the build changed.
- `test/browser-bundle.spec.ts`: `MAX_RAW_BYTES` 5_900_000 → `2_400_000`, `MAX_GZIPPED_BYTES` 1_400_000 → `710_000`, with the recorded measurement, date and command updated, plus a two-line note that the caps assume minification is on.
- `README.md` (package): the artifact paragraph now says minified, about 1.9 MiB raw / 0.6 MiB gzipped, and that a source map with embedded sources ships beside it.
- `docs/testing.md` ("Browser bundle checks"): one new bullet (built minified; caps set against that build; the duplicate-dependency problem is not something minification or a cap fixes), and "unminified" added to the historical 2.5 → 4.66 MiB sentence so it stays true.

## Measured (2026-09-20, `node scripts/build-browser.mjs`, same esbuild options, only `minify` varied)

| | raw | gzipped |
|---|---|---|
| before (`dist/` already on disk) | 4,890,498 B | 1,162,393 B |
| after | 2,005,190 B (1958.2 KiB) | 592,933 B (579.0 KiB) |

Brotli after: 329,521 B (measured for the record; nothing asserts it). Headroom under the new caps is 19.7% raw and 19.7% gzipped, matching the prior ticket's ~20%. The ticket quoted 2,005,086 B at `00c731bc`; the 104-byte difference is the linked `../optimystic` / `../quereus` checkouts moving, as the spec comment already warns.

## What was confirmed rather than assumed

- **Banner survives.** Line 1 of the minified output is `/* @serfab/quereus-plugin-sereus 1.0.0 — browser bundle */`. No `legalComments` change was needed.
- **Source map still resolves.** `dist/plugin-browser.js.map` is emitted (12,846,232 B, up from 12,726,685), version 3, 1,506 sources, `sourcesContent` embedded for every source. Six probe positions in the minified file were traced back with `@jridgewell/trace-mapping` to original files with line and column (e.g. `.../@noble/hashes/src/sha2.ts 254:8`). `package.json` `files` includes `dist`, so the map is published; embedded content is what lets devtools show sources where those relative paths do not exist.
- **Behavior on the exercised path is unchanged.** Built an unminified copy with identical options and ran the same probe against both under Node with `fake-indexeddb`: 11 `registerFunction` and 1 `registerModule` calls, IndexedDB `sereus-strand-shape-test` opened, same `TypeError` afterward, byte-for-byte the same on both.
- **The known minification hazard is absent.** Mangling breaks code that reads `Function.name` / `constructor.name` off a user-declared class. The bundle has 30 `constructor.name` reads; every one is `=== "Uint8Array"` (the built-in, which mangling cannot rename), and all 30 survive in the minified file. No `new.target.name` or `this.constructor.name`. So `keepNames` is not needed and was not added.
- **The existing artifact assertions hold** on the minified file (ESM parse, forbidden-import check, source map present).

## Validation

- `node scripts/build-browser.mjs` → `plugin-browser.js: 1958.2 KiB raw, 579.0 KiB gzipped`.
- `npx vitest run --project unit` (package): 6 files, 90 tests, all pass, 28 s wall. The two bundle specs alone: 6 tests, 6.9 s; `default export is a function` 1,573 ms (the load is not slower on the smaller file).
- `eslint` on the spec: clean. `yarn workspace @serfab/quereus-plugin-sereus typecheck`: clean.

## Tests added

None. The existing `stays under soft size caps` is the guard: switching minification off puts the file at 4,890,498 B against a 2,400,000 B cap, so it fails by arithmetic (2.4x over). A test that asserts the banner survives or that the file "looks minified" would test esbuild, not this package.

## Known gaps, for the reviewer to weigh

- **No real browser.** Nothing here loads the bundle in Quoomb-web's worker or any real browser; the shape test is jsdom plus `fake-indexeddb` and stops at the first libp2p failure. Networking paths run only in the integration suites, none of which consume this artifact. The grep for name-dependent code above covers the one hazard I could name; it is not a proof for every reflective pattern (I did not search for `Function.prototype.toString` use, for example).
- **The cap failing when minification is off was not watched, only computed.** It is a plain `toBeLessThan` against a number 2.4x smaller than the unminified size, so I judged a 25-second rebuild-and-revert not worth it.
- **`scripts/*.mjs` is ignored by the ESLint config** (`eslint` reports "File ignored"), so the one-word change to `build-browser.mjs` was not linted. Pre-existing; the spec was linted.
- **The map was spot-checked programmatically, not opened in devtools.**

## Left alone on purpose

- The ~1.60 MiB of duplicate physical copies of shared dependencies is tracked in `tickets/backlog/reference-app-web-libp2p-interface-dedup.md` (its text about minification not merging them remains accurate); the ~270 KiB of `@libp2p/autonat` / `@libp2p/dcutr` needs an upstream change in `../optimystic`. Neither is touched here.
- No tripwires added: the only conditional concern (a future dependency that keys off a class name) has no site in today's bundle to attach a `NOTE:` to.
