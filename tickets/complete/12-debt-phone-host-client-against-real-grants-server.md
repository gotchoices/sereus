description: The phone app's code for borrowing a node from a home machine now runs, in the end-to-end borrowing test, against that machine's real web server instead of only a hand-written imitation of it.
files: packages/integration-tests/src/scenarios/cadre-host-donation-phone-requester.integration.ts, packages/integration-tests/tsconfig.json, packages/integration-tests/tsconfig.build.json, packages/reference-app-rn/src/host-node-request.ts, packages/reference-app-rn/test/host-node-request.spec.ts, eslint.config.mjs, docs/testing.md, docs/reference-app-rn.md, docs/cadre-host.md, docs/architecture.md
----

# Phone host client runs against the real cadre-host `/grants` server

## What landed

`requestHostNode` (`packages/reference-app-rn/src/host-node-request.ts`) is the phone's client for cadre-host's grantee routes (`POST /grants`, `GET /grants/:id/peer`, `PUT /grants/:id/seed`, `DELETE /grants/:id`). Before this ticket only the unit spec's `FakeHost` ran it. The real-network scenario `cadre-host-donation-phone-requester.integration.ts` now mounts the host's real management server (`createLocalUiServer`, donor-only, `forcePort: 0`) and borrows the node through the phone's own client, which it imports by relative source path. The module imports nothing, and a lint rule now enforces that.

Scenario steps (each its own `it`):

- Step 1: the requester starts and cannot be dialed (unchanged).
- Step 2 (new): a wrong grant token gets the real server's 401, which the client reports as `stage: 'requesting'`, `code: 'unauthorized'` with the grant-token message. Nothing is provisioned.
- Step 3 (old steps 2–5 merged): the client goes through all six stages. The record is `seeded` and keeps `bootstrapNodes: []` although the phone's POST leaves the field off. The node reports exactly one `/ws` port, the requester holds an outbound connection, and the node's `/status` shows a websocket connection in the requester's party.
- Steps 4–7: the old steps 6–9, renumbered (rows cross, respawn, requester restart, terminate).
- Step 8 (new): a request cancelled as `waiting-for-node` begins ends the loan through the real `DELETE` route, and the host's node goes away.

Build config: `rootDir: "src"` moved from `integration-tests/tsconfig.json` to `tsconfig.build.json`, and the build now excludes `**/*.integration.ts`. Without the move, importing a file from outside `src/` fails with TS6059.

The implementer's validation (2026-09-29): the scenario passed 8/8 twice, the unit spec passed 34/34, and typecheck, build and lint were clean. The measured-teeth recipe was re-run: making the child return only its TCP listen address turns steps 3–7 red, and restoring it returns 8/8.

## Review findings

Read the `ticket(implement): debt-phone-host-client-against-real-grants-server` diff first, then the client module, the scenario, the lint config and every doc the change touched.

**Fixed in this pass (minor):**

- *Step 8 accepted any failure at `waiting-for-node`.* It asserted only the stage, so a different failure at that stage (a 404 from `/peer`, say) would also have passed, because cleanup ends the loan in that case too. It now also asserts the message `'The request was cancelled.'`. I traced the path: the abort fires in `onStage`, `send`'s `fetch` rejects on the aborted signal, and `throwIfAborted` throws the abort error at `waiting-for-node`.
- *Step 3 read `hasOutboundTo` once.* The implementer flagged this as a possible flake. It is now a `waitUntil` (30 s, 250 ms interval). This is no weaker: a requester with no listener cannot hold an inbound connection, so waiting only covers a redial between the client's check and this one. The step's timeout became `3 * STARTUP_MS + 2 * OP_MS + 10_000` to cover the new wait, and its comment now says so.
- *The "must stay import-free" contract existed only in comments.* Adding a runtime import to `host-node-request.ts` would have shown up only as the integration scenario failing at load, and that scenario is not run routinely. I added a boundary rule (rung 3): `eslint.config.mjs` applies `@typescript-eslint/no-restricted-imports` with `regex: '.'` and `allowTypeImports: true` to that one file. I checked it by temporarily adding a runtime import and a type-only import to the file. Lint flagged the runtime import and accepted the type-only one. The file was then restored byte-for-byte. The module header, `docs/testing.md` → "App modules in a scenario" and the "Lint coverage" list now mention the rule.

**Checked, no change:**

- Correctness of the client paths the scenario drives: provision without `bootstrapNodes`, the abort-then-cleanup order (`removePeer` is skipped because `dronePeerId` is still unset, and `endLoan` uses its own signal so the aborted caller signal cannot cancel the `DELETE`), and the `explainFailure` rethrow, which keeps `cause`.
- Build config: `yarn workspace @serfab/integration-tests build` and `typecheck` both exit 0, and root `yarn typecheck` is clean, including `check:test-file-typecheck-coverage` (392 files). Nothing reads `dist/scenarios` (checked with grep; only completed tickets mention `integration-tests/dist`, for temporary device-run scripts).
- The lint type-aware pass uses `projectService` on `integration-tests/tsconfig.json`, which no longer sets `rootDir`, so the cross-package import raises no error there. `yarn lint` exits 0.
- Docs: `docs/reference-app-rn.md`, `docs/cadre-host.md`, `docs/architecture.md` and `docs/testing.md` match the new state. Grep finds no remaining reference to this ticket's old backlog path, and no remaining "calls `DonationService` directly" wording.
- Test value: steps 2, 3 and 8 each cover something `FakeHost` cannot (the real server's bearer gate, body parsing and routes). No unit tests were added or needed. None of the scenario's assertions just restate the implementation.

**Accepted as the implementer left them (documented at the site):**

- Step 7 depends on step 3 returning the donation id, so in the teeth run it goes red for a reason that has nothing to do with addresses. The scenario header says so, and making it independent is not worth the extra code.
- Step 8's `cleanupMs: 30 s` override. The comment at the site explains it.
- `FakeHost`'s refusal of `content-type` on a body-less `DELETE` is still the only guard on the client's headers, because the real host now accepts that header (`acceptEmptyJsonBodies`). The scenario's step 8 comment and the spec header say this.
- Paths covered only by `FakeHost`: the retry loops, the other error mappings, and every cleanup branch except "abort after provision". Paths with no headless coverage at all: a device, React Native's `fetch`, and reaching the host by a LAN address. All of these are listed in the scenario header, the module and spec headers, and `docs/reference-app-rn.md`. No ticket was filed: a manual acceptance check already covers them by design.

**Tripwires:** none new. The existing `NOTE:` in `connectToNode` (an offline owner device can use up most of `connectMs`) is untouched and still accurate.

**Tickets filed:** none.

**Not run in this pass: tests.** Both `yarn workspace @serfab/reference-app-rn vitest run --project node test/host-node-request.spec.ts` and the integration scenario stop in `globalSetup` because the stale-build guard reports `@optimystic/db-p2p: dist is stale`. `git -C ../optimystic status` shows uncommitted edits across `packages/db-p2p/src`, which means the sibling repo is being worked on right now, and project rules forbid building it. So the two scenario edits above (the step 8 message assertion and the step 3 `waitUntil`) are checked only by typecheck, lint and reading the code, not by a run. The implementer's 8/8 and 34/34 runs predate them. The next run of `yarn workspace @serfab/integration-tests vitest run src/scenarios/cadre-host-donation-phone-requester.integration.ts`, once the sibling's build is fresh, should confirm them. This is not a failing test, so no `.pre-existing-error.md` was written.

**Leftover build output:** `packages/integration-tests/dist/scenarios/` from earlier builds is still on disk. It is git-ignored, nothing reads it, and `yarn clean` removes it.
