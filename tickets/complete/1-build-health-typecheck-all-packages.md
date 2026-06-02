description: Completed — every TS package now defines a `typecheck` script so root `yarn typecheck` validates all 9 workspaces (was 1 of 9). Reviewed: coverage scope, config DRYness, and documented gaps confirmed honest; one STATUS.md inaccuracy corrected inline.
files: package.json, packages/cadre-cli/package.json, packages/cadre-cli/tsconfig.typecheck.json, packages/cadre-core/package.json, packages/cadre-host/package.json, packages/cadre-provider/package.json, packages/integration-tests/package.json, packages/integration-tests/tsconfig.typecheck.json, packages/quereus-plugin-sereus/package.json, packages/quereus-plugin-sereus/tsconfig.typecheck.json, packages/reference-app-rn/package.json, packages/strand-proto/package.json, docs/STATUS.md, tickets/fix/widen-typecheck-cadre-core-host-tests.md
----

# Make `yarn typecheck` cover the whole monorepo

## Outcome

Root `yarn typecheck` (`package.json:28`, `yarn workspaces foreach -A run typecheck`) previously fanned
out to a `typecheck` script that existed only in `@serfab/reference-app-web` — the other 8 workspaces
were silently skipped (1 of 9 validated). Every TS workspace now defines a `typecheck` script and
`yarn typecheck` exits 0 across all 9.

### Per-package scope (verified)

| package | command | scope |
|---|---|---|
| cadre-cli | `tsc -p tsconfig.typecheck.json --noEmit` | source + tests (`test/*.spec.ts`) |
| integration-tests | `tsc -p tsconfig.typecheck.json --noEmit` | all of `src` (no spec/test files exist) |
| quereus-plugin-sereus | `tsc -p tsconfig.typecheck.json --noEmit` | source + tests (`test/`, `test/e2e/`) |
| reference-app-rn | `tsc --noEmit -p tsconfig.json` | all `**/*.ts(x)` (expo base) |
| cadre-core | `tsc -p tsconfig.build.json --noEmit` | shippable source only (tests deferred) |
| cadre-host | `tsc -p tsconfig.build.json --noEmit` | shippable source only (tests deferred) |
| cadre-provider | `tsc -p tsconfig.build.json --noEmit` | full — no test files exist |
| strand-proto | `tsc -p tsconfig.build.json --noEmit` | shippable source only (deprecated) |
| reference-app-web | `tsc --noEmit` (unchanged) | source only (`.svelte` not checked) |

cadre-core / cadre-host test files carry pre-existing type drift (invisible because vitest never
type-checks and `tsconfig.build.json` excludes tests). They were kept at shippable-source scope and
the drift was filed as follow-up fix ticket `widen-typecheck-cadre-core-host-tests`.

## Review findings

### What was checked

- **Diff read first, before the handoff.** Full implement diff (`4df1e1f`) reviewed: 3 new
  `tsconfig.typecheck.json` files, 8 `package.json` script additions, STATUS.md, and the follow-up
  fix ticket.
- **Coverage scope (claim "all 9 fan out").** Confirmed all 9 packages expose a `typecheck` script
  (enumerated each `package.json`). Ran `yarn typecheck` from root → **exit 0, ~10s**. Ran verbose
  fan-out — every workspace participates.
- **Config DRYness / no accidental emit.** All three new configs `extends` the package base, set
  `noEmit: true`, add `rootDir: "."` only where tests live outside `src` (cadre-cli,
  quereus-plugin-sereus). No copied compiler options. Invoked only with `--noEmit`. Clean.
- **integration-tests typecheck.json vs build.json.** Verified `src` contains **no** `*.spec.ts` /
  `*.test.ts` (only `*.integration.ts`), so the separate config gives identical coverage to
  `build.json` today but correctly future-proofs against added test files. Acceptable.
- **Narrowing of cadre-core / cadre-host justified?** Built temporary widened configs and ran `tsc`.
  Reproduced **exactly** the documented errors: cadre-core 3 (`StorageConfig.type` TS2353,
  libp2p `peerId` TS2353, `privateKey` Uint8Array→PrivateKey TS2322); cadre-host 8 (`NodePorts.admin`
  missing ×3, implicit-`any` ×4, `Array.at()` needs ES2022 ×1). The narrowing is real and necessary.
- **Follow-up fix ticket accuracy.** Every `file:line` reference in
  `widen-typecheck-cadre-core-host-tests.md` matches the live errors verbatim. Safe to rely on.

### What was found & done

- **MINOR (fixed inline):** STATUS.md and the handoff framed `cadre-provider` as having
  `src/**/__tests__` that "are not type-checked" — a phantom gap. cadre-provider has **zero** test
  files anywhere, so its `tsconfig.build.json` scope already covers everything. Corrected the STATUS.md
  wording to say so plainly (no widened config needed).
- **OBSERVED, out of scope (no action):** Root `foreach -A run typecheck` also matches the root
  `sereus-workspace` (whose `typecheck` *is* the foreach), so the whole set runs one nested level —
  ~2× wall-clock. This is a **pre-existing, repo-wide** pattern shared by `test`, `lint`, `dep-check`,
  and `doc` root scripts; not introduced here and not worth a single-script inconsistency. Left as-is.
- **DOCUMENTED GAPS confirmed honest:** Svelte UI (cadre-host `ui/`, reference-app-web `.svelte`)
  genuinely needs `svelte-check`, not `tsc` — correctly excluded and documented. `strand-proto`
  source-only by deprecation. cadre-core/cadre-host test drift correctly deferred to the fix ticket.
- **Clean-checkout note (acknowledged, not a defect):** typecheck against `workspace:` deps resolves
  types from `dist/`, so a clean checkout needs `yarn build` once first — same precondition `yarn build`
  already has. CI must order build-then-typecheck; flagged for whoever wires CI.

### Categories with nothing found

- **Type safety:** new configs introduce no `any`, no emit widening — clean.
- **DRY / modularity:** configs are minimal extends; no duplication.
- **Tests:** no source code changed (scripts + tsconfig only); the type-checker *is* the gate for this
  change and it passes. The monorepo integration/network test suite is long-running and untouched by
  this diff, so it was not exercised — running it would validate nothing about these script additions.
- **Lint:** no lint-relevant source changed; cadre-provider (and the edited files) have no lint script
  to run against `.json`/`.md`.

## Known residual gaps (carried forward)

- cadre-core / cadre-host **test files** remain unchecked until `widen-typecheck-cadre-core-host-tests`
  lands — this is the largest residual gap and the one closest to the motivating regression class.
- Svelte UI is not type-checked anywhere (needs `svelte-check` wiring) — tracked in STATUS.md.
