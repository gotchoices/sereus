---
description: review the three follow-ups landed from the cadre-host-update-flow-hardening ticket
prereq:
files: packages/cadre-host/src/update/apply.ts, packages/cadre-host/src/update/manifest.ts, packages/cadre-host/src/update/index.ts, packages/cadre-host/src/update/__tests__/apply.test.ts, packages/cadre-host/src/update/__tests__/manifest.test.ts, packages/cadre-host/src/update/__tests__/update-service.integration.test.ts
---

Three independent hardening fixes for the cadre-host update flow. None changes the contract with callers; all three close real correctness/robustness gaps identified in the review of `6.4.2-cadre-host-update-flow`.

## What changed

### 1. `defaultNpmExecutor` no longer trips Node DEP0190

`apply.ts` previously called `spawn('npm', args, { shell: process.platform === 'win32' })`. That shape (args array + `shell: true`) emits `DEP0190` because shells concatenate args without escaping. On the next Node major it'll become an error.

Fix: split the spawn spec by platform via the new exported `buildNpmSpawnSpec(args)`:

- **win32** → returns `{ command: 'npm <quoted-args>', args: [], shell: true }`. Empty args means DEP0190 doesn't fire. Each arg is run through `quoteWindowsArg` (cmd.exe quoting — wraps args containing whitespace or shell metachars `[\s"&|<>^()%!]`, escapes embedded `"`, doubles trailing backslashes, refuses control chars).
- **posix** → returns `{ command: 'npm', args, shell: false }`. No shell needed because npm is a real executable on Linux/macOS.

Inputs are still gated by the signed-manifest path (regex-validated package + semver version), so injection surface is minimal; the quoting is defense in depth.

### 2. Stale `applyInProgress` is cleared on construction

If cadre-host is OOM-killed or the box loses power mid-apply, the persisted `update-state.json` keeps `applyInProgress` forever. Every subsequent `apply()` would reject with `apply_in_progress` until an operator hand-edits the JSON.

New private method `UpdateService.recoverInterruptedApply()` runs once in the constructor. If it finds an `applyInProgress` record, it clears the field and writes a `lastError: { code: 'apply_failed', message: 'previous apply (X → Y) was interrupted (cadre-host restarted before it completed); the install may or may not have succeeded — verify with npm ls -g', at: <now> }` so the UI banner surfaces the situation honestly. The npm install itself may or may not have landed — we don't try to guess; the operator confirms via `npm ls -g`.

### 3. Tighter manifest field validation

`isUpdateManifest` was a structural type-guard only — it would happily accept a signed-but-malformed payload that then exploded inside `compareVersions`. Added `assertManifestFieldsWellFormed` (called in `verifyManifest` immediately after the structural check) which enforces:

- `parseVersion(manifest.version)` must succeed → `manifest_invalid` otherwise
- `parseVersion(manifest.minPreviousVersion)` must succeed when present
- `manifest.publishedAt` must round-trip through `new Date(...).toISOString()` (catches malformed dates and non-canonical formats)
- `manifest.channels.npm.package` must match `/^(?:@[a-z0-9-_.]+\/)?[a-z0-9-_.]+$/` and be ≤ 214 chars

## How to verify

```
cd packages/cadre-host
yarn build:server                 # tsc clean
yarn test src/update/__tests__    # 46 tests, all green
yarn test                         # full cadre-host suite, 296 passed / 3 skipped
```

Manual checks (recommended for the reviewer):

- **DEP0190 silencer**: `node --trace-deprecation node_modules/.bin/vitest run src/update/__tests__/apply.test.ts` — the update path should no longer emit DEP0190. (Note: an unrelated DEP0190 still fires from `pidusage/lib/bin.js` in `orchestrator.test.ts`. That's an upstream dep issue, out of scope.)
- **Crash recovery**: write a hand-crafted `<dataDir>/update-state.json` containing `{ "version": 1, "applyInProgress": { "fromVersion": "0.6.0", "toVersion": "0.7.0", "startedAt": "..." } }`, start cadre-host, then `GET /update/state` — should show `applyInProgress: undefined` and `lastError.code === 'apply_failed'` with the "interrupted" message. The next `POST /update/apply` should not hit `apply_in_progress`.
- **Manifest validation**: sign a manifest with `version: "not-semver"` (use `signManifestForTesting` from a one-off node script) and feed it through `verifyManifest` — must throw `manifest_invalid` with a "not a valid semver" message. Same for `minPreviousVersion: "0.6"`, `publishedAt: "sometime last week"`, and `channels.npm.package: "BAD CHARS!"`.

## New / changed tests

- `apply.test.ts`: 4 new tests around `quoteWindowsArg` (safe args untouched, quoting for metachars, escape rules for embedded quotes + trailing backslashes, control-char rejection) and 2 around `buildNpmSpawnSpec` (Windows single-string vs posix passthrough). Note: the platform branches are exercised by temporarily mutating `process.platform` via `Object.defineProperty`. This is the standard vitest pattern for platform tests but does mean the test is sensitive to changes in how it's restored — the `try/finally` is required.
- `manifest.test.ts`: 4 new tests covering each field-level rejection (semver version, minPreviousVersion, ISO publishedAt, npm package name).
- `update-service.integration.test.ts`: 1 new test that seeds `applyInProgress`, constructs a new `UpdateService`, and asserts that (a) the marker is cleared with a clear `lastError`, and (b) a follow-up `apply()` proceeds past the `apply_in_progress` gate.

## Known gaps the reviewer should poke at

- **Quoting helper is exported.** `quoteWindowsArg` and `buildNpmSpawnSpec` are exported from `apply.ts` purely so the tests can exercise platform-specific branches without a child-process spawn. If the reviewer prefers them strictly private, fold the platform test into a single round-trip that calls the executor with a stubbed `spawn`. I picked the simpler-to-test shape on the assumption that the small surface increase is fine.
- **`buildNpmSpawnSpec` mutates `process.platform` in tests.** This is contained to the new tests but a parallel test that reads `process.platform` could race. The current suite is sequential per file so it's safe today; flag if you spot a parallel pattern that breaks.
- **No live npm spawn test.** I deliberately did not add a test that actually spawns `npm`. Such a test would require npm on the test machine, take real time, and write to the real global prefix. The injected-executor pattern already covers the contract; `defaultNpmExecutor` is exercised end-to-end only in production.
- **Recovery message is best-effort.** We can't tell whether the half-complete npm install actually landed — the message tells the operator to verify with `npm ls -g`. If you want richer recovery (e.g., re-running the install when `manifest.channels.npm.package@toVersion` isn't installed), that's a separate ticket; this one only unsticks the state file.
- **214-char package limit is the npm hard cap.** I did not enforce the soft 40-char scope/name caps because the regex already excludes everything else npm would refuse, and the soft caps belong to npm CLI input validation, not our trust gate.

## Out of scope (unchanged from the source ticket)

- The placeholder `PROD_KEY_BASE64` in `release-key.ts` — release-operator's responsibility, tracked separately.
- The standalone-binary apply path — separate ticket.
