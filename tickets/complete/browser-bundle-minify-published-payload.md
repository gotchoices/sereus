description: The plugin's browser build is now minified, cutting the file browsers download from about 4.7 MB to about 1.9 MB (about 1.1 MB to 0.6 MB once compressed), with the size limits in the test tightened to match.
architecture: docs/testing.md
files:
  - packages/quereus-plugin-sereus/scripts/build-browser.mjs
  - packages/quereus-plugin-sereus/test/browser-bundle.spec.ts
  - packages/quereus-plugin-sereus/README.md
  - docs/testing.md
----

# Complete — minify the browser bundle

`scripts/build-browser.mjs` now builds `dist/plugin-browser.js` with `minify: true`. The soft size caps in `test/browser-bundle.spec.ts` were re-tightened against the minified artifact (`MAX_RAW_BYTES` 5,900,000 → 2,400,000; `MAX_GZIPPED_BYTES` 1,400,000 → 710,000), and the package README plus the "Browser bundle checks" section of `docs/testing.md` were updated to describe the new artifact.

Measured on 2026-09-20 with `node scripts/build-browser.mjs`, reproduced during review at the same byte counts:

| | raw | gzipped |
|---|---|---|
| before | 4,890,498 B | 1,162,393 B |
| after | 2,005,190 B (1958.2 KiB) | 592,933 B (579.0 KiB) |

Nothing else in the build changed. The name-and-version banner still occupies line 1 of the output, and dependency license comments are collected at end of file, so minification did not drop attribution.

## Review findings

**Checked by reading and running the code.** Rebuilt the bundle and reproduced the recorded measurement to the byte. Confirmed the minified artifact still carries the banner, still emits `dist/plugin-browser.js.map` (version 3, 1,506 sources, non-empty mappings, `src/plugin-browser.ts` among the sources). Confirmed no source in the plugin reads `Function.name` or `constructor.name` off a first-party class, so mangling has nothing to break there — the two `.name` reads in `compose-strand.ts` are object properties on registration descriptors, not function names. Confirmed the package has no other consumer of the artifact inside the repo and no other document quotes its size, so the README and `docs/testing.md` are the complete documentation surface. Ran `yarn lint` (clean), the package's `unit` project (6 files, 90 tests, pass) and `yarn workspace @serfab/quereus-plugin-sereus typecheck` (clean).

**Fixed in this pass (minor).**

- The comment above the forbidden-import regexes in `browser-bundle.spec.ts` justified the narrow `from "…"` match by esbuild's section-marker comments mentioning module paths. Minification strips those comments — measured: the literals `node:fs`, `node:net`, `@libp2p/tcp` and `node_modules/` now appear zero times anywhere in the bundle — so the stated reason no longer described the file. Rewrote it to say why the narrow match is still the right shape.
- The "Scope notes" bullet in `docs/testing.md` § Lint coverage listed `scripts/` among "non-package trees", which reads as the root `scripts/` directory only. The ESLint ignore is `**/scripts/**` and also covers eight package-level scripts, including the `build-browser.mjs` this ticket edited. Corrected the bullet to say so and name examples. The exclusion itself is deliberate (the config carries its own rationale) and was left in place; the implementer flagged it as a gap, and it is a documented decision rather than an oversight.

**Tripwire recorded, not filed.** The source map is about 12.8 MB — over six times the minified bundle — and `package.json` `files` publishes `dist`, so every install downloads it. That is not new (`sourcemap: true` predates this change) and it is what keeps the minified bundle debuggable, but minification made the map the dominant part of the published tarball. `NOTE:` at the `sourcemap: true` line in `scripts/build-browser.mjs`, naming the two levers (drop `sourcesContent`, or exclude the map) and the revisit condition (install size becoming a complaint).

**Tickets filed: none.** No finding cleared the bar. The one architectural concern in reach — the duplicate physical copies of shared dependencies, about 1.60 MiB of the unminified bundle — already has a ticket at `tickets/backlog/reference-app-web-libp2p-interface-dedup.md` whose text remains accurate, and the `@libp2p/autonat` / `@libp2p/dcutr` weight needs an upstream change in `../optimystic`. Neither is a new instance to file.

**Tests: none added, none cut.** The existing `stays under soft size caps` test is the guard against minification silently regressing — the unminified file is 2.4x the raw cap, so the assertion fails by arithmetic. A test asserting the banner survives or that the output "looks minified" would exercise esbuild, not this package. The prior ticket's four artifact assertions all still earn their place on the minified file.

**Claim corrected.** The handoff said `sourcesContent` is embedded "for every source". It is embedded for 1,501 of 1,506; the five without it are `digitree`'s own sources, whose upstream map points at a sibling checkout that does not exist here. That predates minification and is upstream — devtools still show readable code for everything this repo owns, so the README's wording stands.

**Known gaps carried forward, unresolved by design.** Nothing loads this bundle in a real browser or in Quoomb-web's worker; the shape test is jsdom plus `fake-indexeddb` and stops at the first libp2p failure. The reflective-pattern survey covers `Function.name` / `constructor.name` and is not a proof for every reflection style. The source map was verified programmatically, not opened in devtools. All three were disclosed in the handoff and none is worth a real-browser harness on the strength of a one-flag build change.
