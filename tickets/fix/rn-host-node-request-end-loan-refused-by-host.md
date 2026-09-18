description: When borrowing a node from a home machine fails or is cancelled, the phone asks the machine to take the node back, and the machine refuses every time because of a header the phone sends. The node keeps running, and the token's only node slot stays used, so the user cannot try again until the machine's owner ends the loan by hand.
files: packages/reference-app-rn/src/host-node-request.ts (flow headers, `endLoan`, `send`), packages/reference-app-rn/test/host-node-request.spec.ts, packages/cadre-host/src/server (the `/grants` routes, Fastify)
repro: device run 2026-09-17 (tickets/blocked/rn-host-node-request-device-run.md, "Device run 2026-09-17"); reproduced with curl below
----

# The phone's "end the loan" request is refused by cadre-host (HTTP 400), so failed requests leak a node

## What happens

`runHostNodeRequest` builds one header set for every request to the host:

```ts
headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
```

`endLoan` sends `DELETE /grants/:id` with those headers and no body. cadre-host's management server is Fastify, which rejects a request that declares a JSON content type and carries an empty body:

```
$ curl -X DELETE -H "Authorization: Bearer <grant>" -H "content-type: application/json" http://127.0.0.1:8088/grants/grn_cVKw1qjM0876Lrvc
{"ok":false,"error":{"code":"FST_ERR_CTP_EMPTY_JSON_BODY","message":"Body cannot be empty when content-type is set to 'application/json'"}}  HTTP 400
```

The same request without the `content-type` header answers `{"ok":true}` (HTTP 200) and the loan moves to `terminated`.

On the phone (logcat), after a request that failed at "Connecting to the node…":

```
W ReactNativeJS: [host-node-request] the host refused to end loan grn_cVKw1qjM0876Lrvc (HTTP 400)
```

`donations.json` still read `"status": "seeded"` and the lent node's process was still running. The grant had `maxNodes 1`, so the next **Request Node** failed at once with "Grant is already at its node cap". The app cannot end a loan itself, so the user is stuck until the host's owner runs a `DELETE` or uses the host UI.

This affects every cleanup path that reaches `endLoan`: a failure after the host created the loan (connect timeout, authorize or seed failure) and a cancel via Disconnect.

## Why the tests did not catch it

`test/host-node-request.spec.ts` drives the flow against a fake `fetch` that accepts any `DELETE`. Fastify's empty-JSON-body rule exists only in the real server. The integration scenario `cadre-host-donation-phone-requester` uses the real server but covers the success path, which sends no `DELETE`.

## Likely fix

Send `content-type: application/json` only on requests that have a body (`POST /grants`, `PUT /grants/:id/seed`). Keep the bearer on all of them. `send` already knows whether `body` is present. `endLoan` builds its own request and needs the same rule.

Other clients of the `/grants` surface could send the same header, so consider whether cadre-host should also accept an empty body on `DELETE`. Fastify's content-type parser can be told to ignore empty bodies. Fixing only the app is enough to unblock the phone.

## TODO

- Only send the JSON content type when a body is sent (flow headers, `send`, `endLoan`).
- Make the fake host in `host-node-request.spec.ts` reject a body-less request that declares `application/json` with 400 `FST_ERR_CTP_EMPTY_JSON_BODY`, so the spec fails on the current code, then passes.
- Add a test that runs `endLoan` (or a failed request's cleanup) against the real cadre-host `/grants` server, not only the fake. It could extend the `cadre-host-donation-phone-requester` integration scenario with a failure after provision.
- Decide whether the host should also accept an empty body on `DELETE /grants/:id`, and record the decision in `docs/cadre-host.md`.
