description: The code a new developer is told to copy from the getting-started walkthrough and the main library's quick start has never been run by anyone or anything, so nothing would notice if it stopped working; documentation examples that call the library should be run by a test.
architecture: docs/contributing/gates.md#documentation
files: docs/getting-started.md, packages/cadre-core/README.md, packages/quereus-plugin-sereus/test/schema-guide-examples.spec.ts, packages/quereus-plugin-sereus/test/helpers/fenced-blocks.ts, scripts/check-docs.mjs, packages/integration-tests/src/scenarios/strand-formation-cross-party-seed.integration.ts, docs/contributing/gates.md
tradeoffs: The getting-started script starts two real nodes and joins them over a local network connection, so running it is as heavy as an integration scenario and needs every package built, and snippets shown out of context need scaffolding before they compile; a maintainer may choose to run only the one end-to-end script and leave the rest to review.
----

# Documentation examples that call the API are executed by a test

## What is missing

The repository already holds one class of documentation example to the engine. `packages/quereus-plugin-sereus/test/schema-guide-examples.spec.ts` reads `docs/schema-guide.md`, requires every fenced SQL block to carry a marker saying what it is (`sql schema`, `sql query`, `sql script`, or `sql fragment` for one that is shown and not run), executes or plans each one, and fails on a block with no marker. An SQL example the engine rejects fails in that spec instead of in an app author's hands.

Nothing does the same for examples that call the JavaScript API.

- **`docs/getting-started.md`** is the first document an app developer is sent to (`docs/README.md`, "Build an app"). Its six `js` blocks are written to be appended in order into one file, `two-parties.mjs`, which starts two nodes, founds a strand, issues and redeems a formation invitation, and reads rows across the two parties. The text says the code is "adapted from" an integration scenario. The adapted script itself was checked against the source by reading during the documentation rewrite and was not executed, and no test or script reads the document.
- **`packages/cadre-core/README.md`** has a quick start in three `ts` blocks. It is the page npm shows for the package. Same state: read against the source, never run or compiled.
- **The documentation gate does not cover this.** `scripts/check-docs.mjs` checks links, size budgets and directory indexes, and its header lists "a claim that no longer matches the code" among the things it cannot catch.

Across the developer documentation and package READMEs there are 62 fenced blocks tagged as JavaScript or TypeScript, in 25 files (counted by matching opening fences tagged `js`, `ts`, `typescript`, `javascript`, `tsx` or `mjs` in the tracked Markdown under `docs/` outside `docs/web/`, in `packages/*/README.md` and in the root `README.md`). The largest groups are `packages/cadre-rn/README.md` (12), `docs/getting-started.md` (6), `packages/cadre-provider/README.md` (5), `docs/cadre/membership.md` (5) and `docs/api.md` (4).

## The deliverable

An invariant, not a one-time run: a documentation example that calls the API is executed by a test, and an example that cannot be is marked as not executed where the reader and the test can both see it.

In the terms the schema-guide spec already uses:

- every JavaScript or TypeScript fence in the covered documents carries a marker, and a fence with none fails the test, so a new example forces its author to choose;
- the getting-started blocks are assembled in document order and run as the one script the document says they are, and the run must finish with each party reading the rows the other wrote;
- a block that is a fragment (a config excerpt, a call shown out of context) is at least type-checked against the published types, or marked as shown only;
- the covered set starts with `docs/getting-started.md` and the cadre-core README quick start, and the test names the documents it covers so that adding one is a one-line change.

`docs/contributing/gates.md` ("Documentation") should then say what is and is not executed.

## Use case

A rename or a signature change in cadre-core lands with its tests green. Today the walkthrough a newcomer copies can break in the same commit and stay broken until someone reports it. With the invariant, the commit fails.

## Notes

- `test/helpers/fenced-blocks.ts` already extracts fenced blocks with their info strings and is the natural shared piece. It lives in one package's test folder; `test-harness/` is where cross-package test infrastructure goes.
- The getting-started script uses in-memory keys and storage and loopback WebSocket, the same arrangement as `strand-formation-cross-party-seed.integration.ts`, so `packages/integration-tests` is the layer that already runs code of this weight.
- While the documentation was being rewritten, the linked `../optimystic` build did not load against the linked `../quereus` (a removed `getTypeOrDefault` export), which is one reason the script was not run at the time. That is an environment state, not part of this ticket.
