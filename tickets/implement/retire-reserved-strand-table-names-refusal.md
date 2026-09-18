description: Strand bring-up refuses an app schema that names a table like one of the strand's built-in tables (for example `Member`), because those two tables used to share storage. Optimystic now stores each schema's tables separately, so the refusal protects nothing and its error message is false. Prove the two tables stay separate, then remove the refusal and the docs that describe it.
files: packages/quereus-plugin-sereus/src/reserved-table-names.ts, packages/quereus-plugin-sereus/src/compose-strand.ts (~lines 165-171), packages/quereus-plugin-sereus/src/index.ts (line 14), packages/quereus-plugin-sereus/test/plugin.spec.ts (reserved-names describe block ~lines 530-630), packages/cadre-core/src/cadre-node.ts (foundStrand, ~lines 4776 and 4786-4788, import line 6), packages/cadre-core/test/publish-strand.spec.ts (~lines 9 and 582-591), docs/strands.md ("Reserved Table Names", ~lines 224-240), docs/schema-guide.md (line 602), docs/reference-app-rn.md (line 188), schemas/chat-simple.qsql (line 5), packages/integration-tests/src/scenarios/strand-chat-participants-converge.integration.ts (header sentence "`composeStrand` now refuses the colliding name outright")
prereq: control-collection-ids-schema-qualified-in-tests
difficulty: medium
repro: static
----
# Retire the reserved strand table-name refusal

## Background

A strand database holds two engine schemas: `Strand`, the built-in membership tables (`schemas/strand.qsql`: `Header`, `Invite`, `ConsumedInvite`, `CancelledInvite`, `Member`, `MemberPeer`, `Manager`, `Revocation`), and `App`, the sApp's own tables. Before optimystic `1208af4b` (2026-09-16), a table declared without an explicit `using optimystic('<uri>')` was stored at `tree://default/<Table>`, and the schema catalog was keyed by bare table name. So `App.Member` and `Strand.Member` opened one collection and decoded each other's rows. The chat app saw null-id phantom participants on a device. Sereus responded with `ReservedTableNameError`: `composeStrand` and `CadreNode.foundStrand` refuse an sApp schema that declares a table named like a strand table.

The module's own NOTE says the refusal stops being load-bearing once optimystic becomes schema-qualified, and should stay only if the legible error is still wanted.

Optimystic is now schema-qualified in both places (`../optimystic/packages/quereus-plugin-optimystic/src/schema/table-identity.ts`). The default location is `tree://default/<schema>/<Table>`, and the catalog key carries the schema name. Its spec `same-named-tables-across-schemas.spec.ts` pins that two same-named tables in different schemas keep separate rows.

## Decision: retire it

The fix stage weighed keeping the refusal as a legibility guard and decided against it:

- Its error message ("An app table sharing a strand table's name shares its storage") is now false. Any rewritten rationale would have to invent a new harm.
- There is no name-resolution ambiguity to guard against. Quereus's `schema_path` defaults to `main`, so neither `Strand` nor `App` tables resolve unqualified, and the reference apps already write `App.Participant` / `App.Message`.
- It restricts sApp authors (no app table may be called `Member`, `Header`, `Invite`, …) for no benefit, and AGENTS.md says there is no backwards compatibility to preserve.

Guard on the decision: first add the proof test below. If it shows the two tables still share rows in sereus's composition (for example through a sereus-side storage wrapper or catalog path that optimystic's spec does not cover), do not retire. Instead, keep the refusal, rewrite its rationale around the observed sharing, and record the finding in the review handoff.

## Proof test (write first)

Add to `packages/quereus-plugin-sereus/test/plugin.spec.ts`, using the same in-memory `composeStrand` setup the existing reserved-names tests use. Compose a strand whose sApp schema declares `table Member (Id text primary key, Name text)`, then:

- insert a row into `App.Member`, and confirm the strand's own `Strand.Member` row count is unchanged and `App.Member` reads back exactly the inserted row (no phantom rows from the other table).
- recompose the same strand on the same storage (a warm restart that goes through `hydrate`), and confirm both tables still hold only their own rows and the app table keeps its own columns.

This test replaces the refusal tests as the pin for "same name in both schemas is safe".

## Removal

- Delete `packages/quereus-plugin-sereus/src/reserved-table-names.ts`, its export at `src/index.ts:14`, and the call in `compose-strand.ts` (~line 171, with its comment ~169).
- Remove `assertNoReservedTableNames` from `CadreNode.foundStrand` (`cadre-node.ts` ~4786-4788 and the `@throws` clause ~4776) and from its import on line 6.
- Remove the refusal tests: the reserved-names describe block in `plugin.spec.ts` (~lines 530-630, the tests "reserves every table…", "refuses an sApp table named like…", "compares case-insensitively…", "refuses the `create table` spelling too", "refuses before anything is applied…", "composes a schema whose table names only contain a reserved name", "throws the parser error…", "passes an absent or empty schema"), and "refuses an sApp table named like a strand table before publishing the row" in `cadre-core/test/publish-strand.spec.ts` (~582-591, plus the import on line 9). Check whether `Parser` / `DeclareSchemaStmt` imports in the plugin become unused.
- Docs: replace `docs/strands.md` "Reserved Table Names" (~224-240) with a short paragraph saying that `Strand` and `App` tables with the same name are stored separately (`tree://default/strand/<Table>`, `tree://default/app/<Table>`) and that apps address their tables as `App.<Table>`. Keep the existing NOTE about explicit locations, reworded: an app table given an explicit `using optimystic('tree://default/strand/Member')`, or two app tables given the same explicit URI, would still share storage. Update `docs/schema-guide.md:602` (drop the "don't name an app table like…" rule), `docs/reference-app-rn.md:188` (drop the link to the removed section), and `schemas/chat-simple.qsql:5` (drop the comment line). The chat tables stay named `Participant` / `Invitation`. Renaming them back is out of scope.
- `strand-chat-participants-converge.integration.ts` header: change "`composeStrand` now refuses the colliding name outright (plugin unit suite)" to say that optimystic now stores the two tables separately. The sibling ticket `control-collection-ids-schema-qualified-in-tests` rewrites the surrounding location sentences in the same header, so merge with whatever it left.
- Grep for any remaining `ReservedTableName`, `strandReservedTableNames`, `assertNoReservedTableNames`, and "Reserved Table Names" references (including READMEs and `docs/architecture.md`) and remove them.

## TODO

- Write the proof test and run it: `yarn workspace @serfab/quereus-plugin-sereus test`. Stop and follow the guard above if it fails.
- Remove the refusal from the plugin and from `CadreNode.foundStrand`, with its tests.
- Update the docs and schema comment listed above.
- `yarn workspace @serfab/quereus-plugin-sereus test`, the `publish-strand.spec.ts` file in `@serfab/cadre-core`, `yarn lint`, and the TypeScript build for both packages.
