description: Make every schema example in the schema guide run against the real database engine in a test, and fix the examples, most of which the engine rejects as written today.
architecture: docs/schema-guide.md
files: docs/schema-guide.md, packages/quereus-plugin-sereus/test/schema-guide-examples.spec.ts (new), packages/quereus-plugin-sereus/package.json, packages/quereus-plugin-sereus/src/compose-strand.ts, packages/quereus-plugin-sereus/src/connect.ts, schemas/strand.qsql, docs/testing.md
----

# Execute the schema guide's examples in a test, and repair them

`docs/schema-guide.md` teaches schema authoring through fenced SQL blocks. Nothing runs them, and a probe during planning (each block run against an in-memory Quereus `Database`, with the Sereus crypto plugin registered) found that **every executable-looking block fails as written**. This ticket adds the guard and repairs the guide so the guard passes.

## What the probe found (measured, 2026-09-29, against the linked `@quereus/quereus` dist)

The failures are far wider than the two classes the original ticket named:

- **The `schema "<name>" version 1 using (...) { ... }` header is not Quereus grammar.** Quereus parses `declare schema <identifier> [version '<string>'] [using (...)] { ... }` (`../quereus/packages/quereus/src/parser/parser.ts` → `declareSchemaStatement`). Eleven blocks start with the fictional header and fail on their first token. More to the point, a Sereus app author never writes a wrapper at all: they pass a schema *body* (bare `table` / `index` / `view` / `seed` / `assertion` items) as the `schema` option, and `applyAppSchema` in `packages/quereus-plugin-sereus/src/compose-strand.ts` wraps it in `declare schema App { ... } apply schema App;`. `schemas/chat-simple.qsql` is written that way. The sApp's name and version are the plugin settings `sapp_id` / `sapp_version` (see the `quereus.settings` block in the plugin's `package.json`), and the storage module is set by the composition (Optimystic), not by the author.
- **Seed syntax.** Rows must be wrapped in one outer pair of parentheses: `seed roles (('admin'), ('member'))` or `seed roles values (code) values (('admin'), ('member'))`. The guide's `seed roles (code) values ('admin'),('member')` and the workflow block's unparenthesised rows fail to parse (four blocks).
- **`ifnull` does not exist** in Quereus (`Function not found: ifnull/2`); use `coalesce`. Hits the orders and assertions blocks — and the assertion one fails at apply time.
- **`create unique index` / `create assertion` inside a declaration block only work by accident.** `create` is not an item keyword, so the parser swallows it as an *ignored item* and then parses `unique index …` / `assertion …` as the next item. The same mechanism silently drops a typo'd item: `tabel x (a int)` inside a block parses to a `declareIgnored` item and never creates anything (verified). Write the items as `unique index …` and `assertion …`.
- **Undeclared context variables.** A table that reads a mutation-context variable — bare (`default actor_name`) or qualified (`context.current_tenant_id`) — must declare it in `with context ( ... )`. Undeclared, a bare `default actor_name` fails at apply ("may not reference a bare column"), but a `check (tenant = context.current_tenant_id)` **applies cleanly** and only fails on the first write. Affects the Roles & Permissions, Audit & Security, and Putting It All Together blocks.
- **Functions that do not exist.** `has_role`, `verify_signature`, `SignatureValid`, `endswith` are not registered. `digest` and `verify` are (the crypto plugin, registered by every strand; function names resolve case-insensitively, so `Digest` resolves).
- **A column that does not exist.** The orders block's `within_limit` check reads `customers.credit_limit`; `customers` declares no such column.
- **A nullability contradiction.** Putting It All Together declares `tenant text` (NOT NULL by default) and then checks `tenant is null or …`; it needs `tenant text null`.

## The key engine fact the guard has to work around

**Quereus compiles CHECK constraints when a write is planned, not when the table is created.** A check calling an unknown function, reading an undeclared context variable, or naming a missing column in a subquery all pass `apply schema` and `db.prepare(...)` and fail only when an insert or update is planned. So "the block applied" proves little. `db.getPlan(sql)` does surface them without executing anything (verified for all three classes; a `check on delete` surfaces only when a `delete` is planned). Defaults, generated columns and assertions *are* validated at apply time — which is how the original `default datetime('now')` defect is caught.

## Design (settled)

### Fence markers

Every fenced code block in `docs/schema-guide.md` carries an info string of exactly one of:

- ```` ```sql schema ```` — an sApp schema body, exactly what an app passes as `schema`. Executed.
- ```` ```sql script ```` — a complete statement sequence, run as-is. For the opening "Declarative workflow" block, which demonstrates raw Quereus `declare` / `diff` / `apply` / `explain`.
- ```` ```sql fragment ```` — shown for reading, never executed: lone constraint lines, queries against tables the block does not declare, placeholders.

Any other fence (no info string, bare `sql`, an unknown marker) fails the test, naming its heading, so a newly added block forces its author to choose. Renderers use only the first word of the info string for highlighting, so `sql schema` still highlights as SQL. Explicit markers were chosen over inferring from content because several fragments look like schema (a lone `table …`, lone `constraint` lines) and inference would either execute them or silently skip real schema.

Checking the *query* examples (`fragment` blocks that are queries) is parked in `backlog/debt-schema-guide-query-examples-unchecked`; this ticket covers schema only.

### Extracting the blocks

Use a real Markdown parser — AGENTS.md rules out hand-rolled parsers. Add [`marked`](https://www.npmjs.com/package/marked) as a devDependency of `@serfab/quereus-plugin-sereus` (zero runtime dependencies) and walk `marked.lexer(source)`: track the most recent `heading` token's text, and collect each `code` token's info string (`token.lang` holds the whole info string in current `marked`; confirm on the installed version) and `text`. Name each block `<heading> #<n>`, where `n` counts blocks under that heading — several headings hold more than one block. No existing Markdown parser is in the tree (checked `node_modules`); run `yarn check:dep-ranges` after adding it.

### Harness, per block, each in a fresh `Database`

Blocks reuse table names (`events`, `users`, `messages`), so no state is shared.

1. `new Database()` (default storage module is `memory`, which is what we want — no strand runtime), register the crypto plugin exactly as the Node platform does (`registerPlugin(db, cryptoPlugin)` with `@optimystic/quereus-plugin-crypto/plugin`, see `packages/quereus-plugin-sereus/src/connect.ts`), and register stubs for the functions the guide says the application supplies. After the repairs below that is only `has_role(token, role)`; a stub must be flagged deterministic or the determinism gate rejects the CHECK that calls it. Keep the stub list in the test with a one-line comment each.
2. `script` blocks: `await db.exec(text)`. Done.
3. `schema` blocks:
   - Parse `declare schema App { <body> }` with Quereus's exported `Parser` (`new Parser().parseAll(...)`) and fail if any item has type `declareIgnored` — this is what catches `create …` inside a block and typo'd item keywords, which would otherwise pass silently. The wrapper string is a second copy of the one in `applyAppSchema`; say so in a comment.
   - `await applyAppSchema(db, body)` — the exact function Sereus uses, so a change to the wrapper is exercised too.
   - `await db.exec('apply schema App with seed')` — the declarative diff is already applied, so this only inserts seed rows (idempotent `on conflict do nothing`), validating that seed literals satisfy their table's types and constraints. Sereus itself does not apply seeds today; see the seed note under "Guide repairs".
   - For every table in schema `App` (via `db.schemaManager.getSchema('app')`; `TableSchema` has `columns[].name`, `columns[].generated`, `mutationContext[].name`), `db.getPlan(...)` three statements using `?` placeholders for every value: an `insert` listing every non-generated column, an `update` setting one non-generated column, and a `delete`. When the table declares context variables, each statement carries `with context <var> = ?` for every one of them — without it the plan fails with "requires mutation context variable". All three forms were verified to plan: `insert into T (…) with context x = ? values (…)`, `update T set a = ? with context x = ?`, `delete from T with context x = ?`.
   - For every view in schema `App`, `db.getPlan('select * from App.<view>')`.
4. One `it` per block (`it.each` over the extracted list), so each broken example reports on its own line with its name and the engine's message.
5. Before the per-block cases, assert the extraction found at least one `schema` block and zero unmarked fences — a renamed file or a parser change must fail loudly, not pass on an empty list.

The spec lives at `packages/quereus-plugin-sereus/test/schema-guide-examples.spec.ts`, in the plugin's existing `unit` Vitest project, which already has the stale-build `globalSetup` and is already covered by `tsconfig.typecheck.json` (`include: ["src", "test", …]`). No new project, no new wiring. Read the guide by path relative to the spec file (`../../../docs/schema-guide.md`), resolved from `import.meta.url`.

### Guide repairs

Listed by heading (line numbers drift). The two `### Id immutability` examples, the causal `Message` table and the Views and Generated Columns blocks need only the header change.

- **Top of the guide**: add a short paragraph saying the `schema` examples are sApp schema bodies — what you pass as the `schema` option; Sereus wraps them as `declare schema App { … }` and supplies the storage module; the sApp name/version are the `sapp_id` / `sapp_version` settings — and that `packages/quereus-plugin-sereus/test/schema-guide-examples.spec.ts` executes every `sql schema` and `sql script` block, with the three markers explained in one line each. Remove "`using memory` (or another vtab) selects the storage module" from the characteristics list or reword it to say the composition chooses it.
- **Declarative workflow** (`script`): fix the seed rows' parentheses. Also add a sentence right after it that inside Sereus you write only the body, pointing to the paragraph above.
- **Every `schema "…" version 1 using (…) { … }` block**: drop the header and closing brace, leaving the body (un-indented one level).
- **Minimal Strand Schema Skeleton**: seed syntax; the comment "Seed minimal roles & an admin user" seeds only a user — make it match.
- **Roles & Permissions**: add `with context (current_tenant_id text, auth_token text)`; the stub `has_role` remains an app-supplied UDF as the prose says.
- **Integrity** (orders): `ifnull` → `coalesce`; add `credit_limit real` to `customers`. The lone-constraint "Id immutability / delete guards" block becomes `fragment`.
- **Indexes**: `create unique index` → `unique index`.
- **Ordering Events**: split the `events` block into a `schema` block (the table with its `with context`) and a `fragment` for the `insert … with context now_iso = datetime('now') …` line. The `select … order by Timestamp` block is `fragment`.
- **CTE, Set operations, RETURNING, Table-Valued Functions, LATERAL, Window functions**: `fragment`.
- **Global Assertions**: `create assertion` → `assertion`; `ifnull` → `coalesce`.
- **Audit & Security**: add `with context (actor_name text, operation_signature blob, current_tenant_id text, …)`; replace the invented `verify_signature(...)` with the idiom Sereus actually provides and `schemas/strand.qsql` uses — `verify(digest(<fields>), <signature>, <public key>, 'ed25519')` — which needs the signer's public key as another context variable. Adjust the "(via UDFs)" comment accordingly.
- **Seeds**: seed syntax; and state plainly that the Sereus plugin applies an sApp schema without `with seed` (`applyAppSchema`), so seed items do not insert rows into a strand today — whether they should is an open decision (`tickets/blocked/decide-sapp-schema-seed-rows.md`). Also soften the "Use seeds for deterministic bootstrap" bullet under Practical Guidance to match.
- **Putting It All Together**: seed syntax; `create unique index` / `create assertion` → item forms; `tenant text null`; `with context (current_tenant_id text)` on `conversations`.
- **Additional Coverage — Explicit table context declaration**: replace `SignatureValid(Digest(Tid, id, data), …)` with `verify(digest(Tid, id, data), context.signature, context.user_key, 'ed25519')`; the context variable types should match what `verify` takes (check `schemas/strand.qsql` for the column types it uses for signatures and keys).
- **Additional Coverage — VALUES-based enum/view**: `schema` (a lone view is a valid body; verified it applies and plans).
- **Additional Coverage — Utility validation functions**: `endswith(at, 'Z')` does not exist; use `substr(at, -1) = 'Z'` or `at like '%Z'`.

Keep the prose compact; this is a repair, not a rewrite. Keep SQL reserved words lowercase.

### Docs

Add one bullet to `docs/testing.md` → "Lint coverage", alongside the other "also a test, not lint" guards (for example the Hermes polyfills bullet): what the spec checks, the three fence markers, and that CHECK constraints are only validated by planning a write, which is why the harness plans insert/update/delete per table.

## Edge cases & interactions

- **Unmarked or unknown-marker fence** → fails, naming the heading. Verified by the pre-loop assertion and by inspection.
- **Empty extraction** (file renamed, parser change) → fails via the "at least one `schema` block" assertion.
- **Silently ignored declaration items** (`create …`, a misspelled item keyword) → fails via the `declareIgnored` parse check. Confirm once by temporarily writing `tabel` in a block.
- **CHECK constraints compile lazily** → covered only by `getPlan` on insert and update; `check on delete` only by the delete plan. Confirm once by temporarily removing a `with context` clause from a repaired block: the apply must still pass and the insert plan must fail.
- **Declared context variables** → every planned statement must supply all of them, or the plan fails for the wrong reason. The Explicit-table-context block (three variables) exercises this.
- **Generated columns** (articles `slug`, messages `slug`) → excluded from the insert column list and the update target; inserting into a generated column is itself an error.
- **A table with only key columns** → the update has no non-key column to set; set the first non-generated column even if it is a key column.
- **Assertions and defaults** are validated at apply time; no planning needed. Confirm once by temporarily restoring `default datetime('now')` in one block — the test must fail with the determinism error. This is the class the original ticket was filed for.
- **Seed rows** are checked by `apply schema App with seed`, even though Sereus does not apply seeds; the guide text must not claim otherwise.
- **Blocks sharing table names** → each block gets a fresh `Database`.
- **Windows line endings** → `marked` normalises them; don't hand-split on `\n`.
- **Stale sibling `dist`** → the spec runs under the existing `globalSetup` guard. If it reports `@quereus/quereus` or `@optimystic/quereus-plugin-crypto` stale, stop and record that in the handoff; do not build siblings.
- **`feat-shared-causal-history-for-sapps`** (backlog) also plans to edit the guide's "Ordering Events" section. No conflict now; whoever lands second keeps the fence markers.

The three "confirm once" checks are one-off manual proofs that the guard catches the classes it exists for; record the observed failure messages in the review handoff and revert. They are not separate tests. The spec file is the only new test.

## TODO

- Add `marked` as a devDependency of `@serfab/quereus-plugin-sereus`; run `yarn check:dep-ranges`.
- Write `packages/quereus-plugin-sereus/test/schema-guide-examples.spec.ts` per the harness design (extraction, markers, fresh database per block, crypto + `has_role` stub, ignored-item check, `applyAppSchema`, seed apply, plan insert/update/delete per table and select per view).
- Run it against the unrepaired guide and confirm it fails on the blocks listed above.
- Repair `docs/schema-guide.md` per "Guide repairs", adding a marker to every fence.
- Run the three "confirm once" checks; record the messages; revert.
- Add the `docs/testing.md` bullet.
- `yarn workspace @serfab/quereus-plugin-sereus test` (unit project), `yarn workspace @serfab/quereus-plugin-sereus typecheck`, `yarn lint`.
