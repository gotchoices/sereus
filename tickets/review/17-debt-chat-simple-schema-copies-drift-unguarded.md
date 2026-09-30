description: The reference chat app's database schema is hand-copied into three apps and a design document; the two stale copies now match the original, and four tests fail whenever any copy stops matching it.
files: schemas/chat-simple.qsql, test-harness/qsql-body.ts, test-harness/chat-simple-schema.ts, packages/reference-app-rn/src/chat-strand.ts, packages/reference-app-rn/test/chat-schema-drift.spec.ts, packages/reference-app-web/src/lib/chat-strand.ts, packages/reference-app-web/src/lib/cadre-web.ts, packages/reference-app-web/test/chat-schema-drift.spec.ts, packages/reference-app-web/README.md, packages/reference-app-ns/src/chat-strand.ts, packages/reference-app-ns/test/chat-schema-drift.spec.ts, packages/quereus-plugin-sereus/test/chat-simple-doc-drift.spec.ts, packages/quereus-plugin-sereus/test/helpers/fenced-blocks.ts, packages/quereus-plugin-sereus/test/strand-schema-drift.spec.ts, packages/quereus-plugin-sereus/test/schema-guide-examples.spec.ts, packages/quereus-plugin-sereus/test/e2e/chat-schema.e2e.spec.ts, docs/testing.md, docs/reference-app-rn.md, eslint.config.mjs, AGENTS.md
----

# Guard the hand-kept copies of `schemas/chat-simple.qsql`

## What changed

`schemas/chat-simple.qsql` (two tables, `Participant` and `Message`) is hand-copied as the `CHAT_SCHEMA` string constant in the React Native, web and NativeScript reference apps, and as a fenced block in `docs/reference-app-rn.md`. The web and NativeScript constants were missing the `Participant.Role` line; they now carry it and read identically to the React Native constant. Each copy has a test that compares it with the file.

**Comparison rule** (`normalizeSchemaText` in `test-harness/chat-simple-schema.ts`): remove SQL comments, read CRLF as LF, trim each line's leading and trailing spaces and tabs, drop empty lines. Nothing else is ignored, so a token moved to another line, a changed letter case or a doubled interior space fails.

**Shared code, in `test-harness/` (imported by relative path, never built):**

- `qsql-body.ts` — moved from `packages/quereus-plugin-sereus/test/helpers/`. Gained `stripSqlComments`, built on the existing `skipLineComment` / `skipBlockComment` / `skipStringLiteral`. The comment half of `skipNonCode` became `skipComment` so both callers share it.
- `chat-simple-schema.ts` — `normalizeSchemaText(text)` and `readChatSimpleSchema()` (the file, normalized; rejects if the file is missing).

**App changes:** `CHAT_SCHEMA` is exported from all three apps; banner comments name the enforcing spec; the `cadre-web.ts` doc comment that said the web schema has no `Role` column now says the column is left at its `'member'` default.

**Docs:** one item in `docs/testing.md` → "Lint coverage" (after "Schema guide examples execute"); one clause in `docs/reference-app-rn.md` after the schema block; one paragraph in `packages/reference-app-web/README.md` → "Solo cadre" (see the first gap below); `AGENTS.md`'s one-line description of `test-harness/`.

## Tests added

| Test | Verifies |
|---|---|
| `packages/reference-app-rn/test/chat-schema-drift.spec.ts` (runs in the `node` project) | the React Native `CHAT_SCHEMA` equals the file, normalized |
| `packages/reference-app-web/test/chat-schema-drift.spec.ts` | the web `CHAT_SCHEMA` equals the file, normalized |
| `packages/reference-app-ns/test/chat-schema-drift.spec.ts` | the NativeScript `CHAT_SCHEMA` equals the file, normalized (imports the real module, no mock) |
| `packages/quereus-plugin-sereus/test/chat-simple-doc-drift.spec.ts` | `docs/reference-app-rn.md` has exactly one code block whose nearest heading is "Simplified Chat Schema", and it equals the file, normalized |
| `strand-schema-drift.spec.ts`: "stripSqlComments keeps a `--` that sits inside a string literal" | a `--` inside `'...'` survives; a trailing comment on the same line is removed |
| `strand-schema-drift.spec.ts`: "stripSqlComments does not let a `'` inside a `--` comment open a literal" | an apostrophe in a comment does not swallow the following lines |
| `strand-schema-drift.spec.ts`: "stripSqlComments removes a `/* */` comment, including one spanning lines" | block comments are removed, including a `--` and a `'` inside one |

No test for `normalizeSchemaText` on its own: it is four string operations over `stripSqlComments`, and the four guards run it against real text.

## Validation run

All in the foreground on Windows, after the last code change:

- `yarn lint` — exit 0.
- `yarn typecheck` (root, including the three coverage gates) — exit 0; 396 collected test files inside a type-check program.
- `yarn dep-check` (knip + dependency ranges) — exit 0; nothing reported for the new or moved files.
- `yarn workspace @serfab/quereus-plugin-sereus test` — 12 files, 155 passed, 1 todo.
- `yarn workspace @serfab/reference-app-rn test` — 22 files, 302 passed.
- `yarn workspace @serfab/reference-app-web test` — 4 files, 67 passed.
- `yarn workspace @serfab/reference-app-ns test` — 8 files, 128 passed.
- `yarn workspace @serfab/reference-app-web playwright test e2e/solo` — 17 passed, including `schema-signature-gate.spec.ts`. The `e2e/distributed` tier was not run.
- Not run: `integration-tests`, the apps' `test:bundle` scripts, and any on-device run.

**Each guard was seen to fail.** `Content text not null` was changed to `... nulL` in each of the four copies in turn; the matching spec failed with the message naming both files, and the copy was restored. Renaming the document heading also failed the document spec ("expected +0 to be 1"). No permanent test was added for this.

**Line endings.** Every compared file is LF on disk in this checkout, so the guards did not exercise the CRLF step by themselves. As a one-off, `schemas/chat-simple.qsql` was rewritten with CRLF, the web guard still passed, and the file was restored.

## Known gaps and things to look at

- **A browser that ran the previous web build cannot start the new one.** Measured with a scratch script (not kept): build the web app with the old constant, send a message in a persistent Chromium profile, rebuild with the new constant, reopen the same profile. Result: `startCadre failed: QuereusError: Failed to execute DDL: ALTER TABLE App.Participant ADD COLUMN Role ... Module for table 'Participant' does not support ALTER TABLE ADD COLUMN`, and the Messages page never becomes usable. The plan ticket's statement that the schema apply "adds the defaulted column" is wrong. The plan ticket also said a manual "clear site data" is an acceptable answer under the no-backwards-compatibility policy, so nothing was built for it; the constraint is now stated in `packages/reference-app-web/README.md`. `docs/architecture.md` already records the same refusal for the control database (`ALTER TABLE ... DROP CONSTRAINT`). The Playwright solo suite cannot see this: every test starts from an empty profile.
- **The same failure is expected, but not measured, for a NativeScript install** that has a chat strand stored from the previous build, since its constant gained the same column. No device run was done. The React Native constant did not change.
- **`test/helpers/` in the plugin was not deleted.** The plan said to delete it once empty. It now holds `fenced-blocks.ts`, the heading-tracking block extractor lifted out of `schema-guide-examples.spec.ts` so that spec and the new document spec share it. `schema-guide-examples.spec.ts` was changed only to call it; its 26 tests still pass.
- **`readChatSimpleSchema` builds a path, not a `URL`.** Passing `new URL(..., import.meta.url)` to `readFile` failed `tsc` in `reference-app-rn`, whose program includes the DOM library's `URL` type. A comment at the site says so.
- **`eslint.config.mjs` had a note saying nothing in `test-harness/` is async**, and that test infrastructure growing promises should trigger giving `test-harness/` its own `tsconfig.json` and type-aware linting. `readChatSimpleSchema` is async. The note was reworded to name that one awaited read rather than adding the lint pass; a caller that forgets `await` compares a string with a promise and fails. The reviewer may prefer the lint pass.
- **Double-quoted identifiers are not recognised by the scanner** (pre-existing). A `--` inside `"..."` would be stripped as a comment from both sides of a comparison. Recorded as a `NOTE:` in the header of `test-harness/qsql-body.ts`; no schema here quotes an identifier.
- **"Under the heading" means nearest preceding heading at any level.** A sub-heading inserted between "Simplified Chat Schema" and the block makes the document spec fail with zero blocks found, which is loud rather than silent.
- **The `docs/testing.md` item is one four-sentence bullet** in a list whose neighbours are much longer. `AGENTS.md` asks for a headed section when an item describes a mechanism with several parts; the plan asked for one item. Left as one item.
- **Out of scope, unchanged:** the four further hand copies in test fixtures (`packages/reference-app-rn/test-fixture/start.mjs` and three `packages/integration-tests/src/scenarios/*.integration.ts` files), tracked by backlog ticket `debt-test-fixtures-hand-copy-the-chat-schema`.

## Use cases for review

- Edit any one of the five texts (the file, three constants, the document block) without the others: the matching spec(s) should fail naming the two files to edit. Editing only the file should fail all four.
- Edit only a comment, the indentation or blank lines in any copy: all four should stay green.
- Add a column whose `check` contains `'--'` to the file and the copies: the guards should compare the full line, not a truncated one.
- Rename or duplicate the "Simplified Chat Schema" block in the document: the document spec should fail on the block count.
- Delete `schemas/chat-simple.qsql`: all four should fail with a file-not-found rejection, not pass.
