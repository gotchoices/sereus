description: The hosting-service program used to report its version as 0.0.1 whatever release was installed; it now reads the installed package's version, and cadre-host reads its own version in one place instead of three.
files: packages/cadre-provider/src/package-version.ts, packages/cadre-provider/src/bin/provider.ts, packages/cadre-provider/src/server/routes.ts, packages/cadre-host/src/package-version.ts, packages/cadre-host/src/bin/host.ts, packages/cadre-host/src/installer/index.ts, packages/cadre-host/src/server/routes/status.ts, packages/cadre-host/src/__tests__/cli.smoke.test.ts, .release-notes.pending.md
difficulty: easy
----
# cadre-provider version read from package.json; cadre-host's three readers merged

Follow-up to GitHub issue gotchoices/sereus#35. `bumpp --recursive` rewrites only `package.json`, so a version literal in source goes stale.

## What changed

- `src/package-version.ts` in cadre-provider and cadre-host exports `packageVersion`, read with `createRequire(import.meta.url)('../package.json')` (the cadre-cli pattern). The module sits one level below `package.json` both in `src/` (vitest) and `dist/` (built).
- cadre-provider: `--version` and `GET <basePath>/status` use `packageVersion` (both were `'0.0.1'`).
- cadre-host: the three private `readPackageVersion` functions (`bin/host.ts`, `installer/index.ts`, `server/routes/status.ts`) are gone; all use `packageVersion`. The `'0.0.0-unknown'` fallback is gone too, so a missing `package.json` throws at module load, matching cadre-cli.
- Release-notes bullet under a "cadre-provider" section in `.release-notes.pending.md`.

## Review findings

Read the diff of `ticket(implement): provider-version-hard-coded` before the handoff.

- **Correctness:** both new modules resolve `../package.json` correctly from `src/` and `dist/` (`rootDir: src`, `outDir: dist` in both packages). No bundler is involved in either package, and no Dockerfile in the repo ships cadre-provider's `dist` without `package.json`. Grepped `packages/`, `docs/` and `ops/` for leftover `'0.0.1'` / `'0.0.0-unknown'` literals and other `.version(` calls: none left except one stale comment (below).
- **Provider `/status` over HTTP** (the implementer left this open): `auth-scope-enforcement.test.ts` already injects `GET /api/v1/status`, so the route module loads and serves with `packageVersion` under vitest. I added no assertion on the value; it is the same constant that `--version` prints.
- **Minor, fixed:** `server/routes/status.ts` was left with a blank line at the top of `registerStatusRoute` where the removed `const version` had been. Removed it.
- **Minor, fixed:** a comment in `cli.smoke.test.ts` said the test "catches the version falling back to '0.0.0-unknown'", and that fallback no longer exists. It now says the test catches `dist/package-version.js` resolving the wrong path.
- **Error handling:** dropping the swallow-all `catch` fits the project rule against eating exceptions. A missing `package.json` is a broken install and should fail loudly.
- **DRY:** the one-line module now exists in cadre-cli, cadre-host and cadre-provider. Sharing it across packages would need a common dependency for a single line that resolves relative to its own package, so I left the copies. Not filed.
- **Tests:** none added and none cut. The existing host smoke test and `cli-reference.test.ts` already pin `--version` against `package.json`. cadre-provider has no equivalent, and a test for a constant does not meet the bar.
- **Docs:** `docs/cadre-host.md`, `docs/architecture.md` and the package READMEs don't describe how the version is read. Nothing to update.
- **Validation:** `yarn lint` exit 0. cadre-provider tests 237 passed. cadre-host tests 442 passed, 4 skipped (the skips were already there).
- **Tripwires:** none.
