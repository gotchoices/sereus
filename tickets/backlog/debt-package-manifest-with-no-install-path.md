description: A folder in this repo can declare which libraries it needs while having no way to ever install them, and nothing notices — the code simply fails the first time someone runs it. Add an automated check that catches that.
files: scripts/check-dep-ranges.mjs, scripts/check-stale-build-guard-wiring.mjs, package.json, ops/test/package.json, docs/testing.md
difficulty: easy
tradeoffs: Only one folder has ever been in this state and the fix ticket removes it, so this gate guards against a defect the repo may never see again — and it needs a small allowlist that someone has to keep honest.
----

# Nothing checks that a declared dependency can actually be installed

## The class of defect

A `package.json` anywhere in this repo can list `dependencies` and provide no
mechanism by which those dependencies are ever installed. Nothing catches it. The
folder looks like a working package — it has a name, scripts, a dependency list —
and the failure only appears the first time somebody actually runs the code, as a
bare `ERR_MODULE_NOT_FOUND` from Node.

That is a long feedback loop for a fully static, cheaply checkable property.

## The instance that motivated this

`ops/test/` declared 12 dependencies while being neither a registered Yarn
workspace nor a standalone project with its own install. Three of its five scripts
died at import. See `bug-ops-test-not-a-yarn-workspace` for the full account and the
repair; this ticket is the generalisation, filed separately because it lands at a
different site (`scripts/`) and should not hold up that repair.

The instance stayed invisible for a long time partly because the failure is
*partial*: Node resolves modules by walking up the directory tree, so an
unregistered folder inside the monorepo silently borrows whatever happens to be
hoisted into the root `node_modules`. Some imports resolve, some do not, and the
resolved ones can be entirely the wrong major version. The result reads like a
missing-package problem rather than a wiring problem.

## What a checker would assert

For every `package.json` in the repo outside `node_modules/`: if it declares
`dependencies` or `devDependencies`, at least one install path must exist for it.

The three install paths in use today:

- it is matched by a glob in the root `workspaces` array (everything in
  `packages/*`), or
- it carries its own lockfile — `tess/package-lock.json`, `tess/ui/package-lock.json`, or
- it is documented as a standalone `npm --prefix` install —
  `ops/docker/turn-credential-issuer`, `ops/docker/libp2p-infra`, `ops/test`.

The third path is the awkward one: "documented as" is not a machine-readable fact.
Whoever picks this up should decide how to represent it — an explicit allowlist
constant in the checker (simplest, matches how other gates here handle known
exceptions), or a marker field in the manifest itself. Manifests declaring no
dependencies at all — `test-harness/package.json` — are trivially fine and need no
entry either way.

Surveyed state at time of filing (six non-root manifests):

| manifest | deps | install path |
|---|---|---|
| `ops/docker/libp2p-infra` | 9 + 1 dev | standalone `npm --prefix` |
| `ops/docker/turn-credential-issuer` | 2 + 2 dev | standalone `npm --prefix` |
| `tess` | 4 | own `package-lock.json` |
| `tess/ui` | 6 dev | own `package-lock.json` |
| `test-harness` | none | n/a |
| `ops/test` | 12 | **none** — the defect |

Since filing, `bug-ops-test-not-a-yarn-workspace` has landed: `ops/test` now
installs standalone (`npm --prefix ops/test install`) and belongs on the third
path, not in the defect row. The table above is left as the original survey.

## Where it fits

This is the same shape as the four gates already in `scripts/`, and should join
them: a `scripts/check-*.mjs` that exits non-zero with a legible message, a
`scripts/check-*.test.mjs` driving it against a fixture tree via an env-var root
override, a `check:` and a `test:` entry in the root `package.json`, and the
`test:` entry appended to the root `test` script. `scripts/check-stale-build-guard-wiring.mjs`
and its test are the closest existing template.

Two adjacent `NOTE:` comments are worth reading first, because they mark the same
brittleness from the other side — tooling that hardcodes `packages/` while claiming
to mirror the `workspaces` field:

- `scripts/check-dep-ranges.mjs:48`
- `scripts/lib/typecheck-programs.mjs:44`

Both say, in effect, "only scans `packages/*`, which is exactly the root
`workspaces` globs today; if a second glob is ever added, teach this to read
`workspaces` instead." A checker written for this ticket should read the
`workspaces` field rather than hardcoding the glob, so it does not become the third
comment of that kind.

## Why a maintainer might decline this

The honest case against: `ops/test` is the only folder that has ever been in this
state, and once its repair lands the gate guards a set of zero. The allowlist for
standalone `npm --prefix` projects is hand-maintained, so the gate can rot into a
thing people append to without thinking. Against that: the check is small and
entirely static, the repo already carries four gates of exactly this shape, and the
defect it catches is one that hides for months and then surfaces as a confusing
module-resolution error rather than a wiring error.
