description: The test suites only give valid results when optimystic and quereus are linked from sibling folders. Run against the published npm packages (what users actually install), 21 tests fail even though the code behaves correctly, so the suite can't be used to check a release against what ships.
files:
  - package.json (root `resolutions` linking `../optimystic` and `../quereus`)
  - test-harness/build-targets-spec.ts (asserts each optimystic dependency is `linked`)
  - test-harness/build-freshness.spec.ts (the node_modules-chain cases)
  - packages/quereus-plugin-sereus/src/cached-storage.ts (`instanceof MemoryRawStorage` / `CachedRawStorage`)
  - packages/cadre-core/vitest.config.ts, packages/integration-tests/vitest.config.ts
----

# The suite is only valid against a linked optimystic

## What happened

On 2026-09-23 sereus `6b238976` was checked in a throwaway worktree with the root `resolutions` removed, so `@optimystic/*` 1.4.0 and `@quereus/quereus` 4.19.4 came from npm. The worktree also needed `.yarnrc.yml` copied in by hand. It is gitignored, so without it a fresh checkout installs in Plug'n'Play mode and native builds fail; that is a separate problem, recorded below. Lint, build, typecheck, the 10 script tests and `smoke:published` passed. The workspace tests did not:

- **7 workspaces:** `build-targets.spec.ts` fails by design. It asserts optimystic is `linked` so the stale-build guard can watch it.
- **integration-tests:** the two `build-freshness.spec.ts` node_modules-chain cases fail, for the same reason.
- **cadre-core, 8 tests:** `cadre-node-control-node-options` (storage ×5), `strand-instance-manager-storage-ownership` ×2, `cadre-node-control-backfill` ×1. `wrapStorageWithCache` fails to recognise a `MemoryRawStorage` or `CachedRawStorage` the test created, so it wraps it.
- **integration-tests, 9 scenarios:** `control-write-degraded-cohort-member` ×6 and `control-cohort-edge-carries-data` ("the forced cohort was never consulted", spy call count 0), plus `control-stream-authz` and `relay-only-control-addr` (a stranger's connection is never torn down within 20 s).

## What is known

- Under vitest, `@optimystic/db-p2p` and `@optimystic/db-p2p/rn` give the test the same class (`MemoryRawStorage === MemoryRawStorage`). But `wrapStorageWithCache`, imported through `@serfab/quereus-plugin-sereus`, does not recognise that instance. So the plugin sees a different module instance of db-p2p than the test does.
- **In plain Node against the same install, the product is correct:** `wrapStorageWithCache(new MemoryRawStorage())` returns the same instance, and re-wrapping a `CachedRawStorage` returns it unchanged. `smoke:published` (packed tarballs, clean project) also passes.
- Adding `server.deps.inline` for the `@optimystic/*` packages to cadre-core's vitest config did **not** fix the 8 cadre-core failures. The duplication is likely in how vitest loads the workspace plugin (inlined through its real path, or externalized through the `node_modules/@serfab` symlink), not in db-p2p itself.
- The two connection-gating timeouts are **not proven** to come from this. They were checked against the linked tree instead (see below).

## Why it matters

The linked tree is optimystic's working copy, often with another agent's uncommitted edits in it. So a release is gated against code that is neither what it depends on nor what it ships. A suite that also runs against the published packages checks what users actually install.

## Do

1. Find where the second db-p2p instance comes from under vitest when deps are installed (vitest's `server.deps` inline/external handling of `@serfab/*` workspace symlinks, or `resolve.preserveSymlinks`). Fix it in config so the product and the tests share one module graph.
2. Make `build-targets.spec.ts` and the `build-freshness` node_modules-chain cases accept an installed dependency when the dependency isn't linked, rather than failing.
3. Add a documented way to run `yarn check` against the published packages (for example a script that makes the throwaway worktree). Whether it runs automatically before a release is the maintainer's call.
4. Separately: `.yarnrc.yml` is gitignored because it holds `npmAuthToken`, which also drops `nodeLinker: node-modules` from every fresh clone. Move the non-secret settings into a committed file, and keep the token in the user-level config or an environment variable.
