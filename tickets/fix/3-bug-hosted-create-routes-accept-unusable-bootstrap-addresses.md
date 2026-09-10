---
description: The two hosting services check that a request lists at least one address to connect to, but not that the entries are usable addresses — so a mistyped one is accepted and the node they start fails later instead of the caller being told.
files: packages/cadre-provider/src/server/routes.ts, packages/cadre-host/src/server/routes/grants.ts, packages/cadre-provider/src/server/owner-key-validation.ts, packages/cadre-provider/src/service/container-env.ts
repro: static
---

# Hosted create routes accept bootstrap addresses they cannot use

## Background

Two request boundaries spawn a node on a caller's behalf:

- `POST /containers` in cadre-provider (`src/server/routes.ts`)
- `POST /grants` in cadre-host (`src/server/routes/grants.ts`), which forwards to
  `DonationService.provision`

Both take a `bootstrapNodes` list — the peer addresses the new node dials to reach
the party. Both forward it verbatim into the child as the `CADRE_BOOTSTRAP_NODES`
environment variable (`cadre-provider/src/service/container-env.ts`).

The owner-key field on these same two requests was fixed in
`bug-hosted-owner-key-pins-unchecked-at-api-boundary`: entries are now shape-checked
where the caller supplies them, so a typo comes back as a `400` naming the bad value
instead of a node that dies at boot. `bootstrapNodes` still has the gap that ticket
closed for owner keys.

## What is wrong

Both routes check only that `bootstrapNodes` is a non-empty array. Neither checks:

- **that the entries are strings.** `bootstrapNodes: [42]` passes both routes. It is
  then string-joined into an environment variable, so the node starts with the
  characters `42` where an address should be.
- **that an entry is a usable address at all.** `"not-an-address"` is accepted by
  both routes and reaches the node the same way.

cadre-provider's `partyId` check has the smaller version of the first problem: it
tests truthiness only (`if (!body.partyId)`), so a non-string `partyId` is accepted
where cadre-host's equivalent route checks `typeof`.

Read from the code, not observed: nothing between these routes and the spawned
child parses the value, and no repo caller sends a bad one. **What would confirm
it:** POST either route with `bootstrapNodes: ["not-an-address"]` and watch whether
the response is a `201` and the child then fails — and if it fails, whether the
failure is legible anywhere the caller can see.

## Why it matters

Same reason as the owner-key ticket: the request is the last point at which the
caller can fix a typo. After that the failure surfaces (if at all) as container
status on someone else's machine. It is also the caller's quota/resources that are
spent provisioning something that could never have worked.

## Expected behaviour

A `bootstrapNodes` entry that is not a string, or that cannot be parsed as a
multiaddr, should be answered `400` naming the offending entry, with nothing
provisioned — matching how each route now answers a malformed owner key
(`INVALID_REQUEST` on the provider, `invalid_request` on the host). `partyId`
should be type-checked on the provider route as it already is on the host route.

## Open question for whoever picks this up

Parsing a multiaddr needs a parser. cadre-host can import one (it already depends on
`@serfab/cadre-core`), but cadre-provider deliberately declares **no** workspace
dependencies — the reason its owner-key check restates the rule locally over
`uint8arrays` rather than importing cadre-core's
(`packages/cadre-provider/src/server/owner-key-validation.ts` documents the
tradeoff). `@multiformats/multiaddr` is a plain npm package, so the same escape
hatch is available, but hand-rolling a multiaddr parser is not (see AGENTS.md: no
half-baked parsers). Decide whether the address check is worth the dependency, or
whether the string-type check alone is the right scope here.
