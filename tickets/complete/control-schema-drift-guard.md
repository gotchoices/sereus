description: Drift-guard test asserting the embedded CONTROL_SCHEMA matches schemas/control.qsql; CONTROL_SCHEMA extracted to its own module. Reviewed and complete.
files: schemas/control.qsql, packages/cadre-core/src/control-schema.ts, packages/cadre-core/src/control-database.ts, packages/cadre-core/test/control-schema-drift.spec.ts
----

## What shipped

The security-critical `CadreControl` authorization schema lived as two hand-maintained
copies (`schemas/control.qsql` on disk; the embedded `CONTROL_SCHEMA` string, which is the
one that actually runs since `ControlDatabase.loadSchema()` uses it by default and no runtime
path sets `schemaPath`). Nothing enforced they stayed identical, so a one-sided edit was a
silent security regression.

Shipped the **drift-guard test** (codegen deliberately deferred):

- **Extracted** `CONTROL_SCHEMA` into a new package-internal module
  `packages/cadre-core/src/control-schema.ts`; `control-database.ts` now imports it and
  dropped the 125-line inline definition. Not re-exported from `index.ts`; the test imports
  it directly via `../src/control-schema.js`.
- **Added** `packages/cadre-core/test/control-schema-drift.spec.ts`: reads
  `schemas/control.qsql` from disk, normalizes both copies for EOL/trailing-whitespace only,
  and asserts equality with an actionable first-differing-line message naming both files.

No runtime behavior change: the embedded constant remains the live source of truth; RN still
gets it with no file read.

**Implementer deviation (reviewed & endorsed):** the two copies were not byte-identical —
two comment-only cross-reference differences existed (lines 49, 69). The implementer
reconciled by adopting the **qualified** form (`…in cadre-core`) in the new embedded constant
and leaving `schemas/control.qsql` untouched. Behavior-preserving (comments never affect SQL
execution); the qualified comment is more informative and not touching the on-disk artifact
is the lower-risk direction. Confirmed correct.

## Review findings

Adversarial pass over commit `b630e52`. Read the implement diff fresh before the handoff.

**Correctness / behavior (checked — clean).**
- Re-read the full diff: extraction is faithful, `control-database.ts:204` still assigns
  `schemaContent = CONTROL_SCHEMA`. Verified `schemaPath` (the only file-read branch in
  `loadSchema()`) is set by no runtime code path, so the embedded constant is genuinely the
  live source of truth — the handoff's premise holds.
- Confirmed both on-disk `schemas/control.qsql` and `control-schema.ts` are identical under
  normalization (the spec passes).

**Guard efficacy (independently re-verified with a DIFFERENT mutation than the implementer's).**
- Weakened the `CadrePeer` replay guard (`new.UpdatedAt > …` → `>=`) directly in
  `schemas/control.qsql` (a genuinely security-meaningful change, not a literal typo) →
  the spec **failed** with the custom actionable message ("First difference at line 73 …
  Mirror your edit in BOTH …"). Reverted `schemas/control.qsql` clean afterward. The guard
  bites on real semantic drift, not just the implementer's chosen mutation.

**Normalization over-tolerance (checked — safe).** The per-line trailing-whitespace strip
cannot mask a semantic change because every string literal in the schema is single-line; SQL
is whitespace-insensitive at line ends. CRLF→LF handles the autocrlf checkout. It does not
collapse interior whitespace or strip comments, so content changes still trip it.

**Lint / typecheck / tests (run — all green).**
- `npx eslint` on the three touched files → **0 errors** (3 warnings, all pre-existing in
  `control-database.ts` at lines 144/147/191, outside the diff region).
- `yarn workspace @serfab/cadre-core typecheck` (covers src + test) → clean.
- `yarn workspace @serfab/cadre-core test` → **306 passed (23 files)**, incl. the new spec.
  No `.pre-existing-error.md` needed — suite fully green.

**Docs (checked).** The new block comments in `control-schema.ts` and the spec accurately
describe the invariant and the runtime-vs-reference roles. Minor imprecision ("fails the
build" — strictly it fails the test suite, which gates merges); not worth an edit.

**Minor findings fixed inline:** none — nothing warranted an inline change.

**Major findings → new ticket filed:**
- **`tickets/plan/strand-schema-drift-guard.md`** — the parallel `STRAND_SCHEMA` ↔
  `schemas/strand.qsql` duplication is **live but unguarded**. The completed
  `apply-strand-membership-schema` ticket explicitly deferred this guard and recorded it as
  "Tracked there" (i.e. via this ticket). Filed the follow-up so that tracking link does not
  break. The ticket flags the key asymmetry the control guard didn't face: `STRAND_SCHEMA` is
  body-only and wrapped by `composeStrand` at runtime, so the strand guard must compare the
  *body* of the `.qsql`, not the whole file.

## Known gaps (carried forward, by design)

- **The second copy is still hand-maintained.** This guard *catches* drift; it does not
  *eliminate* duplication. True single-source needs codegen — deferred as not worth the build
  surface for a two-copy artifact.
- **Path coupling:** the spec hard-codes `../../../schemas/control.qsql`; a move throws ENOENT
  (loud failure, not a silent pass) — acceptable.
