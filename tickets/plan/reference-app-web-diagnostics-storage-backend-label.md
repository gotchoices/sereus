description: Diagnostics "Storage backend" cell shows the minified class name in the production bundle; surface a stable label instead
files: packages/reference-app-web/src/lib/diagnostics.svelte.ts, packages/reference-app-web/src/Diagnostics.svelte
----

## Background

`collectStorage()` in `packages/reference-app-web/src/lib/diagnostics.svelte.ts:442` reads `storage.constructor.name` to populate the Diagnostics "Storage backend" cell. Vite minifies class names in the production build, so the cell renders something like `Sie` instead of the human-meaningful `IndexedDBRawStorage`. In dev mode it reads correctly.

The Playwright suite was originally asked to assert the cell equals `IndexedDBRawStorage`; it was loosened during implement to "non-empty and not the `—` placeholder" because of this minification. The current `solo/diagnostics.spec.ts` reflects the loosened assertion.

## Desired behaviour

The cell should display a stable, human-readable backend identifier in both dev and production builds. Two reasonable options:

- Add a static `BACKEND_NAME` (or similar) constant to each `IRawStorage` implementation and read it in `collectStorage()`.
- Inline a small mapping in `diagnostics.svelte.ts` from concrete class identity (`instanceof`) to a literal string. Slightly more brittle but does not require touching the storage classes.

Either path should leave the Tier 1 spec free to tighten its assertion back to `expect(backend).toBe('IndexedDBRawStorage')` (or whatever the stable label becomes).

## Out of scope

- Reformatting the rest of the Diagnostics page.
- Tier 2 connectivity (see `web-e2e-tier2-connectivity`).
