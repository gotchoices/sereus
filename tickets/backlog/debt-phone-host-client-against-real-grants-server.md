description: The phone app's code for borrowing a node from a home machine is only tested against a hand-written imitation of that machine's web server, so it can pass its tests while the real server refuses it. Add a test that runs the phone's code against the real server.
files: packages/reference-app-rn/src/host-node-request.ts, packages/reference-app-rn/test/host-node-request.spec.ts, packages/integration-tests/src/scenarios/cadre-host-donation-phone-requester.integration.ts, packages/cadre-host/src/server/index.ts (`createLocalUiServer`, exported from `@serfab/cadre-host`), docs/reference-app-rn.md, docs/testing.md
tradeoffs: The phone module lives in a private Expo app package that `integration-tests` cannot import today (its tsconfig `rootDir` is `src`, and depending on the RN app would pull Expo into the install), so the plumbing may cost more than the class of bug it catches, now that the fake host models the one known divergence.
----

# Run the phone's host client against the real cadre-host `/grants` server

`packages/reference-app-rn/src/host-node-request.ts` is the phone's client for cadre-host's grantee-facing `/grants` HTTP surface: `POST /grants`, `GET /grants/:id/peer`, `PUT /grants/:id/seed`, and `DELETE /grants/:id`. It imports nothing and takes `fetch` and the node as dependencies, so it can run under Node.

Current coverage:

- `test/host-node-request.spec.ts` runs it against `FakeHost`, a hand-written fake `fetch`. The fake only knows the server rules someone thought to copy into it.
- `integration-tests/.../cadre-host-donation-phone-requester.integration.ts` runs a real lent node and a phone-shaped requester, but it calls `DonationService` methods directly. It never makes an HTTP request, so the server's routing, bearer check, origin guard, body parsing and error envelope never meet the phone's requests.

What slipped through: the phone sent `content-type: application/json` on a body-less `DELETE`. Real Fastify answered 400 `FST_ERR_CTP_EMPTY_JSON_BODY`, the fake answered 200, and on a device every failed borrow leaked a running node and used up the grant's node slot (fixed by `rn-host-node-request-end-loan-refused-by-host`, which also makes the fake reject that request and makes the host tolerate it). Other differences between the fake and the real server would go unnoticed the same way, for example the origin guard (`server/origin-guard.ts`), the shape of 401/403/404 envelopes, or a route whose path or method changes on one side only.

## Expected behavior

At least one automated test drives the real `requestHostNode` against a real `createLocalUiServer` with the `/grants` routes mounted and a real `DonationService` behind them, bound to loopback. It covers:

- the success path through `PUT /grants/:id/seed` (the lent node can be a real `cadre-cli` child, as in the existing scenario, or a fake orchestrator if the test stops before the dial-in);
- a failure after provision, where cleanup's `DELETE /grants/:id` must leave the donation `terminated` in the store;
- one error mapping from a real server response, such as a wrong grant token → the grant-token message.

## Open question for whoever plans this

How the test reaches the phone module. The options seen so far:

- import it into `integration-tests` by relative path (needs a tsconfig/lint change, since `rootDir` is `src`);
- move `host-node-request.ts` into a small shared package both can depend on;
- give `reference-app-rn` a dev dependency on `@serfab/cadre-host` and run the test in its `node` vitest project, which pulls a Node server package into the app's install.

`docs/testing.md` is where the chosen pattern should be written down.
