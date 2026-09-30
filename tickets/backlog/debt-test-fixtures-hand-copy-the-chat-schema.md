description: Four test fixtures carry their own hand-typed copy of the reference chat app's database schema, three of them already out of date, so those tests exercise a schema the apps no longer run.
prereq: debt-chat-simple-schema-copies-drift-unguarded
files: packages/reference-app-rn/test-fixture/start.mjs, packages/integration-tests/src/scenarios/websocket-chat.integration.ts, packages/integration-tests/src/scenarios/convergence-stress.integration.ts, packages/integration-tests/src/scenarios/multi-party-workflows.integration.ts, packages/integration-tests/src/fixtures/index.ts, schemas/chat-simple.qsql, test-harness/chat-simple-schema.ts
tradeoffs: The three integration scenarios only need some two-table schema to push rows through, so a maintainer may say their copy is a test fixture in its own right and need not track the app's schema at all.
----

# Test fixtures hand-copy `schemas/chat-simple.qsql`

`debt-chat-simple-schema-copies-drift-unguarded` reconciles and guards the copies inside the three reference apps and the design document. Four more hand-typed copies sit in test fixtures and are not covered by it:

- `packages/reference-app-rn/test-fixture/start.mjs` — the Node process the React Native end-to-end run pairs the phone with ("mirrors src/chat-strand.ts"). It agrees with the file today. It is the copy where agreement matters most: it joins the same strand as the app under test, and the schema text is stored in the strand's `Strand.Header.sAppSchema` row.
- `packages/integration-tests/src/scenarios/websocket-chat.integration.ts` ("mirrors reference-app-rn/src/chat-strand.ts"), `convergence-stress.integration.ts` and `multi-party-workflows.integration.ts` — all three lack the `Participant.Role` column the file and the apps have.

## Expected end state

No test fixture carries its own typed-out copy of the chat schema, or each one that does is checked against the file.

- The integration scenarios can load the file: `packages/integration-tests/src/fixtures/index.ts` already exports `loadChatSimpleSchema()`, used by `strand-chat-participants-converge.integration.ts`. Each of the three scenarios builds its signed app config at module top level, so switching means awaiting the loader there or building the config in a setup hook.
- `start.mjs` is a plain `.mjs` script with a side-effecting `main()`, so a test cannot import its constant as it stands. Either it reads a text that is known to equal what the phone app embeds, or the constant moves to a small side-effect-free module a spec can import and compare using `normalizeSchemaText` / `readChatSimpleSchema` from `test-harness/chat-simple-schema.ts`. Whether the fixture may load the comment-bearing file while the phone runs the comment-free constant depends on whether any join path compares the stored schema text between peers; that needs checking before choosing, and is not yet known.

The integration scenarios run against a real network and are slow; whoever plans this should confirm which of them are runnable inside an agent run.
