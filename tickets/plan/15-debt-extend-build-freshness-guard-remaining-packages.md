description: Once the "stale compiled code passes tests anyway" problem is fixed for one package (`cadre-core`), the same silent-false-green risk still exists for every other package in the repo that imports another workspace or linked package's compiled output in its own tests — this is about closing that gap everywhere else too.
prereq:
files: test-harness/build-freshness.ts (after debt-embedded-schema-stale-dist-false-green lands), packages/quereus-plugin-sereus/vitest.config.ts, packages/cadre-cli/vitest.config.ts, packages/cadre-host/vitest.config.ts, packages/cadre-provider/vitest.config.ts
difficulty: easy
----

Ticket `debt-embedded-schema-stale-dist-false-green` wires a stale-build guard
(newest-source-mtime vs. newest-compiled-output-mtime, throwing with a
"run this build command" remedy) into `@serfab/cadre-core`'s own test suite, and
lifts the guard's implementation out of `packages/integration-tests` into a
shared repo-root location (`test-harness/build-freshness.ts`) so it has one home
instead of becoming a second hand-maintained copy.

`cadre-core` was fixed because that's where the false-green was actually observed
(a security-relevant schema edit that 938 passing tests never actually exercised).
The same exposure exists, unguarded, in every other package whose own test suite
imports a workspace or linked-sibling package's compiled `dist/` rather than its
source:

- `packages/quereus-plugin-sereus`'s own suite imports the linked
  `@optimystic/*`/`@quereus/quereus` packages for real (non-mocked) database
  behavior — if one of those sibling checkouts (`../optimystic`, `../quereus`)
  has edited-but-unbuilt source, this suite runs the old behavior and reports
  green.
- `packages/cadre-cli`, `packages/cadre-host`, and `packages/cadre-provider`
  each depend on `@serfab/cadre-core` and/or `@serfab/quereus-plugin-sereus` as
  workspace packages, plus some of the same linked siblings, and each has its
  own test suite that could be exercising a stale build of any of them.

Once the shared `test-harness/build-freshness.ts` module exists (exporting a
generic `assertBuildFresh(targets)` that takes a per-caller target list — see
the prerequisite ticket for its exact shape), wiring each of these packages in
should be a small, mechanical, per-package change: add a `test/global-setup.ts`
(or equivalent) with that package's own dependency list, and register it via
`globalSetup` in that package's `vitest.config.ts` — the same two-step pattern
the prerequisite ticket already uses for `cadre-core`.
