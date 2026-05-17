description: Diagnostics "Storage backend" cell now uses a stable label that survives Vite minification
files: packages/reference-app-web/src/lib/diagnostics.svelte.ts, packages/reference-app-web/e2e/solo/diagnostics.spec.ts
----

## Background

`collectStorage()` previously populated the Diagnostics "Storage backend" cell
with `storage.constructor.name`. Vite minifies class names in the production
bundle, so the cell rendered something like `Sie` instead of
`IndexedDBRawStorage` in production builds. The solo Playwright suite was
loosened during the parent ticket's implement pass to "non-empty and not `—`"
because of this.

## Approach taken

Chose the inline mapping option from the plan — leaves the storage classes
(which live in the `optimystic` workspace) untouched and keeps the mapping
co-located with the diagnostics surface that cares about display labels.

`diagnostics.svelte.ts` now imports the concrete `IndexedDBRawStorage` class
and resolves the backend label via a small `storageBackendLabel()` helper that
uses `instanceof`. The literal string `'IndexedDBRawStorage'` survives
minification. The web app today only ever constructs `IndexedDBRawStorage`
(`packages/reference-app-web/src/lib/optimystic.ts:143`); the helper falls
back to `'unknown'` for any other implementation, which is the right signal
for "we forgot to add a label here" rather than silently rendering minified
junk.

The Tier 1 solo diagnostics spec
(`packages/reference-app-web/e2e/solo/diagnostics.spec.ts`) is tightened to
`expect(page.getByTestId('diag-storage-backend')).toHaveText('IndexedDBRawStorage')`.

## What landed

- `packages/reference-app-web/src/lib/diagnostics.svelte.ts`
  - Imports `IndexedDBRawStorage` and `IRawStorage`.
  - New `storageBackendLabel(storage)` helper with an `instanceof` branch.
  - `collectStorage()` uses it instead of `storage.constructor.name`.
- `packages/reference-app-web/e2e/solo/diagnostics.spec.ts`
  - Tightened the assertion to `toHaveText('IndexedDBRawStorage')` and dropped
    the "non-empty / not `—`" workaround comment.

## Verification done

- `yarn typecheck` in `packages/reference-app-web` is clean.

## TODO

- Run `yarn test:e2e` (or at least the `solo/diagnostics.spec.ts` test) in
  `packages/reference-app-web` against a production build to confirm the
  tightened assertion holds when class names are minified. Playwright config
  builds for production by default — verify that's still the case before
  treating a passing run as proof.
- If a future `IRawStorage` is added that the web app could plausibly mount,
  extend `storageBackendLabel()` with another branch.
