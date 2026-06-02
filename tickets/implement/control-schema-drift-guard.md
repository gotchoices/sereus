description: Add a drift-guard test asserting the embedded control schema matches schemas/control.qsql
files: schemas/control.qsql, packages/cadre-core/src/control-database.ts, packages/cadre-core/src/control-schema.ts (new), packages/cadre-core/test/control-schema-drift.spec.ts (new)
----
## Problem

The security-critical `CadreControl` authorization schema exists as two independent, hand-maintained copies with nothing enforcing they stay identical:

- `schemas/control.qsql` — the on-disk reference artifact.
- The embedded `CONTROL_SCHEMA` string constant in `packages/cadre-core/src/control-database.ts` (currently lines 19-115).

The embedded copy is the one that actually runs in production / React Native: `ControlDatabase.loadSchema()` (`control-database.ts` ~line 246) uses `CONTROL_SCHEMA` by default and only reads the `.qsql` file when `config.schemaPath` is set — which in practice never happens at runtime (no code path sets it; grep confirms `schemaPath` is only a config option, unused outside potential test overrides). So `schemas/control.qsql` is effectively documentation and the embedded constant is the live source of truth.

A future edit to `schemas/control.qsql` that misses the embedded constant silently fails to take effect at runtime. Because this schema gates every control-plane mutation (the `verify(...)` checks for `AuthorityKey`, `ValidationKey`, `Strand`, `CadrePeer`, `FormationInvite`, `FormationUsage`), a missed mirror edit is a silent security regression.

The two copies are **currently byte-identical** (line-by-line; including the known wrong-curve `FormationInvite.AuthorizedAddOrRemove` verify present in both — `control.qsql:69` / `control-database.ts:87`). So the guard test below passes on current `master`.

## Chosen approach: drift-guard test

Of the two acceptable resolutions named in the source ticket (build-time codegen vs. an equality test), use the **test**. Rationale:

- Zero changes to the monorepo build/bundle pipeline — preserves the cross-platform constraint trivially, because the hand-edited embedded constant remains the runtime source and RN still gets it with no file read.
- The vitest suite already runs in Node and can read the repo-root `.qsql` file from disk, so the guard needs no new tooling.
- Directly satisfies the requirement: any future edit to either copy that is not mirrored fails CI.

Codegen (generating the embedded constant from `control.qsql`) was considered and deferred: it would make the embedded copy a generated artifact (true single source), but it adds a generator script, a committed generated file, and prebuild wiring — and still needs an "is the generated file current?" test of equivalent complexity. Not worth the added build surface for a two-copy artifact. If a third copy of this schema ever appears, revisit codegen.

### Refactor: extract the embedded constant

To let the test import the embedded schema cleanly (and to give it a single canonical home), move the `CONTROL_SCHEMA` string out of `control-database.ts` into a new dedicated module:

`packages/cadre-core/src/control-schema.ts`
```ts
/**
 * Embedded control schema for cross-platform compatibility.
 *
 * This is the authoritative runtime copy of the CadreControl authorization
 * schema. It is duplicated from `schemas/control.qsql` so that React Native and
 * other filesystem-less environments get the schema without a runtime file read.
 *
 * The two copies MUST stay identical — `control-schema-drift.spec.ts` fails the
 * build if they drift. Any edit here must be mirrored in `schemas/control.qsql`
 * and vice versa.
 */
export const CONTROL_SCHEMA = `-- This manages a Sereus party's cadre ...
... (verbatim current contents) ...
apply schema CadreControl;`;
```

`control-database.ts` then imports it: `import { CONTROL_SCHEMA } from './control-schema.js';` and drops the inline definition (and its block comment, which moves to the new file). No behavior change. The constant stays module-internal to the package — no need to re-export from `index.ts`; the test imports it directly via `../src/control-schema.js`, matching how `schema-verification.spec.ts` imports internals.

### The guard test

`packages/cadre-core/test/control-schema-drift.spec.ts`:

- Read `schemas/control.qsql` from disk. Resolve the repo-root path relative to the test file via `import.meta.url` (vitest runs the `.ts` source under `packages/cadre-core/test/`, so `new URL('../../../schemas/control.qsql', import.meta.url)` → repo root). Use `node:fs/promises` `readFile` + `node:url` `fileURLToPath`.
- Import `CONTROL_SCHEMA` from `../src/control-schema.js`.
- Normalize both for EOL/final-newline only (the repo is checked out on Windows; git may deliver CRLF, and `.editorconfig` controls the trailing newline). Normalization must tolerate those two differences and **nothing else** — it must still catch any real content change:
  ```ts
  const normalize = (s: string) =>
    s.replace(/\r\n/g, '\n')      // CRLF -> LF
     .replace(/[ \t]+$/gm, '')    // strip trailing horizontal whitespace per line
     .replace(/\n+$/g, '')        // drop trailing blank lines / final newline
     .trimEnd();
  ```
- Assert `normalize(fileContents) === normalize(CONTROL_SCHEMA)`.
- On mismatch, produce a helpful failure message instructing the editor to mirror the change in both `schemas/control.qsql` and `packages/cadre-core/src/control-schema.ts`. A `expect(a).toBe(b)` already diffs; optionally compute the first differing line number to make the failure actionable.

Keep the per-line/trailing normalization conservative — do **not** collapse interior whitespace or strip comments, since that would let real semantic edits (e.g. a changed `verify(...)` argument) slip through.

## Interaction with in-flight tickets

Two implement tickets currently edit **both** copies by hand and rely on the editor remembering to mirror:
- `formationinvite-fix-curve-and-wire-consent` (fixes the wrong-curve `FormationInvite` verify in both copies),
- `control-key-constraints-bind-row-and-single-use-stamp` / `control-key-constraints-sign-only-stampid-replayable` (rewrite the `Authorized` constraints in both copies).

This guard is exactly the safety net for those edits: if either lands a change in only one copy, this test fails. There is **no ordering dependency** — the guard passes on current `master` and does not depend on those tickets landing first, so no `prereq:` is set. (If one of those tickets lands a one-sided edit before this guard, that is the bug this guard is meant to expose; it does not change the work here.)

## TDD / expected behavior

- On current `master` (both copies identical): `yarn workspace @serfab/cadre-core test` passes including the new `control-schema-drift` spec.
- Sanity-check the guard actually bites: temporarily mutate one character inside `CONTROL_SCHEMA` (e.g. change an `'ed25519'` to `'ed25519x'`) and confirm the spec fails; revert. (Do this manually during implementation; do not commit a flakiness/snapshot of it.)
- EOL robustness: the spec must pass whether `control.qsql` is checked out with LF or CRLF line endings.

## TODO

- [ ] Create `packages/cadre-core/src/control-schema.ts` exporting `CONTROL_SCHEMA` with the verbatim current contents of the constant from `control-database.ts:19-115` (move the explanatory block comment here, expanded to state the drift-guard invariant).
- [ ] Edit `packages/cadre-core/src/control-database.ts`: remove the inline `CONTROL_SCHEMA` definition and add `import { CONTROL_SCHEMA } from './control-schema.js';`. Confirm `loadSchema()` and all other references still resolve.
- [ ] Add `packages/cadre-core/test/control-schema-drift.spec.ts` per the design above (read `.qsql`, import constant, normalize, assert equality with an actionable mismatch message).
- [ ] Run `yarn workspace @serfab/cadre-core build` (tsc) to confirm the refactor type-checks.
- [ ] Run `yarn workspace @serfab/cadre-core test 2>&1 | tee /tmp/cadre-core-test.log` and confirm the new spec passes and nothing regressed. (Note: `seed-bootstrap.spec.ts` has a pre-existing CadrePeer-delete failure on `master` per `tickets/complete/6.6-cadre-node-admin-channel.md`; if it surfaces, follow the pre-existing-error flagging process rather than chasing it.)
- [ ] Verify the guard bites by temporarily mutating one copy, observing the failure, and reverting (do not commit the mutation).
- [ ] Write the review handoff honestly: note that the embedded copy remains hand-maintained (the guard catches drift but does not eliminate the second copy), and that codegen was deliberately deferred.
