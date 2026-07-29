description: Our packages said they worked with an older version of the database engine than the one we actually build and test against, and nothing caught that drift. An automated check now fails the build when the two disagree.
files: scripts/check-dep-ranges.mjs, scripts/check-dep-ranges.test.mjs, package.json (root), docs/STATUS.md
----

# Gate: declared dependency ranges must cover the linked workspace versions

Shipped and reviewed. Gate live in `yarn dep-check`; its tests chained into root `yarn test`.

## What landed

`scripts/check-dep-ranges.mjs` — for every root `package.json` `resolutions` entry pointing at a
`link:` sibling workspace (e.g. `@optimystic/db-core` → `link:../optimystic/packages/db-core`), read
that sibling's real version, then check every `packages/*/package.json`
`dependencies` / `peerDependencies` / `optionalDependencies` entry naming it against
`semver.satisfies`. Generic over whatever `resolutions` holds, so `@optimystic/*` and
`@quereus/quereus` are covered today and any future linked package for free.

- Reports the direction of drift (declared range too old, so a consumer installs a substrate this
  repo never tests — vs. declared range ahead of the local checkout) plus a suggested
  `^<linked version>` edit. Fails; never auto-fixes.
- Missing sibling checkout (bare CI clone with no `../optimystic`) → logged skip, not a failure.
- Unparseable declared range or sibling version → its own readable failure, not a crash.
- `DEP_RANGE_CHECK_ROOT` redirects the whole check at a fixture root, for tests.

Wiring: `yarn check:dep-ranges` standalone; `yarn dep-check` = `knip && yarn check:dep-ranges`;
`yarn test` chains `yarn test:dep-ranges`; `semver ^7.7.3` added as a root devDependency;
`docs/STATUS.md` → "Declared dependency range vs linked workspace" documents the gate.

## Review findings

Checked: the full implement diff (`6be615e`) read cold before the handoff summary; script structure
against SPP/DRY/small-function/naming/type-safety/error-handling; error and edge paths of every
branch (`link:` filter, absent sibling, missing `version`, invalid range, invalid version, missing
`packages/` dir); test coverage vs. the code's actual branch set; every declared range in all seven
consuming packages against the linked sibling versions on disk; `docs/STATUS.md` against the code as
it now stands. Ran `yarn lint` (clean), `yarn check:dep-ranges` (exit 0, 9 linked packages),
`yarn dep-check` (exit 0), and the full `yarn test` (all workspaces green, 5m21s, plus 9/9
dep-range tests).

**Minor — fixed in this pass:**

- *Unhandled crash on a non-semver declared range.* `semver.satisfies` swallows an unparseable range
  and returns `false`, but `semver.gtr`/`ltr` in `direction()` throw on it — so a dependency declared
  as `workspace:^`, `catalog:`, or any non-range protocol would have taken the gate down with a raw
  `TypeError: Invalid comparator` instead of reporting a problem. Same for a sibling `package.json`
  with a malformed `version` (`TypeError: Invalid Version`). `direction()` now checks
  `semver.validRange` / `semver.valid` first and returns a readable reason for each; the suggested
  edit is omitted when the linked version isn't valid semver (it would have printed `^undefined`-style
  nonsense). Two tests added.
- *Accumulation loop untested* (the handoff flagged this itself). Added a test with two packages and
  three drifted ranges spread across `dependencies`, `peerDependencies`, and `optionalDependencies`,
  asserting all three appear and the trailing count says 3.
- *Non-`link:` resolution skip untested* (also self-flagged). Added a test with a plain semver
  resolution; the gate reports "nothing to check" and exits 0.
- *Test fixture cleanup could leak on failure.* `run()` deleted its tmpdirs after `spawnSync` returned
  but outside any `finally`, so a throw between spawn and cleanup left fixture dirs behind. Now in a
  `finally`.
- *`readdirSync` on an absent `packages/` dir* would throw ENOENT for a misdirected
  `DEP_RANGE_CHECK_ROOT`; now returns an empty list.
- *Docs drift from this pass.* `docs/STATUS.md`'s test-coverage sentence listed only the original five
  cases; updated to the nine that exist.

**Major — none.** The gate does what it claims, on the real repo and on fixtures, in both drift
directions, and the 0.x-vs-1.0 caret boundary is handled by deferring to `semver` rather than a
hand-rolled comparison. No new tickets filed.

**Tripwires — none new.** Two conditional concerns noticed while reading, both already parked in
`docs/STATUS.md` by prior work, so they were not re-filed: `@optimystic/db-p2p-storage-fs` has no
`resolutions` entry and so resolves from the registry (its version can silently trail its linked
siblings once the sibling checkout carries an unpublished version), and `@quereus/quereus` is a
regular `dependency` rather than a `peerDependency` in the published packages (two Quereus instances
if a consumer ever pins a major our range excludes). Two new `NOTE:` comments were added at their
code sites in `scripts/check-dep-ranges.mjs`: coverage is exactly the set of `link:` resolutions
(registry-resolved siblings are silently outside the gate), and only `packages/*` is scanned, which
matches the root `workspaces` globs today but would need to read `workspaces` if a second glob is
added.

**Deliberately not pursued:** a range whose floor sits well below the linked version but still admits
it (e.g. `^4.3.0` with 4.5.1 linked) passes the gate. That is the designed contract — the gate
enforces "declared range admits the tested version", and keeping the floor itself current stays the
manual lockstep rule already documented in `docs/STATUS.md`. Worth knowing when reading a green run.

## Pre-existing, unrelated

Nothing new. The `packages/integration-tests` build-staleness failure an earlier pass hit was already
triaged (commit `633aa1a`) and `tickets/.pre-existing-error.md` cleared; that suite passed cleanly in
this review's full `yarn test` run. `tickets/.pre-existing-known.md` tracks one unrelated intermittent
flake (`push-wake-e2e`) which did not surface here.
