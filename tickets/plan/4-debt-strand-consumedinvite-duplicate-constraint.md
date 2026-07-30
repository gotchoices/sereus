----
description: One of the invitation tables has the same rule written out twice under two different names, which is harmless but misleading to read.
files: schemas/strand.qsql (ConsumedInvite table), packages/quereus-plugin-sereus/src/strand-schema.ts (mirrored STRAND_SCHEMA), packages/cadre-core/src/strand-membership-writer.ts (consumeInvite doc block), docs/architecture.md
difficulty: easy
----

# `ConsumedInvite` declares the same check twice

The `Strand.ConsumedInvite` table carries two constraints with different names and a
character-for-character identical condition — both assert that the member being recorded
already has a `Member` row:

- `MemberExists`
- `MemberValid`

Same operations (both are unqualified, so both apply to insert and update), same predicate,
same effect. One of them is dead weight.

Pre-existing; noticed during review of `bug-strand-member-delete-unauthorized`, which read
this table but did not change it. No behavior consequence — the duplicate just costs an extra
evaluation and makes the table harder to read, and a reader reasonably assumes two
differently-named constraints check different things.

Drop one (keep `MemberExists`, the clearer name). Both copies of the schema must be edited
together — `schemas/strand.qsql` and the embedded `STRAND_SCHEMA` — or the drift guard in
`packages/quereus-plugin-sereus/test/strand-schema-drift.spec.ts` fails. Two prose references
name the pair and should be updated at the same time: the `consumeInvite` doc block in
`strand-membership-writer.ts` and the `consumeInvite` bullet in `docs/architecture.md`.
