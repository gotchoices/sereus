description: Diagnostics "Storage backend" cell now uses a stable label that survives Vite minification
files: packages/reference-app-web/src/lib/diagnostics.svelte.ts, packages/reference-app-web/e2e/solo/diagnostics.spec.ts
----

## Summary

`collectStorage()` previously populated the Diagnostics "Storage backend" cell
with `storage.constructor.name`. Vite mangles class names in production
builds, so the cell rendered something like `Sie` instead of
`IndexedDBRawStorage`. The parent ticket's implement pass had loosened the
Tier 1 solo Playwright assertion to "non-empty and not `—`" as a workaround.

## What landed

- `packages/reference-app-web/src/lib/diagnostics.svelte.ts`
  - Imports `IndexedDBRawStorage` from `@optimystic/db-p2p-storage-web` and
    `IRawStorage` (type-only) from `@optimystic/db-p2p`.
  - New `storageBackendLabel(storage: IRawStorage | null): string | null`
    helper uses `instanceof IndexedDBRawStorage` to resolve a stable display
    label. The literal `'IndexedDBRawStorage'` survives minification;
    unknown implementations fall back to `'unknown'` (intentionally a "we
    forgot a branch here" signal rather than minified gibberish).
  - `collectStorage()` calls `storageBackendLabel(storage)` instead of
    `storage.constructor.name`.
- `packages/reference-app-web/e2e/solo/diagnostics.spec.ts`
  - Assertion tightened to
    `expect(page.getByTestId('diag-storage-backend')).toHaveText('IndexedDBRawStorage')`.
  - "Non-empty / not `—`" workaround comment dropped.

The web app currently only ever constructs `IndexedDBRawStorage` (via
`packages/reference-app-web/src/lib/optimystic.ts:143`), so the single
`instanceof` branch covers every real production path.

Note: the code edits actually landed in the plan commit `440c625` rather
than the implement commit `2ad59d8`. The implement commit only moved the
ticket file. Functionally equivalent to a sequential plan → implement; just
slightly unusual provenance for the diff.

## Review findings

### What was checked

- Read the implement-stage commit (`2ad59d8`) and the underlying code diff
  (committed in `440c625`) with fresh eyes against the current file state.
- Cross-checked the helper's type signature against `getStorage(): IRawStorage | null`
  in `packages/reference-app-web/src/lib/optimystic.ts:82-84`.
- Verified `IndexedDBRawStorage` is the only `IRawStorage` ever instantiated
  in the web app (`grep` for `new .*RawStorage` across the package).
- Confirmed `IRawStorage` is re-exported from `@optimystic/db-p2p`
  (`packages/db-p2p/src/index.ts:16`), and `IndexedDBRawStorage` is the
  exported class in `@optimystic/db-p2p-storage-web`
  (`indexeddb-storage.ts:16`).
- Searched `docs/`, `CLAUDE.md`, `AGENTS.md`, and all markdown for references
  to the "Storage backend" cell — nothing else describes this cell, so no
  docs update is owed.
- `yarn typecheck` in `packages/reference-app-web` — clean.
- `yarn test:e2e e2e/solo/diagnostics.spec.ts` against the production
  (Playwright config: `yarn build && yarn preview`, see
  `playwright.config.ts:28`) build — passed. Vite emitted a 1.27 MB
  minified main chunk; the cell rendered exactly `IndexedDBRawStorage`.
  This is the load-bearing evidence that the new helper survives
  minification.

### Code-quality angles

- **SPP / DRY / modular**: `storageBackendLabel()` is a single-purpose helper
  co-located with its only caller. Good.
- **Maintainability**: comment block on lines 440-442 explains *why* the
  helper exists (minification breaks `constructor.name`) — appropriate
  WHY-comment, not narration.
- **Type safety**: `IRawStorage | null` matches `getStorage()` exactly. The
  `instanceof` narrowing is the canonical way to map a runtime class to a
  stable identifier.
- **Resource cleanup / error handling**: N/A — pure function, no side
  effects.
- **Performance**: O(1) per tick; the `IndexedDBRawStorage` class is already
  in the bundle via `optimystic.ts:143`, so this added zero new code to the
  production chunk.

### Issues found

- **None requiring inline fix.** Notes for future readers:
  - `instanceof` across module boundaries can fail if
    `@optimystic/db-p2p-storage-web` ends up duplicated in `node_modules`
    (e.g. two resolved versions). In this monorepo it's a workspace
    dependency and the e2e green-test against the real production bundle is
    the strongest evidence we have that no duplication is occurring. If a
    second copy ever appears, the cell would silently switch to `'unknown'`
    — visible regression, easy to diagnose. Acceptable.
  - The `'unknown'` fallback drops *all* debug signal for an unrecognised
    backend. A future maintainer might prefer
    `'unknown (' + storage.constructor.name + ')'` so prod gives at least a
    minified hint. Left as-is — the current behaviour is the cleaner
    "force a code change when a new impl is added" signal, and reverting to
    `constructor.name` for the fallback re-introduces minification noise in
    exactly the case where we'd want a clear answer.
  - No unit test exercises the `'unknown'` branch. Adding one would be
    artificial today (no second implementation exists). If/when an OPFS or
    other backend lands, that new impl's ticket should add a branch and the
    e2e for that mode should assert the new label.

### Edge cases / regressions / interactions

- `null` storage (node not started yet) — helper returns `null`; the
  Svelte template renders `'—'` (`Diagnostics.svelte:223`). Unchanged from
  before.
- The Diagnostics page renders `state.storage.backend ?? '—'`, so the
  string-or-null contract is preserved end-to-end.
- No other tests touched this cell — verified via `grep` for
  `diag-storage-backend` and `storage.backend`.

### Lint / tests / typecheck

- `yarn typecheck` — pass (exit 0).
- `yarn test:e2e e2e/solo/diagnostics.spec.ts` — 1 passed (17.7 s
  wall-clock, includes prod build + reference-peer mesh spawn).
- No separate `lint` script exists in `packages/reference-app-web/package.json`.

### Docs

- `docs/architecture.md` and the broader `docs/` tree do not describe the
  Diagnostics "Storage backend" cell. The implement handoff did not edit
  docs, and on review the doc tree confirms there is nothing to update.

## Disposition

All review findings are minor and informational. No follow-up tickets
required.
