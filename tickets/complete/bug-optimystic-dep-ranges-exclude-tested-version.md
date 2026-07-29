---
description: Every package here declared that it needed version 0.16 of the storage library, but we build and test against 0.17. The declared version ranges were raised so a fresh install actually gets the tested code, including four replication fixes that were keeping data from reaching a second machine.
files: packages/cadre-cli/package.json, packages/cadre-core/package.json, packages/integration-tests/package.json, packages/quereus-plugin-sereus/package.json, packages/reference-app-ns/package.json, packages/reference-app-rn/package.json, packages/reference-app-web/package.json, yarn.lock, docs/STATUS.md
---

# Declared `@optimystic/*` and `@quereus/quereus` ranges bumped to match tested versions

## What shipped

All 22 `@optimystic/*` dependency ranges across the workspace moved `^0.16.3` → `^0.17.0`, matching
the version linked via root `resolutions` (`link:../optimystic/packages/*`, 0.17.0 on disk) and the
newest npm release. For a `0.x` version `^0.16.3` *excludes* 0.17.0, so a consumer installing from the
registry got a substrate one minor behind everything this repo builds and tests — missing the fixes
that make two-node replication work.

Touched packages: `cadre-cli`, `cadre-core`, `integration-tests`, `quereus-plugin-sereus`,
`reference-app-ns`, `reference-app-rn`, `reference-app-web`. `cadre-host`, `cadre-provider` and
`strand-proto` declare and import nothing from `@optimystic/*` or `@quereus/quereus` — verified, so
nothing was skipped there.

`@quereus/quereus` also moved `^4.4.0` → `^4.5.0` in the six packages that declare it (every one above
except `cadre-cli`, which reaches Quereus only through `cadre-core`). This half is floor tracking, not
a fix: `^4.4.0` already admitted 4.5.0, since caret ranges cross minors above 1.0.

`yarn.lock` refreshed. One entry actually re-fetched code — `@optimystic/db-p2p-storage-fs`, the single
substrate package with no `resolutions` entry, so it resolves from the registry. It moved from a real
0.16.3 tarball to a real 0.17.0 one; every other `@optimystic/*` lock entry changed metadata only. That
also means the bump ended a genuine cross-version mix: registry `storage-fs` 0.16.3 had been running
against linked `db-core`/`db-p2p` 0.17.0.

`docs/STATUS.md` → "Declared dependency range vs linked workspace" records the new state, why the two
halves differ in kind, and the `storage-fs` asymmetry.

The recurrence-prevention gate is not part of this ticket — it is tracked separately as
`debt-declared-dep-range-drift-gate` in `tickets/fix/`, which this review sharpened with the facts
below.

## Review findings

**Verified independently of the handoff summary (all clean):**

- **Coverage is complete.** `grep` across every `packages/*/package.json` finds zero `0.16.x` / `4.4.x`
  stragglers, in any dependency section. A wider sweep of `docs/`, `ops/`, `schemas/`, `scripts/`,
  package READMEs and root `package.json` for hardcoded `@optimystic`/`@quereus` versions found only
  historical prose in `STATUS.md`, which is correct as history.
- **Declared ranges match reality.** All eight linked `../optimystic` packages read 0.17.0 from disk and
  `../quereus/packages/quereus` reads 4.5.0. `npm view` confirms 0.17.0 and 4.5.0 are the newest
  published versions, so the ranges admit exactly what the repo tests — the STATUS.md "newest npm
  release" claim is now registry-verified rather than asserted.
- **`cadre-host` / `cadre-provider` / `strand-proto` really are clean.** Not just missing the
  declaration — they contain zero `@optimystic/*` or `@quereus/quereus` import statements, so there is
  no undeclared-dependency hole hiding behind the absent range. `knip` agrees: it reports no unlisted
  and no unused dependencies anywhere (its output is unused-*export* noise only, pre-existing).
- **Lockfile is genuinely in sync.** `yarn install --immutable` passes, which is the check that matters
  for a lockfile edit — a hand-tweaked or half-regenerated lock would fail here.
- **Gates pass.** `yarn lint` clean (exit 0, no output). `yarn build` clean in 33s (only the
  pre-existing vite dynamic-vs-static chunk warnings from the sibling `db-p2p`, unrelated).
  `yarn test`: 1930 passed, 4 skipped, 1 todo, **0 failed**, exit 0.
- **The prior run's flaky failure is gone.** The interrupted review pass hit
  `cadre-host … getStats > returns plausible numbers with zero network counters` timing out under
  full-suite load and logged it to `.pre-existing-error.md`. Triage has since landed a timeout-margin
  fix (`0cdb0b6`) and pruned the ledger entry; the test passes in this run's full-suite execution.
  Nothing outstanding, nothing re-reported.
- **The build-freshness guard is not fooled by this change.** `build-freshness.ts` lists
  `@optimystic/db-p2p-storage-fs` as a `linked` target even though it is a registry copy — checked, and
  that is fine by construction: `checkLinkedTarget` skips real directories, so a registry copy is
  skipped rather than reported permanently stale.

**Corrected in this pass (minor, fixed inline):**

- The "five bug fixes" framing carried from the originating bug report was never verified. It is
  **four**: `0.16.3..0.17.0` in `../optimystic` contains four `fix(db-p2p)` commits (read-repair at
  small cluster sizes, refusing unmaterializable revisions, two-node commit-path healing, reads
  acquiring an unseen block) plus one `feat(db-p2p)` — optional inbound-stream authorization — which
  the original count folded in as a fix. Corrected in this ticket's `description` and in `STATUS.md`.
- `STATUS.md` claimed all seven packages declare both `@optimystic/*: ^0.17.0` and
  `@quereus/quereus: ^4.5.0`. `cadre-cli` declares no `@quereus/quereus` at all. Reworded to name the
  six that do, and why `cadre-cli` is not among them.

**Tests:** none added, and none warranted — this ticket changes declared metadata, not behavior. The
behavior it protects (a consumer installing a substrate that can replicate) is not observable from
inside this repo at all, because `resolutions` overrides every declared range. That gap is the entire
premise of `debt-declared-dep-range-drift-gate`, which is where the missing check belongs; duplicating
a half-version of it here would be the wrong home.

**Major findings: none.** No new tickets filed. The one systemic issue this bug exposes — that drift
between declared range and linked workspace is invisible to every gate in the repo — was already
ticketed before this review as `debt-declared-dep-range-drift-gate` in `tickets/fix/`. This pass
corrected three facts in it rather than filing a duplicate: the count is 22 ranges not 24, the gap is
four `db-p2p` fixes not five, and `cadre-host`/`cadre-provider` were listed as drifted when they
declare no such dependency at all (the gate should still walk them, so a future direct dependency is
covered from day one).

**Tripwires recorded (not ticketed):**

- `@optimystic/db-p2p-storage-fs` resolving from the registry while its siblings are linked is
  consistent *today* only because 0.17.0 is published. The moment the sibling checkout carries an
  unpublished version, that package runs an older build against newer `db-core`/`db-p2p`. Parked as a
  `NOTE:` in `docs/STATUS.md` → "Declared dependency range vs linked workspace", with the remedy
  (add a `resolutions` entry like the other storage backends have). Architectural, no single code site.
- The published packages declare `@quereus/quereus` as a regular `dependency`, not a `peerDependency`
  — including `quereus-plugin-sereus`, which is loaded *into* a Quereus host. Harmless while ranges
  agree and installers dedupe to one copy; if a consumer ever pins a Quereus major our range does not
  admit, they get two Quereus instances and cross-instance `instanceof` checks start failing. Parked as
  a `NOTE:` in the same `STATUS.md` section (recorded by the earlier review pass, kept).
