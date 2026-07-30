description: Every package's test-runner config file is now type-checked, so a setting the test runner has dropped fails the build instead of being silently ignored — closing a gap that once hid a broken setting for an entire major-version upgrade.
files: packages/cadre-cli/tsconfig.typecheck.json, packages/cadre-core/tsconfig.typecheck.json, packages/cadre-host/tsconfig.typecheck.json, packages/cadre-provider/tsconfig.typecheck.json, packages/cadre-provider/package.json, packages/quereus-plugin-sereus/tsconfig.typecheck.json, packages/strand-proto/tsconfig.typecheck.json, packages/strand-proto/package.json, docs/STATUS.md
---

# Type-check every package's `vitest.config.ts` — complete

## What landed

Vitest never type-checks its own config, so an option the installed Vitest no longer
recognizes sits in the file doing nothing. That bit once already: `test.poolOptions.forks.
singleFork` was removed in Vitest 4, `integration-tests` kept it, and its network-binding
scenarios ran in parallel for a whole major version. `integration-tests` was fixed at the
time; this ticket closed the remaining six packages.

- `cadre-cli`, `cadre-core`, `quereus-plugin-sereus` — added `vitest.config.ts` to the
  existing `tsconfig.typecheck.json` `include`; each already had a wide-enough `rootDir`.
- `cadre-host` — same, plus a `rootDir: "."` override it was missing (it inherited
  `rootDir: "src"` from the base config, which would have rejected a package-root file).
- `cadre-provider`, `strand-proto` — new `tsconfig.typecheck.json` each, with the
  `typecheck` script repointed at it. Both previously type-checked through
  `tsconfig.build.json`, which is also what `yarn build` emits from; widening that file
  would have moved where the real build looks for sources.
- `docs/STATUS.md` → "Type-check coverage" describes the invariant and why it exists.

`reference-app-rn` and `reference-app-web` needed nothing — their `typecheck` scripts run
against the package's main `tsconfig.json`, whose `include` already matches the config file.
`reference-app-ns` has no `vitest.config.ts` at all.

## Review findings

### Verified — the change actually does what it claims

The implement pass validated only that `typecheck` stayed **green**, which does not prove the
config file entered the TypeScript program at all. Verified properly by injecting an unknown
key into each `vitest.config.ts` and confirming the type checker rejects it:

- All **nine** packages that have a `vitest.config.ts` — the six this ticket touched plus
  `integration-tests`, `reference-app-rn`, `reference-app-web` — report
  `TS2769: … 'bogusOptionXyz' does not exist in type 'InlineConfig'`. The `docs/STATUS.md`
  claim about the two app packages being already-covered is true, not assumed.
- Root `yarn typecheck` fails end-to-end (exit 1) with one config poisoned, so the gate — not
  just the per-package script — actually catches it.
- Nested project configs are covered too: a key inside
  `quereus-plugin-sereus`'s `test.projects[].test` is rejected against `ProjectConfig`. This
  matters because the `poolOptions` precedent lived nested, not at the top level.
- All injected edits were reverted; working tree confirmed clean afterwards.

### Verified — the `cadre-provider` test exclusion is justified, not assumed

The implement handoff asserted `cadre-provider`'s tests "carry the same kind of type drift" as
`cadre-core`/`cadre-host` without measuring it. Measured: 4 real errors across
`container-seed-endpoint.test.ts` and `orchestrator-port-leak.test.ts` (`TS2352` casting
`undefined`, `TS2493` indexing an empty tuple). The exclusion is warranted and the
`docs/STATUS.md` sentence about it is accurate.

### Fixed in this pass (minor)

- **`docs/STATUS.md` said "validates all 9" workspaces.** There are ten now —
  `reference-app-ns` landed since that line was written and does have a `typecheck` script.
  Corrected.
- **The new invariant bullet was scoped as "every non-Svelte-app package".** Wrong qualifier
  in both directions: `reference-app-web` *is* a Svelte app and *is* covered, and
  `reference-app-ns` is excluded not for being Svelte but for having no `vitest.config.ts`.
  Restated as "every package that has a `vitest.config.ts`", with `reference-app-ns` named
  explicitly so a reader can tell coverage from absence.
- **`docs/STATUS.md` pointed at a fix ticket that does not exist.**
  `widen-typecheck-cadre-core-host-tests` is referenced as the tracking ticket for the
  excluded test files but is on no board and in no archive. Repointed at the real ticket
  filed below.
- Recorded the injection-based verification in `docs/STATUS.md` so the next person does not
  have to re-derive that green ≠ covered.

### Filed as new tickets (major)

- **`backlog/debt-guard-vitest-config-typechecked`** — nothing *enforces* the invariant. It
  survives on nine hand-edited config files and a docs paragraph; a new package, a `typecheck`
  script repointed back at `tsconfig.build.json`, or a trimmed `include` all regress it while
  `yarn typecheck` stays green. `reference-app-ns` is the concrete near-term case: it gains a
  `vitest.config.ts` when `debt-ns-unit-test-harness` lands. The repo already has the right
  pattern to copy (`scripts/check-dep-ranges.mjs` + `node --test`, wired into root
  `yarn test`).
- **`backlog/debt-widen-typecheck-to-test-files`** — the work `docs/STATUS.md` claimed was
  tracked but was not. `cadre-core`, `cadre-host` and `cadre-provider` test files are checked
  by nothing at all (Vitest does not type-check; `tsc` never sees them). Ticket carries the
  four measured `cadre-provider` errors verbatim and a reproduction command.

### Recorded as tripwires, not tickets

- **`cadre-provider`'s exclude is directory-shaped (`src/**/__tests__/**`) where the old
  `tsconfig.build.json` was filename-shaped (`**/*.test.ts`).** Identical today — every test
  lives under a `__tests__` directory, which is also all vitest's `include` matches. Parked as
  a `NOTE:` comment in `packages/cadre-provider/tsconfig.typecheck.json` at the exclude.
- **Seven near-identical `tsconfig.typecheck.json` files with no shared base config.** Not new
  debt — each package's `tsconfig.json` is hand-duplicated the same way, so this is consistent
  with existing practice. Parked as a bullet in `docs/STATUS.md` → "Type-check coverage",
  naming the trigger: the first time one compiler option has to change across all of them.

### Checked and clean — nothing found

- **Build safety.** `cadre-provider` and `strand-proto` still `build` from their untouched
  `tsconfig.build.json`; the new `rootDir: "."` widening lives only in `noEmit` programs, so
  it cannot move emit output.
- **Scope creep into test files.** Neither source-only package (`cadre-host`,
  `cadre-provider`) pulled test files into its program — their `include` lists `src`
  explicitly rather than `.`.
- **Formatting conventions.** `quereus-plugin-sereus`'s tabs preserved; the two new files use
  2-space indentation matching their sibling configs.
- **Documentation sweep.** Every file mentioning `tsconfig.build.json` / `tsconfig.typecheck.
  json` was read (`docs/STATUS.md`, `packages/quereus-plugin-sereus/README.md`). Only
  `docs/STATUS.md` needed changes; the README describes the `build` path only, still accurate.

### Gates

| gate | result |
| --- | --- |
| `yarn lint` | exit 0 |
| `yarn typecheck` (root, all 10 workspaces) | exit 0 |
| `cadre-provider` tests | 15 files, 97/97 pass |
| `strand-proto` tests | 3 files, 25/25 pass |
| `cadre-cli` tests | 8 files, 99/99 pass |
| `cadre-host` tests | 57 files, 465 pass / 4 skipped |
| `quereus-plugin-sereus` tests | 7 files, 68 pass / 1 todo |
| `cadre-core` tests | blocked before running — see below |
| `yarn dep-check` | exit 1 — pre-existing, see below |
| `integration-tests` | not run: real-network suite, ~370 s sequential, outside this ticket's blast radius |

Two red states, both recorded in `tickets/.pre-existing-error.md`, neither caused by this
diff (which touches no runtime source):

- **`yarn dep-check` exits 1.** `packages/reference-app-web/test/node-local-slots.spec.ts`
  imports `@libp2p/peer-id` without that package being declared in the workspace manifest;
  knip's dependency rules are `error`-level. Introduced by `web-durable-node-local-stores-tests`
  (`aca9c7d`, an ancestor of this ticket's implement commit). `docs/STATUS.md` →
  "Dependency-check coverage" still claims the gate exits 0 — stale, flagged for the fixer.
- **`cadre-core` tests never start**, stopped by the stale-build guard: the sibling
  `../quereus` repo has uncommitted source edits newer than its `dist`. That is the guard
  doing its job, not a defect, and rebuilding another repo's in-flight work is not this
  ticket's to do.
