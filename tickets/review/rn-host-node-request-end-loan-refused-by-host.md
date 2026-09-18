description: When a phone's request to borrow a node from a home machine failed or was cancelled, the home machine refused the phone's "end the loan" request, so the node kept running. The phone no longer sends the header that caused the refusal, and the home machine now accepts that header anyway.
files: packages/reference-app-rn/src/host-node-request.ts, packages/reference-app-rn/test/host-node-request.spec.ts, packages/cadre-host/src/server/server.ts, packages/cadre-host/src/server/__tests__/grants-route.test.ts, docs/cadre-host.md, docs/reference-app-rn.md
----

# Phone's `DELETE /grants/:id` no longer refused; host tolerates an empty JSON body

## The bug

The phone's cadre-host client (`requestHostNode`) sent `content-type: application/json` on every request, including the body-less `DELETE /grants/:id` that cleanup sends to end a loan. cadre-host runs Fastify 5.7.1, whose default JSON parser answers `400 FST_ERR_CTP_EMPTY_JSON_BODY` to that. So every failed or cancelled borrow after `POST /grants` succeeded left the lent node running and holding the grant's node slot. With `maxNodes: 1`, the next request was then refused with "already at its node cap".

## What changed

**Phone (`host-node-request.ts`).** `Flow` now holds only the bearer string (`authorization`). A new `headersFor(flow, hasBody)` builds every request's headers: always the bearer, plus `content-type: application/json` only when a body goes with the request. `send` passes `body !== undefined`; `endLoan` passes `false`. The module comment no longer says the integration scenario is the "wire-level proof" of the whole path.

**Host (`server.ts`).** `buildFastify()` (the one constructor, used by `createLocalUiServer` in `server/index.ts`) now calls `acceptEmptyJsonBodies(app)`. That removes the `application/json` parser and adds one registered with `{ parseAs: 'string' }`: a zero-length body answers `done(null, undefined)`; anything else goes to `app.getDefaultJsonParser('error', 'error')`, so malformed JSON and prototype-poisoning payloads are still `400 FST_ERR_CTP_INVALID_JSON_BODY`. No `bodyLimit` override, so the server default applies. I re-checked that every route reading a body uses `request.body ?? {}` (`grep -rn "request.body" packages/cadre-host/src/server`): grants.ts 116/156, grants-admin.ts 29, nat.ts 33/50, settings.ts 48, trust-circle.ts 29, update.ts 40. cadre-provider's Fastify server is unchanged.

The delegated call is `void parseJson(request, body, done)`. Fastify types the default parser as a union that includes a promise-returning form, which lint's no-floating-promises rule flagged. The real default parser is the callback form.

**Docs.** `docs/cadre-host.md` → Local UI server → API surface has a new paragraph, "An empty JSON body counts as no body", with the reason. `docs/reference-app-rn.md` (Borrowing a Node From a cadre-host) and the spec's header comment now say that the integration scenario calls `DonationService` directly, not over HTTP, and point to `backlog/debt-phone-host-client-against-real-grants-server`.

## Tests

**`host-node-request.spec.ts`**
- `FakeHost` reads headers through `new Headers(init.headers)` and records `contentType` on each `Call`.
- New `parserRefusal(call)` models strict Fastify before any route runs. GET and HEAD are skipped, because Fastify never parses their bodies. For other methods, declaring JSON with no body gets `400 FST_ERR_CTP_EMPTY_JSON_BODY`, and sending a body without declaring JSON gets `415 FST_ERR_CTP_INVALID_MEDIA_TYPE`. The fake stays strict on purpose, even though the host is now lenient.
- New `expectLoanEnded(host)` checks that exactly one `DELETE /grants/donation-1` went out and that no warning containing "end loan" was logged. The eight cleanup tests now use it instead of the old `countOf('DELETE …') === 1` check: node never boots, seed refused, 409 on the seed, connect timeout, reconcile pass throws, peer with no address, `addDrone` throws, and cancellation.
- Two new tests. One checks that the `DELETE` after a failure carries the bearer and no content type, and that the loan ended. The other checks the content type on each request of the happy path: POST json, GET none, PUT json.
- Checked before the fix: on the old client, 11 tests failed, each because of the header. After the fix: 34/34 in the file, and the whole package passes (317 tests, 21 files).

**`grants-route.test.ts`**
- The app is now built with `buildFastify()` instead of a bare `Fastify()`, so the route tests parse bodies the way production does.
- New tests:
  - `DELETE /grants/:id` with the JSON content type and no body → 200, and the store row is `terminated`.
  - `POST /grants` with the JSON content type and an empty body → the route's own `400 invalid_request` "partyId is required".
  - A truncated JSON body → `400 FST_ERR_CTP_INVALID_JSON_BODY`.
  - A `__proto__` body → the same 400, and nothing is provisioned.
  - `application/json; charset=utf-8` still parses, → 201.
- Checked the other way round: with the `acceptEmptyJsonBodies(app)` call commented out, the first two new tests fail. The call is restored.
- Whole package: 657 passed, 4 skipped (the skips were there before), 68 files.

Also run: `yarn workspace @serfab/reference-app-rn typecheck`, `yarn workspace @serfab/cadre-host typecheck`, and `yarn lint`. All clean.

## Known gaps / things for the reviewer to check

- **Still no test runs the phone client against the real `/grants` server.** The fake host copies only the two Fastify parser rules above. Any other difference between the fake and the real server would still go unnoticed, for example the origin guard or the shape of the error bodies. This is tracked in `backlog/debt-phone-host-client-against-real-grants-server`, which is unchanged.
- **The host no longer rejects an empty JSON body anywhere on the management server,** including `/api/*`, `/auth/*`, `/nat/*` and `/update/*`, not only `/grants`. This was decided in the fix stage. A future route that reads `request.body` without `?? {}` would get `undefined`.
- **`server.smoke.test.ts` does not exercise the parser.** The coverage goes through `buildFastify()` in `grants-route.test.ts`, which is the same constructor `createLocalUiServer` uses.
- **Not checked on a device.** Item 2 of `tickets/blocked/rn-host-node-request-device-run.md` already asks for this: after a failed request, and after a Disconnect during a request, the donation should end up `terminated` in `donations.json`.

## Usage / validation

- `yarn workspace @serfab/reference-app-rn test`, `yarn workspace @serfab/cadre-host test`, both typechecks, and `yarn lint`.
- By hand against a running host: `curl -X DELETE -H "authorization: Bearer <token>" -H "content-type: application/json" http://127.0.0.1:<port>/grants/<id>` should now answer 200, and the donation should show `terminated`.
