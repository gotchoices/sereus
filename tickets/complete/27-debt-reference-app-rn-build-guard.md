description: The React Native reference app's unit tests now abort with a clear message instead of quietly running months-old compiled output of the packages they depend on.
files: packages/reference-app-rn/vitest.config.ts, packages/reference-app-rn/test/global-setup.ts, packages/reference-app-rn/test/build-targets.spec.ts, test-harness/build-freshness.ts, docs/STATUS.md
---

# reference-app-rn stale-build guard — complete

`reference-app-rn` was the last Vitest package running another package's compiled
output with nothing checking that output was current. Three of its specs
(`node-local-slots.spec.ts`, `secure-key-store.spec.ts`, `push-wake.spec.ts`)
import real runtime values from `@serfab/cadre-core`, which resolves through a
symlink to a `dist` that a source edit does not update. It now runs the same
freshness check the other six packages use.

## What shipped

- `packages/reference-app-rn/test/global-setup.ts` — exports `TARGETS` (eight
  packages: `@serfab/cadre-core` and `@serfab/quereus-plugin-sereus` as
  `workspace`; `@optimystic/db-core`, `db-p2p`, `db-p2p-storage-rn`,
  `quereus-plugin-crypto`, `quereus-plugin-optimystic` and `@quereus/quereus` as
  `linked`) and calls `assertBuildFresh(TARGETS, import.meta.url)`.
- `packages/reference-app-rn/test/build-targets.spec.ts` — one
  `describeBuildTargets` call holding that list against the package manifest,
  pinning `@serfab/cadre-core` (workspace) and `@optimystic/db-p2p` (linked).
- `packages/reference-app-rn/vitest.config.ts` — `globalSetup` on the `node`
  project block only.

Review pass added: the `reference-app-rn` entry in `docs/STATUS.md`, the missing
consumer line in `test-harness/build-freshness.ts`'s module comment, and a
corrected symbol name in the new setup file's doc comment.

## Review findings

### Checked and clean

- **The eight targets are really checked, not silently skipped.** A `linked`
  target whose `node_modules` entry is a real directory rather than a symlink is
  skipped by design, so a wrong list would pass unnoticed. Resolved all six from
  `packages/reference-app-rn/test/` the way the guard does: all six are symlinks
  into the sibling checkouts (`db-p2p`, `db-p2p-storage-rn` and `@quereus/quereus`
  from the app's own `node_modules` under its `hoistingLimits: "workspaces"`;
  `db-core` and the two `@optimystic/quereus-plugin-*` from the repo root), and
  every declared `distEntry` file exists. Both `workspace` targets resolve too.
- **The `react` project is correctly left unguarded.** Its single spec `vi.mock`s
  `@serfab/cadre-core` and `../../src/cadre-phone`; `cadre-phone.ts` is the only
  module in this package importing `@optimystic/db-p2p-storage-rn` at runtime, and
  every other `src` module the hook pulls in imports only local files. Nothing in
  that project loads compiled output.
- **Failure path.** Not a synthetic check this time — the sibling `../quereus`
  checkout was genuinely mid-edit during the review, and the guard aborted the run
  naming `@quereus/quereus` and the exact remedy (`Run in C:\projects\quereus: …`).
  Re-ran once that checkout settled: 10 files / 164 tests pass.
- **The doc comments' factual claims.** Verified each spec named in
  `global-setup.ts` imports what the comment says it does: `push-wake.spec.ts`
  reaches `STRAND_WAKE_TYPE` through `src/push-wake.ts` (a value import, not a
  type one), `secure-key-store.spec.ts` and `node-local-slots.spec.ts` import real
  `cadre-core` values. The claim that the list is deliberately wider than
  `dependencies` holds — `@optimystic/db-core` and the three plugin packages are
  not declared by this app.
- **Target-list completeness.** The list covers every `workspace:`/`link:` entry
  in the manifest; the remaining dependencies are registry copies, which the guard
  skips by design.
- **Lint and tests.** Root `yarn lint` clean. `yarn workspace
  @serfab/reference-app-rn test` 10 files / 164 tests. `yarn workspace
  @serfab/reference-app-rn typecheck` clean. `yarn check:vitest-typecheck-coverage`
  and `yarn check:test-file-typecheck-coverage` both pass, the latter now counting
  253 collected files (the two new ones) with 0 orphans. `yarn dep-check` reports
  nothing new for these files.
- **No pre-existing failures to report.** The only red encountered was the stale
  sibling above, which is the guard working as designed, not a broken test.

### Found and fixed in this pass

- **`docs/STATUS.md` still said this package had no guard.** It read
  "`reference-app-rn` remains the one app with no guard at all … see backlog
  `debt-reference-app-rn-build-guard`" — false as of the implement commit, and
  pointing at a ticket that no longer exists. Replaced with an entry describing
  what landed, including why the `react` project is exempt, and naming the two
  packages that legitimately still have no guard (`cadre-provider`, which has no
  workspace or linked dependencies, and `reference-app-ns`, which has no Vitest
  config yet).
- **`test-harness/build-freshness.ts`'s module comment lists its consumers** — the
  six setup files that call it. `reference-app-rn`'s was missing; added.
- **Wrong symbol name in the new setup file's doc comment.** It said
  `node-local-slots.spec.ts` composes `kvSlot`; this package's export is
  `kvStoreSlot` (`kvSlot` is the web app's). Carried over with the comment when the
  file was modelled on `reference-app-web`'s.
- **The stale count in `docs/STATUS.md`** for the test-file type-check sweep
  (251 → 253 collected files).

### Filed as a ticket

- `backlog/debt-build-guard-wiring-unasserted` — **nothing detects the guard being
  switched off.** Seven packages now enable it with one `globalSetup:` line in
  their Vitest config. Delete that line and every check still passes: the setup
  file stays on disk, stays type-checked, and stays imported by the package's own
  `build-targets.spec.ts`, so lint, `knip` and both existing coverage scripts stay
  quiet while the suite silently returns to reporting green on stale builds. This
  is repo-wide rather than specific to this ticket, and the repo already has two
  scripts of exactly this shape (`check-vitest-typecheck-coverage`,
  `check-test-file-typecheck-coverage`) written after the same kind of drift.

### Considered and deliberately not filed

- **The eight-entry target list is now near-verbatim across four packages**
  (`cadre-cli`, `cadre-host`, `reference-app-web`, `reference-app-rn` share seven
  of eight entries). Left alone: each list must be a superset of *its own*
  manifest and the drift spec enforces that per package, so a shared constant
  would have to be sliced back apart per consumer to keep the same guarantee. Not
  recorded as a tripwire either — `build-targets.spec.ts` already fails the moment
  a list drifts from its package, so there is no silent-rot condition to watch for.
- **`tsc --incremental` leaving an entry point's mtime behind a rebuild.** Looked
  like a false-positive source (the sibling repos build with
  `incremental`/`composite`), but `checkBuildFreshness` already compares against
  the newest file anywhere under the output tree for exactly this reason, and says
  so in its comment. No concern to record.

### Not checked

- The `StaleReason` branches other than `stale` (`unresolved`, `missing`) were not
  exercised through this package's wiring, matching the implementer's note. They
  are covered directly by `test-harness/build-freshness.spec.ts`, and the wiring
  cannot select which branch fires.
- The Expo end-to-end suite (`yarn workspace @serfab/reference-app-rn test:e2e`)
  needs an Android emulator and Maestro, so it is not agent-runnable; it is
  untouched by this change, which only adds a Vitest `globalSetup`.
