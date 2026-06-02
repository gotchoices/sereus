----
description: add a real dependency-check tool (knip) plus per-package dep-check scripts so unused/missing/phantom deps are detected
prereq: build-health-typecheck-all-packages
files: package.json, packages/*/package.json
effort: medium
----

# Make `yarn dep-check` actually check dependencies

Root `dep-check` (package.json:26) runs `yarn workspaces foreach -A run dep-check`, but no package
defines a `dep-check` script and there is no knip/depcheck config in the repo. `yarn dep-check`
completes in ~0s and returns success, so unused, missing, and phantom (used-but-undeclared)
dependencies go undetected across all nine workspaces.

Verified: `git grep -E '"(knip|depcheck)'` matches nothing outside node_modules; `yarn dep-check`
prints "Done in 0s" and exits 0.

## Design decision: tool choice

- **knip (recommended)** — monorepo-aware, single root config, detects unused deps, unlisted/phantom
  deps, unused exports, and unused files in one pass. Understands Yarn workspaces. Richer than
  depcheck and DRYer (one config vs per-package).
- **depcheck** — per-package only, detects unused + missing deps but not unused exports/files, and
  needs invoking per workspace.

Recommend **knip**. It can be wired either as a single root `knip` run (preferred, one config
covering all workspaces) or, to fit the existing `yarn workspaces foreach -A run dep-check` fan-out,
as per-package `dep-check` scripts. Pick one and be consistent:

- **Option A (root-level, simplest):** add a root `knip.json`/`knip.ts` describing each workspace's
  entry points, add knip as a root devDependency, and change root `dep-check` (package.json:26) to
  `knip` (no foreach). Cleaner and faster; one config to maintain.
- **Option B (per-package):** keep the foreach, add a `dep-check` script to each package and a
  per-workspace knip config. More moving parts; only choose if the runner/CI expects per-package
  scripts.

Recommend Option A unless there's a reason to preserve the foreach contract. Document the choice.

## Expectations

- knip configured with correct entry points per workspace (bins, build outputs, vitest/playwright
  configs, vite configs, `scripts/*.mjs` build helpers) so it does not false-positive on legitimately
  used files/deps.
- The `resolutions` link: entries in root package.json (../optimystic, ../quereus) and `workspace:`/
  `*` internal deps must not be flagged as missing/unused — configure ignores as needed.
- expo / react-native (reference-app-rn) and svelte/vite (reference-app-web, cadre-host ui) have
  framework-implicit deps; add knip plugins or ignores so they aren't false-flagged.
- A clean `yarn dep-check` should exit 0. Where knip surfaces genuine findings, fix the easy/safe
  ones (remove truly-unused deps, add truly-missing ones); for anything ambiguous or risky, add a
  documented `ignore` entry rather than guessing, and list deferred findings in the review handoff.

## Cross-platform note

The `dep-check` command must run on Windows (PowerShell) and POSIX. Rely on knip's own config-driven
file discovery; do not pass shell globs (`**/*.ts`) as CLI args — PowerShell will not expand them.

## TODO

- [ ] Add knip as a root devDependency (`yarn add -D knip` at repo root).
- [ ] Author a root knip config covering all nine workspaces with correct entry points + ignores
      (Option A), or per-package configs + scripts (Option B). Document which.
- [ ] Wire `dep-check` (root script and/or per-package) to invoke knip.
- [ ] Run `yarn dep-check 2>&1 | tee /tmp/depcheck.log`; triage findings — fix safe ones, ignore
      (with comments) the ambiguous ones, and get the gate to exit 0.
- [ ] Confirm internal `workspace:`/`*` deps and the `resolutions` link: packages are not false-flagged.
- [ ] Update docs/STATUS.md (or the build-health doc) noting `yarn dep-check` is now real, and list
      any findings intentionally ignored/deferred.
- [ ] Produce a review/ handoff honest about remaining false-positive ignores and any unresolved findings.
