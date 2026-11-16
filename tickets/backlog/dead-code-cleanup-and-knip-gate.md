description: clean up the dead-code backlog surfaced by knip and decide whether to promote dead-code rules from warn to error
files: knip.ts, docs/STATUS.md, packages/cadre-provider/src/server/index.ts, packages/cadre-provider/src/service/index.ts, packages/cadre-host/src, packages/reference-app-web/src, packages/reference-app-rn
difficulty: easy
----

# Dead-code cleanup + optional knip dead-code gate

The `build-health-dep-check` ticket made `yarn dep-check` (knip) a real gate, but scoped it to
**dependency** drift only. knip's dead-code rules (`files`, `exports`, `types`, `nsExports`,
`nsTypes`, `enumMembers`, `duplicates`) are deliberately downgraded to `warn` in `knip.ts` so
they surface without blocking. A real backlog of dead code remains:

- **~15 unused files** — including two never-imported barrels
  `packages/cadre-provider/src/{server,service}/index.ts` (the package's own `index.ts` re-exports
  the leaf modules directly, bypassing these barrels), plus reference-app polyfills/maestro/
  test-fixture helpers and a `cadre-host/ui/svelte.config.js`.
- **~40 unused exports** and **~29 unused exported types**, concentrated in `cadre-host` (installer /
  service-host / UI state) and `reference-app-web` (`lib/*.svelte.ts`, diagnostics, ice-config).

Run `yarn dep-check` and read the `warn`-level output for the current, authoritative list.

## What this ticket should decide / do

- Triage each warn: genuinely dead → remove; legitimate public/library surface or framework-
  consumed → keep and (if it's a file/export knip can't see is used) teach `knip.ts` about it.
  Be careful with reference-app-web/-rn surface that is template/route/entry-consumed.
- After cleanup, decide whether to **promote the now-clean dead-code rules from `warn` to `error`**
  in `knip.ts` `rules` so regressions are caught. Only flip rules whose backlog is actually drained —
  app/library public surface that is intentionally exported should stay `warn` or be `ignore`d with
  rationale, not forced to `error`.

## Notes

- This is dead-code hygiene, not a correctness defect — the dep-check gate is green and correct
  without it. Keep changes mechanical and verify `yarn build` + `yarn typecheck` after removals
  (an "unused" export may be the only thing keeping a file in the build graph).

## Premise check

Read against the tree during the documentation rewrite; `yarn dep-check` was not run, so the counts above (about 15 files, 40 exports, 29 types) are unconfirmed and may have moved.

- **`docs/STATUS.md` in the `files:` line does not exist.** The dependency check is now described in `docs/contributing/gates.md` → "Dependency-check coverage", which names this ticket as the reason dead code only warns. That section is the document to update when rules are promoted.
- **The rules are still at `warn`.** `knip.ts` sets `files`, `exports`, `types`, `nsExports`, `nsTypes`, `enumMembers` and `duplicates` to `'warn'`.
- **The three files named above still exist:** `packages/cadre-provider/src/server/index.ts`, `packages/cadre-provider/src/service/index.ts` and `packages/cadre-host/ui/svelte.config.js`.
- **One more candidate.** `packages/cadre-core/src/arachnode-stub.ts` is exported from `index.ts` and constructed nowhere in `packages/*/src`. An export from a package entry is public surface to knip, so it will not appear in the warn list.
