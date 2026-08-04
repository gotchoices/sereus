----
description: A release-time script now installs our packages the way a customer would — from real tarballs into a throwaway project — and runs a single-node scenario against them. It fails on purpose today, because installing our library from the registry is genuinely broken.
files: scripts/smoke-published-install.mjs, scripts/lib/published-smoke-support.mjs, scripts/lib/published-smoke-scenario.mjs, scripts/smoke-published-install.test.mjs, package.json, docs/STATUS.md, test-harness/build-freshness.ts, packages/cadre-core/test/control-database-solo.spec.ts
----

# What shipped

`yarn smoke:published` packs every `pub:*` workspace, installs the tarballs plus registry
dependencies into a scratch project under the OS temp dir with **npm**, prints a resolved-version
report, then runs a port of the cadre-of-one control-DB spec against that install.

- **`scripts/smoke-published-install.mjs`** — orchestration and reporting (264 lines).
- **`scripts/lib/published-smoke-support.mjs`** — everything that is a pure function of the repo or
  of an installed `node_modules` tree: flag parsing, the publishable set, declared ranges, the
  resolution walk, nested-copy detection, tarball provenance, build staleness (248 lines, added in
  review).
- **`scripts/smoke-published-install.test.mjs`** — 22 `node --test` cases pinning each of those in
  both directions against fixtures (286 lines, added in review).
- **`scripts/lib/published-smoke-scenario.mjs`** — the scenario body, copied into the scratch project
  and run by `node`; a port of `packages/cadre-core/test/control-database-solo.spec.ts` onto
  `node:assert/strict`, because the scratch project has neither vitest nor `src` access.
- **`package.json`** — `smoke:published` (not in `yarn test`: needs the network, ~40 s) and
  `test:published-smoke-support` (in `yarn test`: fixtures only, under a second).
- **`docs/STATUS.md`** — section "Installing what a customer installs — `yarn smoke:published`
  (a release step, not a test)".

## It fails, and that is the correct result

```
yarn smoke:published --skip-build
```

ends with `ERR_MODULE_NOT_FOUND: Cannot find package 'chai'`, imported from
`@optimystic/db-p2p/dist/src/testing/raw-storage-conformance.js` — the upstream defect recorded in
`tickets/blocked/optimystic-testing-barrel-breaks-consumer-install`. **Do not install `chai` into the
scratch project to make this green**; that hides the exact defect the gate exists to catch. A green
run is only expected once that blocked ticket is resolved. A failing run always leaves the scratch
project in place and prints its path.

# Review findings

Implement-stage diff read first, before the handoff summary. `yarn smoke:published --skip-build` run
end to end (reproduced the `chai` failure exactly as described), `yarn lint` clean, and the three
root check suites plus the source spec re-run. Findings by category:

## Fixed in this pass

- **The script had no test file, against an established convention.** Every other gate script in
  `scripts/` has a sibling `<name>.test.mjs` wired into `yarn test` (`check-dep-ranges`,
  `check-vitest-typecheck-coverage`, `check-test-file-typecheck-coverage`); this one had none. That
  is the root cause of two of the three gaps the handoff listed as unproven. Split the pure logic
  into `scripts/lib/published-smoke-support.mjs` and added 22 cases covering it. Both previously
  theoretical guards are now pinned in the *failing* direction — the provenance check rejects a
  registry fallback and an absent lockfile entry, the resolution walk finds a nested copy over the
  hoisted one — and each was additionally exercised against the real scratch install from the live
  run, not only fixtures.
- **`--skip-build` could pack a stale `dist` and print `PASSED` for the previous build.** `pack` does
  not build, so the documented fast path could smoke-test code that is not in the working tree — the
  same false green `test-harness/build-freshness.ts` exists to prevent for the suites. `--skip-build`
  now refuses when any publishable package's `dist` is missing or older than its `src`. Verified end
  to end by bumping one source file's mtime forward: the run stopped before packing with
  `@serfab/cadre-core: dist/ is older than src/` (mtime restored afterwards).
- **`declaredRange` took the first workspace that mentioned a dependency and ignored the rest.**
  `@libp2p/websockets` is a real dependency of `@serfab/quereus-plugin-sereus` and a dev dependency of
  `@serfab/cadre-core` — the scenario needs the latter, but the range came from the former by
  iteration order alone. Now every workspace is consulted (both dependency fields) and a disagreement
  is a loud error, since the scratch project installs exactly one copy and there is no right answer
  to pick silently.
- **Unknown flags were silently ignored.** `--skipbuild` would quietly start a full monorepo build the
  caller did not ask for. Flags are now validated and a typo exits 1 before anything is packed.
- **The report was buried.** A run printed 981 lines, ~900 of them `yarn pack`'s per-file archive
  listing across six workspaces, for a script whose entire value is a readable report. Pack output is
  now captured (it takes under a second, so no idle-timer risk) and echoed only if pack fails; the
  same run is 67 lines. `yarn build` still streams.
- **The spec/port drift note pointed only one way.** The handoff said "both files carry a comment
  saying to change them together" — only the port did. Someone editing
  `control-database-solo.spec.ts` had no way to learn the port existed. Added the back-pointer there.

## Filed as separate work

- **`blocked/publish-deprecated-strand-proto-decision`** — `@serfab/strand-proto` is called deprecated
  in `AGENTS.md`, `eslint.config.mjs` and `docs/STATUS.md`, nothing in the repo depends on it, and yet
  `yarn pub` still publishes it — so the new gate now packs and installs it every release run. Keep
  publishing it or stop is a call only a human can make (there may be external consumers this repo
  cannot see), which is why it is in `blocked/` rather than `backlog/`.
- **`backlog/debt-tooling-scripts-unlinted-and-unchecked`** — already claimed `scripts/`, so an arm was
  appended rather than a new ticket filed: root `scripts/` is now 2,854 lines (measured with
  `wc -l scripts/*.mjs scripts/*.js scripts/lib/*.mjs`), up from the 1,768 that ticket recorded on
  2026-08-02, and all four new files are unlinted and untyped like the rest of the tree.

## Parked as tripwires, not tickets

- **The staleness rule now exists in two places.** `test-harness/build-freshness.ts` is TypeScript with
  no build step (vitest transpiles it as a global-setup import), so a plain node script cannot import
  it; the newest-src-versus-newest-output rule is re-derived in the support module. `NOTE:` comments at
  both sites say to change them together, and name "a third caller" as the point to give the module a
  build.
- **The POSIX branch of the process shim has never run.** `NOTE:` at `run()` in the smoke script,
  naming both places to expect the first failure (`shell: false`, and the backslash normalisation in
  the `file:` spec).
- **Nested-copy detection is one level deep.** `NOTE:` on `nestedCopies`, saying to widen it to walk
  the installed tree if a duplicate ever hides below a publishable package's direct dependencies.

## Checked and found nothing

- **The port versus the spec.** Compared assertion by assertion against
  `control-database-solo.spec.ts` and `control-db-node-helpers.ts`. Same three cases, same assertions,
  same operation labels; the only differences are the deliberate ones the port documents (`within`
  re-derived on `Promise.race` because cadre-core does not export `withTimeout`, `node:assert/strict`
  instead of vitest's `expect`, `util.inspect` instead of `JSON.stringify` so `Set` comparisons print
  distinguishably). The spec itself still passes — 3/3.
- **Error and resource handling in the scenario.** Import failure, hang and assertion failure each
  produce a distinct diagnosis; both node lifecycles stop in `finally`; the deadline timer is cleared
  on both paths; the explicit `process.exit` is justified in a comment (libp2p keeps handles alive
  after `stop()`).
- **Docs.** Every file the change touches, plus the ones it should have touched, was read against the
  new reality. `docs/STATUS.md` needed the four new facts above (staleness refusal, flag validation,
  the unit tests, and what genuinely remains unproven); nothing else in `docs/` or `AGENTS.md`
  describes this gate. `knip.ts` already treats `scripts/*.mjs` as entry points and ignores the tree,
  so the new files need no configuration.

## Still unproven, deliberately

The orchestration that only a real green run can exercise: the on-success `cleanup()`, the final
`PASSED` line, and the `yarn build` branch. Every verification run — the implementer's and this
review's — ended at the `chai` import failure, which is the point. These are now the only untested
paths, and they are named as such in `docs/STATUS.md`; the first successful run after the upstream
blocker clears will cover them.

`yarn test` was not run whole: the monorepo suite is far past the runnable window here, and the diff
touches no package source (one comment in `control-database-solo.spec.ts`, one in
`test-harness/build-freshness.ts`). What was run: `yarn lint`, `yarn test:published-smoke-support`
(22 pass), `yarn test:dep-ranges` (9), `yarn test:vitest-typecheck-coverage` (16),
`yarn test:test-file-typecheck-coverage` (30), and `control-database-solo.spec.ts` (3). No
pre-existing failures surfaced.
