description: Every package here said it needed version 0.16 of the storage library, but we build and test against 0.17. This bumped the declared version ranges so a fresh install actually gets the tested code, including five bug fixes that were blocking data from reaching a second machine.
files: packages/cadre-cli/package.json, packages/cadre-core/package.json, packages/integration-tests/package.json, packages/quereus-plugin-sereus/package.json, packages/reference-app-ns/package.json, packages/reference-app-rn/package.json, packages/reference-app-web/package.json, yarn.lock
---

# Declared `@optimystic/*` and `@quereus/quereus` ranges bumped to match tested versions

## What changed

All 22 `@optimystic/*` dependency ranges across the workspace raised `^0.16.3` → `^0.17.0`, matching
the version actually linked via `resolutions` in root `package.json` (`link:../optimystic/packages/*`,
`0.17.0` on disk). Without this, a fresh `yarn install` outside this repo's `resolutions` override
would have resolved to a stale `0.16.x` publish missing five bug fixes needed for data replication to
a second machine.

Touched: `packages/cadre-cli`, `packages/cadre-core`, `packages/integration-tests`,
`packages/quereus-plugin-sereus`, `packages/reference-app-ns`, `packages/reference-app-rn`,
`packages/reference-app-web`. `packages/cadre-host` and `packages/cadre-provider` carry no direct
`@optimystic/*` dependency — confirmed nothing to change there.

Also bumped `@quereus/quereus` floor `^4.4.0` → `^4.5.0` in the same 6 packages that declare it, to
match the linked `../quereus/packages/quereus` version on disk (`4.5.0`). Note: `^4.4.0` already
*admitted* 4.5.0 (caret ranges cross minors above 1.0), so this half of the change is a floor-tracking
cleanup, not a bug fix like the `@optimystic/*` half — worth knowing when reviewing for "is this
actually a fix."

`yarn.lock` refreshed via `yarn install` (resolution metadata only — the `link:` resolutions meant no
new code was actually fetched).

## How to verify

- `yarn build` from repo root — full workspace build, should be clean (only pre-existing chunk-size
  bundler warnings, unrelated).
- `yarn test` from repo root — should be green except one known-flaky, unrelated test (see below).
- Spot check: `grep -n "@optimystic\|@quereus/quereus" packages/*/package.json` should show `^0.17.0`
  / `^4.5.0` everywhere, no `0.16.x` / `4.4.x` stragglers.

## Test results (this session, re-verified independently of the implement-stage report)

- `yarn build`: clean.
- `yarn test`: 94 + 938 + 447 = 1479 passed, 4 skipped, **1 failed** —
  `packages/cadre-host/src/__tests__/orchestrator.test.ts` →
  `HostProcessOrchestrator.getStats > returns plausible numbers with zero network counters`
  (`Test timed out in 5000ms`).
  - Reproduced this failure myself (independently of the prior implement-stage run), then reran the
    same test in isolation and it passed in 3.4s — same flaky pattern the implement-stage report
    described, now confirmed twice.
  - `cadre-host` has zero `@optimystic/*` or `@quereus/quereus` dependency — nothing this ticket
    touches. Logged to `tickets/.pre-existing-error.md` this time (the implement-stage pass noted it
    but didn't log it, since it didn't reproduce in isolation on that run — logging it now since it's
    now failed twice under full-suite load and deserves triage rather than staying buried in ticket
    prose). Reviewer: no action needed on this ticket's account; the triage pipeline should pick up
    `.pre-existing-error.md` and route a timeout-margin fix to `cadre-host`'s orchestrator test
    separately.

## Gaps / things a reviewer should know

- No new tests added — this is a version-range bump, not new behavior; existing suite is the coverage.
- The "five bug fixes" and "second machine" framing in the description come from the originating `fix/`
  ticket's research, not independently re-verified here — this ticket's job was the range bump itself,
  not re-auditing which upstream commits fixed what.
- `packages/cadre-host` and `packages/cadre-provider` were named in the *original* bug ticket's `files:`
  header but turned out to have no direct `@optimystic/*`/`@quereus/quereus` dependency — confirmed
  clean, nothing silently skipped there.
