----
description: Our packages say they work with an older version of the database engine than the one we actually build and test against, and nothing catches that drift — so people installing our published packages get a combination we never test. Add an automated check that fails when the two disagree.
prereq: solo-control-node-dep-floor-and-regression-test
files: package.json (root resolutions), packages/*/package.json, .github/workflows (or the repo's build-health gate), docs/STATUS.md
difficulty: easy
----

# Gate: declared dependency ranges must cover the linked workspace versions

## Problem

Development in this repo resolves `@optimystic/*` and `@quereus/*` to **linked sibling
workspaces** via root `resolutions` (`link:../optimystic/...`, `link:../quereus/...`). Every
test, build, and integration run therefore exercises whatever version those workspaces are at.
The `dependencies` ranges each package *publishes*, however, are edited by hand and drift.

Found in practice: with the sibling workspace at `@optimystic/*` **0.16.2**, all seven
publishing/consuming packages still declared `^0.14.1`. A consumer installing
`@serfab/cadre-core` from the registry got a substrate two minor versions older than anything
CI here had ever run — and the first user-visible symptom was a hang in a configuration that
passes at HEAD (see `solo-control-node-dep-floor-and-regression-test`).

The one-time correction lands in that ticket. This ticket is the **guard** so it cannot
silently recur.

## Expected behavior

A cheap check — a script wired into the existing build-health / lint gate — that, for each
workspace package, compares every declared range against the version of the corresponding
linked workspace package and **fails** when the linked version does not satisfy the declared
range. It should name the package, the declared range, and the linked version.

Open questions for the implementer to settle (both have defensible defaults):

- Should the check merely fail, or offer a `--fix` that rewrites the ranges? Default:
  fail with an exact suggested edit; a fix mode is a nice-to-have.
- Should it also flag the inverse — a declared range far *newer* than the linked workspace,
  meaning local development is behind what we promise? Default: yes, same check, different message.

## Notes

- Must work when the sibling workspaces are absent (a clean CI clone without `../optimystic`):
  skip with a clear message rather than fail.
- The same drift applies to `@quereus/quereus` (currently consistent: `^4.4.0` vs linked 4.4.1)
  — the check should be generic over whatever is in `resolutions`, not hardcoded to optimystic.
