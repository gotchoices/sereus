description: Three more parts of the codebase can silently test old, unrebuilt copies of the packages they depend on — the same false-green risk already fixed once for `cadre-core` needs wiring into `quereus-plugin-sereus`, `cadre-cli`, and `cadre-host` too.
prereq:
files: test-harness/build-freshness.ts, test-harness/build-targets.ts, packages/cadre-core/test/global-setup.ts, packages/cadre-core/test/build-targets.spec.ts, packages/integration-tests/test/global-setup.ts, packages/integration-tests/test/build-targets.spec.ts, packages/quereus-plugin-sereus/vitest.config.ts, packages/quereus-plugin-sereus/package.json, packages/cadre-cli/vitest.config.ts, packages/cadre-cli/package.json, packages/cadre-host/vitest.config.ts, packages/cadre-host/package.json, root package.json (resolutions), docs/STATUS.md
difficulty: easy
----

# Background

`test-harness/build-freshness.ts` exports `assertBuildFresh(targets)`: it throws,
with a `yarn workspace <name> build` (or sibling-checkout) remedy, when a
`workspace:` or `link:`-resolved dependency's `src` was edited more recently than
its compiled `dist`. Two suites already call it from their own vitest
`globalSetup` (`packages/cadre-core/test/global-setup.ts`,
`packages/integration-tests/test/global-setup.ts`), each owning a hand-written
`TARGETS: BuildTarget[]` list, held against that package's own `package.json`
dependencies by a companion check (`test-harness/build-targets.ts`'s
`targetListProblems`) that fails the suite if the list silently falls behind —
wired per package as `test/build-targets.spec.ts`.

This ticket wires the same two-file pattern (`test/global-setup.ts` +
`test/build-targets.spec.ts`, registered via `globalSetup` in
`vitest.config.ts`) into three more suites. A fourth candidate,
`cadre-provider`, turns out **not** to need it — see below.

# Design (resolved during planning)

Researched each candidate package's `package.json` `dependencies` and actual
test imports (real symbol imports vs. type-only, `vi.mock` scope, and what each
compiled entry point transitively pulls in). Findings:

- **`cadre-provider`**: its `package.json` has **zero** `workspace:` or
  `link:`-resolved dependencies (`dockerode`, `fastify`, `commander`, `js-yaml`,
  `nanoid`, `@fastify/cors` only — all registry packages). There is nothing for
  `assertBuildFresh` to check, and wiring it in anyway would add the guard's
  filesystem-walk cost for zero benefit. **Do not touch `cadre-provider`.** (The
  `files:` list above omits it for this reason — the original ticket's guess
  that it needed wiring didn't hold up.)
- **`quereus-plugin-sereus`**: has no `@serfab/*` dependency (nothing upstream
  of it in this repo), but depends on five `link:`-resolved sibling packages —
  and its own `strand-schema-drift.spec.ts` / `test/e2e/*` tests are exactly the
  ones a stale `@quereus/quereus` checkout would silently invalidate (the
  motivating case named in the original ticket).
- **`cadre-cli`**: several `test/*.spec.ts` files import real (non-type, not
  `vi.mock`-ed) symbols from `@serfab/cadre-core` (e.g.
  `requireEd25519PublicKeyB64` in `subcommand-wiring.spec.ts`,
  `pinnedKeyTrustPolicy` in `start-pins.spec.ts`), and `../src/commands/*.ts`
  modules imported by the specs load `@serfab/cadre-core`'s compiled entry point
  at module-evaluation time regardless. That entry point in turn imports
  `@serfab/quereus-plugin-sereus`, which imports the same five linked siblings —
  so `cadre-cli`'s target list needs to be a **superset** matching what
  `cadre-core`'s own list already covers, plus `@serfab/cadre-core` itself.
- **`cadre-host`**: `package.json` declares `@serfab/cadre-cli`,
  `@serfab/cadre-core`, and `@serfab/cadre-provider` as `workspace:^`
  dependencies. Its own `src` (not just `test/__tests__`) imports real symbols
  from `@serfab/cadre-core` (`canonicalJson` in `src/update/manifest.ts`,
  `validatePushCredentials` in `src/push/index.ts`), and
  `src/auth/__tests__/trust-circle-integration.test.ts` imports and drives a
  real `CadreNode`. `src/orchestrator/host-process-orchestrator.ts` also
  resolves `@serfab/cadre-cli`'s bin path at runtime (production code path;
  today's orchestrator *tests* substitute a fake child script specifically to
  avoid needing `cadre-cli` built — see `src/__tests__/orchestrator.test.ts`'s
  own comment — so that particular target is covered defensively, matching
  `package.json`, not because a currently-passing test proves it's exercised).
  `@serfab/cadre-provider` has no dependencies of its own worth chaining
  through (see above). Via `@serfab/cadre-core`, the same five linked siblings
  and `@serfab/quereus-plugin-sereus` apply here too.

Note throughout: `@optimystic/db-p2p-storage-fs` is a `dependencies` entry on
several of these packages but is **not** in the root `package.json`'s
`resolutions` (unlike `db-core`, `db-p2p`, `db-p2p-storage-web`,
`quereus-plugin-crypto`, `quereus-plugin-optimystic`, `@quereus/quereus`, all of
which are `link:`-resolved) — it resolves to a real, registry-installed
directory in `node_modules`, not a symlink. `checkLinkedTarget` skips
non-symlinked entries unconditionally, and `distBackedDependencies` only
classifies a dependency as checkable when the root `resolutions` actually
`link:`s it — so `db-p2p-storage-fs` is never a required (or useful) target list
entry, matching `cadre-core`'s and `integration-tests`' existing lists. Don't
add it.

None of the four candidate packages set `installConfig.hoistingLimits` (unlike
`reference-app-web`, see `docs/STATUS.md` and backlog
`debt-stale-build-guard-hoisting-limited-packages`), so the plain repo-root
`node_modules` resolution `checkLinkedTarget` already does is correct as-is —
no variant of the guard is needed here.

## Target lists to wire

**`packages/quereus-plugin-sereus/test/global-setup.ts`** (new) — all `linked`,
none reachable via a `packageName` this repo declares under `packages/`:

```
{ packageName: '@optimystic/db-core', distEntry: 'dist/src/index.js', location: 'linked' },
{ packageName: '@optimystic/db-p2p', distEntry: 'dist/src/index.js', location: 'linked' },
{ packageName: '@optimystic/db-p2p-storage-web', distEntry: 'dist/src/index.js', location: 'linked' },
{ packageName: '@optimystic/quereus-plugin-crypto', distEntry: 'dist/index.js', location: 'linked' },
{ packageName: '@optimystic/quereus-plugin-optimystic', distEntry: 'dist/index.js', location: 'linked' },
{ packageName: '@quereus/quereus', distEntry: 'dist/src/index.js', location: 'linked' },
```

**`packages/cadre-cli/test/global-setup.ts`** (new) — `cadre-core`'s own list
plus `cadre-core` itself:

```
{ packageName: '@serfab/cadre-core', distEntry: 'dist/index.js', location: 'workspace' },
{ packageName: '@serfab/quereus-plugin-sereus', distEntry: 'dist/index.js', location: 'workspace' },
{ packageName: '@optimystic/db-core', distEntry: 'dist/src/index.js', location: 'linked' },
{ packageName: '@optimystic/db-p2p', distEntry: 'dist/src/index.js', location: 'linked' },
{ packageName: '@optimystic/quereus-plugin-crypto', distEntry: 'dist/index.js', location: 'linked' },
{ packageName: '@optimystic/quereus-plugin-optimystic', distEntry: 'dist/index.js', location: 'linked' },
{ packageName: '@quereus/quereus', distEntry: 'dist/src/index.js', location: 'linked' },
```

**`packages/cadre-host/src/__tests__/global-setup.ts`** (new — `cadre-host` has
no package-root `test/` dir; its specs live under `src/**/__tests__` and
`ui/__tests__`, so put this beside them rather than inventing a new
convention):

```
{ packageName: '@serfab/cadre-cli', distEntry: 'dist/bin/cadre.js', location: 'workspace' },
{ packageName: '@serfab/cadre-core', distEntry: 'dist/index.js', location: 'workspace' },
{ packageName: '@serfab/cadre-provider', distEntry: 'dist/index.js', location: 'workspace' },
{ packageName: '@serfab/quereus-plugin-sereus', distEntry: 'dist/index.js', location: 'workspace' },
{ packageName: '@optimystic/db-core', distEntry: 'dist/src/index.js', location: 'linked' },
{ packageName: '@optimystic/db-p2p', distEntry: 'dist/src/index.js', location: 'linked' },
{ packageName: '@optimystic/quereus-plugin-crypto', distEntry: 'dist/index.js', location: 'linked' },
{ packageName: '@optimystic/quereus-plugin-optimystic', distEntry: 'dist/index.js', location: 'linked' },
{ packageName: '@quereus/quereus', distEntry: 'dist/src/index.js', location: 'linked' },
```

Every `global-setup.ts` file's job is exactly `cadre-core`'s: export `TARGETS`
and a default `assertBuildFresh(TARGETS)` export, doc comment explaining why
this suite needs it (copy/adapt `packages/cadre-core/test/global-setup.ts`'s).
Each needs a companion `targetListProblems` spec, following
`packages/cadre-core/test/build-targets.spec.ts` structure exactly (3 `it`s:
coverage is `[]`, the manifest scan actually found something — pin one
`workspace` and one `linked` name specific to that package — and no duplicate
`packageName` entries).

# Edge cases & interactions

- **`quereus-plugin-sereus`'s `vitest.config.ts` uses `test.projects` (two
  inline projects, `unit` and `e2e`), not a flat `test` block.** Verify
  empirically whether a `globalSetup` declared once at the top level (sibling
  to `projects`) actually runs for both projects under this repo's Vitest 4.1.8,
  or whether each project object needs its own `globalSetup` entry. If in doubt,
  set it in **both** project blocks rather than relying on unverified
  inheritance — a guard that silently doesn't run for the `e2e` project (the one
  actually exercising the linked siblings most heavily, via
  `test/e2e/networked.e2e.spec.ts` / `strand-schema.e2e.spec.ts`) reintroduces
  exactly the false-green this ticket exists to close. Confirm by temporarily
  touching a linked sibling's `src` file's mtime (`touch ../quereus/packages/quereus/src/index.ts`
  or similar — don't actually edit content) and running each project's tests
  separately to see the guard fire, then revert.
- **`cadre-host`'s smoke tests spawn `cadre-host`'s *own* `dist/bin/host.js`**
  (`src/__tests__/cli.smoke.test.ts`, `cli-invite.smoke.test.ts`,
  `cli-nat.smoke.test.ts`) as a child process — a same-package staleness
  concern (host's own src edited without rebuilding host), not a
  cross-package one. `assertBuildFresh` / `BuildTarget` is about *other*
  packages' compiled output (see `cadre-core`'s own list deliberately excluding
  itself); this ticket's guard does not and should not try to cover a
  package's own dist staleness. Leave as-is — do not add `@serfab/cadre-host`
  to its own target list.
- **`packages/cadre-host/vitest.config.ts`'s `include` globs are
  `src/**/__tests__/**/*.test.ts` and `ui/__tests__/**/*.test.ts`** — different
  from `cadre-core`/`cadre-cli`'s `test/**/*.spec.ts`. The new
  `build-targets.test.ts` spec **must** use the `.test.ts` suffix and live
  under `src/__tests__/` (not `test/`) or Vitest will silently never collect
  it — verify with `yarn workspace @serfab/cadre-host exec vitest list --filesOnly`
  before considering this done.
- **Mutation-test each new `build-targets` spec**, the way the prior ticket did
  for `cadre-core`: temporarily delete one real entry from `TARGETS`, confirm
  the spec fails with the expected "is a workspace/linked dependency but is
  missing from the target list" message, then restore it. Passing on the first
  try with no verification that it can fail is not sufficient coverage.
- **Mutation-test `assertBuildFresh` itself** for at least one of the three new
  suites, the way the `cadre-core` ticket did: `rm -rf` (or rename) one linked
  target's `dist` and confirm `yarn workspace <name> test` fails fast naming
  that package and a build remedy, rather than running a stale/absent build
  silently; restore afterward.
- **Concurrent sibling-repo edits** (`../quereus`, `../optimystic` being
  actively developed) will make these three suites abort with a stale-build
  error the same way `cadre-core`'s and `integration-tests`' already do — this
  is the accepted, documented tradeoff (see `docs/STATUS.md`'s
  "Stale-build guard extended to the linked sibling workspaces" entry), not a
  regression to soften.
- **Don't wire `cadre-provider`.** Confirmed via `package.json` inspection
  during planning: it has no `workspace:` or `link:` dependency at all. If a
  future dependency change gives it one, that's a new, separate concern.

## Tasks

- Add `packages/quereus-plugin-sereus/test/global-setup.ts` + `test/build-targets.spec.ts`; wire into `vitest.config.ts` (both `unit` and `e2e` projects — see edge case above).
- Add `packages/cadre-cli/test/global-setup.ts` + `test/build-targets.spec.ts`; wire into `vitest.config.ts`.
- Add `packages/cadre-host/src/__tests__/global-setup.ts` + `src/__tests__/build-targets.test.ts`; wire into `vitest.config.ts`.
- Confirm (and leave a one-line note in the handoff either way) whether `cadre-provider` truly needs no changes — don't silently skip it without saying so.
- Run each of the three packages' own `yarn workspace <name> test` (not just typecheck/lint) to prove the guard is live, plus the mutation tests described above.
- `yarn typecheck` and `yarn lint` at the root.
- Update `docs/STATUS.md`'s stale-build-guard section with a short entry for the three newly-wired suites (following the existing entries' style), and note `cadre-provider` was evaluated and correctly excluded.
