description: The schema guide's example queries (selects, updates with RETURNING, window functions) are never run, and several use functions or syntax the database engine does not have.
prereq: debt-schema-guide-examples-never-executed
architecture: docs/schema-guide.md
files: docs/schema-guide.md, packages/quereus-plugin-sereus/test/schema-guide-examples.spec.ts
tradeoffs: The query examples illustrate syntax rather than a schema someone copies whole, several deliberately use placeholders, and checking them means pairing each with a schema to plan against, which adds scaffolding to a compact guide for modest benefit.
----

# The schema guide's query examples are never checked

The prerequisite ticket makes every schema example in `docs/schema-guide.md` run in a test, and marks the remaining blocks `sql fragment` — shown for reading, never executed. Many of those fragments are queries, and they have the same drift problem the schema examples had. Found while planning the prerequisite (each run against an in-memory Quereus database with the crypto plugin registered, 2026-09-29):

- **Window functions**: `DigestAll(...) over (...)` fails with "Unknown window function: DigestAll".
- **Table-Valued Functions & JSON Helpers**: a comma-join that passes a column of the preceding table into `json_array_elements_text(...)` failed to plan ("<alias>.<column> isn't a column") in a probe against a stand-in table; a `cross join lateral json_each(...)` form planned. The guide's exact query was not run, since its `messages` table has no `tags` column.
- **RETURNING**: reads `body` on `messages`, but the skeleton's `messages` table (the one the section's column names come from) declares `content`, not `body`.
- **CTE**: ends in a literal `select ...;` placeholder, a parse error by design.
- `ifnull`, used in the guide before the prerequisite repairs it, does not exist in Quereus; a query example could reintroduce it with nothing to catch it.

## Expected behaviour

Query examples that claim to work are planned (not executed) against a schema, so a query using a missing function, column or unsupported form fails the same test the schema examples run under. Blocks that are placeholders on purpose stay `fragment`. The design choice to make is how a query block names the schema it runs against — for example a marker such as `sql query=<name>` referring to a named schema block — kept as light as the guide's compact style allows.
