description: Generalize the control-schema drift guard to also protect STRAND_SCHEMA against schemas/strand.qsql. The strand membership schema is live but currently has NO drift protection.
files: packages/cadre-core/test/control-schema-drift.spec.ts (template), packages/quereus-plugin-sereus/src/strand-schema.ts, schemas/strand.qsql, packages/quereus-plugin-sereus/src/compose-strand.ts
----

## Why

The `control-schema-drift-guard` ticket (now complete) added a test that fails the
suite whenever the embedded `CONTROL_SCHEMA` and the on-disk `schemas/control.qsql`
diverge — because a one-sided edit to a security-critical authorization schema is a
silent regression.

The **exact same duplication exists for the strand membership/RBAC schema** and is
currently **unguarded**:

- `schemas/strand.qsql` — on-disk canonical copy.
- `STRAND_SCHEMA` in `packages/quereus-plugin-sereus/src/strand-schema.ts` — the
  embedded runtime copy that actually runs in React Native / filesystem-less
  environments.

The completed `apply-strand-membership-schema` ticket verified the two are
byte-equivalent **today** (6081 chars, equal) but explicitly deferred the *guard*,
recording that it should "generalize from `control-schema-drift-guard` once that
lands. Tracked there." That ticket has now landed; this ticket is that follow-up.
The strand schema gates strand membership, invites, and RBAC writes, so unguarded
drift carries the same security risk that motivated the control-schema guard.

## Requirements

- A test (passing on current master) fails the suite whenever `STRAND_SCHEMA` and
  the relevant portion of `schemas/strand.qsql` diverge, with an actionable
  first-differing-line message naming **both** files to edit.
- Tolerate only EOL / trailing-newline / trailing-whitespace differences (same
  normalization the control guard uses) — do **not** collapse interior whitespace
  or strip comments, so any real content change trips it.

## Key wrinkle vs. the control guard (must be handled)

The control guard compared **whole file == whole constant** because `CONTROL_SCHEMA`
embeds the full `declare schema CadreControl { ... } apply schema CadreControl;`.

`STRAND_SCHEMA` is **NOT** symmetric: it holds only the **body** (the inner table
declarations). `compose-strand.ts` (`composeStrand`) wraps it in
`declare schema Strand { ... } apply schema Strand;` at runtime, whereas
`schemas/strand.qsql` contains the full wrapped form. So the guard must compare the
**body of `schemas/strand.qsql`** (the text inside `declare schema Strand { ... }`)
against `STRAND_SCHEMA` — not the whole file. Extract the body robustly (a real
brace-matched extraction, not a janky regex), or have the test wrap `STRAND_SCHEMA`
through the same `composeStrand` path and compare full-to-full. The latter is likely
cleaner and reuses existing composition logic — prefer it if practical.

## Suggested approach (design decision left to plan/implement)

The existing `control-schema-drift.spec.ts` is a ready template. Two options:

1. **Parameterize** a shared drift-check helper over `{ label, constant, qsqlPath,
   transform }` pairs (`transform` adapts for the body-only vs. full-file asymmetry),
   and drive it for both control and strand. DRY-est, but the two specs live in
   different packages (`cadre-core` vs. `quereus-plugin-sereus`), so a shared helper
   needs a sensible home (e.g. a small shared test util) — weigh that cost.
2. **Copy the spec** into `quereus-plugin-sereus` adapted for the body/compose
   asymmetry. Less DRY, zero cross-package coupling.

Pick based on whether a cross-package test util is justified for two consumers; note
a third schema copy would tip it toward option 1.

## Out of scope

Codegen / true single-sourcing of either schema (still deferred — see the control
ticket's "Known gaps"). This ticket only adds the *guard*.
