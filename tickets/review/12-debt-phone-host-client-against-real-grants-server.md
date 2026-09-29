description: The phone app's code for borrowing a node from a home machine now runs, in the end-to-end borrowing test, against that machine's real web server instead of only a hand-written imitation of it. Review the changed test, the build-config change that allows it, and the docs.
files: packages/integration-tests/src/scenarios/cadre-host-donation-phone-requester.integration.ts, packages/integration-tests/tsconfig.json, packages/integration-tests/tsconfig.build.json, packages/reference-app-rn/src/host-node-request.ts, packages/reference-app-rn/test/host-node-request.spec.ts, docs/testing.md, docs/reference-app-rn.md, docs/cadre-host.md, docs/architecture.md
----

# Phone host client runs against the real cadre-host `/grants` server

## What changed

`requestHostNode` (`packages/reference-app-rn/src/host-node-request.ts`) is the phone's client for cadre-host's grantee routes (`POST /grants`, `GET /grants/:id/peer`, `PUT /grants/:id/seed`, `DELETE /grants/:id`). Until now only the unit spec's `FakeHost` ran it. The real-network scenario `cadre-host-donation-phone-requester.integration.ts` called `DonationService` directly, so the server's routing, bearer check, origin guard, body parsing and error envelope never met the phone's actual requests.

The scenario now mounts the real server (`createLocalUiServer`, donor-only, `forcePort: 0`, stopped first in `afterAll`) and drives the borrowing through the phone's own client, imported by relative source path (`../../../reference-app-rn/src/host-node-request.js`). This works because the module imports nothing; its header now says it must stay that way.

**Build config.** `rootDir: "src"` moved from `integration-tests/tsconfig.json` to `tsconfig.build.json`, and the build now excludes `**/*.integration.ts`, as it already did `*.spec.ts` / `*.test.ts`. Without that, the file from outside `src/` fails `yarn build` with TS6059. Checked: `yarn build` still emits `dist/harness/...` at the same paths, and `tsc -p tsconfig.json --noEmit` (the config an editor uses) is clean. The stale-build guard's target check reads `package.json` dependencies, not `dist`, so it is unaffected.

## The scenario's steps now (each its own `it`)

- **Step 1** — unchanged (the requester starts and cannot be dialed).
- **Step 2 (new)** — a wrong grant token: the real server answers 401 and the client maps it to `stage: 'requesting'`, `code: 'unauthorized'`, and the "does not recognise this grant token" message. `hostOrch.listNodes()` stays empty, so nothing was provisioned.
- **Step 3 (old steps 2–5 merged)** — `requestHostNode` borrows the node. Assertions: all six stages are reported in order; the record is `seeded` with the scenario's `partyId`; `bootstrapNodes` is `[]` even though the phone's POST leaves the field off (this was the small divergence the plan mentioned); the orchestrator's node is in the requester's party; `getPeer` reports the same peer id, exactly one `/ws` port, and a mixed address list; the requester holds an **outbound** connection; the lent node's `/status` shows a websocket connection in the party; the requester still has no listen addresses. A failure is rethrown by `explainFailure` with the client's stage, code and detail, so a red run still names where it broke.
- **Steps 4–7** — old steps 6–9, renumbered, otherwise unchanged (host-side: rows cross, respawn, requester restart, terminate).
- **Step 8 (new)** — with a second grant, the request is aborted from `onStage` as `waiting-for-node` begins (before the first `GET /peer`, so the timing does not depend on how fast the child boots). Assertions: the rejection is at `stage: 'waiting-for-node'`, the grant's single donation is `terminated`, and the orchestrator no longer has its node. This proves the body-less `DELETE` ends the loan through the real route.

## Validation run (2026-09-29)

- `yarn workspace @serfab/integration-tests vitest run src/scenarios/cadre-host-donation-phone-requester.integration.ts`: 8/8 green, twice (about 24 s each; step 6 took 1.8 s in one run and 17 s in the other, a variance in the restart reconnect that this ticket did not touch).
- `yarn workspace @serfab/reference-app-rn vitest run --project node test/host-node-request.spec.ts`: 34/34.
- `yarn workspace @serfab/integration-tests typecheck`, `yarn workspace @serfab/integration-tests build`, `yarn lint`, root `yarn typecheck` (including `check:test-file-typecheck-coverage`): all clean.
- **Teeth recipe re-run and recorded in the scenario header.** `childListenAddrs` was changed to return only the TCP entry, `@serfab/cadre-host` rebuilt, and the scenario run: step 3 went red at stage `connecting` after its 90 s connect budget, and steps 4, 5, 6 and 7 went red too. Steps 1, 2 and 8 stayed green. The line was then restored and `cadre-host` rebuilt (git shows no diff there), and the scenario went back to 8/8.

## Things for the reviewer to weigh

- **Step 7 going red in the teeth run comes from the step chain, not from the addresses.** When step 3 fails, the client never returns a donation id, and its own cleanup has already ended the loan, so `terminate(undefined)` throws `not_found`. Before the merge, old step 9 stayed green in this run, because old step 2 had already set the id. The header says this. Setting the id from host-side state when step 3 fails would make step 7 independent again, but I judged it not worth the extra code.
- **Step 3 asserts `hasOutboundTo` directly, without a `waitUntil`.** The client has just seen an open connection, and a listener-less requester can only hold outbound ones, so this is the strictest form. If the connection were dropped and redialed in that instant, it would flake; it did not in the two green runs.
- **Step 8 raises `cleanupMs` to 30 s** (the app's default is 10 s), so that a slow child stop on a loaded machine cannot time out the `DELETE` before the host answers. The assertions (`terminated`, node gone) would catch a refused `DELETE` either way. A comment at the site explains this.
- **What step 8 does not prove:** that the original bug (Fastify refusing `content-type: application/json` on a body-less `DELETE`) is gone from the client. The host now tolerates that header (`acceptEmptyJsonBodies` in `cadre-host/src/server/server.ts`), so the unit spec's `FakeHost` refusal rule is still the only guard on the client's headers. The step's comment says the host tolerates the header and that the step pins only that the loan ends.
- **Still covered only by `FakeHost`:** the `peer_unavailable` and `seed_failed` retry loops, the other error mappings (403, 404, 409, `quota_exceeded`, `forbidden_origin`), and every cleanup branch except "abort after provision". Not covered headlessly at all: a device, React Native's `fetch`, and a LAN host address (the origin guard's refusal). These are listed in the scenario header, the module and spec headers, and `docs/reference-app-rn.md`.
- **Leftover compiled scenarios.** `packages/integration-tests/dist/scenarios/` from earlier builds is still on disk, because `tsc` does not delete outputs it no longer emits. It is git-ignored, nothing reads it, and `yarn clean` removes it.

## Tests added or changed

- Step 2 (new): the real server's 401 for an unknown bearer reaches the user as the grant-token message, and nothing is provisioned.
- Step 3 (replaces old steps 2–5): the phone's real request sequence works end to end against the real server and a real `cadre-cli` child, including a POST that leaves out `bootstrapNodes`.
- Step 8 (new): a cancel after provisioning ends the loan through the real `DELETE` route.

No unit tests were added. The build-config change has no test; the build and typecheck runs above check it.

## Docs updated

- `docs/testing.md`: a new section, "App modules in a scenario" (the relative-source-import pattern, why not a package dependency, the import-free rule, no stale-build guard needed, scenarios excluded from the build and `rootDir` moved). The phone-requester bullet in the topology coverage map now says the scenario goes through the real `/grants` routes with the phone's own client.
- `docs/reference-app-rn.md` (Borrowing a Node From a cadre-host): the "no automated test" sentence and its backlog link are replaced with what each test covers and what is still manual.
- `docs/cadre-host.md` (status of the donation surface) and `docs/architecture.md` (`@serfab/cadre-host` bullet): "provisions with `bootstrapNodes: []`" now reads "provisions over the `/grants` routes with the phone's own client, sending no `bootstrapNodes`".
- `host-node-request.ts` and `test/host-node-request.spec.ts` headers: the references to this ticket are gone, and they now state what the scenario covers and what only `FakeHost` covers.
