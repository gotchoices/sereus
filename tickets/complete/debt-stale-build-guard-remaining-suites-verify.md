description: A safety check that stops tests from silently running against old, unrebuilt code is now wired into three more parts of the codebase, verified end to end, and the five near-identical copies of its companion test were folded into one shared version.
prereq:
files: test-harness/build-freshness.ts, test-harness/build-targets.ts, test-harness/build-targets-spec.ts, packages/quereus-plugin-sereus/test/global-setup.ts, packages/quereus-plugin-sereus/test/build-targets.spec.ts, packages/cadre-cli/test/global-setup.ts, packages/cadre-cli/test/build-targets.spec.ts, packages/cadre-host/src/__tests__/global-setup.ts, packages/cadre-host/src/__tests__/build-targets.test.ts, packages/cadre-core/test/build-targets.spec.ts, packages/integration-tests/test/build-targets.spec.ts, packages/cadre-provider/vitest.config.ts, docs/STATUS.md
difficulty: easy
----

## What landed

`assertBuildFresh` (from `test-harness/build-freshness.ts`) fails a test run up front when a
package the suite runs *compiled* code from has been edited without a rebuild. It already
guarded `cadre-core`, `integration-tests` and `reference-app-web`; the implement pass wired
it into `quereus-plugin-sereus`, `cadre-cli` and `cadre-host` as well, each via its own
vitest `globalSetup` file holding that suite's own list of packages, plus a companion spec
that cross-checks the list against the package's real `dependencies` so the list cannot rot
in silence. `cadre-provider` was left unwired on purpose — it declares no workspace or
sibling-checkout dependencies, so there is nothing to check.

This review pass verified all of that, then fixed what it found (below).

## Review findings

### Checked

- **Read the implement diffs first** (`67707f7`, `8a2d77a`) before the handoff summary.
- **Target lists vs. reality** — re-derived each of the three new lists by hand from that
  package's `package.json` and the root manifest's `resolutions`. All three correct.
  `@optimystic/db-p2p-storage-fs` is legitimately absent from `cadre-cli`'s and
  `quereus-plugin-sereus`'s lists: it has no `link:` resolution, so it arrives as a registry
  copy whose file timestamps are packing artifacts and which the guard skips by design.
  `db-p2p-storage-web` *is* linked and *is* listed. Every `distEntry` in the three lists
  exists on disk.
- **`cadre-provider` really has nothing to guard** — confirmed from its manifest: zero
  `workspace:`/`link:` dependencies.
- **Test quality beyond the happy path** — mutation-tested the shared spec both ways:
  deleting a real entry from a `TARGETS` array fails the coverage assertion; giving a pinned
  dependency the wrong origin fails the pin assertion. Both restored, working tree clean
  after.
- **Lint / typecheck / tests** — `yarn lint` exit 0, `yarn typecheck` (all workspaces) exit 0,
  `yarn dep-check` exit 0. Suites: `quereus-plugin-sereus` 8 files / 77 passed + 1 todo;
  `cadre-cli` 14 files / 164 passed; `cadre-host` 59 files / 511 passed + 4 skipped;
  `cadre-core` 83 files / 1315 passed + 1 skipped; `integration-tests` 37 files / 191 passed
  + 1 expected-fail, with one pre-existing failure recorded separately (below).
- **Docs** — read `docs/STATUS.md`'s stale-build section against the code rather than trusting
  it; the implement pass's bullet was accurate.

### Found and fixed in this pass

- **Five verbatim copies of the same spec.** The three new `build-targets` specs were
  copy-pastes of `cadre-core`'s and `integration-tests`', identical apart from the suite
  name, the package root, and the two dependencies each pins — a direct hit on the repo's
  "stay DRY" rule, and the ticket had tripled the duplication rather than noticing it.
  Extracted to `test-harness/build-targets-spec.ts`, exporting
  `describeBuildTargets(suiteName, { packageDir, targets, expectFound })` and a
  `packageRootFrom(import.meta.url, ...)` helper. All five call sites are now a doc comment
  plus one call; each keeps the comment explaining why *its* list is wider than its own
  `dependencies`. `expectFound` is a name→origin map rather than two hand-written
  assertions, which also improves the failure message — it now names the package that
  disagreed instead of just printing `expected 'workspace' to be 'linked'`.
- **`test-harness/build-freshness.ts`'s module comment listed only two consumers.** It had
  gone stale the moment the guard was wired into three more suites (and it had already
  missed `reference-app-web`). All six `global-setup.ts` paths now listed.

### Recorded as a tripwire, not a ticket

- `cadre-provider` is the only package with no guard and no target-list spec, so nothing
  fails if it ever gains a workspace or sibling-checkout dependency. Conditional — there is
  nothing wrong today, only if that dependency arrives. Parked as a `NOTE:` comment at the
  site (`packages/cadre-provider/vitest.config.ts`) telling the next reader what to add, and
  as a sentence in `docs/STATUS.md`.

### Found, not this ticket's

- `packages/integration-tests/src/scenarios/zz-scratch-delete-alone.integration.ts` fails
  with `SyncRetryExhaustedError` inside `@optimystic/db-core`'s collection sync. Untouched by
  this ticket, not in `tickets/.pre-existing-known.md`, so written up in
  `tickets/.pre-existing-error.md` for the triage pass. Nothing was skipped or loosened to
  get a green run. Worth noting for whoever picks it up: the file's own header says it is a
  scratch experiment to be deleted once settled, not a regression test.
- The sibling `../quereus` checkout had uncommitted in-progress source edits mid-review, so
  the guard correctly reported `@quereus/quereus` stale and aborted the run. Rebuilding that
  sibling (the guard's own printed remedy) cleared it. Not a defect — this is the documented,
  accepted cost of failing hard on a stale sibling.

### No findings

- **Error handling and resource cleanup** — nothing here opens a handle, spawns a process or
  catches an error; `assertBuildFresh` throws once with a printable remedy and the specs are
  pure assertions. Nothing to find, and nothing was invented to fill the category.
- **Type safety** — no `any`, no assertions, no non-null operators in the new code; the
  origin values are the existing `Origin` union, so a typo'd pin fails to compile.
- **Performance** — the guard's tree-walk cost is already documented with its own `NOTE:` and
  its own escape hatch in `build-freshness.ts`; the three new suites add nothing to that
  picture beyond three more calls of the same shape.
- **New tripwires beyond the one above** — the guard's known edges (timestamps rather than
  content hashes, registry copies skipped, packages that limit dependency hoisting) are all
  already documented in `build-freshness.ts`'s comments or `docs/STATUS.md`.

## Known behaviour, carried forward

The guard compares file modification times, not content. A sibling checkout whose sources are
merely *touched* — a branch switch, a tool that rewrites a file byte-identically — reads as
stale. Rebuilding is the right response either way, but a reviewer re-running these checks
should not mistake that for a defect. Relatedly, `tsc --incremental` may not rewrite anything
when content is genuinely unchanged, in which case deleting the sibling's `.tsbuildinfo`
forces the rebuild through. Both are pre-existing and documented in the harness.
