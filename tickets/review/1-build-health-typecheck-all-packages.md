description: Review the typecheck-coverage work — every TS package now defines a `typecheck` script so `yarn typecheck` validates all 9 workspaces (was 1 of 9). Verify coverage scope, config DRYness, and that documented gaps are honest.
prereq: build-health-typecheck-all-packages
files: package.json, packages/cadre-core/package.json, packages/cadre-cli/package.json, packages/cadre-cli/tsconfig.typecheck.json, packages/cadre-host/package.json, packages/cadre-provider/package.json, packages/integration-tests/package.json, packages/integration-tests/tsconfig.typecheck.json, packages/quereus-plugin-sereus/package.json, packages/quereus-plugin-sereus/tsconfig.typecheck.json, packages/strand-proto/package.json, packages/reference-app-rn/package.json, docs/STATUS.md, tickets/fix/widen-typecheck-cadre-core-host-tests.md
----

# Review: make `yarn typecheck` cover the whole monorepo

## What was done

Root `yarn typecheck` (`package.json:28`, `yarn workspaces foreach -A run typecheck`) previously ran a
`typecheck` script that existed only in `@serfab/reference-app-web` — the other 8 workspaces were
silently skipped. Every TS workspace now defines a `typecheck` script. **`yarn typecheck` exits 0 and
fans out to all 9 packages** (verified — see Validation below).

### Per-package scope chosen

| package | `typecheck` command | scope |
|---|---|---|
| cadre-cli | `tsc -p tsconfig.typecheck.json --noEmit` | source **+ tests** (`test/*.spec.ts`) |
| integration-tests | `tsc -p tsconfig.typecheck.json --noEmit` | all of `src` incl. `.integration.ts` |
| quereus-plugin-sereus | `tsc -p tsconfig.typecheck.json --noEmit` | source **+ tests** (`test/`, `test/e2e/`) |
| reference-app-rn | `tsc --noEmit -p tsconfig.json` | all `**/*.ts(x)` (expo base) |
| cadre-core | `tsc -p tsconfig.build.json --noEmit` | **shippable source only** (see gap) |
| cadre-host | `tsc -p tsconfig.build.json --noEmit` | **shippable source only** (see gap) |
| cadre-provider | `tsc -p tsconfig.build.json --noEmit` | shippable source only (no widened tests) |
| strand-proto | `tsc -p tsconfig.build.json --noEmit` | shippable source only (deprecated, by design) |
| reference-app-web | `tsc --noEmit` (unchanged) | source only (`.svelte` not checked) |

New files: `tsconfig.typecheck.json` in cadre-cli, integration-tests, quereus-plugin-sereus. Each is
DRY — `extends: "./tsconfig.json"`, `noEmit: true`, and (where tests live outside `src`) `rootDir: "."`
plus `include: ["src", "test"]`. No copied compiler options.

## Design decision & why two packages are narrow

The ticket's primary must-pass deliverable was shippable-source typecheck for all 9 (closes the
"1 of 9" bug with zero new failures). The second pass widened to test files **where green**. Two
packages had **pre-existing** type drift in test files (hidden because vitest never type-checks and
`tsconfig.build.json` excludes tests):

- **cadre-core** (3 errors): `StorageConfig.type` removed, libp2p `peerId`→`privateKey`,
  `CadreNodeConfig.privateKey` is `PrivateKey` not `Uint8Array`.
- **cadre-host** (8 errors): `NodePorts.admin` now required (3 fixtures), implicit-`any` params (4),
  `Array.at()` needs ES2022 lib (1).

These were left at shippable-source scope and the drift was filed as a follow-up fix ticket
`widen-typecheck-cadre-core-host-tests` (with exact file:line and fixes). This matches the ticket's
explicit guidance ("leave the narrow typecheck … document the remainder").

## Known gaps (intentionally not closed here)

- **cadre-core / cadre-host test files are NOT type-checked.** This is the biggest residual gap — see
  the follow-up fix ticket. The motivating regression class (test-file type drift) is still uncaught
  for these two until that lands.
- **cadre-provider `src/**/__tests__` are NOT type-checked** — `tsconfig.build.json` excludes them and
  no widened config was added. They were not verified to be green; a reviewer wanting full coverage
  should add a `tsconfig.typecheck.json` and check.
- **Svelte UI is NOT covered**: cadre-host `ui/**/*.svelte` and reference-app-web `.svelte` need
  `svelte-check` (a devDependency in both), not `tsc`. Out of scope; documented in `docs/STATUS.md`.
- **strand-proto** left source-only (deprecated per AGENTS.md).

## Validation performed

- `yarn typecheck` from repo root → **exit 0**, `Done in ~10s`.
- Each package run individually via `yarn workspace @serfab/<pkg> run typecheck` → all exit 0
  (cadre-core/cadre-host confirmed green at the narrowed build.json scope).
- Confirmed all 9 packages expose a `typecheck` script (listed in table above).
- Packages were already built (`dist/*.d.ts` present), which workspace `types` resolution requires —
  **note for reviewer:** `yarn typecheck` on a clean checkout (no `dist/`) for packages with
  `workspace:` deps will fail to resolve types until `yarn build` runs once. This pre-existed (build's
  own `tsc` has the same requirement) but is worth confirming acceptable for CI ordering
  (build-then-typecheck, or `yarn build` first).

## What a reviewer should poke at

- **Clean-checkout ordering**: does CI run `yarn build` before `yarn typecheck`? If typecheck is meant
  to run standalone, workspace type resolution against `dist/` is a trap.
- **Root-script recursion**: `foreach -A run typecheck` also matches the root `sereus-workspace`
  (which has a `typecheck` script = the foreach itself), so it runs one nested level. Harmless but
  wasteful; pre-existing, not introduced here. Consider `-A --exclude .` or filtering if it bothers.
- **integration-tests typecheck.json** is effectively the same coverage as its `build.json` (only
  `.integration.ts`, no `.spec`/`.test`); the separate config is for uniformity. Confirm that's wanted
  vs. just pointing at `build.json`.
- Spot-check that the new `tsconfig.typecheck.json` files don't accidentally widen *emit* (they all set
  `noEmit: true` and are only used with `--noEmit`).
- Verify the follow-up fix ticket's file:line references still match before relying on them.
