---
description: The check that stops tests running against an out-of-date build used to look for shared libraries in one central folder only; it now looks in the folders each project actually uses, so projects that keep their own copies are no longer blind.
files: test-harness/build-freshness.ts, test-harness/build-freshness.spec.ts, packages/integration-tests/test/global-setup.ts, packages/cadre-core/test/global-setup.ts, packages/cadre-cli/test/global-setup.ts, packages/cadre-host/src/__tests__/global-setup.ts, packages/quereus-plugin-sereus/test/global-setup.ts, packages/reference-app-web/test/global-setup.ts, docs/STATUS.md
difficulty: medium
---

# Review: `linked` guard targets resolve through the consuming package's `node_modules` chain

## What changed

`test-harness/build-freshness.ts` used to resolve every `linked` target (a
package from a sibling checkout — `../optimystic`, `../quereus` — reaching
`node_modules` as a symlink) through the repository root's `node_modules` and
nowhere else. It now walks the chain Node itself would walk.

- **`NodeModulesEntry`** added: `LinkedPackage | { status: 'absent' }`.
  `LinkedPackage` keeps the three states a *completed* lookup can produce
  (`linked` / `not-linked` / `unresolved`); `absent` is the one only a
  single-directory lookup can report, and is what lets the walker tell *keep
  looking* from *found, and unusable*.
- **`resolveLinkedPackage(nodeModulesDir, packageName)`** now returns
  `NodeModulesEntry` and answers `absent` when nothing is at the path. The
  dangling-symlink case stays `unresolved`. Its classification logic is otherwise
  untouched: symlink → `linked` (via `realpathSync`, which also normalises the
  `\\?\` prefix Windows junctions carry), real directory → `not-linked`.
- **`resolveLinkedPackageFrom(fromDir, packageName)`** added. Walks
  `<dir>/node_modules` from `fromDir` upward to `findWorkspaceRoot(fromDir)`
  **inclusive**; when that is `undefined` (no ancestor declares `workspaces` —
  only reachable from temp-dir fixtures) it walks to the filesystem root rather
  than throwing. First non-`absent` classification wins and ends the walk. Empty
  chain → `unresolved` with a detail naming every directory searched:
  `not installed (looked in <dir1>, <dir2>, …)`.
- **`checkLinkedTarget`**'s first parameter is now `fromDir` (the consuming
  suite's directory), not a `node_modules` path.
- **`assertBuildFresh(targets, setupUrl)`** takes a **required** second argument
  — the calling setup module's `import.meta.url`. `fileURLToPath` is called
  eagerly and unguarded, before the targets are walked, so a call site passing a
  plain path fails loudly even with an empty target list.
- **`repoNodeModules()` deleted**, along with the `NOTE` on it that predicted
  exactly this ticket. Module header rewritten to describe the chain.
- Workspace targets are untouched — still located by scanning `packages/`.

**Six call sites updated, not the five the ticket listed.** The ticket's "Call
sites" section omitted `packages/quereus-plugin-sereus/test/global-setup.ts`,
which also calls `assertBuildFresh` (the module header in `build-freshness.ts`
listed all six). All six now pass `import.meta.url`.

`docs/STATUS.md` gained an entry for the change, and two now-false claims in it
were corrected: the clause saying `checkLinkedTarget` resolves from the repo
root, and a pointer to the retired backlog slug
`debt-stale-build-guard-hoisting-limited-packages` (repointed at
`debt-web-app-build-guard-targets`). The equivalent stale comment in
`packages/reference-app-web/test/global-setup.ts` was corrected the same way —
its target list was deliberately **not** expanded, that being the follow-on
ticket `debt-web-app-build-guard-targets` (`tickets/implement/15.5-…`).

## Why it matters

`packages/reference-app-web` (and `reference-app-ns`, `reference-app-rn`) declare
`installConfig.hoistingLimits: "workspaces"`, so yarn installs their dependencies
into their own `packages/<app>/node_modules`. Confirmed on this checkout:

```
packages/reference-app-web/node_modules/@optimystic/db-core            -> /c/projects/optimystic/packages/db-core
packages/reference-app-web/node_modules/@optimystic/db-p2p             -> /c/projects/optimystic/packages/db-p2p
packages/reference-app-web/node_modules/@optimystic/db-p2p-storage-web -> /c/projects/optimystic/packages/db-p2p-storage-web
packages/reference-app-web/node_modules/@quereus/quereus               -> /c/projects/quereus/packages/quereus
```

Before this change such a suite could not list those as guard targets at all —
the guard looked only at the root and would report the wrong copy, or "not
installed. Run: yarn install" forever.

## Use cases to test / validate

Behavioural contract worth re-deriving rather than trusting:

- **Nearest wins.** Package-local `node_modules/@sibling/pkg` and root
  `node_modules/@sibling/pkg` both present, pointing at *different* working
  copies → the package-local one is judged. (The fixture uses two distinct
  sibling roots on purpose; one shared target would prove nothing.)
- **A registry copy shadows a link.** Package-local entry is a real directory,
  root entry is a symlink → `not-linked`, i.e. skipped. The walk must **not**
  recover to the root: Node loads the local copy, so judging the root's link
  reports staleness of code that never runs.
- **A dangling link stops the walk.** Nearest entry is a symlink whose target is
  gone, an ancestor has a good one → `unresolved` ("no longer exists", remedy
  `yarn install`), no fall-through.
- **Nothing anywhere** → `unresolved`, detail names every directory searched, in
  order.
- **The bound is the monorepo root.** A `node_modules` *above* the workspace root
  holding the package is never consulted.
- **No workspace root above `fromDir`** → walk to the filesystem root, no throw.
- **Deep `fromDir`.** `packages/cadre-host/src/__tests__` crosses a
  `src/node_modules` that does not exist and carries on to the root.
- **A plain path where a URL belongs** → `fileURLToPath` throws. Deliberate loud
  failure for a miswritten call site.
- **Windows junctions** still classify as symlinks (`lstat().isSymbolicLink()`),
  and `realpathSync` still normalises their `\\?\` target spelling. This
  checkout is Windows, so all of the above ran against real junctions.

## Verification run

All from `C:\projects\sereus` on Windows.

| command | result |
| --- | --- |
| `yarn workspace @serfab/integration-tests exec vitest run build-freshness` | 34 passed |
| `yarn workspace @serfab/cadre-core test` | 83 files, 1315 passed, 1 skipped |
| `yarn workspace @serfab/cadre-cli test` | 14 files, 164 passed |
| `yarn workspace @serfab/quereus-plugin-sereus test` | 8 files, 77 passed, 1 todo |
| `yarn workspace @serfab/reference-app-web test` | 1 file, 12 passed |
| `yarn workspace @serfab/cadre-host exec vitest run __guard_probe_no_such_spec__` | globalSetup ran, guard clean |
| `yarn workspace @serfab/{cadre-core,cadre-cli,cadre-host,quereus-plugin-sereus,reference-app-web,integration-tests} run typecheck` | all clean |
| `yarn lint` | exit 0 |

Note the harness spec's invocation: the ticket's suggested filter
`../../test-harness/build-freshness.spec.ts` matches **no** files (vitest
filters are substring matches against discovered paths, and the discovered path
is relative to the `integration-tests` root). Use the substring
`build-freshness` instead.

## Known gaps — read before signing off

- **The full `integration-tests` suite was not run.** It is slow and
  network-bound; the ticket explicitly scoped verification to the harness spec.
  Its `global-setup.ts` was exercised (that is what loads the harness spec) and
  its guard passed, but no integration scenario ran.
- **`cadre-host`'s own suite was not run**, only its `globalSetup` via a
  deliberately non-matching filter. That proves the guard resolves every target
  from the deepest `fromDir` in the repo; it proves nothing about that suite.
- **The chain's "nearest wins" behaviour has no end-to-end exercise yet.** Every
  case is covered by temp-dir fixtures in `build-freshness.spec.ts`, but no real
  call site currently lists a target that resolves package-locally —
  `reference-app-web`'s list is still the single `@serfab/cadre-core` workspace
  entry. `debt-web-app-build-guard-targets` is what turns this on for real, and
  is where a regression in the walk would first show up in anger.
- **`assertBuildFresh`'s own describe block still resolves against the real
  repository** (it uses names no install can produce), so it does not exercise
  the walk — only that the second argument is threaded and that a non-URL
  throws. The walk's coverage is entirely in the `node_modules chain` block.
- **`../quereus` was rebuilt three times during this run** because it is being
  edited concurrently by something else; the guard fired correctly each time.
  Nothing was changed in that repo beyond running its build. If the reviewer's
  suites abort with `@quereus/quereus: dist is stale`, that is the guard working,
  not a regression — run the build it names.
- **`resolveLinkedPackage`'s catch-all on `lstat` maps every failure to
  `absent`**, including permission errors, which would silently continue the
  walk rather than reporting. Pre-existing shape (it previously mapped them all
  to `unresolved`); not worsened, not fixed.

## Tripwires parked in code

- `test-harness/build-freshness.ts`, `nodeModulesChain` — `NOTE:` the walk does
  not skip ancestors already named `node_modules` the way Node's own algorithm
  does. Unreachable today (no setup module lives inside `node_modules`, and the
  extra candidate directories would have to exist to be hit); the fix, if it ever
  matters, is one basename check.
- `test-harness/build-freshness.ts`, `nodeModulesChain` — `NOTE:` cost. A handful
  of `lstat` calls per target per suite start-up, ~11 targets at most. Cache the
  chain per `fromDir` if it ever shows up; it cannot change during a run.
