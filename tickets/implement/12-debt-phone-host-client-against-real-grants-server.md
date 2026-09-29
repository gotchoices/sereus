description: The phone app's code for borrowing a node from a home machine is only tested against a hand-written imitation of that machine's web server, so it can pass its tests while the real server refuses it. Make the existing end-to-end borrowing test go through the phone's real code and the real server.
files: packages/integration-tests/src/scenarios/cadre-host-donation-phone-requester.integration.ts, packages/integration-tests/tsconfig.json, packages/integration-tests/tsconfig.build.json, packages/reference-app-rn/src/host-node-request.ts, packages/reference-app-rn/test/host-node-request.spec.ts, packages/cadre-host/src/server/index.ts, packages/cadre-host/src/server/routes/grants.ts, docs/testing.md, docs/reference-app-rn.md, docs/cadre-host.md, docs/architecture.md
----

# Run the phone's host client against the real cadre-host `/grants` server

## Background

`packages/reference-app-rn/src/host-node-request.ts` (`requestHostNode`) is the phone's client for cadre-host's grantee-facing HTTP surface (`packages/cadre-host/src/server/routes/grants.ts`): `POST /grants`, `GET /grants/:id/peer`, `PUT /grants/:id/seed`, `DELETE /grants/:id`. It imports nothing and takes `fetch` and the node as dependencies.

Today it is tested only against `FakeHost` (`reference-app-rn/test/host-node-request.spec.ts`), a hand-written fake `fetch`. The real-network scenario `integration-tests/src/scenarios/cadre-host-donation-phone-requester.integration.ts` runs a real lent `cadre-cli` child and a phone-shaped in-process `CadreNode`, but calls `DonationService` methods directly, so the server's routing, bearer check, origin guard, body parsing and error envelope never meet the phone's requests. A real divergence already slipped through this gap (the body-less `DELETE` sent with `content-type: application/json`, refused by Fastify with 400, fixed by `rn-host-node-request-end-loan-refused-by-host`). A smaller one is visible now: the scenario provisions with `bootstrapNodes: []`, while the phone omits the field entirely.

## Decisions

**How the test reaches the phone module: a relative source import from the integration scenario.** The scenario imports `../../../reference-app-rn/src/host-node-request.js` directly.

- It works because the module is dependency-free by design (its header already says so, for its unit spec). Checked during planning: a NodeNext ESM file importing it by relative path type-checks cleanly with `tsc` 5.9.3 and `types: ["node"]` (the module is CommonJS-format under NodeNext because `reference-app-rn/package.json` has no `"type"`, and importing named exports from it into ESM is allowed). Vitest resolves the `.js` specifier to the `.ts` source.
- Importing source rather than a build means no stale-build guard is needed for it.
- `integration-tests/tsconfig.typecheck.json` already sets `rootDir: "../.."`, so `yarn typecheck` admits the file as-is.
- Rejected: a dev dependency from `reference-app-rn` on `@serfab/cadre-host` (installs a Fastify server and its dependency tree into the Expo app's own `node_modules`, since that package sets `hoistingLimits: "workspaces"`, and into every EAS build install). Rejected: moving the module into a shared or published package (it carries phone-specific user wording such as the `adb reverse` hint; a new package or a new public cadre-core API for one test is more than the test is worth). Rejected: a dependency from `integration-tests` on `@serfab/reference-app-rn` (the Expo app has no exports map, and linking it drags the question of its dependencies into this package).

**Build config.** `integration-tests`' `yarn build` (`tsconfig.build.json`, extending `tsconfig.json` with `rootDir: "src"`) would fail with TS6059 on a file outside `src`. Fix it on principle, not with a one-file exclusion: scenario files are Vitest test files exactly like the `*.spec.ts` / `*.test.ts` the build already excludes, and nothing consumes compiled scenarios (the ad-hoc device-run scripts in `dist/` import the harness only). So:

- add `"**/*.integration.ts"` to `tsconfig.build.json`'s `exclude`;
- move `"rootDir": "src"` from `tsconfig.json` into `tsconfig.build.json`, so an editor opening the scenario (which uses `tsconfig.json`) does not show TS6059 on the import. `tsconfig.typecheck.json` overrides `rootDir` itself and is unaffected. Confirm `yarn workspace @serfab/integration-tests build` still emits `dist/harness/...` at the same paths (it will, since the build keeps `rootDir: "src"`).

**Where the test lives: fold into the existing phone-requester scenario rather than a new file.** That scenario already has everything the success path needs — a real `HostProcessOrchestrator` spawning a real `cadre-cli` child, a real `DonationService`, and a real phone-shaped `CadreNode` whose `addDrone` mints a seed the child accepts. A second file would repeat two real child spawns and an in-process node to prove the same thing. Driving its steps 2–5 through `requestHostNode` over HTTP makes the scenario prove the phone's actual requests work, not a hand-picked equivalent of them.

## The changed scenario

In `beforeAll`, after `donationService` is built, mount the real server:

```ts
server = createLocalUiServer({
  uiPort: <any valid port; forcePort overrides it>,
  dataDir: join(tmpRoot, 'ui'),
  orchestrator: hostOrch,
  grants,
  donations: donationService,
  forcePort: 0,
});
hostUrl = (await server.start()).url; // http://127.0.0.1:<port>
```

(`createTestCadreHost` in `src/harness/test-cadre-host.ts` shows the same `forcePort: 0` wiring; it is not reused here because it installs a founder-role host with trust-circle and NAT services this scenario does not need.) Keep the `GrantService` instance in a variable so later tests can issue a second grant. In `afterAll`, `await server?.stop()` before the orchestrator cleanup.

Steps, in file order:

- **Step 1** — unchanged.
- **New: a wrong grant token is refused by the real server and mapped to the grant-token message.** `requestHostNode(hostUrl, 'not-a-real-token', { fetch: globalThis.fetch, node: requester! })` rejects with a `HostNodeRequestError` whose `stage` is `'requesting'`, `code` is `'unauthorized'`, and `message` is the 401 text from `plainMessage` ("The host does not recognise this grant token…"; compare against the same literal the unit spec uses or a regex on its start — do not export `plainMessage` for this). Also assert nothing was provisioned: `hostOrch.listNodes()` is empty. No child is spawned, so this costs milliseconds and fails fast if routing or the envelope shape drifts.
- **Steps 2–5 merged: the phone's client borrows the node over HTTP.** One `it` calls `requestHostNode(hostUrl, grantToken, { fetch: globalThis.fetch, node: requester!, onStage: (s) => stages.push(s), budgets: { nodeStartupMs: STARTUP_MS, seedRetryMs: OP_MS, connectMs: STARTUP_MS, pollIntervalMs: 500 } })`. On rejection, rethrow with the error's `stage`, `code` and `detail` in the message, so a failure still names the step it broke on (what the separate `it`s used to give). Then assert the facts the old steps pinned, reading host-side state directly:
  - `stages` equals all six stages in order;
  - `donationService.get(donationId)` has `status: 'seeded'`, `partyId` equal to the scenario's, and `bootstrapNodes` equal to `[]` — now proved for a request that **omits** the field, which is what the phone sends;
  - `hostOrch.getNode(donationId)?.partyId` is the requester's party;
  - `donationService.getPeer(donationId)`: peer id matches the returned `peerId` and `/^12D3Koo/`; exactly one `/ws` port (`wsPortsOf`), stored in `wsPortsBeforeRespawn` for step 7; the list is mixed (some non-`/ws` entry);
  - `hasOutboundTo(requester!, peerId)` (the client's own check accepts any open connection; this pins direction), the lent node's `/status` reports `partyId` and a `websocket` connection (keep the existing poll), and `requester!.getMultiaddrs()` is still `[]`.
  Set `donationId`, `dronePeerId`, `droneMultiaddrs` from the result so steps 6–9 run unchanged. Carry over the explanatory comments from old steps 2–5 that still apply (why the premise is re-asserted after connecting, why `peersAdded` is not asserted, why the address list is not filtered); drop the ones about `applySeed` polling and the manual `reconcileControlCohort` call, which the client now does. The `it` timeout covers the three budgets plus the `/status` poll.
- **Steps 6–9** — renumber to follow; otherwise unchanged. They stay host-side (`respawn`, `stopContainer`, `terminate` have no phone-side call).
- **New, last: a failure after provision ends the loan through the real `DELETE`.** Issue a second grant (`grants.issue({ label: … })`) so this test does not depend on step 9 having freed the first grant's single node slot (`DEFAULT_MAX_NODES` is 1). Make an `AbortController` and call `requestHostNode` with `signal: controller.signal` and `onStage: (s) => { if (s === 'waiting-for-node') controller.abort(); }`. Aborting inside the callback happens before the first `GET /peer` is sent, so the failure is deterministic and does not depend on how fast the child boots; it is also the device path (`use-cadre.ts`'s `stop` aborts a running request). Assert: rejection is a `HostNodeRequestError` with `stage: 'waiting-for-node'`; `donationService.list(secondToken)` holds exactly one donation and its `status` is `'terminated'`; `hostOrch.getNode(thatId)` is `undefined`. This is the body-less `DELETE` that the real server once refused.

Update the scenario's header: the numbered step list, the paragraph describing what it pins (it now drives the host over HTTP with the phone's own client, imported by relative path — say why in a sentence and point at `docs/testing.md`), and the MEASURED TEETH paragraph. Re-run that recipe (edit `childListenAddrs` in `packages/cadre-host/src/orchestrator/host-process-orchestrator.ts` to return the TCP entry alone, `yarn workspace @serfab/cadre-host build`, run the scenario, restore the line, rebuild, run again) and record which steps went red with today's date; the merged step should fail at stage `connecting`. `cadre-host` is in this repo, so building it is allowed; the sibling-repo rule does not apply. If the recipe cannot be completed in this run, restore and rebuild `cadre-host` anyway, keep the old dated record, and say so in the handoff.

## Edge cases & interactions

- **Origin guard.** Node's `fetch` sends `Host: 127.0.0.1:<port>` and no `Origin`, which the guard accepts; the server's `start()` returns a `127.0.0.1` URL. Verified by the success step passing. A real phone on a LAN address hits the `forbidden_origin` branch, which stays covered by the unit spec only — note this in the scenario header as out of scope, alongside the existing WAN note.
- **Body-less `DELETE`.** Covered by the abort test through cleanup. The host now tolerates the bad header too, so this test would not have caught the original bug by itself; it pins that the loan actually ends (`terminated`) through the real route. Verified by the test.
- **Wrong token creates nothing.** `DonationService.provision` validates the grant before writing a record; asserted via `hostOrch.listNodes()` being empty.
- **Structural fit of `CadreNode` to `HostNodeRequestNode`.** `use-cadre.ts` already passes a real `CadreNode`; confirmed here by `yarn workspace @serfab/integration-tests typecheck`. If it fails, fix the interface in `host-node-request.ts`, not with a cast in the test.
- **Chained state.** The success step sets `donationId`/`dronePeerId`/`droneMultiaddrs`/`wsPortsBeforeRespawn` for steps 6–9 exactly as old steps 2–3 did; if it fails, those steps fail as they do today. The wrong-token and abort tests do not depend on the chain (the abort test uses its own grant).
- **Port band.** The abort test's child comes from the same orchestrator and port band (20340–20499) and is reclaimed by `terminate`; step 7's respawn only needs its own donation's ports, which the earlier allocation holds.
- **Teardown order.** Stop the server before removing orchestrator nodes, so no request lands mid-teardown.
- **Module stays import-free.** Add one sentence to the `host-node-request.ts` header: the integration scenario imports this file by relative path from Node, so it must keep importing nothing (a native or Expo import would break that scenario at load). By inspection.
- **Build and gates.** `yarn workspace @serfab/integration-tests build` still succeeds and emits the harness; `yarn typecheck` (including `check:test-file-typecheck-coverage`) and `yarn lint` pass. Run them; no test for the config itself.

## Docs

- `docs/testing.md`: add a short section (next to "Stale-build guard" or under the topology coverage map, whichever reads better) stating the pattern: an app module with no imports can be run in an integration scenario by relative source import; why that and not a package dependency or a shared package; that scenario files are excluded from the `integration-tests` build; that nothing needs a stale-build guard for it. Update the phone-requester bullet near line 584 to say it drives the host over HTTP with the phone's own client.
- `docs/reference-app-rn.md` ~line 677: replace the "No automated test runs the phone's HTTP client against the real `/grants` server" sentence and its backlog link with what now runs where. What still is not covered headlessly: a device, React Native's `fetch`, and a LAN address (origin guard).
- `docs/cadre-host.md` ~line 142 and `docs/architecture.md` ~line 1808: "provisions with `bootstrapNodes: []`" becomes "provisions over the `/grants` routes with the phone's own client, sending no `bootstrapNodes`".
- `host-node-request.ts` header (lines ~33–38) and `test/host-node-request.spec.ts` header (the "NOT covered" bullet): drop the references to this ticket and say the real server is now exercised by the scenario, which covers the success path, a 401 mapping and the cleanup `DELETE`; `FakeHost` remains the only coverage for the retry loops, the other error mappings and every cleanup branch.

## TODO

- Move `rootDir: "src"` from `integration-tests/tsconfig.json` to `tsconfig.build.json`; add `**/*.integration.ts` to the build's `exclude`; confirm `yarn workspace @serfab/integration-tests build` still emits `dist/harness/`.
- In the phone-requester scenario: import `requestHostNode` / `HostNodeRequestError` / `HostNodeRequestStage` by relative path and `createLocalUiServer` from `@serfab/cadre-host`; mount and tear down the server.
- Add the wrong-token test; merge steps 2–5 into the HTTP-driven step with its post-condition asserts; renumber 6–9; add the abort-cleanup test with its own grant.
- Update the scenario header (step list, scope, out-of-scope notes, MEASURED TEETH) and re-run the teeth recipe.
- One sentence in the `host-node-request.ts` header about staying import-free; update it and the spec header per Docs.
- Update `docs/testing.md`, `docs/reference-app-rn.md`, `docs/cadre-host.md`, `docs/architecture.md`.
- Run `yarn workspace @serfab/integration-tests typecheck`, `yarn workspace @serfab/integration-tests vitest run src/scenarios/cadre-host-donation-phone-requester.integration.ts`, `yarn workspace @serfab/reference-app-rn vitest run --project node test/host-node-request.spec.ts`, `yarn lint`, and root `yarn typecheck`. Run in the foreground; the scenario takes a few minutes.
