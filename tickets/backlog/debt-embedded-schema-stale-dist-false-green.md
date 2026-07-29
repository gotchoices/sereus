description: Editing one of the copied-into-code database schemas and then running the test suite gives a passing result that means nothing — the tests quietly keep using the previously-built version of the schema, so a broken or even absent change looks fine.
prereq:
files: package.json (root "test" script), packages/quereus-plugin-sereus/package.json (exports point at dist/), packages/cadre-core/package.json (test script), packages/quereus-plugin-sereus/test/strand-schema-drift.spec.ts, packages/cadre-core/test/control-schema-drift.spec.ts
difficulty: easy
----

# A schema edit can pass the whole test suite without ever being loaded

## What happens

Two security-critical database schemas are kept as hand-maintained duplicate copies: a
readable `.qsql` file under `schemas/`, and a string constant compiled into TypeScript so
that React Native and other environments with no filesystem still get the schema.

`packages/cadre-core` reaches the string-constant copy through the
`@serfab/quereus-plugin-sereus` package's published entry points, which resolve to that
package's **build output** (`dist/`), not its source. Nothing in the test wiring rebuilds
first:

- the root `test` script is `yarn workspaces foreach -A run test` — `-A`, not the
  topological `-At`, so package order is arbitrary,
- and no `test` script declares a dependency on `build`.

So after editing the embedded schema in source, every test in `cadre-core` — including the
ones that stand up a real database and exercise the schema's access-control rules — runs
against whatever was last built. They pass. They prove nothing about the edit.

## Observed, not theoretical

While implementing `bug-strand-invite-no-revocation`, a new table plus a new access-control
rule were added to both copies of the strand schema. The full `cadre-core` suite reported
**938 tests passing**. The new table was not present in the running database at all. A
throwaway probe caught it with `QuereusError: Table not found: Strand.CancelledInvite`.
After `yarn workspace @serfab/quereus-plugin-sereus build`, the suite was re-run and the
new rules were genuinely exercised.

The failure mode is silent and inverted from the usual one: the *stronger* your new
constraint, the more convincingly the stale run passes, because nothing is enforcing it.

## Why the existing drift guards do not catch it

There are two text-comparison guards (`strand-schema-drift.spec.ts`,
`control-schema-drift.spec.ts`) that fail the build if the two copies of a schema diverge.
Both import the string constant from **source**, so they pass happily on a tree that was
never built. They confirm the two copies agree; they say nothing about which copy is loaded
at runtime.

## What a fix needs to guarantee

Someone who edits an embedded schema and runs the tests must not be able to get a green
result from a stale build. Any of these would do it, and the trade-offs are worth thinking
about rather than picking the first one:

- make the test wiring build-ordered (topological workspace iteration, and/or a `pretest`
  that builds the dependency),
- or have consumers resolve the plugin's source during tests (a path alias) so there is no
  build artifact in the loop at all,
- or add a check that fails loudly when the built copy of a schema differs from the source
  copy — extending the existing drift guards to compare against `dist/` as a third copy.

The same staleness applies to anything else `cadre-core` imports from that package, not only
to the schemas; the schemas are simply where a false green is most dangerous, because they
are the access-control layer.

## Scope note

This is repo-wide test-harness hygiene, not specific to the strand schema. It was found
during a strand ticket but should not be fixed inside one.
