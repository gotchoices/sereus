description: The hosting-service program reports its version as 0.0.1 no matter which release is installed, both on the command line and from its status endpoint; read it from the installed package instead, and make cadre-host read its version one way instead of three.
files: packages/cadre-provider/src/bin/provider.ts, packages/cadre-provider/src/server/routes.ts, packages/cadre-host/src/bin/host.ts, packages/cadre-host/src/installer/index.ts, packages/cadre-host/src/server/routes/status.ts, packages/cadre-cli/src/bin/cadre.ts (precedent), .release-notes.pending.md
difficulty: easy
repro: static
----
# cadre-provider version is hard-coded; cadre-host reads it three ways

GitHub issue gotchoices/sereus#35 (`cadre --version` printed a stale value) is fixed in cadre-cli by reading `package.json` at runtime: `createRequire(import.meta.url)('../../package.json')` in `packages/cadre-cli/src/bin/cadre.ts`. The issue asked to check the other two programs. `bumpp --recursive` rewrites `package.json` files only, so any version string in source never moves.

## Findings (read, not run)

cadre-provider hard-codes `'0.0.1'` in two places:
- `src/bin/provider.ts:31` — `.version('0.0.1')`, so `cadre-provider --version` is wrong.
- `src/server/routes.ts:87` — `GET <basePath>/status` replies `version: '0.0.1'`. Same defect, same fix; not named in the original ticket.

No test in either package asserts on `'0.0.1'`.

cadre-host reads its `package.json` correctly but has three private `readPackageVersion` copies, each with its own relative path:
- `src/bin/host.ts:435` (used for `.version(...)` and the updater's `currentVersion`)
- `src/installer/index.ts:250`
- `src/server/routes/status.ts:80` (caches, and tries two paths so it works from `src/` under vitest and from `dist/`)

## Fix

Both packages compile with `rootDir: src` → `outDir: dist`, so a module at the package's `src/` root sits one level below `package.json` both as `src/package-version.ts` (vitest) and `dist/package-version.js` (built). One path, `'../package.json'`, works in both; no candidate list needed.

In each package add `src/package-version.ts` exporting the version, read the cadre-cli way:

```ts
import { createRequire } from 'node:module';

// src/package-version.ts and dist/package-version.js both sit one level below package.json.
export const packageVersion = (createRequire(import.meta.url)('../package.json') as { version: string }).version;
```

Reading at module load and throwing if `package.json` is missing is acceptable: `package.json` is always published with the package (`files` lists `dist`, and npm always includes `package.json`), and cadre-cli already does exactly this. cadre-host's `'0.0.0-unknown'` fallback then disappears; its smoke test (`src/__tests__/cli.smoke.test.ts:45`) checks the version does *not* fall back to that, which still holds.

## TODO

- Add `packages/cadre-provider/src/package-version.ts`; use it in `bin/provider.ts` (`.version(packageVersion)`) and `server/routes.ts` (status reply).
- Add `packages/cadre-host/src/package-version.ts`; replace the three `readPackageVersion` copies (host.ts, installer/index.ts, server/routes/status.ts) with it, and drop now-unused imports (`readFileSync`, `fileURLToPath`, `dirname`, `resolve`) where nothing else uses them.
- Build both packages (`yarn workspace @serfab/cadre-provider build`, `yarn workspace @serfab/cadre-host build`) and run `node packages/cadre-provider/dist/bin/provider.js --version` and `node packages/cadre-host/dist/bin/host.js --version`; both must print their `package.json` version.
- Run `yarn lint` and both packages' tests. No new test (cadre-cli's fix set the precedent of verifying by running the built CLI).
- Add a bullet to `.release-notes.pending.md`, e.g. "**`cadre-provider --version`** and its `/status` endpoint report the real version instead of `0.0.1` (#35)." Place it in a section that fits, or a short new cadre-provider section.
