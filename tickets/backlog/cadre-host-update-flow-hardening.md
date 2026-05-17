---
description: cadre-host update flow — npm-shell hardening, applyInProgress crash recovery, tighter manifest validation
prereq:
files: packages/cadre-host/src/update/apply.ts, packages/cadre-host/src/update/manifest.ts, packages/cadre-host/src/update/index.ts, packages/cadre-host/src/update/__tests__/
---

Follow-ups raised by the review of `6.4.2-cadre-host-update-flow`. None are blocking for the npm-install path landing, but each is a real correctness/robustness concern worth fixing before standalone-binary updates are wired up or the prod signing key is published.

## 1. `defaultNpmExecutor` uses `shell: true` + args (Node DEP0190)

`packages/cadre-host/src/update/apply.ts:117` spawns `npm` with `{ shell: process.platform === 'win32' }` and an args array. Node logs DEP0190 on every Windows test run:

> DeprecationWarning: Passing args to a child process with shell option true can lead to security vulnerabilities, as the arguments are not escaped, only concatenated.

Real exploitability is gated by manifest-signature verification (the args come from a signed payload), but the deprecation is on the path to becoming an error in a future Node major, and a tighter shape avoids the shell entirely:

- Resolve `npm.cmd` (or `npm.ps1`) on Windows via PATH lookup and `spawn(resolved, args)` without a shell.
- Or — flip to a single command string + empty args (the shape `shell: true` actually wants).
- Either way, **also** validate `manifest.channels.npm.package` against the npm naming regex before passing to spawn, as defense in depth.

## 2. `applyInProgress` can leak after a crash

`UpdateService.apply()` writes `applyInProgress` to `update-state.json` before invoking npm, then clears it on success/failure (`packages/cadre-host/src/update/index.ts:181-221`). If cadre-host is OOM-killed or the machine loses power mid-apply, the state file retains `applyInProgress` forever and every subsequent `apply()` rejects with `apply_in_progress`. There is no operator recovery path short of manually editing JSON.

Fixes to consider:

- On `UpdateService` construction, clear any stale `applyInProgress` and record a `lastError: { code: 'apply_failed', message: 'previous apply interrupted (cadre-host restarted)' }`. The npm install may or may not have actually landed; the user gets a clear banner.
- Add a coverage test that spins up the service with a pre-populated `applyInProgress` and asserts the recovery behavior.

## 3. Tighter manifest field validation

`isUpdateManifest` only checks types — it doesn't verify `version` parses as semver or that `publishedAt` is an ISO 8601 string. A malformed (but signed) manifest would surface as a confusing `compareVersions` throw further downstream.

- Reject the manifest in `verifyManifest` if `parseVersion(manifest.version)` throws, with code `manifest_invalid` and a clear message.
- Same for `minPreviousVersion`.
- Optional: validate `publishedAt` with `new Date(...).toISOString()` round-trip equality.
- Optional: validate `channels.npm.package` against npm's naming regex (`/^(?:@[a-z0-9-_.]+\/)?[a-z0-9-_.]+$/`).

## Out of scope

- The placeholder release key in `release-key.ts` — that one is the release operator's job, tracked separately as part of release-tooling.
- The standalone-binary apply path — separate ticket.
