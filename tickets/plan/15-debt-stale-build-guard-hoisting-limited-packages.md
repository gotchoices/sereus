description: The check that stops tests from running against an out-of-date build cannot see the shared libraries used by the web reference app, so that app's tests can silently pass against stale code from a neighbouring project.
files: test-harness/build-freshness.ts, test-harness/build-targets.ts, packages/reference-app-web/test/global-setup.ts, packages/reference-app-web/package.json, packages/cadre-core/test/global-setup.ts, packages/integration-tests/test/global-setup.ts
difficulty: medium
---

# Stale-build guard can't see a package that keeps its own `node_modules`

## Background

Several test suites in this repo run *compiled* output of other packages rather
than their source. If someone edits one of those packages and forgets to build
it, the suite quietly exercises the previous build — a false pass (a change that
was never actually tested) or a false failure (a bug that was already fixed).

`test-harness/build-freshness.ts` exists to stop that: before a suite runs, it
compares each listed package's newest source timestamp against its compiled
entry point and fails the run up front, naming the build command to run.

Packages come from two places. Some are workspaces in this repository, found by
scanning `packages/`. Others are sibling checkouts (`../optimystic`,
`../quereus`) that reach `node_modules` as a symlink, courtesy of the repo
root's `resolutions`. The guard looks those second ones up **only in the
repository root's `node_modules`**.

## The problem

`packages/reference-app-web` declares `installConfig.hoistingLimits:
"workspaces"`, so its dependencies are installed into its *own*
`packages/reference-app-web/node_modules`, not the root's. Its copies of
`@optimystic/db-core`, `@optimystic/db-p2p`, `@optimystic/db-p2p-storage-web`
and `@quereus/quereus` are therefore invisible to the guard — and at least one
of them (`db-p2p-storage-web`) is not present at the root at all, so listing it
makes the guard report "not installed. Run: yarn install" forever instead of
checking anything.

That app now has a vitest suite that imports `@serfab/cadre-core` for its real
behaviour, and cadre-core in turn runs the compiled output of those sibling
packages. Its guard list is consequently a single entry (`@serfab/cadre-core`,
found by the workspace scan, which works fine), and it is the only guarded
package with no `build-targets.spec.ts` — that spec cross-checks a suite's list
against its own manifest, and here it would insist on exactly the entries the
guard cannot resolve.

Net effect: a stale sibling build cannot be caught for the web app's unit tests,
and the drift check that protects the *other* suites' lists is absent from this
one.

## Expected behaviour

- A `linked` guard target resolves through whichever `node_modules` actually
  serves the consuming package — its own directory first, then the parents up to
  the repo root — rather than the repo root alone.
- `packages/reference-app-web/test/global-setup.ts` can then list the sibling
  packages its suite really runs, and gain a `build-targets.spec.ts` like the
  other two guarded packages, so its list cannot rot silently either.
- The existing behaviour is preserved: a registry-installed copy (a real
  directory, not a symlink) is still skipped rather than judged, because its
  timestamps are packing artifacts.

## Related, worth folding in

`packages/reference-app-web/package.json` declares `"@serfab/cadre-core": "*"`
where every other package in the repo uses `workspace:^` or `workspace:*`. Both
resolve to the local workspace, but the tooling that recognises a
workspace dependency by its `workspace:` prefix — `test-harness/build-targets.ts`
and `scripts/check-dep-ranges.mjs` — cannot see this one, so it is exempt from
checks it should be subject to. Confirm nothing depends on the bare `*` (it may
have been chosen for the Vite/`hoistingLimits` setup) before changing it.
