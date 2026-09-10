----
description: The two services that start a node for someone accept any junk in the list of peer addresses the new node is supposed to dial, so a mistyped address is answered "created" and the node quietly fails on someone else's machine instead of the caller being told what is wrong.
files: packages/cadre-provider/src/server/routes.ts, packages/cadre-provider/src/server/owner-key-validation.ts, packages/cadre-provider/package.json, packages/cadre-host/src/server/routes/grants.ts, packages/cadre-host/src/donation/donation-service.ts, packages/cadre-provider/src/server/__tests__/create-container-owner-keys.test.ts, packages/cadre-host/src/server/__tests__/grants-route.test.ts
repro: verified
difficulty: medium
----

# Validate `bootstrapNodes` at the two hosted-create boundaries

## What was reproduced

Both create routes were driven with bad `bootstrapNodes` through their own test
harnesses (temporary test files, since removed). Every case below was answered
**201**, no validation anywhere in between:

| route | payload | answer |
| --- | --- | --- |
| `POST /api/v1/containers` (cadre-provider) | `bootstrapNodes: [42]` | 201 |
| `POST /api/v1/containers` | `bootstrapNodes: ['not-an-address']` | 201 |
| `POST /api/v1/containers` | `partyId: 42` | 201 |
| `POST /grants` (cadre-host) | `bootstrapNodes: [42]` | 201 |
| `POST /grants` | `bootstrapNodes: ['not-an-address']` | 201 |

## What happens downstream (also verified)

The value is forwarded verbatim into the spawned child — joined into
`CADRE_BOOTSTRAP_NODES` by `container-env.ts` on the provider, written into the
child's `cadre.json` by `host-process-orchestrator.ts` on the host — and reaches
`@libp2p/bootstrap` via `createLibp2pNode`. Three distinct outcomes, none of them
visible to the caller who made the request:

1. **Unparsable address → the child dies at boot.** `@libp2p/bootstrap`'s
   constructor does `options.list.map(str => multiaddr(str))` *before* any
   filtering, and `multiaddr()` throws on anything not starting with `/`.
   Confirmed directly: `multiaddr('not-an-address')` and `multiaddr('42')` both
   throw `InvalidMultiaddrError: String multiaddr must start with "/"`, and
   `multiaddr(42)` throws `Must be a string, Uint8Array, Component[], or another
   Multiaddr`. So libp2p construction throws and the node never starts.

2. **Address with no `/p2p/<peerId>` → the node starts and never joins.** This is
   the quiet one. `/ip4/127.0.0.1/tcp/4001` parses fine, then `@libp2p/bootstrap`
   filters it out (`invalid bootstrap multiaddr without peer id`, logged inside
   the child) and the node comes up with **zero** bootstrap peers: healthy-looking,
   permanently alone, never reaching the party it was created for. cadre-core's
   `getBootstrapPeerIds` (`cadre-node.ts` ~line 1878) likewise skips such an entry
   silently.

3. **Address with a malformed peer id → the child dies at boot.** `multiaddr()`
   does *not* validate the `/p2p/` value — `multiaddr('/ip4/1.2.3.4/tcp/1/p2p/12D3KooReq').getPeerId()`
   returns the junk string unchanged — but `@libp2p/bootstrap` then calls
   `peerIdFromString` on it, which throws `Incorrect length`. A truncated
   copy-paste of a 52-character base58 peer id is the most likely human typo in
   this field, and it is invisible until the child crashes.

`partyId` has the smaller version of the same gap on the provider: `if (!body.partyId)`
is a truthiness test, so `partyId: 42` is accepted and becomes the characters `42`
in `CADRE_PARTY_ID` (an object would become `[object Object]`). cadre-host's route
already does the `typeof` check.

## The rule to enforce

A `bootstrapNodes` entry is usable exactly when it is:

- a string,
- parsable as a multiaddr,
- carrying a `/p2p/<peerId>` component,
- whose peer id decodes (`peerIdFromString`).

Anything else is answered **400** naming the offending entry, with nothing
provisioned — matching how each route now answers a malformed owner key
(`INVALID_REQUEST` on the provider, `invalid_request` on the host). Every rejection
must name *which* entry was bad: with several addresses in one request the message
is the only thing that says so.

## The dependency decision (the ticket's open question, resolved)

cadre-provider deliberately declares **no** `workspace:` dependencies — the reason
`owner-key-validation.ts` restates cadre-core's Ed25519 rule locally over
`uint8arrays` rather than importing it. That comment's stated objection is to
pulling **libp2p + quereus + optimystic** into a thin Docker-host service, not to
npm packages as such.

**Add `@multiformats/multiaddr` and `@libp2p/peer-id` to cadre-provider as plain
npm dependencies** and use the same rule on both sides. Measured closure (from the
installed `package.json` files at the repo root): `@multiformats/multiaddr@12.5.1`
depends on `@chainsafe/is-ip`, `@chainsafe/netmask`, `@multiformats/dns`,
`abort-error`, `multiformats`, `uint8-varint`, `uint8arrays`;
`@libp2p/peer-id@6.0.4` depends on `@libp2p/crypto`, `@libp2p/interface`,
`multiformats`, `uint8arrays`, and `@libp2p/crypto@5.1.13` adds `@noble/curves`,
`@noble/hashes`, `protons-runtime`, `uint8arraylist`. All pure-JS leaf libraries —
**no libp2p networking stack, no quereus, no optimystic**, so the reason the
existing comment gives for the no-workspace-deps rule is untouched, and the note in
`vitest.config.ts` about needing no stale-build guard stays true (nothing added is
a workspace package).

Hand-rolling a multiaddr or peer-id parser is out of the question (AGENTS.md: no
half-baked parsers).

cadre-host already declares `@libp2p/peer-id`, `@libp2p/crypto` and
`@libp2p/interface`; it needs `@multiformats/multiaddr` added (it currently has no
direct declaration).

**If a reviewer rejects `@libp2p/peer-id` on the provider**, the fallback is to drop
requirement (4) — peer-id decodability — on *both* sides so the two rules stay
identical, and say so in the module comment. Do not let the two packages diverge in
what they accept.

## Shape of the fix — one validated request per route, not one more inline `if`

This is the second instance of the same class: a hosted create route forwarding a
caller-supplied string into a spawned child that must parse it, without parsing it
at the boundary. `pinnedOwnerKeys` was the first
(`bug-hosted-owner-key-pins-unchecked-at-api-boundary`); `bootstrapNodes` is this
one; `partyId`, `profile`, `strandFilter` and `resources` are the same shape and
sit in the same route bodies. Rather than add a third inline check, give each route
**one validator that returns the typed request object**, so a field that reaches
the spawn path has necessarily been through it:

```ts
// cadre-provider: src/server/create-request-validation.ts
export function validateCreateContainerRequest(
  body: unknown,
  customerId: string,
): { request: CreateContainerRequest } | { error: string };
```

```ts
// cadre-host: src/server/routes/provision-request-validation.ts
export function validateProvisionRequest(
  body: unknown,
  grantToken: string,
): { request: DonationProvisionRequest } | { error: string };
```

The route's job becomes: authenticate, call the validator, `400` with
`error` on failure, hand the returned object to the service. The existing
`validatePinnedOwnerKeys` moves *inside* the provider's validator (keep it in its
own module — its cross-package pointer comment is the thing that keeps the two
Ed25519 copies in step). Address validation is worth its own module on each side
for the same reason, with the same kind of comment pointing at the other copy.

Keeping the two copies in step is manual, as with the owner keys: neither package
can see the other's rule. What the tests give instead is a tripwire on each side —
pin both to the same accept/reject table so changing either one fails that
package's own suite, and the comment above the rule points at the other copy.

## Fixture fallout — expect existing tests to fail until updated

The new rule rejects addresses several current fixtures use. These are not
regressions; they are fixtures that were never dialable:

- **cadre-provider route tests use `'/ip4/127.0.0.1/tcp/4001'`** — no `/p2p/`, so
  case (2) above. In `auth-scope-enforcement.test.ts`, `container-token-redaction.test.ts`
  (3 sites), `create-container-owner-keys.test.ts`, `shutdown-after.test.ts` (6 sites).
- **cadre-host tests use `'/ip4/127.0.0.1/tcp/4001/p2p/12D3KooReq'`** — that peer id
  does not decode (case (3)). In `grants-route.test.ts`, `donation-service.test.ts`
  (several sites), `donation-supervisor.test.ts`.
- `bootstrapNodes: []` fixtures in the *service*-level tests are unaffected: the
  validator lives at the route boundary, and the empty-list rule (`length === 0` →
  400) is unchanged.

Use one real peer id in the shared fixtures, e.g.
`/ip4/127.0.0.1/tcp/4001/p2p/12D3KooWA9hbnKrRnPRSPTRkzXqTHzGE8YpJ3JHZmQ5tGwLRTMmp`
(verified to decode). `packages/integration-tests` already builds its addresses
with real peer ids (`withPeerId(...)` in `provider-seed-accepted.integration.ts`
and `cadre-host-node-donation.integration.ts`), so those scenarios need no change.

## Note worth leaving in the code

`container-env.ts` joins the list with `,` into `CADRE_BOOTSTRAP_NODES`, which
`cadre-cli`'s loader splits back on `,`. A multiaddr contains no comma, so the
address rule also closes that split — worth one line at the validator saying the
comma-join downstream is part of why entries must be multiaddrs.

## TODO

- Add `@multiformats/multiaddr` + `@libp2p/peer-id` to `packages/cadre-provider/package.json`
  dependencies; add `@multiformats/multiaddr` to `packages/cadre-host/package.json`.
- Write the address rule as its own module on each side (provider:
  `src/server/bootstrap-node-validation.ts`; host: alongside the grants route),
  each with the cross-package pointer comment modelled on `owner-key-validation.ts`,
  and each returning a message naming the offending entry.
- Add `validateCreateContainerRequest` (provider) and `validateProvisionRequest`
  (host), folding in the existing `partyId` / `bootstrapNodes` / owner-key / `profile`
  checks; make `partyId` a `typeof` + non-empty check on the provider to match the host.
- Rewrite both route handlers to call the validator and hand its result to the
  service — no per-field `if` left in the route body.
- Test both validators against one shared accept/reject table per package: non-string,
  empty/whitespace, `'not-an-address'`, valid-multiaddr-without-`/p2p/`,
  `/p2p/` with an undecodable id, and a good address. Assert the error message names
  the bad entry.
- Add a route-level test on each side: bad `bootstrapNodes` → 400 **and** nothing
  provisioned (provider: store has no container; host: `donations.list(token)` empty).
- Update the fixtures listed above to a real peer id.
- Run `yarn workspace @serfab/cadre-provider test`, `yarn workspace @serfab/cadre-host test`,
  both `typecheck`s, and `yarn lint`.
