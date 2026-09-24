description: The test suite could only be run against working copies of two sibling projects on the developer's disk. It can now also run against the versions users download, via a new documented command.
architecture: docs/testing.md
files: test-harness/build-targets.ts, test-harness/build-targets-spec.ts, test-harness/build-freshness.spec.ts, scripts/check-published.mjs, scripts/check-published.test.mjs, scripts/lib/published-check-support.mjs, scripts/lib/run-command.mjs, scripts/smoke-published-install.mjs, package.json, docs/testing.md
----

# Let the suite run against the published dependency packages

## What landed

**Arm 1 — the assertions that hard-coded "linked".** Both sites now decide their expectation from the root manifest instead of assuming the `resolutions` block is there.

- `test-harness/build-targets.ts`: `linkedResolutions` is exported (it was private). Its doc comment says why: a suite's expectation for a dependency depends on the install shape in front of it.
- `test-harness/build-targets-spec.ts`: the `are checked against dependencies that were actually found` case branches. When the root manifest links the name it asserts `'linked'` exactly as before; when it does not, a new `expectInstalledFromRegistry` helper asserts both that `distBackedDependencies` omits the name (correct — a packed copy's mtimes cannot be judged) *and* that `resolveLinkedPackageFrom` reports `'not-linked'`, i.e. a real directory is installed there. The second half is what keeps the case from going vacuous: a misspelled name in `expectFound` still fails. The eight `expectFound` blocks are unchanged.
- `test-harness/build-freshness.spec.ts`: the two `node_modules chain, on this checkout` cases go through one `expectResolves(name, ...segments)` helper that builds the same either/or expectation. The `describe` doc comment says what the registry branch cannot observe — `not-linked` says a real directory was found first and nothing about *which* `node_modules` answered, so the walk itself is pinned only by the temp-directory fixture above it.

**Arm 2 — the command.** `yarn check:published` → `scripts/check-published.mjs`. It refuses a dirty tree (printing the differing paths; `--allow-dirty` overrides and says loudly that HEAD is still what gets checked), adds a detached worktree at HEAD under the OS temp dir, deletes the `resolutions` key from that worktree's root manifest and nothing else, runs `yarn install --no-immutable`, prints what every `@optimystic/*` and `@quereus/*` name resolved to (hoisted, then every workspace that resolved its own copy instead), runs `yarn build`, `yarn lint`, `yarn typecheck`, `yarn test` there, and removes the worktree. `--keep` retains it.

Removal unlinks every symlink and junction under the worktree first, then tries `git worktree remove --force`, then falls back to a `\\?\`-prefixed recursive delete plus `git worktree prune`.

Decisions live in `scripts/lib/published-check-support.mjs` and are unit-tested by `scripts/check-published.test.mjs` (`yarn test:published-check-support`, chained into root `yarn test`).

**One change beyond the ticket, flagged for review.** `scripts/smoke-published-install.mjs`'s `run()` — the Windows `.cmd`/shell spawn shim — was about to be copied verbatim into the new script, so it moved to `scripts/lib/run-command.mjs` and both scripts import it. `capture()` (trimmed stdout of a command expected to succeed) is new there, used by the new script for `git status --porcelain` and `git rev-parse`. The smoke script is otherwise untouched except for one relocated `NOTE:` about the win32-only backslash normalisation, which used to live in `run()`'s doc comment. `yarn test:published-smoke-support` is green (23/23) after the move. If a reviewer would rather the release gate stayed frozen, reverting is one function move back.

## Use cases worth exercising

**The de-linked branch of both arms.** This is the whole point of Arm 1, and it is the part a green main-tree run cannot see. To reproduce what was measured here without paying for the four gates: add a detached worktree at HEAD outside the repo, delete `resolutions` from its root `package.json`, `yarn install --no-immutable`, then run the nine affected spec files with `yarn exec vitest run` from the worktree root (default vitest config, no `globalSetup` — these specs need no `dist`). All nine must pass.

**The vacuity guard.** Misspell a name in any package's `expectFound` (say `@optimystic/db-corex`) and confirm the case fails in *both* install shapes — `'linked'` in the main tree, `'not-linked'` in a de-linked one. If it passes de-linked, the `resolveLinkedPackageFrom` half is not doing its job.

**The dirty-tree refusal.** `node scripts/check-published.mjs` on a dirty tree must exit 1, name the paths, and create no worktree (`git worktree list` unchanged). Verified.

**The Windows removal fallback.** `git worktree remove --force` on a deep `node_modules` tree fails with `Filename too long`, and the fallback must finish the job and leave `git worktree list` clean. Verified — it fired on the real run.

**The link removal.** `scripts/check-published.test.mjs` pins it in both directions against a fixture (the link goes, its target's file survives). This is the guard against the Windows data-loss incident recorded in `docs/testing.md` → "Scratch worktrees and clones"; it is worth re-reading rather than taking on trust.

## Tests added

| test | what it verifies |
| --- | --- |
| `scripts/check-published.test.mjs` → `delinkedManifest drops the whole resolutions key and nothing else` | the one edit the worktree differs by: `resolutions` gone, `workspaces`/`scripts`/`name` untouched, `link:` names reported separately from non-`link:` ones |
| … `delinkedManifest is a no-op report on a manifest with no resolutions` | no crash and empty reports on a manifest that has no such key |
| … `dirtyPaths` (2 cases) | modified / staged / untracked all count as dirty; an empty porcelain reads as clean |
| … `reportedSiblingNames covers the linked set plus sibling deps that were never linked` | the union rule behind the report's coverage |
| … `workspacePackages reads every packages/* manifest and skips directories without one` | the workspace scan the nested report walks |
| … `nestedSiblingCopies reports only a workspace resolving away from the hoisted copy` | the report's signal — a package with its own `node_modules` did not test the hoisted artifact |
| … `unlinkReparsePoints removes the link and leaves what it points at` | the documented Windows data-loss hazard, both directions |
| … `reparsePointsUnder does not descend into a link, so a cycle cannot hang it` | the walk terminates on a self-referential junction |
| … `parseFlags` (2 cases) + `the script exits non-zero on an unknown flag without adding a worktree` | a typo cannot silently check the wrong commit |

No test was added for Arm 1: the branch it introduces is exercised by the nine existing `build-targets` / `build-freshness` specs in both install shapes, and a test that faked a root manifest to drive the other branch would be testing `linkedResolutions`, which those nine already pin.

## What was run

Linked main tree, 2026-09-24:

- `yarn lint` — green (whole repo).
- `yarn dep-check` — green (knip's pre-existing unused-file/export noise, then `check-dep-ranges: all declared ranges admit their linked workspace version (10 linked package(s))`). None of the four new files is flagged.
- `yarn check:vitest-typecheck-coverage`, `yarn check:test-file-typecheck-coverage`, `yarn check:stale-build-guard-wiring` — green.
- Every root script test in the `yarn test` chain, run individually: 169 tests, 0 failures. That includes the new `test:published-check-support` (12) and `test:published-smoke-support` (23) after the `run()` move.
- `tsc --noEmit` over `test-harness/build-freshness.spec.ts` and `test-harness/build-targets-spec.ts` — clean.
- The nine affected spec files (`yarn exec vitest run`, root default config): **61 passed**.
- `node scripts/check-published.mjs` on the dirty tree: refused, exit 1, no worktree created.

De-linked worktree at HEAD `17e8cab2`, same day, driven by the new script's own helpers with the four gates replaced by the nine spec files:

- `delinkedManifest` de-linked 10 packages, dropped nothing else.
- `yarn install --no-immutable` resolved `@optimystic/*` 1.5.0 and `@quereus/quereus` 4.19.4 from the registry — the same versions the ticket's 2026-09-24 measurement saw. Install took 1m36s (fetch 2.5s off a warm cache; the rest was native builds). `cpu-features@0.0.10 couldn't be built successfully (exit code 1)` appeared and was correctly not treated as a failure.
- The resolved report printed all ten names and twelve nested copies across the three reference apps (each carries its own `@optimystic/db-core`, `db-p2p`, its own storage package and `@quereus/quereus`, because they declare `installConfig.hoistingLimits: "workspaces"`).
- The nine spec files: **61 passed** — this is the de-linked half of both arms, green.
- Removal: 9 links unlinked; `git worktree remove --force` failed with `Filename too long` exactly as the ticket predicted; the `\\?\` delete and `git worktree prune` finished it. `git worktree list` clean afterwards, `yarn.lock` in the main tree untouched.

## Known gaps — read these before reviewing

**`yarn check:published` has never been run end to end.** Two independent reasons, neither resolvable inside this ticket:

1. It refuses a dirty tree and builds from `HEAD`, and this ticket's changes are uncommitted until the runner commits. A run now would check the *previous* commit, where the three assertions still hard-code "linked" — it would fail for the reason this ticket exists to remove.
2. Its four gates (`build`, `lint`, `typecheck`, `test` over the whole monorepo including the integration suite) run far past the ten-minute wall-clock ceiling an agent can sit through.

So the worktree lifecycle, the install, the manifest strip, the report and the Windows removal are all verified against a real run; **the four gates inside the worktree are not**. The first person to run `yarn check:published` from a committed HEAD should expect surprises there and should treat whatever the `test` gate turns up as new information — the ticket's measurement did not cover the full `integration-tests` suite, nor the `cadre-cli`, `cadre-host`, `cadre-provider` or reference-app suites.

**`yarn typecheck` and `yarn test` could not be run in the main tree at all.** `../optimystic` has no `dist` in any of the packages this repo links (472 modified/untracked paths in its tree) and `../quereus` has `tickets/.in-progress` — its runner is working. Per `tickets/rules/sibling-repos.md` and `docs/testing.md` → "When it fires because a sibling's own runner is mid-ticket", building them is forbidden, so every sibling-dependent typecheck and suite here is blocked on the siblings' own builds. This is the documented mid-ticket state, not a test failure, so nothing was written to `tickets/.pre-existing-error.md`. What it means for review: the eight `build-targets.spec.ts` files were run through vitest directly (default config, no `globalSetup`) rather than through their own packages' `yarn test`, and `test-harness/build-freshness.spec.ts` likewise rather than through `@serfab/integration-tests`. The specs themselves need no `dist`; what went unexercised is the normal path that reaches them, which the stale-build guard blocks while a sibling is unbuilt. Re-run `yarn test` once the siblings are built.

**Worth noting as a property, not a gap:** the de-linked worktree does not depend on the siblings' build state at all — registry copies ship their own `dist` and `.d.ts`. `yarn check:published` is therefore runnable on this machine right now even though `yarn test` is not.

**The POSIX half of `scripts/lib/run-command.mjs` has still never executed**, as it never had in its previous home. The `shell: false` branch and the quoting it skips are unproven off Windows.

**`@optimystic/demo` reports `(not installed)`** in the de-linked report. It has a `resolutions` entry but nothing in this repo depends on it, so it is genuinely absent — correct, but a reader may read it as a problem. Left as is rather than filtering the report, because the alternative (hiding a name the root manifest names) is worse.

## Tripwires

- `scripts/lib/published-check-support.mjs` imports `findPackageDir` and `readJson` from `scripts/lib/published-smoke-support.mjs`. Both are generic (`node_modules` walk, JSON read) and duplicating them would be worse, but the module they live in is named for the other script. If a third script wants them, move them to a module of their own rather than growing the coupling. Recorded here only — no `NOTE:` at the site, since the import line says it plainly.
- `workspacePackages` in the same module re-derives the `packages/*` glob that `scripts/lib/typecheck-programs.mjs` already derives; a `NOTE:` at the site says both must be taught if `workspaces` ever grows a second root. Reaching into the typecheck lib for it would drag `typescript` into a script that has nothing to do with it.
