---
description: The check that stops tests running against an out-of-date build used to look for shared libraries in one central folder only; it now looks in the folders each project actually uses, so projects that keep their own copies are no longer blind.
files: test-harness/build-freshness.ts, test-harness/build-freshness.spec.ts, packages/integration-tests/test/global-setup.ts, packages/cadre-core/test/global-setup.ts, packages/cadre-cli/test/global-setup.ts, packages/cadre-host/src/__tests__/global-setup.ts, packages/quereus-plugin-sereus/test/global-setup.ts, packages/reference-app-web/test/global-setup.ts, docs/STATUS.md
---

# `linked` guard targets resolve through the consuming package's `node_modules` chain

## What shipped

`test-harness/build-freshness.ts` used to look for a `linked` target — a package
from a sibling checkout (`../optimystic`, `../quereus`) reaching `node_modules` as
a symlink — in the repository root's `node_modules` and nowhere else. It now walks
the chain Node itself walks.

- `resolveLinkedPackageFrom(fromDir, packageName)` walks `<dir>/node_modules` from
  `fromDir` upward to `findWorkspaceRoot(fromDir)` **inclusive**, so a
  `node_modules` above the monorepo root is never consulted. The first directory
  holding an entry wins, whatever that entry is — a registry copy or a dangling
  link ends the walk rather than "recovering" to the root, because Node loads the
  near copy and judging the far one reports on code that never runs. An empty
  chain reports `unresolved` naming every directory searched.
- `resolveLinkedPackage(nodeModulesDir, packageName)` classifies one directory and
  gained an `absent` state (`NodeModulesEntry = LinkedPackage | { status: 'absent' }`)
  so the walker can tell *keep looking* from *found, and unusable*.
- `assertBuildFresh(targets, setupUrl)` takes the caller's `import.meta.url` as a
  **required** second argument; a default would silently reinstate the blind spot.
  All six call sites pass it. `repoNodeModules()` is gone.
- Workspace targets are untouched — still located by scanning `packages/`.

Why it matters: `reference-app-web`, `reference-app-ns` and `reference-app-rn`
declare `installConfig.hoistingLimits: "workspaces"`, so yarn installs their
`@optimystic/*` / `@quereus/*` into `packages/<app>/node_modules`, and that is the
copy their suites load. Before this, such a suite could not list those as guard
targets at all.

Follow-on work already queued: `debt-web-app-build-guard-targets`
(`tickets/implement/15.5-…`) turns the wider target list on for `reference-app-web`.

## Review findings

### Checked and clean

- **The walk's bound is really the monorepo root.** Verified no package under
  `packages/` declares `workspaces`, so `findWorkspaceRoot(fromDir)` cannot stop
  the walk early at an intermediate package. (An initial grep suggested three
  nested workspace roots; that was a false positive matching the *value* of
  `"hoistingLimits": "workspaces"`, confirmed by parsing each manifest.)
- **No existing target is silently shadowed by the new stop-at-first-hit rule.**
  Every non-app `packages/*/node_modules` on this checkout holds only `.bin`,
  `.vite`, `.vite-temp` — nothing that could end a walk before the root. So no
  suite lost guard coverage in the change.
- **The `setupUrl` guard fails loudly cross-platform.** A Windows path parses as a
  `c:` scheme and `fileURLToPath` rejects it; a POSIX path fails to parse at all.
  Both throw, which is the intent.
- **`build-targets.ts` / `targetListProblems` needed no change** — it reads
  manifests and root `resolutions`, never `node_modules`.
- **Type narrowing on `NodeModulesEntry`** is sound; `resolveLinkedPackageFrom`
  returns the narrower `LinkedPackage` without a cast.

### Fixed in this pass (minor)

- **`resolveLinkedPackage` swallowed every `lstat` failure as "nothing here".** An
  unreadable directory (permissions) continued the walk and could judge a copy the
  suite does not load — the precise failure the walk exists to avoid. Now only
  `ENOENT`/`ENOTDIR` mean `absent`; anything else reports `unresolved` with the
  errno code. Added `errorCode(error)`, a cast-free `unknown` narrowing. Covered by
  a new portable case (a file standing where a `node_modules` should be).
- **Stale signature in the module header** — `assertBuildFresh(targets)` in
  `build-freshness.ts`'s own doc comment, and in two `docs/STATUS.md` entries that
  describe the export in present tense. All three corrected.
- **The chain had no end-to-end exercise** (a gap the implementer flagged). Added
  `describe('node_modules chain, on this checkout')`: from
  `packages/reference-app-web/test`, `@optimystic/db-core` resolves through the
  app's own `node_modules` junction, and `@optimystic/quereus-plugin-crypto` —
  linked at the root, absent locally — is still found, proving the walk carries on
  past a hoisting-limited package. The second case names its premise in a comment
  so a future install change points at the fix.
- **`cadre-host`'s own suite was run**, closing the implementer's second stated
  gap: 59 files, 511 passed, 4 skipped.

### Filed as a new ticket (major)

- **`backlog/debt-reference-app-rn-build-guard`.** `packages/reference-app-rn`'s
  unit suite imports runtime values from `@serfab/cadre-core`
  (`PersistentTrustedOwnerStore`, `KeyStoreAccessError`, `STRAND_WAKE_TYPE`) — real
  compiled `dist` — and has no `globalSetup` guard at all, so a stale `cadre-core`
  reports green there. Pre-existing, not caused by this diff, but squarely in this
  guard's domain and only cheaply fixable now that the walk reaches package-local
  installs. `reference-app-ns` has the same exposure and no unit-test harness; that
  stays with the existing `debt-ns-unit-test-harness`.

### Tripwires parked, not ticketed

- `build-freshness.ts`, `nodeModulesChain` — two `NOTE:`s from the implement stage,
  both re-read and left as they are: the walk does not skip ancestors named
  `node_modules` the way Node does (unreachable — no setup module lives there), and
  its per-target `lstat` cost (cache per `fromDir` if it ever shows up).
- `build-freshness.spec.ts`, `linked sibling packages` fixture — added a `NOTE:`
  that this block's `<tmp>` has no `workspaces` ancestor, so its walk runs to the
  filesystem root. Harmless while the fixture uses `@sibling/pkg`, a name no real
  install produces; bounding it is not possible here because the
  `not in a workspace` case needs the opposite.

### Known gap left open, with reason

- **The full `integration-tests` suite was not run** — network-bound and slow, the
  same deferral the implement stage made. Its `global-setup.ts` was exercised (it
  is what loads the harness spec) and its guard passed, but no scenario ran. Three
  scenarios there are known-failing for unrelated, already-tracked reasons
  (`tickets/.pre-existing-known.md`).
- **"Nearest wins" still has no *discriminating* real-repo case.** Both the app's
  local `@optimystic/db-core` link and the root's point at the same sibling working
  copy, so the resolved path cannot say which directory won. The temp-dir fixtures
  cover it with two distinct sibling roots; `debt-web-app-build-guard-targets` is
  where a regression would first show up in anger.

## Verification

All from `C:\projects\sereus` on Windows, after the review's edits.

| command | result |
| --- | --- |
| `yarn workspace @serfab/integration-tests exec vitest run build-freshness` | 37 passed |
| `yarn workspace @serfab/cadre-host test` | 59 files, 511 passed, 4 skipped |
| `yarn workspace @serfab/cadre-core test` | 83 files, 1315 passed, 1 skipped |
| `yarn workspace @serfab/cadre-cli test` | 14 files, 164 passed |
| `yarn workspace @serfab/quereus-plugin-sereus test` | 8 files, 77 passed, 1 todo |
| `yarn workspace @serfab/reference-app-web test` | 1 file, 12 passed |
| `yarn workspace @serfab/{cadre-core,cadre-cli,cadre-host,quereus-plugin-sereus,reference-app-web,integration-tests} run typecheck` | all clean |
| `yarn lint` | exit 0 |

`../quereus` was being edited concurrently and its build fired the guard twice
during this run; rebuilding it as the message instructed cleared it both times.
That is the guard working. Nothing in that repository was changed beyond running
its build.

Note for anyone re-running the harness spec: the vitest filter must be the
substring `build-freshness`, not a path — vitest matches substrings against
discovered paths, which are relative to the `integration-tests` root.
