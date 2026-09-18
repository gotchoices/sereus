description: Strand bring-up no longer refuses an app schema that names a table like one of the strand's built-in tables (for example `Member`). Optimystic now stores the two tables separately, and a new test proves they keep their own rows, including after a restart. Review the removal and the rewritten docs.
files: packages/quereus-plugin-sereus/test/plugin.spec.ts ("an sApp table named like a strand table" describe block), packages/quereus-plugin-sereus/src/compose-strand.ts, packages/quereus-plugin-sereus/src/index.ts, packages/quereus-plugin-sereus/README.md (`schema` option row), packages/cadre-core/src/cadre-node.ts (foundStrand, import line 6), packages/cadre-core/test/publish-strand.spec.ts, docs/strands.md ("Same-Named Tables in `Strand` and `App`"), docs/schema-guide.md, docs/reference-app-rn.md, schemas/chat-simple.qsql, schemas/chat.qsql, packages/reference-app-rn/src/chat-strand.ts, packages/integration-tests/src/scenarios/strand-chat-participants-converge.integration.ts (header)
difficulty: easy
----
# Review: retire the reserved strand table-name refusal

## What changed

A strand database holds two engine schemas: `Strand` (built-in membership tables) and `App` (the sApp's tables). Sereus used to refuse an sApp schema that declared a table named like a `Strand` table (`ReservedTableNameError`, raised by `composeStrand` and `CadreNode.foundStrand`), because optimystic once stored both `Member` tables in one collection. Optimystic (from `1208af4b`) now stores a table with no explicit location at `tree://default/<schema>/<Table>` and keys its catalog record by schema and name. That made the refusal unnecessary and its error message false, so it is removed:

- Deleted `packages/quereus-plugin-sereus/src/reserved-table-names.ts` and its export from `src/index.ts`, plus the stale compiled copies in `dist/`.
- `composeStrand` no longer calls `assertNoReservedTableNames`. The doc comment's step list is updated.
- `CadreNode.foundStrand` no longer calls it. Its `@throws` clause and import are updated.
- Removed the 8 refusal tests in `plugin.spec.ts` and the one in `publish-strand.spec.ts`.
- Docs: the `docs/strands.md` "Reserved Table Names" section is replaced by "Same-Named Tables in `Strand` and `App`". The rule is removed from `docs/schema-guide.md`, the link from `docs/reference-app-rn.md`, and the "not `Member` because…" comments from `schemas/chat-simple.qsql`, `schemas/chat.qsql` and `packages/reference-app-rn/src/chat-strand.ts`. The plugin README's `schema` option row now links the new section. The integration-test header now says optimystic stores the two tables separately. It builds on the location sentence the sibling ticket `control-collection-ids-schema-qualified-in-tests` wrote there. The chat tables stay named `Participant` / `Invitation`.

## Proof test (the guard on the decision)

`plugin.spec.ts` → "an sApp table named like a strand table" → "keeps its rows apart from the strand table, and across a warm restart". It uses the `local` transactor over one `MemoryRawStorage`, with the libp2p node mocked the way the rest of the file does:

- Cold session: apply the sApp schema `table Member (Id text primary key, Name text)`. Insert a closed-strand `Strand.Header`, the founding `Strand.Member` (`m1`), then `App.Member` (`a1`, `Alice`). `select * from App.Member` must equal exactly `[{Id:'a1', Name:'Alice'}]`, which also pins its column set. `Strand.Member` must hold exactly its own row.
- Warm session: a new `Database` over the same storage. `hydrated.tables` must equal the cold session's `Strand` + `App` table count, read from Quereus's `schema()` function. A catalog keyed by bare table name holds one `Member` record for both tables, so it would hydrate one table fewer. Both tables must again hold only their own rows.

**Negative check, run by hand and then reverted:** declaring the app table as `table Member using optimystic('tree://default/strand/Member') (…)`, which forces the shared location, makes the test fail with an extra `{Id: null, Name: null}` row in `App.Member`. That is the null-id phantom participant the chat app showed. So the test detects sharing, and the default location keeps the tables apart. The ticket's guard ("if the tables still share rows, keep the refusal") therefore did not trip.

## Validation run

- `yarn workspace @serfab/quereus-plugin-sereus test`: 10 files, 113 passed, 1 todo.
- `packages/cadre-core`: `npx vitest run test/publish-strand.spec.ts`: 39 passed.
- `yarn lint`: clean.
- `build` and `typecheck` for `@serfab/quereus-plugin-sereus` and `@serfab/cadre-core`: clean.
- Not run: the full cadre-core suite, the integration tests (only a comment changed there), and the reference-app builds (only a comment changed).

## Gaps and things worth a second look

- **Only the `local` transactor is exercised.** Apps run on `network`. The storage location and catalog key are derived in optimystic independently of the transactor, so I expect the same result, but no sereus test runs this on `network`. `strand-chat-participants-converge.integration.ts` covers real networks, but under the renamed `Participant` table, not `Member`.
- **Trailing `using` is silently ignored.** A trailing `using optimystic(…)` after a declared table's column list is dropped without error. Quereus's declare-schema parser treats it as an unrecognized item (`declareIgnoredItem` in `../quereus/packages/quereus/src/parser/parser.ts`, which has its own NOTE accepting this). My first negative check used that spelling and passed for that reason. The `docs/strands.md` NOTE now says the clause goes before the column list. Nothing is filed, because the behaviour is upstream and already acknowledged there.
- **Explicit locations can still share storage.** The explicit-location hole carries over from the old section, now as a NOTE in `docs/strands.md`. Two app tables, or an app table and a strand table, given the same explicit URI still share one collection. Optimystic refuses such a pairing only once the collection holds rows.
- `git rm` staged the deletion of `reserved-table-names.ts`. Everything else is unstaged.
