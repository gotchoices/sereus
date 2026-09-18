description: When a phone's request to borrow a node from a home machine fails or is cancelled, the phone's "end the loan" request is refused, so the node keeps running and the phone cannot try again. Fix the phone so it stops sending the header that causes the refusal, and make the home machine accept that header anyway.
files: packages/reference-app-rn/src/host-node-request.ts, packages/reference-app-rn/test/host-node-request.spec.ts, packages/cadre-host/src/server/server.ts (`buildFastify`), packages/cadre-host/src/server/__tests__/grants-route.test.ts, packages/cadre-host/src/server/__tests__/server.smoke.test.ts, docs/cadre-host.md (Local UI server → API surface / Node donation), docs/reference-app-rn.md (line ~622, the coverage paragraph)
repro: verified
----

# The phone's `DELETE /grants/:id` is refused with HTTP 400, so a failed borrow leaks the lent node

## Cause (reproduced)

`requestHostNode` in `packages/reference-app-rn/src/host-node-request.ts` builds one header set for every request to cadre-host (line ~195):

```ts
headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
```

`send` (line ~496) and `endLoan` (line ~472) both pass `flow.headers` unchanged. `endLoan` sends `DELETE /grants/:id` with no body. cadre-host's management server is Fastify 5.7.1, whose default JSON parser (`node_modules/fastify/lib/content-type-parser.js`, `defaultJsonParser`) rejects a zero-length body that declares `application/json`:

```
400 {"ok":false,"error":{"code":"FST_ERR_CTP_EMPTY_JSON_BODY","message":"Body cannot be empty when content-type is set to 'application/json'"}}
```

Reproduced in-process during the fix stage: the `grants-route.test.ts` fixture (real `registerGrantsRoutes` + `registerErrorHandler`, fake orchestrator), `app.inject({ method: 'DELETE', url: '/grants/<id>', headers: { authorization: 'Bearer …', 'content-type': 'application/json' } })` answers exactly that 400. The same request without the content type answers 200 and the donation becomes `terminated`. Also seen on a device (`tickets/blocked/rn-host-node-request-device-run.md`, "Device run 2026-09-17") and with curl.

Effect: every cleanup path that reaches `endLoan` fails — a failure after `POST /grants` succeeded (node never boots, seed refused, authorize fails, connect timeout) and a cancel via Disconnect. `endLoan` only logs `the host refused to end loan … (HTTP 400)`. The loan stays live, the node keeps running, and a grant with `maxNodes: 1` then answers every new request with "already at its node cap" until the host's owner ends the loan by hand.

## Why the tests missed it

- `test/host-node-request.spec.ts` uses a fake `fetch` (`FakeHost`) that accepts any `DELETE`. It records `authorization` but not `content-type`, and the cleanup tests only assert that a `DELETE` was *sent* (`countOf('DELETE /grants/donation-1') === 1`), not that it was accepted.
- `grants-route.test.ts` builds its server with a bare `Fastify()`, and its `DELETE` test sends no content type.
- `packages/integration-tests/src/scenarios/cadre-host-donation-phone-requester.integration.ts` calls `DonationService` methods directly. It does not use HTTP at all, so no test runs the phone's HTTP client against the real `/grants` server. `docs/reference-app-rn.md` (~line 622) and the header comment of `host-node-request.spec.ts` both describe that scenario as covering "the same flow on the wire", which is wrong for the HTTP half. The missing test is filed separately as `backlog/debt-phone-host-client-against-real-grants-server`.

## Fix — two parts, both in this ticket

### 1. Phone: send the JSON content type only with a body

`Flow.headers` holds only the bearer. `send` adds `content-type: application/json` when `body !== undefined`. `endLoan` never sends a body, so it uses the bearer-only headers. Keep a single place that builds the headers for a request (for example a small `headersFor(flow, hasBody)` helper) so `send` and `endLoan` cannot drift apart again.

### 2. Host: treat an empty JSON body as no body

Decision (made in the fix stage; record it in `docs/cadre-host.md`): cadre-host's management server accepts a request that declares `application/json` but carries an empty body, and hands the route `request.body === undefined`. Reasons:

- `/grants` is the one surface on this server meant for other people's clients (the phone app today, other requester apps and scripts later). Sending a JSON content type on every request, body or not, is a common client habit (the phone did it; `packages/cadre-host/ui/src/lib/api.ts` is written to avoid it). A strict rejection turns that habit into a leaked node and a used-up quota slot, which costs much more than it protects.
- Every route that reads a body already treats a missing one as `{}`: `grants.ts` (116, 156), `grants-admin.ts` 29, `nat.ts` 33 and 50, `settings.ts` 48, `trust-circle.ts` 29, `update.ts` 40 all use `request.body ?? {}`. So a body-requiring route still answers its own 400 `invalid_request` for an empty body, which names the missing field instead of Fastify's parser error. Re-check this list with `grep -rn "request.body" packages/cadre-host/src/server` when you implement.
- Non-empty malformed JSON is still rejected, and prototype-poisoning protection is unchanged, because the non-empty case is delegated to Fastify's own parser.

Where: `buildFastify()` in `packages/cadre-host/src/server/server.ts`, the single constructor used by `createLocalUiServer`. Replace the `application/json` parser with one that answers `done(null, undefined)` for a zero-length body and otherwise calls the parser returned by `app.getDefaultJsonParser('error', 'error')` (Fastify's documented API; the arguments are the proto/constructor-poisoning actions, `'error'` being Fastify's default). Register it with `{ parseAs: 'string' }`, and pass `bodyLimit` only if you need to override the server default. Use `app.removeContentTypeParser('application/json')` followed by `app.addContentTypeParser(...)`. This is not a new parser, just Fastify's parser with an empty-body branch in front of it.

cadre-provider also runs Fastify (`POST /containers`), but no phone client talks to it. Leave it alone.

## Tests

- **`host-node-request.spec.ts` — make the fake host enforce the rule.** `FakeHost.fetch` answers `fail(400, 'FST_ERR_CTP_EMPTY_JSON_BODY', …)` for any request that declares `application/json` without a body, the way a strict Fastify server does. Record `contentType` on `Call`. Add a helper, or an assertion in the existing cleanup tests (the "gives up on a node that never comes up", seed-refused, `addDrone`-throws, peer-with-no-address and cancellation tests), that the loan was actually ended: no `refused to end loan` warning, not just `countOf('DELETE …') === 1`. Add one direct test: a failure after provision → the `DELETE` carries the bearer and no content type → no warning. Confirm the new assertions fail on the current code before you change `host-node-request.ts`.
- **cadre-host — pin the leniency.** In `grants-route.test.ts`, build the app with `buildFastify()` instead of a bare `Fastify()`, so the route tests run with the same parser setup as production. Add: `DELETE /grants/:id` with `content-type: application/json` and no body → 200 and `terminated`; `POST /grants` with the JSON content type and an empty body → the route's own 400 `invalid_request`, not `FST_ERR_CTP_EMPTY_JSON_BODY`; a non-empty malformed body is still 400. If `buildFastify` cannot be used there, put the parser tests in `server.smoke.test.ts` against `createLocalUiServer`.
- Run `yarn workspace @serfab/reference-app-rn test` (node project) and `yarn workspace @serfab/cadre-host test`, plus both packages' typecheck and `yarn lint`.

## Docs

- `docs/cadre-host.md`: one short paragraph or bullet (Local UI server → API surface, or the Node donation section next to step 5 `DELETE /grants/:id`) stating the empty-JSON-body rule and why.
- `docs/reference-app-rn.md` ~line 622 and the header comment of `host-node-request.spec.ts`: correct the "on the wire" claim. The integration scenario proves the lent node and the dial-in, but not the phone's HTTP calls to `/grants`, and point to `debt-phone-host-client-against-real-grants-server`.

## Follow-up for the device run

`tickets/blocked/rn-host-node-request-device-run.md` item 2 already asks for an on-device check once this lands: a failed request and a Disconnect during a request should both end with the donation `terminated` in `donations.json`. Nothing to change there.

## TODO

- Phone: bearer-only `Flow.headers`; add the JSON content type only when `send` has a body; `endLoan` sends none. Build request headers in one place.
- Fake host in `host-node-request.spec.ts`: reject a body-less `application/json` request with 400 `FST_ERR_CTP_EMPTY_JSON_BODY`, record the content type, and assert in the cleanup tests that the loan was actually ended (no "refused" warning). See the tests fail first, then pass.
- Host: an empty-body-tolerant JSON parser in `buildFastify()` that delegates non-empty bodies to `app.getDefaultJsonParser('error', 'error')`.
- `grants-route.test.ts` on `buildFastify()`; add the DELETE-with-content-type, POST-with-empty-body and malformed-body cases.
- Docs: the empty-body rule in `docs/cadre-host.md`; correct the "on the wire" coverage claim in `docs/reference-app-rn.md` and the spec header.
- Run tests, typecheck and lint for both packages.
