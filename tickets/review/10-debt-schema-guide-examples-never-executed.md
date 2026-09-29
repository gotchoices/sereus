description: Review the new test that runs every schema example in the schema guide against the real database engine, and the repairs that make those examples work.
architecture: docs/schema-guide.md
files: docs/schema-guide.md, packages/quereus-plugin-sereus/test/schema-guide-examples.spec.ts, packages/quereus-plugin-sereus/package.json, yarn.lock, docs/testing.md
----

# Schema guide examples now execute in a test — review handoff

## What landed

**New spec** `packages/quereus-plugin-sereus/test/schema-guide-examples.spec.ts` (plugin's existing `unit` Vitest project; no new wiring). It reads `docs/schema-guide.md` with `marked` (new devDependency, `^18.0.14`; `yarn check:dep-ranges` clean, knip reports nothing new) and walks every fenced block. Each fence's info string must be exactly `sql schema`, `sql script` or `sql fragment`; anything else fails the first test, naming the heading. Per executable block, in a fresh in-memory `Database` with the crypto plugin registered (as `src/connect.ts` does) and a deterministic `has_role` stub:

- `script` → `db.exec(text)`.
- `schema` → parse `declare schema App { <body> }` with Quereus's `Parser` and fail on any `declareIgnored` item (catches `create unique index …` inside a block and typo'd item keywords, which otherwise pass silently); `applyAppSchema(db, body)` (the plugin's real function); `apply schema App with seed` (seed literals must fit their tables); then `db.getPlan` an insert (all non-generated columns), an update (first non-generated column) and a delete per table, each carrying `with context <var> = ?` for every declared context variable, and `select *` per view. Planning is needed because Quereus compiles CHECK constraints when a write is planned, not at `create table`.

One `it` per block, generated with a `for` loop rather than `it.each`, because `it.each`'s `$name` interpolation truncated long headings to identical strings. Blocks are named `<heading> #<n>`.

**Guide repairs** (`docs/schema-guide.md`): every fence marked (25 → 26, the Ordering Events block split into `schema` + `fragment`); the fictional `schema "…" version 1 using (…) { }` header dropped from 13 blocks, bodies un-indented; seed syntax fixed; `ifnull` → `coalesce`; `create unique index` / `create assertion` → item forms; `with context (…)` added to Roles & Permissions, Audit & Security, Putting It All Together; `customers.credit_limit` added; `tenant text null`; invented functions replaced (`verify_signature`, `SignatureValid`/`Digest` → `verify(digest(…), sig, key, 'ed25519')` with base64url `text` sig/key like `schemas/strand.qsql`; `endswith` → `like '%Z'`). New top paragraph says the examples are sApp schema bodies, that Sereus wraps them as `App` and picks the storage module, that `sapp_id`/`sapp_version` carry name/version, and explains the three markers. Seeds section and the Practical Guidance bullet now say Sereus applies app schemas without `with seed`, pointing at `tickets/blocked/decide-sapp-schema-seed-rows.md`.

**Docs**: one bullet in `docs/testing.md` → "Lint coverage".

## Tests added

- `schema-guide-examples.spec.ts` › "marks every fence and contains schema examples" — no unmarked fence; at least one `schema` block (an empty extraction fails loudly).
- `schema-guide-examples.spec.ts` › one case per `schema`/`script` block (17 today) — the example parses with no ignored items, applies, seeds, and plans a write against every table / a read against every view.

## Validation run

- `yarn workspace @serfab/quereus-plugin-sereus vitest run --project unit` — 7 files, 119 tests pass.
- `yarn workspace @serfab/quereus-plugin-sereus typecheck`, `yarn lint`, `yarn check:test-file-typecheck-coverage`, `yarn check:vitest-typecheck-coverage` — clean.
- Against the header-stripped but otherwise unrepaired guide, 11 of 18 cases failed with the expected engine messages (seed `Expected '(' before seed row values`, `context.current_tenant_id isn't a column` at insert planning, `Function not found: ifnull/2`, `SignatureValid/3`, `endswith/2`, ignored-item count for `create …`, `may not reference a bare column` for the undeclared `actor_name` default).

One-off "confirm once" checks (guide temporarily edited, then restored from a backup copy):

- `tabel user_roles (…)` in the Views block → `items the parser ignored (a \`create …\` prefix or a misspelled item keyword): expected 1 to be +0`.
- `with context (…)` removed from Roles & Permissions → apply passed; failure came from planning: ``planning `insert into App.protected_records (…) values (?, ?, ?, ?, ?)` failed: context.current_tenant_id isn't a column``.
- `created text default datetime('now')` in the Generated Columns block → `Non-deterministic expression not allowed in DEFAULT for column 'created' in table 'articles'. Expression: datetime('now')…` at apply.
- Also probed directly: an `assertion` calling `ifnull` fails at apply (`Cannot create assertion 'a': Function not found: ifnull/2`), so assertions need no planning.

## Upstream findings (Quereus, sibling repo — not filed; sibling repos are read-only here)

- **Seed column list is ignored at apply.** `seed t values (b, a) values (('B', 'A'))` parses, but `../quereus/packages/quereus/src/runtime/emit/schema-declarative.ts` stores only `item.seedData`, dropping `item.columns`, and inserts positionally: verified that `B` lands in column `a`. A row omitting a column fails with "Column count mismatch". The guide now avoids this form and warns against it. A human should file this in the Quereus repo; when fixed, the guide's caution sentence in "Seeds" should go.
- `DeclareIgnoredItem.text` is always `''` (`Parser.sourceSlice` is a placeholder), so the spec can report only a *count* of ignored items, not which item. Quereus already carries a NOTE about silently ignoring typo'd items (`parser.ts` `declareIgnoredItem`).

## Known gaps / for the reviewer

- Planning proves the SQL compiles; nothing *executes* a write. A check that compiles but is wrong at runtime (e.g. `verify` argument order) is not caught. The `has_role` stub always returns 1.
- `fragment` blocks (the query examples) are unchecked; tracked in `tickets/backlog/debt-schema-guide-query-examples-unchecked.md`.
- The "Additional Coverage: Patterns from VoteTorrent" heading holds seven blocks, so its cases are named `#1`…`#7` rather than by their paragraph labels.
- The `has_role` stub list in the spec and the wrapper string in `ignoredItemCount` are second copies (the latter of `applyAppSchema`'s wrapper), each commented.
- Test cases are built at collection time from a `readFileSync`; if the guide is missing the whole file fails to collect (loud, but not a named assertion).
- `feat-shared-causal-history-for-sapps` (backlog) also edits the guide's "Ordering Events" section; whoever lands second must keep the fence markers.
