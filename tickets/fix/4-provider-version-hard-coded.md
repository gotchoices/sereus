description: The hosting-service command line reports its version as 0.0.1 whatever release is installed, the same mistake GitHub issue 35 reported for the cadre command line, which is now fixed there.
files: packages/cadre-provider/src/bin/provider.ts (`.version('0.0.1')`), packages/cadre-cli/src/bin/cadre.ts (the fix for #35: `createRequire(import.meta.url)('../../package.json')`), packages/cadre-host/src/bin/host.ts and packages/cadre-host/src/installer/index.ts (two local `readPackageVersion` copies)
difficulty: easy
repro: static
----
# cadre-provider `--version` is hard-coded

GitHub issue gotchoices/sereus#35 reported `cadre --version` printing `0.7.1` on 1.14.0; it is fixed on master (`fix(cadre-cli): read cadre --version from package.json`) and listed in `.release-notes.pending.md`. The issue asked to check cadre-host and cadre-provider for the same pattern:

- cadre-host reads its `package.json` (`readPackageVersion` in `bin/host.ts`, with a second copy in `installer/index.ts`). Fine, though duplicated within the package.
- cadre-provider still has `.version('0.0.1')` in `src/bin/provider.ts`. Confirmed by reading; `bumpp --recursive` rewrites `package.json` files only, so this string never moves.

Expected: `cadre-provider --version` prints the installed package's version. Read it the way cadre-cli does (relative to `dist/bin/`), and fold cadre-host's two copies into one while there. Verify by running the built CLI; a test is optional (cadre-cli's choice for the same fix is the precedent). Add a line to `.release-notes.pending.md`.
