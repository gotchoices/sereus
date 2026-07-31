---
description: The check that stops tests from running against an out-of-date build only looks for shared libraries in one central folder, so it goes blind for any project that keeps its own copy of its libraries; make it look in the folders that project actually uses.
files: test-harness/build-freshness.ts, test-harness/build-freshness.spec.ts, packages/cadre-core/test/global-setup.ts, packages/cadre-cli/test/global-setup.ts, packages/cadre-host/src/__tests__/global-setup.ts, packages/quereus-plugin-sereus/test/global-setup.ts, packages/reference-app-web/test/global-setup.ts
difficulty: medium
---

# Resolve `linked` guard targets through the consuming package's own `node_modules` chain

## Background

`test-harness/build-freshness.ts` fails a test run up front when a package the
suite runs *compiled* code from has sources newer than its build output. It
handles two kinds of target:

- `workspace` — a package under this repo's `packages/`, found by scanning that
  directory. Unaffected by this ticket.
- `linked` — a package from a sibling checkout (`../optimystic`, `../quereus`)
  that reaches `node_modules` as a symlink, courtesy of the root manifest's
  `link:` resolutions.

Today `checkTarget` resolves every `linked` target through `repoNodeModules()` —
the repository root's `node_modules`, and nowhere else. There is already a `NOTE`
on that function predicting exactly the failure below.

## The problem

`packages/reference-app-web` (and `reference-app-ns`, and `reference-app-rn`)
declare `installConfig.hoistingLimits: "workspaces"`, so yarn installs their
dependencies into their *own* `packages/<app>/node_modules` rather than hoisting
them to the root. Verified on this checkout:

```
packages/reference-app-web/node_modules/@optimystic/db-core            -> ../../../optimystic/packages/db-core
packages/reference-app-web/node_modules/@optimystic/db-p2p            -> ...
packages/reference-app-web/node_modules/@optimystic/db-p2p-storage-web -> ...
packages/reference-app-web/node_modules/@quereus/quereus              -> ...
```

A suite in such a package therefore cannot list its sibling dependencies as
guard targets at all: the guard would look only at the repo root and report
either the wrong copy or "not installed. Run: yarn install" forever. The root
happens to carry symlinks for these four *today*, but that is incidental — it is
not where this package resolves them from, and nothing keeps it true.

## The fix

Resolve a `linked` target by walking the real Node resolution chain: from the
directory of the calling `global-setup` module, check `<dir>/node_modules/<pkg>`
at that directory and at each ancestor, up to **and including** the monorepo
root. First directory that has an entry wins — whatever that entry turns out to
be. Do not keep searching past it: that entry is what Node itself would resolve,
so it is the one whose freshness matters.

The existing per-directory classification is unchanged and still correct — a
symlink is a working copy worth judging, a real directory is a registry install
whose `src`/`dist` mtimes are packing artifacts and must be skipped, not judged.

### Interfaces

Split the "what is at this one path" question from the "which path" question, so
the walker can tell *absent here, keep looking* from *present but unusable*:

```ts
/** What `node_modules/<pkg>` turned out to be, once one was found. */
export type LinkedPackage =
	| { readonly status: 'linked'; readonly root: string }
	| { readonly status: 'not-linked' }
	| { readonly status: 'unresolved'; readonly detail: string };

/** Adds the one state only a single-directory lookup can report. */
export type NodeModulesEntry =
	| LinkedPackage
	/** Nothing at this path — the walk should continue to the next ancestor. */
	| { readonly status: 'absent' };

/** Classifies one `node_modules` directory's entry. */
export function resolveLinkedPackage(nodeModulesDir: string, packageName: string): NodeModulesEntry;

/** Walks the `node_modules` chain above `fromDir` and classifies the first hit. */
export function resolveLinkedPackageFrom(fromDir: string, packageName: string): LinkedPackage;

/** `fromDir` is the consuming suite's directory, not a `node_modules` path. */
export function checkLinkedTarget(fromDir: string, target: BuildTarget): string | undefined;

/**
 * `setupUrl` is the calling setup module's own `import.meta.url` — the guard
 * derives the directory to resolve `linked` targets from.
 */
export function assertBuildFresh(targets: readonly BuildTarget[], setupUrl: string): void;
```

`assertBuildFresh` gains a **required** second parameter rather than defaulting
to the repo root: a silent default reinstates exactly the blind spot this ticket
removes, and every call site is in this repo (five of them), so there is nothing
to keep compatible.

The chain's upper bound is `findWorkspaceRoot(fromDir)`, inclusive. When that
returns `undefined` (no ancestor declares `workspaces` — only reachable from
temp-dir fixtures), walk to the filesystem root instead of throwing; a guard that
crashes on an odd layout is worse than one that searches a little too far.

When the whole chain comes up empty, the message stays actionable and names what
was searched:

```
@optimystic/db-core: not installed (looked in <dir1>, <dir2>, …). Run: yarn install
```

`repoNodeModules()` and its `NOTE` about package-local installs both go away —
the note described this ticket.

## Call sites

Five, all of the form `assertBuildFresh(TARGETS)` → `assertBuildFresh(TARGETS, import.meta.url)`:

- `packages/integration-tests/test/global-setup.ts`
- `packages/cadre-core/test/global-setup.ts`
- `packages/cadre-cli/test/global-setup.ts`
- `packages/cadre-host/src/__tests__/global-setup.ts` (two directories deeper —
  the chain crosses `src/node_modules`, which does not exist, and carries on)
- `packages/reference-app-web/test/global-setup.ts`

All five resolve to the repo root's `node_modules` today and must keep doing so
after the change; only `reference-app-web` has a package-local one to find first,
and its target list is not expanded here — that is the follow-on ticket
`debt-web-app-build-guard-targets`.

## Edge cases & interactions

- **Nearest wins over the root.** Both `packages/app/node_modules/@sibling/pkg`
  and `<repo>/node_modules/@sibling/pkg` present, pointing at *different*
  working copies: the package-local one is judged. Prove it with two distinct
  sibling roots, not one — a fixture where both links share a target proves
  nothing.
- **A registry copy shadows a link.** Package-local entry is a real directory
  while the root entry is a symlink: result is `not-linked`, i.e. skipped. The
  walk must not "recover" by continuing to the root — Node would load the local
  copy, and judging the root's link would report staleness of code that never
  runs.
- **A dangling symlink stops the walk.** Nearest entry is a symlink whose target
  no longer exists, an ancestor has a good one: report `unresolved` ("no longer
  exists", remedy `yarn install`), do not fall through.
- **Nothing anywhere.** `unresolved`, and the detail names every directory
  searched, in order.
- **The bound is the monorepo root.** A `node_modules` *above* the workspace
  root holding the package must not be consulted. Fixture:
  `<tmp>/node_modules/@sibling/pkg` plus `<tmp>/repo/package.json` declaring
  `workspaces`, searching from `<tmp>/repo/packages/app/test` → `unresolved`.
- **No workspace root above `fromDir`.** Walk to the filesystem root; no throw.
  This is the shape the existing `linked sibling packages` fixtures have.
- **Windows junctions.** `lstat().isSymbolicLink()` already reports true for the
  junctions yarn writes on Windows; keep the existing `realpathSync` handling
  (it normalises the `\\?\` prefix) and do not regress it — this repo's primary
  checkout is Windows.
- **`fromDir` is a directory, `setupUrl` is a URL.** `fileURLToPath` throws on a
  plain path; that is the desired loud failure for a miswritten call site, not
  something to catch.
- **Cost.** The walk is a handful of `lstat` calls per target per suite start-up
  (at most ~11 targets). No caching needed; if it ever shows up, cache the
  resolved chain per `fromDir`.

## Tests

Extend `test-harness/build-freshness.spec.ts`. The existing `linked sibling
packages` block passes `nodeModules` as `checkLinkedTarget`'s first argument —
update those calls to pass the fixture's `tmp` directory instead, so they
exercise the walk rather than accidentally landing on a `node_modules` path. The
existing `resolveLinkedPackage` cases stay as single-directory cases; move the
"not installed at all" case to `resolveLinkedPackageFrom` and add an `absent`
case for the single-directory function.

New fixture for the chain, mirroring the real layout:

```
<tmp>/node_modules/@sibling/pkg                      -> above the repo root; must NOT be found
<tmp>/repo/package.json                              (declares `workspaces`)
<tmp>/repo/node_modules/@sibling/pkg                 -> <tmp>/hoisted
<tmp>/repo/packages/app/node_modules/@sibling/pkg    -> <tmp>/local
<tmp>/repo/packages/app/test                         (the `fromDir`)
```

Cases, expected results:

- both installs present → `{ status: 'linked', root: <tmp>/local }`
- package-local absent, root present → `{ status: 'linked', root: <tmp>/hoisted }`
- package-local is a real directory, root is a link → `{ status: 'not-linked' }`
- package-local link dangles, root link is good → `unresolved`, detail contains
  "no longer exists"
- neither present → `unresolved`, detail contains "not installed" and both
  searched `node_modules` paths
- only `<tmp>/node_modules` (above the repo root) has it → `unresolved`
- stale `<tmp>/local` → `checkLinkedTarget(fromDir, …)` reports "dist is stale"
  and names `<tmp>/local`, not `<tmp>/hoisted`

`assertBuildFresh`'s own describe block needs the new second argument;
`import.meta.url` of the spec file is the natural value there.

## TODO

- Add `NodeModulesEntry` with the `absent` state; narrow `LinkedPackage` to the
  three states a completed lookup can produce. Update the doc comments.
- Make `resolveLinkedPackage` return `absent` instead of `unresolved` when
  nothing is at the path; keep the dangling-symlink case as `unresolved`.
- Add the chain walker: candidate `node_modules` directories from `fromDir` up
  to `findWorkspaceRoot(fromDir)` inclusive, or the filesystem root when there is
  none. First non-`absent` classification wins.
- Add `resolveLinkedPackageFrom(fromDir, packageName)` returning the first hit,
  or `unresolved` naming every directory searched.
- Change `checkLinkedTarget`'s first parameter to `fromDir` and route it through
  the walker.
- Add the required `setupUrl` parameter to `assertBuildFresh`; thread the derived
  directory through `checkTarget` to `checkLinkedTarget`. Workspace targets are
  untouched.
- Delete `repoNodeModules()` and its stale `NOTE`; refresh the module header so
  it describes the chain rather than the root-only lookup.
- Update the five `assertBuildFresh(TARGETS)` call sites to pass
  `import.meta.url`.
- Rewrite the affected parts of `build-freshness.spec.ts` and add the chain
  cases above.
- Verify. `test-harness/**/*.spec.ts` is run by the **integration-tests** suite
  (its `vitest.config.ts` `include` reaches back up to the repo root), and that
  suite's full run is slow and network-bound — run just the harness spec:
  `yarn workspace @serfab/integration-tests exec vitest run ../../test-harness/build-freshness.spec.ts 2>&1 | tee /tmp/harness.log`.
  Then `yarn workspace @serfab/cadre-core test`, `yarn workspace
  @serfab/reference-app-web test`, `yarn workspace @serfab/cadre-cli test`,
  `yarn workspace @serfab/quereus-plugin-sereus test`, and `yarn lint`. Stream
  every one with `2>&1 | tee`, never a silent redirect.
