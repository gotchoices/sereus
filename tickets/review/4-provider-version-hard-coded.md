description: The hosting-service program used to report its version as 0.0.1 whatever release was installed; it now reads the installed package's version, and cadre-host reads its own version in one place instead of three.
files: packages/cadre-provider/src/package-version.ts, packages/cadre-provider/src/bin/provider.ts, packages/cadre-provider/src/server/routes.ts, packages/cadre-host/src/package-version.ts, packages/cadre-host/src/bin/host.ts, packages/cadre-host/src/installer/index.ts, packages/cadre-host/src/server/routes/status.ts, .release-notes.pending.md
difficulty: easy
----
# cadre-provider version read from package.json; cadre-host's three readers merged

Follow-up to GitHub issue gotchoices/sereus#35 (cadre-cli's `--version` was stale; fixed there by reading `package.json` at runtime). `bumpp --recursive` only rewrites `package.json`, so any version literal in source goes stale.

## What changed

- New `src/package-version.ts` in both cadre-provider and cadre-host exporting `packageVersion`, read with `createRequire(import.meta.url)('../package.json')` — the cadre-cli pattern. Both packages compile `rootDir: src` → `outDir: dist`, so the module is one level below `package.json` under vitest (`src/`) and when built (`dist/`).
- cadre-provider: `bin/provider.ts` `.version(packageVersion)`; `server/routes.ts` `GET <basePath>/status` replies `version: packageVersion` (was `'0.0.1'` in both).
- cadre-host: removed the three private `readPackageVersion` functions (`bin/host.ts`, `installer/index.ts`, `server/routes/status.ts`) and their now-unused imports; all use `packageVersion`. The `'0.0.0-unknown'` fallback is gone — a missing `package.json` now throws at module load (same as cadre-cli; npm always publishes `package.json`).
- Release-notes bullet added under a new short "cadre-provider" section in `.release-notes.pending.md`.

## Validation done

- Built both packages; `node packages/cadre-provider/dist/bin/provider.js --version` and `node packages/cadre-host/dist/bin/host.js --version` both print `1.14.0`, matching their `package.json`.
- `yarn lint` exit 0.
- cadre-provider tests: 237 passed. cadre-host tests: 442 passed, 4 skipped (pre-existing skips). The host smoke test (`src/__tests__/cli.smoke.test.ts`) asserting the version is not `0.0.0-unknown` still passes.

## Tests added

None — per the ticket, verified by running the built CLIs (cadre-cli's precedent); no existing test asserted `'0.0.1'`.

## For the reviewer

- The provider `/status` version was not exercised over HTTP in this run; it is the same constant as `--version`.
- Edited files are CRLF; edits preserved that. The two new files were also written CRLF.
