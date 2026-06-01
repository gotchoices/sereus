----
description: Control schema duplicated verbatim between control.qsql and embedded constant with no sync guard
files: schemas/control.qsql, packages/cadre-core/src/control-database.ts
----
The security-critical `CadreControl` authorization schema is maintained as two independent copies that can silently drift apart.

One copy lives in `schemas/control.qsql`. The other is the embedded `CONTROL_SCHEMA` string constant in `packages/cadre-core/src/control-database.ts` (lines 19-115). The embedded copy exists for cross-platform reasons: React Native and other environments without filesystem access cannot read the `.qsql` file at runtime. `ControlDatabase.loadSchema()` (`packages/cadre-core/src/control-database.ts`, around line 246) uses the embedded `CONTROL_SCHEMA` constant by default and only reads from `schemas/control.qsql` when `config.schemaPath` is set — which in practice happens only in Node-based test overrides.

This duplication is dangerous because the two copies are not connected by any test, build step, or generation process that asserts they remain identical. A future edit to `schemas/control.qsql` that does not also update the embedded constant will silently fail to take effect at runtime: the production code path runs the stale embedded copy. Because this schema defines the authorization constraints for `AuthorityKey`, `ValidationKey`, `Strand`, `CadrePeer`, `FormationInvite`, and `FormationUsage` — the verify/signature checks that gate all control-plane mutations — a missed edit is a security regression that would not surface in normal review.

The risk is not hypothetical: the `FormationInvite` ed25519 curve discrepancy (the `verify(...)` calls in the `AuthorizedAddOrRemove` constraint omitting the explicit curve argument used elsewhere) currently exists identically in both copies, demonstrating that edits to this schema must be mirrored in two places and that nothing enforces the mirroring.

This diverges from Sereus's stated goals: the control database is the trust root for a party's cadre and strand participation, so its authorization schema is exactly the kind of security-critical artifact that must have a single, authoritative definition. Cross-platform support (the reason the embedded copy exists) and a single source of truth are both required and are currently in tension.

Expected behavior: establish a single source of truth for the control schema, or a build/test guard that fails when the two copies diverge, so that security-critical authorization-schema edits cannot silently miss the copy that actually runs in production. Acceptable resolutions include generating the embedded constant from `schemas/control.qsql` at build time, or adding a test that loads both and asserts byte-for-byte (or semantically normalized) equality. The cross-platform constraint — that React Native and other filesystem-less environments still get the schema without a runtime file read — must be preserved by whatever approach is chosen.

Key files: `schemas/control.qsql`, `packages/cadre-core/src/control-database.ts` (embedded `CONTROL_SCHEMA` at lines 19-115, `loadSchema()` and `schemaPath` handling).
