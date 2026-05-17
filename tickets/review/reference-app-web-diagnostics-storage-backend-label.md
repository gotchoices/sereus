description: Diagnostics "Storage backend" cell now uses a stable label that survives Vite minification
files: packages/reference-app-web/src/lib/diagnostics.svelte.ts, packages/reference-app-web/e2e/solo/diagnostics.spec.ts
----

## Summary

`collectStorage()` previously populated the Diagnostics "Storage backend" cell
with `storage.constructor.name`. Vite mangles class names in production builds,
so the cell rendered something like `Sie` instead of `IndexedDBRawStorage`. The
parent ticket's implement pass had loosened the Tier 1 solo Playwright
assertion to "non-empty and not `—`" as a workaround.

## What changed

- `packages/reference-app-web/src/lib/diagnostics.svelte.ts`
  - Imports `IndexedDBRawStorage` from `@optimystic/db-p2p-storage-web` and the
    `IRawStorage` type from `@optimystic/db-p2p`.
  - Adds a small `storageBackendLabel(storage)` helper (lines 443-447) that
    uses `instanceof IndexedDBRawStorage` to resolve a stable display label.
    The literal `'IndexedDBRawStorage'` survives minification; unknown
    implementations fall back to `'unknown'` (intentionally a "we forgot a
    branch here" signal rather than silently rendering minified gibberish).
  - `collectStorage()` calls `storageBackendLabel(storage)` instead of
    `storage.constructor.name`.
- `packages/reference-app-web/e2e/solo/diagnostics.spec.ts`
  - Tightens the assertion to
    `expect(page.getByTestId('diag-storage-backend')).toHaveText('IndexedDBRawStorage')`.
  - Drops the "non-empty / not `—`" workaround comment.

The web app today only ever constructs `IndexedDBRawStorage` via
`packages/reference-app-web/src/lib/optimystic.ts:143`, so a single
`instanceof` branch covers all real production paths.

## How to validate

- `yarn typecheck` in `packages/reference-app-web` — clean.
- `yarn test:e2e e2e/solo/diagnostics.spec.ts` in `packages/reference-app-web`
  — passes. The Playwright config (`playwright.config.ts:28`) runs
  `yarn build && yarn preview`, i.e. a real production (minified) build, so a
  green run on this spec is the load-bearing evidence that the label survives
  minification. Confirmed: the spec passes (1.3 MB minified bundle) and the
  rendered cell reads exactly `IndexedDBRawStorage`.

## Review hot spots

- `storageBackendLabel()` returns `'unknown'` for any non-`IndexedDBRawStorage`
  implementation. That's deliberate (the Diagnostics page is developer-facing
  evidence; a string the maintainer can grep is more useful than a minified
  ctor name), but worth confirming the reviewer agrees with that policy versus
  e.g. `'unknown (' + storage.constructor.name + ')'`.
- The branch added a runtime import of `IndexedDBRawStorage` to
  `diagnostics.svelte.ts`. That class is already in the bundle via
  `optimystic.ts:143`, so this should not change the production chunk size in
  any meaningful way — but worth a glance at the build report if the reviewer
  is being picky.
- If a future `IRawStorage` implementation is added that the web app could
  plausibly mount (e.g. an OPFS backend), `storageBackendLabel()` needs a new
  branch — there is no test forcing that, only the `'unknown'` fallback and
  the spec asserting `'IndexedDBRawStorage'` while the production code mounts
  IndexedDB.

## Known gaps

None deferred. The single TODO from the implement ticket (run the e2e against
the production build) was completed.
