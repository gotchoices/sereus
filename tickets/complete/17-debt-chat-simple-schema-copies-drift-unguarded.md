description: The reference chat app's database schema is hand-copied into three apps and a design document; the two stale copies now match the original, and four tests fail whenever any copy stops matching it.
files: schemas/chat-simple.qsql, test-harness/qsql-body.ts, test-harness/chat-simple-schema.ts, packages/reference-app-rn/src/chat-strand.ts, packages/reference-app-rn/test/chat-schema-drift.spec.ts, packages/reference-app-web/src/lib/chat-strand.ts, packages/reference-app-web/src/lib/cadre-web.ts, packages/reference-app-web/test/chat-schema-drift.spec.ts, packages/reference-app-web/README.md, packages/reference-app-ns/src/chat-strand.ts, packages/reference-app-ns/test/chat-schema-drift.spec.ts, packages/quereus-plugin-sereus/test/chat-simple-doc-drift.spec.ts, packages/quereus-plugin-sereus/test/helpers/fenced-blocks.ts, packages/quereus-plugin-sereus/test/strand-schema-drift.spec.ts, packages/quereus-plugin-sereus/test/schema-guide-examples.spec.ts, packages/quereus-plugin-sereus/test/e2e/chat-schema.e2e.spec.ts, docs/testing.md, docs/reference-app-rn.md, eslint.config.mjs, AGENTS.md
----

# Guard the hand-kept copies of `schemas/chat-simple.qsql`

## What was built

`schemas/chat-simple.qsql` (two tables, `Participant` and `Message`) is hand-copied as the `CHAT_SCHEMA` string constant in the React Native, web and NativeScript reference apps, and as a fenced block in `docs/reference-app-rn.md`. The web and NativeScript constants were missing the `Participant.Role` line; all three constants are now byte-identical. Each copy has a test that compares it with the file.

**Comparison rule** (`normalizeSchemaText` in `test-harness/chat-simple-schema.ts`): remove SQL comments, read CRLF as LF, trim each line's leading and trailing spaces and tabs, drop empty lines. Nothing else is ignored, so a token moved to another line, a changed letter case or a doubled interior space fails.

**Shared code in `test-harness/`** (imported by relative path, never built):

- `qsql-body.ts` — the comment- and string-aware SQL scanner, moved from the plugin's `test/helpers/`, with `stripSqlComments` added. Its unit tests are in `packages/quereus-plugin-sereus/test/strand-schema-drift.spec.ts`.
- `chat-simple-schema.ts` — exports one function, `describeChatSchemaCopy(where, readCopy)`, which registers the test for one copy. The normalization and the file read are private to it.

**The four guards:** `test/chat-schema-drift.spec.ts` in each of `reference-app-rn`, `reference-app-web`, `reference-app-ns`, and `packages/quereus-plugin-sereus/test/chat-simple-doc-drift.spec.ts` for the document block (which must be the only code block whose nearest heading is "Simplified Chat Schema").

**Known constraint, documented in `packages/reference-app-web/README.md`:** a build whose `CHAT_SCHEMA` changes an existing table cannot open a chat database an earlier build left behind, because the schema apply issues `ALTER TABLE` and the optimystic table module refuses it. The implementer measured this for the web app (`startCadre` fails until site data is cleared). Nothing migrates it, per the no-backwards-compatibility policy.

## Review findings

Reviewed the diff of `ticket(implement): debt-chat-simple-schema-copies-drift-unguarded` before the handoff text.

**Checked**

- The three `CHAT_SCHEMA` constants: extracted each template literal and hashed it; all three are identical.
- Every `insert into ... Participant` in the web and NativeScript apps names its columns (`(Id, Name)`), so the added defaulted `Role` column does not break their writes.
- No remaining import of the old `test/helpers/qsql-body` path; no doc still says the web schema lacks `Role`.
- `stripSqlComments`: read against its three unit tests and the scanner's existing helpers. A `--` inside a string literal is kept; an apostrophe inside a comment does not open a literal; an unterminated literal is copied to end of input rather than read as code.
- Each guard fails when it should, re-run after the review edits: a changed letter in the web constant fails with both file names in the message; renaming the document heading fails on the block count; moving `schemas/chat-simple.qsql` aside fails with `ENOENT`. All three were restored afterwards.
- Docs: `docs/testing.md`, `docs/reference-app-rn.md`, the web README and `AGENTS.md` read against the code. The `docs/testing.md` item is one bullet of four sentences describing one check; left as one item.
- `yarn lint`, `yarn typecheck` (396 collected test files), `yarn dep-check`: all exit 0. `yarn test` in `quereus-plugin-sereus` (155 passed, 1 todo), `reference-app-rn` (302), `reference-app-web` (67), `reference-app-ns` (128): all pass.

**Found and fixed in this pass (minor)**

- The three app specs were the same 18 lines differing only in a path, and each awaited an exported async helper from a `test/` tree that is not linted for floating promises. Replaced the two exports with `describeChatSchemaCopy`, which registers the test and does the awaiting itself; each app spec is now one call, and the document spec passes a function that locates its block. No spec can leave the read unawaited.
- `eslint.config.mjs`: the `NOTE:` about `test-harness/` being outside type-aware linting was reworded to match (nothing async is exported; the revisit condition is "test infrastructure starts exporting a promise a spec must await").
- `AGENTS.md` said `test-harness/` is imported "from packages' vitest `globalSetup`"; it is also imported from specs. Corrected.
- Backlog ticket `debt-test-fixtures-hand-copy-the-chat-schema` named the two functions that are no longer exported; its one sentence now names `describeChatSchemaCopy`.

**Major findings:** none. Nothing filed.

**Tripwires (recorded at the site, not filed)**

- Double-quoted identifiers are not recognised by the scanner, so a `--` inside `"..."` would be read as a comment. `NOTE:` in the header of `test-harness/qsql-body.ts` (written by the implementer; confirmed no schema here quotes an identifier).
- `test-harness/` and `test/` trees are outside type-aware linting. `NOTE:` in `eslint.config.mjs`, as above.
- Noticed, not recorded: `stripSqlComments` replaces a comment with nothing, so `a/**/b` becomes `ab`. For this to hide a difference, the source file would have to separate two tokens by a comment alone; the reverse case fails loudly.

**Considered and left alone**

- An existing web or NativeScript install with a chat strand from the previous build cannot start the new build (measured for web by the implementer; expected but not measured for NativeScript, no device run). The plan ticket accepted "clear the data" under the no-backwards-compatibility policy, and the web README states the constraint. Not re-filed.
- `packages/quereus-plugin-sereus/test/helpers/` still exists, holding `fenced-blocks.ts`, which two specs share. Correct home; it depends on `marked`, a dependency of that package only.
- No unit test for `normalizeSchemaText`: four string operations over a tested function, exercised by four guards against real text.

**Not run:** `integration-tests`, the Playwright suites (the implementer ran `e2e/solo`, 17 passed; nothing under `src/` changed in review), the apps' `test:bundle` scripts, and any on-device run.

**Out of scope, tracked:** four further hand copies in test fixtures — backlog ticket `debt-test-fixtures-hand-copy-the-chat-schema`.
