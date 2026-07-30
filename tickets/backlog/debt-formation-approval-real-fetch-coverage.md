description: The code that calls an outside approval service over the network is only tested against a fake network. Test it against a real one, because the real network behaves differently in exactly the places the code guesses at.
files: packages/cadre-core/src/formation-approval.ts, packages/cadre-core/test/formation-approval.spec.ts, packages/integration-tests/
difficulty: easy
----

# Real-network coverage for the formation approval client

## Background

When a party invites someone to a strand, the invitation may name an outside approval service (a
web hook) that gets asked whether that one person may join. `createHttpFormationApprover()` in
`packages/cadre-core/src/formation-approval.ts` is the client that does the asking. Its contract
is documented for hook operators in `docs/api.md` ("Validate Strand Formation (approval hook)").

Every existing test for that client injects a stub in place of `fetch`. The stub is written to
behave the way we believe a real `fetch` behaves — which means the tests confirm our belief, not
the platform.

## Why this matters

Three behaviours are decided by the platform's `fetch`, not by our code, and the client branches
on all three:

- **Redirects.** The client sends `redirect: 'error'`. Whether that makes `fetch` *reject*, or
  resolve with a response whose `redirected` is true, differs by runtime. The client handles both
  and the stub tests exercise both — separately, by construction. Neither test tells us which one
  a real Node or browser `fetch` actually does.
- **Aborting mid-body.** The client arms one timer that must still be armed while the response
  body is being read. Whether an abort during the body read surfaces as an `AbortError` from the
  stream, or as some other stream error, is the platform's choice.
- **Response body streaming.** The client caps a response at 64 KiB and is supposed to stop
  *reading* at the cap rather than buffer and then measure. Against a stub `ReadableStream` this
  is easy to demonstrate; against a real socket it involves the runtime's own buffering.

## What to build

A test that stands up a throwaway HTTP server in-process and drives the **real** global `fetch`
through it — no `fetchImpl` injection. Cover at least:

- a hook that answers a valid approval (the baseline: the real path works at all)
- a hook that answers `403` (refusal) and one that answers `500` (unavailable)
- a hook that redirects (`302` to another path) — assert the outcome is `unavailable` whichever
  way the platform reports it
- a hook that sends headers and then never finishes the body — assert the timeout fires and the
  failure is `unavailable`
- a hook that streams far more than 64 KiB without declaring a `content-length` — assert
  `malformed`, and assert the server observed the client hang up early rather than reading it all

`packages/integration-tests/` is the home for cross-package real-network tests and is the natural
place for this; a self-contained server inside `packages/cadre-core/test/` would also be
acceptable if it stays fast and needs no fixture beyond `node:http`.

## Out of scope

Contacting a real third-party approval service, and anything about wiring the client into the
redemption path (separate tickets).
