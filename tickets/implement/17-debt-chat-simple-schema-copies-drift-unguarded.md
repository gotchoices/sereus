description: The reference chat app's database schema is hand-copied into three apps and a design document; bring the two stale copies back in line and add tests that fail whenever any copy stops matching the original.
files: schemas/chat-simple.qsql, packages/reference-app-rn/src/chat-strand.ts, packages/reference-app-web/src/lib/chat-strand.ts, packages/reference-app-web/src/lib/cadre-web.ts, packages/reference-app-ns/src/chat-strand.ts, docs/reference-app-rn.md, docs/testing.md, packages/quereus-plugin-sereus/test/helpers/qsql-body.ts, packages/quereus-plugin-sereus/test/strand-schema-drift.spec.ts, packages/quereus-plugin-sereus/test/e2e/chat-schema.e2e.spec.ts, packages/quereus-plugin-sereus/test/schema-guide-examples.spec.ts, test-harness/
----

# Guard the hand-kept copies of `schemas/chat-simple.qsql`

## Current state

`schemas/chat-simple.qsql` is the schema the reference chat apps run. It is a bare list of two tables (`Participant`, `Message`) with explanatory `--` comments and no `declare schema` wrapper. Four hand-typed copies exist:

| Copy | Form | Agrees with the file today? |
|---|---|---|
| `packages/reference-app-rn/src/chat-strand.ts` | `const CHAT_SCHEMA` template literal, comments removed | yes |
| `packages/reference-app-web/src/lib/chat-strand.ts` | same | **no** — `Participant.Role` line missing |
| `packages/reference-app-ns/src/chat-strand.ts` | same | **no** — `Participant.Role` line missing |
| `docs/reference-app-rn.md`, section "Simplified Chat Schema" | fenced `sql` block, with its own shorter comments | yes |

The missing line is `Role text not null default 'member' check (Role in ('owner', 'member'))`. Neither the web nor the NativeScript app reads or writes `Role`, and the column has a default, so their existing `insert ... (Id, Name)` statements keep working once it is added.

The copies stay as string constants: the React Native bundler cannot read a `.qsql` file from disk, and the schema text is also written into each strand's `Strand.Header.sAppSchema` row, so a copy that stripped or kept different comments from another app's copy would be a different stored value. This ticket does not change how the apps load the schema; it makes the copies agree and keeps them agreeing.

## Design

### What "agrees" means

Two schema texts agree when they are identical after this normalization, and nothing else:

1. Remove SQL comments (`-- ...` to end of line, and `/* ... */`), recognising string literals so that a `--` inside `'...'` is not treated as a comment. `''` inside a literal is an escaped quote.
2. Convert CRLF to LF.
3. Trim leading and trailing horizontal whitespace from every line.
4. Drop lines that are now empty.

Interior whitespace, letter case, token order and line breaks between tokens are all significant. A reformat that moves a token to another line therefore fails the guard; that is a deliberate false positive, preferred over any normalization clever enough to hide a real difference. Comments must be ignored because the file carries long comments, the code copies carry none, and the document carries shorter ones.

### Shared helper in `test-harness/`

`test-harness/` is the existing home for test code shared across packages by relative import (it is not a workspace and is never built; every package's `test/global-setup.ts` already imports from it, so the TypeScript `rootDir` arrangements are in place).

- Move `packages/quereus-plugin-sereus/test/helpers/qsql-body.ts` to `test-harness/qsql-body.ts`. It already contains the comment- and string-aware scanner (`skipNonCode` and the three `skip*` functions). Update its two importers (`strand-schema-drift.spec.ts`, `e2e/chat-schema.e2e.spec.ts`) and delete the now-empty `helpers/` directory.
- Add to that file an exported `stripSqlComments(source: string): string`, built on the existing `skipLineComment` / `skipBlockComment` / `skipStringLiteral` functions: walk the text; copy string literals through verbatim; drop comments; copy everything else. Do not write a second scanner and do not use a regex for this.
- Add `test-harness/chat-simple-schema.ts` exporting:
  - `normalizeSchemaText(text: string): string` — the four steps above.
  - `readChatSimpleSchema(): Promise<string>` — reads `schemas/chat-simple.qsql` relative to the helper's own `import.meta.url` and returns it **normalized**.
  
  No vitest import in either helper file; they are plain functions.

The header comment of `strand-schema-drift.spec.ts` says its shape is a deliberate copy rather than a shared helper and that a third embedded schema should tip that. Update the comment to say where the scanner now lives and who uses it; leave the strand guard's own, stricter `normalize` (which keeps comments and indentation significant) exactly as it is — the strand constant is meant to be byte-for-byte the file body, the chat constants are not.

### One guard per app, next to its constant

Each of the three apps exports its constant (`export const CHAT_SCHEMA`) and gains one spec in its own `test/` directory, picked up by its existing vitest `include`:

```ts
it('CHAT_SCHEMA matches schemas/chat-simple.qsql', async () => {
	expect(normalizeSchemaText(CHAT_SCHEMA)).toBe(await readChatSimpleSchema());
});
```

vitest's string diff is enough of a failure message; add a short assertion message naming both files to edit.

This was chosen over a single test in `quereus-plugin-sereus` that reaches into the three apps. That test would either import app source across package boundaries (dragging each app's dependencies and TypeScript settings into the plugin's test run) or read the `.ts` files as text and cut the template literal out by hand, which is the kind of ad-hoc parser the project rules forbid. Importing a constant from the module that owns it needs neither.

For React Native, put the test in the `node` project (`test/*.spec.ts`), where `test/chat-strand.spec.ts` already imports `../src/chat-strand.js` directly. For NativeScript, import the real module (no `vi.mock` of `../src/chat-strand` in this spec). For web, `src/lib/chat-strand.ts` imports only `@serfab/cadre-core` and already loads under Node in the Playwright fixtures.

### Guard for the document

The design document has no module to import from, so its guard lives in `packages/quereus-plugin-sereus/test/`, which already depends on `marked` and already extracts fenced blocks from `docs/schema-guide.md` (`schema-guide-examples.spec.ts`, `extractBlocks`). Add a spec that lexes `docs/reference-app-rn.md` with `marked`, takes the fenced code block(s) under the heading whose text is `Simplified Chat Schema`, requires exactly one, and asserts `normalizeSchemaText(block) === await readChatSimpleSchema()`. Finding zero or more than one block is a failure, not a skip, so renaming the heading cannot silently disable the guard. Reuse the `marked.walkTokens(marked.lexer(...))` heading-tracking approach from `schema-guide-examples.spec.ts`; if lifting a small shared function out of that spec is cleaner than repeating eight lines, do that inside the plugin's `test/` directory.

### Reconcile the copies

- Add the `Role` line to the web and NativeScript constants, with the trailing comma on the `Name` line, so they read identically to the React Native constant.
- `packages/reference-app-web/src/lib/cadre-web.ts` (doc comment on the closed-strand host function, near line 565) states "the web chat schema carries no participant `Role` column". Reword: the column exists and defaults to `'member'`; the web app does not assign owner/member roles.
- The banner comments above the web and NativeScript constants say "matches schemas/chat-simple.qsql"; add that a test enforces it (name the spec), as should the React Native one.

### Documentation

- `docs/testing.md`: the section that lists test-enforced checks (where "Schema guide examples execute" is described) gains one item for this guard: which copies are covered, where the specs live, and what the normalization ignores.
- `docs/reference-app-rn.md`: the sentence after the fenced block ("`schemas/chat-simple.qsql` is the source of record for the above") gains a clause saying the block is checked against the file by a test. No other doc changes.

## Edge cases & interactions

- **`--` inside a string literal** (for example a future `check (Tag <> '--')`): must survive stripping. Verified by a test of `stripSqlComments` — add two or three cases to the existing extractor cases in `strand-schema-drift.spec.ts` (a `--` inside a literal is kept; a `'` inside a `--` comment does not open a literal and swallow the following lines; a `/* */` comment is removed). These are the only new helper tests; the scanner functions underneath are already covered there.
- **A comment between two tokens on one line** (`a /* x */ b`) leaves a doubled space and would fail against a copy written `a b`. Accepted: it fails loudly rather than passing wrongly. No test.
- **Line endings**: the repo checks out with CRLF on Windows (`core.autocrlf`); template literals in `.ts` files and the `.qsql` file may differ in line endings. Step 2 of the normalization covers it; the guards themselves running on Windows verify it.
- **Guard silently comparing nothing**: `readChatSimpleSchema` must throw if the file is missing (plain `readFile` does). The document guard must fail when it finds no block. Verify by inspection. An empty-to-empty comparison is not otherwise reachable because the constants are non-empty.
- **Prove each guard can fail**: before finishing, temporarily alter one character in each of the four copies in turn, confirm the matching spec fails, and restore it. Record in the review handoff that this was done. Do not add permanent tests for it.
- **Web app with an existing browser database**: the web app uses a fixed strand id (`sereus-web-chat`) persisted in IndexedDB, so a browser that ran the old schema reopens that database under the new one. The declarative schema apply adds the defaulted column. Run the web package's Playwright solo suite if it is runnable in the agent environment (`yarn workspace <web package> test:e2e`); if it is not, say so in the handoff rather than claiming it. The project has no backwards-compatibility requirement yet, so a manual "clear site data" is an acceptable answer if a stale database misbehaves — but report it.
- **Signed web schema**: the web app signs `CHAT_SCHEMA` at runtime with `signSchema`, so changing the text needs no stored signature update. `getTamperedChatSAppConfig` appends to the valid schema and is unaffected. Verified by the existing `e2e/solo/schema-signature-gate.spec.ts` if the Playwright suite runs.
- **NativeScript specs that mock the module**: `cadre-vm.spec.ts`, `chat-vm.spec.ts` and `settings-view-model.spec.ts` replace `../src/chat-strand` with `chatStrandMock()` from `test/stubs/fake-cadre-node.ts`. A new named export does not need adding to the stub unless one of those specs' subjects imports it (none does). The React Native `test/react/*.spec.ts` mocks are in the same position.
- **Type checking of the moved helper**: `test-harness/**/*.ts` is type-checked through `packages/integration-tests/tsconfig.typecheck.json`. After the move, run `yarn typecheck` at the root; `scripts/check-test-file-typecheck-coverage.mjs` fails if a test file falls outside every type-check program.
- **Out of scope, already filed**: four further hand copies exist in test fixtures (`packages/reference-app-rn/test-fixture/start.mjs` and three `packages/integration-tests/src/scenarios/*.integration.ts` files). They are tracked in backlog ticket `debt-test-fixtures-hand-copy-the-chat-schema`; do not touch them here.

## Validation

Run in the foreground: `yarn lint`, `yarn typecheck`, and the `test` script of `quereus-plugin-sereus`, `reference-app-rn`, `reference-app-web`, and `reference-app-ns`. The `integration-tests` suite is not needed (no scenario changes). If the stale-build guard reports a sibling repository's `dist` is stale, stop and record it — do not build the sibling.

## TODO

- Move `qsql-body.ts` to `test-harness/`, add `stripSqlComments`, fix the two imports, remove the empty `helpers/` directory, update the file's header comment listing its callers
- Add `test-harness/chat-simple-schema.ts` (`normalizeSchemaText`, `readChatSimpleSchema`)
- Add the `stripSqlComments` cases to `strand-schema-drift.spec.ts` and update that spec's header comment
- Add the `Role` line to the web and NativeScript constants; export `CHAT_SCHEMA` from all three apps; update the banner comments
- Reword the `cadre-web.ts` comment about the missing `Role` column
- Add one drift spec to each of `reference-app-rn/test`, `reference-app-web/test`, `reference-app-ns/test`
- Add the document drift spec to `quereus-plugin-sereus/test`
- Update `docs/testing.md` and the one sentence in `docs/reference-app-rn.md`
- Break each of the four copies once to see its guard fail, restore, and note it in the handoff
- Run lint, typecheck and the four packages' tests; attempt the web Playwright solo suite and report honestly whether it ran
