---
description: three independent hardening fixes for the cadre-host update flow (DEP0190 silencer, stale applyInProgress recovery, tighter manifest field validation)
files: packages/cadre-host/src/update/apply.ts, packages/cadre-host/src/update/manifest.ts, packages/cadre-host/src/update/index.ts, packages/cadre-host/src/update/__tests__/apply.test.ts, packages/cadre-host/src/update/__tests__/manifest.test.ts, packages/cadre-host/src/update/__tests__/update-service.integration.test.ts
---

## What landed

Three independent hardening fixes for the cadre-host update flow, all merged as `5e1a2aa ticket(implement): cadre-host-update-flow-hardening`:

1. **`defaultNpmExecutor` no longer trips Node DEP0190** — replaces `spawn('npm', args, { shell: process.platform === 'win32' })` with a platform-split spawn spec built by the new exported `buildNpmSpawnSpec(args)`. On Windows we pre-quote each arg with `quoteWindowsArg` (handles whitespace + cmd metachars + embedded quotes + trailing backslashes, rejects control chars) and pass a single command string with empty args + `shell: true`. On posix we spawn npm directly with `shell: false`.
2. **Stale `applyInProgress` is cleared on construction** — new private `UpdateService.recoverInterruptedApply()` runs once in the constructor, clears any persisted in-flight marker, and writes a `lastError: { code: 'apply_failed', message: '…interrupted… verify with npm ls -g', at: <now> }` so the UI banner surfaces the situation honestly.
3. **Tighter manifest field validation** — new `assertManifestFieldsWellFormed()` called inside `verifyManifest` enforces semver on `version` and `minPreviousVersion`, ISO-8601 round-trippability on `publishedAt`, and the npm package-naming regex (plus 214-char hard cap) on `channels.npm.package`.

All three close real correctness/robustness gaps identified in the review of `6.4.2-cadre-host-update-flow`. None changes the contract with callers.

## Review findings

Verification performed against `5e1a2aa`, reading the diff fresh before consulting the implement-stage handoff.

### Build, tests, lint

- `yarn build:server` (tsc): **clean, exit 0**.
- `yarn test src/update/__tests__` in `packages/cadre-host`: **46 tests pass across 5 files** (apply, manifest, store, version, update-service.integration), 625 ms.
- No `lint` script exists in `packages/cadre-host`; TypeScript strict mode is the only static check and passes.

### Code review by aspect

- **DEP0190 dodge — correctness of the Windows quoting** (`apply.ts:172-183`). Manually traced inputs against MSVCRT/cmd rules:
  - safe args (`install`, `-g`, `@serfab/cadre-host@0.7.0`) early-return unchanged because none of the metachars in `[\s"&|<>^()%!]` match.
  - `'with"quote'` → `(\\*)"` matches the lone `"` with zero preceding slashes → replaced with `\"` → wrapped → `'"with\\"quote"'` ✓
  - `'trail ing\\'` → triggers quote path (has space) → trailing-backslash regex doubles the single `\` to `\\` → `'"trail ing\\\\"'` ✓
  - `'trailing\\'` → no metachar (just one trailing backslash, no space) → early-returns unchanged ✓ (cmd.exe passes it through verbatim when not enclosed in quotes — the test asserts this)
  - Control-char rejection covers `\x00`, `\r`, `\n` — enough to block injection of CRLF command separators. Other C0 controls (`\x01-\x1f`, `\x7f`) are not blocked; cmd.exe usually passes them through but they'd never appear in semver-validated input. **Acceptable as defense-in-depth.**
  - Metachar set `[\s"&|<>^()%!]` covers all cmd.exe special chars (`& | < > ^ % ! ( )` + quote + whitespace). `=`, `;`, `'`, backtick are not cmd-special in argument context — omission is correct.
  - The global regex `(\\*)"` does NOT re-match its own replacement output because JS `replace` advances `lastIndex` past the matched substring, not past the replacement. Verified mentally.
- **`buildNpmSpawnSpec` posix branch** (`apply.ts:163-169`). Returns `{ command: 'npm', args, shell: false }`. npm on Linux/macOS is a node script with a shebang, so `execve` handles it directly without a shell. No regression vs. the previous code (which previously only used shell on win32 anyway).
- **`recoverInterruptedApply` semantics** (`index.ts:109-122`). Sync read + sync update via `UpdateStateStore` — no `await`. Runs once in the constructor (idempotent across multiple instances on the same dataDir because the second instance reads an already-cleared state). Overwrites any prior `lastError`; this is acceptable because an interrupted apply is more relevant than a stale `signature_invalid`. The "may or may not have succeeded — verify with `npm ls -g`" message is honest about the recovery's limits.
- **`assertManifestFieldsWellFormed` ordering** (`manifest.ts:147-180`). Sequential checks, first-failure throws — standard. The `parsed.toISOString() !== m.publishedAt` round-trip catches both unparseable strings and non-canonical formats (e.g. `'2026-05-15T18:00Z'` lacks ms and would mismatch). The npm regex `^(?:@[a-z0-9-_.]+\/)?[a-z0-9-_.]+$` is slightly looser than npm CLI's own (allows leading `_`/`.`) — acceptable because the value comes from a signed manifest produced by the release pipeline, not user input.
- **`compareVersions` downstream safety**. With field validation in place, `compareVersions` in `index.ts` and `apply.ts` can no longer throw on malformed semver strings sourced from a signed manifest. ✓
- **DRY**. `DEFAULT_NPM_TIMEOUT_MS` is declared in both `apply.ts:23` and `index.ts:39`. **Pre-existing duplication, not introduced by this ticket.** Out of scope.
- **Resource cleanup**. No new resources (timers/files/sockets) introduced; the recovery path is a single sync `update()`. ✓
- **Error handling**. Recovery never throws (constructor must not fail on a corrupted state). Manifest validation throws `UpdateErrorException('manifest_invalid', …)` with descriptive messages. ✓
- **Type safety**. `buildNpmSpawnSpec` return type is an inline object literal (`{ command: string; args: string[]; shell: boolean }`); promoting it to an exported interface would be churn for a single call site. ✓ No `any`.
- **Cross-platform**. The platform branch is the only platform-specific code path. `process.platform === 'win32'` matches the canonical Node check. ✓

### Tests

- **`quoteWindowsArg` tests** (`apply.test.ts:103-126`) cover safe args, metachar quoting, embedded-quote escaping, trailing-backslash doubling, and control-char rejection. **Covers happy path + edge cases.** ✓
- **`buildNpmSpawnSpec` tests** (`apply.test.ts:128-158`) cover both platform branches by mutating `process.platform`. The `try/finally` correctly restores the original. Vitest runs tests within a file serially by default, so the in-process mutation doesn't race the other tests in this file. **Cross-file parallelism is fine** because the mutation is wrapped in `try/finally` per test.
- **Manifest field-validation tests** (`manifest.test.ts:94-127`) cover each new rejection path (semver version, minPreviousVersion, ISO publishedAt, npm package name regex). Each constructs a *signed* envelope with the malformed field so it specifically exercises the new field-level guard, not the structural one. ✓
- **Recovery integration test** (`update-service.integration.test.ts:207-239`) seeds `applyInProgress` via `UpdateStateStore`, constructs a `UpdateService` (verifies the marker is cleared and `lastError.code === 'apply_failed'` with `/interrupted/i`), then constructs a *second* `UpdateService` with a different `currentVersion` and asserts that `apply()` reaches `no_update_available` rather than short-circuiting on `apply_in_progress`. The second-instance construction is slightly indirect but correctly proves the gate is open. **Minor: could be simplified by calling `svc.apply()` directly with a matching-version envelope, but the existing form is clearer about intent.** Not worth a follow-up fix.
- **Regression coverage**. The pre-existing 11 `applyUpdate` + 12 `UpdateService` tests still pass — the spawn-spec change is contained behind the injected `NpmExecutor`, so none of the existing apply/restart/rollback tests had to change.
- **Gaps that don't warrant new tests**:
  - No live `npm` spawn test — deliberately deferred (would require npm on the runner, write to the real global prefix). The injected executor pattern is sufficient.
  - No test of `lastError` being overwritten by a successful subsequent apply — implicitly covered by the existing apply-success tests that assert `lastError: undefined` after a successful `apply()`.

### Documentation

- `docs/cadre-host.md:169-177` describes the update flow at architecture level (notify-by-default, apply flow, restart semantics). The behaviors described from the outside are unchanged: `applyInProgress`/`lastError` still appear in `update-state.json`, the apply path still re-fetches/re-verifies, and signature failures still surface as `lastError`. **No doc update required** — the three fixes are internal correctness improvements that don't alter the documented contract.
- No README, ADR, or in-tree spec references the previous DEP0190 behavior or the missing recovery logic. ✓

### Known gaps the implementer flagged, and disposition

- **Quoting helpers are exported for testability** — accepted; the surface increase is trivial (two pure functions) and the alternative (stubbing `spawn` to test platform branches) is materially worse.
- **`process.platform` mutation in tests** — accepted; contained per-test with `try/finally`, and vitest's per-file serialization makes the pattern safe in this suite.
- **No live npm spawn test** — accepted; out of scope for an injected-executor design.
- **Best-effort recovery message** — accepted; richer recovery (e.g. re-running the install when the new version isn't actually installed) belongs to a separate ticket if ever needed.
- **214-char hard cap, no soft 40-char limit** — accepted; the regex already excludes everything else npm would refuse, and the soft cap is npm CLI's responsibility.

### Out of scope (unchanged from source ticket)

- Placeholder `PROD_KEY_BASE64` in `release-key.ts` — release-operator's responsibility, tracked separately.
- Standalone-binary apply path — separate ticket.

## Verdict

Ship. All three fixes are correct, well-tested, and don't introduce regressions. No follow-up tickets needed.
