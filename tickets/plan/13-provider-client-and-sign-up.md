description: An app can rent an always-on node from a hosting provider on the user's behalf: the user signs up and pays on the provider's own web page, the app receives a scoped access token, creates the node, signs the seed on the phone and connects to it.
prereq: provider-drone-reachable-by-phone, cadre-invitations-redeemable-by-any-member
files: packages/cadre-core/src/, packages/cadre-rn/src/, packages/cadre-provider/src/server/, packages/cadre-provider/README.md, packages/reference-app-rn/app/settings.tsx, docs/architecture.md
difficulty: hard
----

# Rent a provider node from an app

## Use case

A user without a basement server opens a store in an app, picks "Acme Cadre Nodes", subscribes, and the app adds the rented node to their cadre. The user still signs the node's authorization on the phone; the provider never holds an owner key.

## What exists

The provider API (`POST /containers` with `pinnedOwnerKeys`, `GET /containers/:id/peer`, `PUT /containers/:id/seed`, `DELETE`), JWT/API-key auth with scopes, `BillingHooks`, and a public `GET /billing/plans` (packages/cadre-provider/README.md).

## What to build

- **Sign-up protocol: OAuth 2 authorization code with PKCE.** The app opens the provider's authorize URL in the system browser. The provider runs its own account and checkout pages and redirects back to the app's link with a code. The app exchanges the code for a token scoped to `containers:*` for this customer. Add a provider-side reference implementation of the OAuth endpoints in cadre-provider (behind the existing `AuthHooks`), so a provider gets them by configuration.
- **Provider descriptor.** A small JSON document a provider publishes (name, API base URL, OAuth endpoints, plans URL, terms URL, regions, icon). The store screen renders descriptors; where descriptors come from is `decide-provider-directory`.
- **Client** in cadre-core (shared by cadre-rn and web): `rentNode(descriptor, token)` → create with the cadre's owner keys pinned → read peer → `addDrone` (the owner signs, through the app's normal approval prompt) → `PUT seed` → the phone dials the node.
- **Invitation at create time.** When the cadre already has a reachable member (a basement node, another rented node), `rentNode` instead passes an open cadre invitation (no target peer id, since the container's peer id is not known yet; single use, short expiry, never an owner grant) in `POST /containers`. The container pins the owner keys the invitation carries and redeems it at those members itself, so the phone skips reading the peer, `addDrone` and `PUT seed`, and can close once the create returns. `POST /containers` validates the invitation's shape at the boundary like `pinnedOwnerKeys`. When the phone is the cadre's only member, `rentNode` uses the peer → seed → dial path above. Choose automatically from the cadre's reachable members.
- **Subscription state.** The app shows the node's status and the subscription's renewal and lapse dates. When the provider terminates a node for non-payment, the app offers to remove it (`remove-a-device-or-app-from-a-cadre`).
- **Reference app**: a store screen with a single configured test provider is enough here.

## Claim model (gotchoices/sereus#40, question 2)

Since 1.14 a phone adds a cadre-cli or cadre-host node by claiming it: the node starts with a one-time claim secret, the phone scans a `sereus-join:` node code (peer id, addresses, secret) and calls `CadreNode.claimNode`, which delivers a seed carrying a proof of the secret. kjeib asks whether the provider should do the same: `POST /containers` starts the container waiting to be claimed and returns its node code, and the app claims it. That would replace `pinnedOwnerKeys` + `GET /peer` + `addDrone` + `PUT /seed`, so an app has one way to add a node, whoever runs it.

Recommended: adopt it, and settle it first when this ticket is planned. Reasons: one code path in apps and in cadre-core; the provider never handles owner keys or seeds at all; it composes with "Invitation at create time" above (claim when the phone is the only member, invitation when another member is reachable, exactly as cadre-host offers both). What to check: the claim secret then passes through the provider's API response, so it must be returned once, over TLS, to the authenticated customer only, and never logged; a container nobody claims (app killed) is the "seed never delivered" edge case below in a new form. `docs/architecture.md` → "Enrollment Flow: Phone Adds Provider Drone" and "Provider Flow" describe the seed path and change with it. If the planner finds a reason the seed path must stay (a provider that must know the owner before starting a container, for billing or abuse control), that is a product question for `blocked/`.

## Edge cases & interactions

- The token expires mid-flow: refresh, or re-run authorization.
- The invitation is used up or expires before the container redeems it (slow provisioning): the container reports it on `GET /containers/:id`, and the app issues a fresh one or falls back to the seed path.
- Node created but the seed never delivered (app killed): on next launch the app finds the unseeded container and finishes, or deletes it.
- The user cancels checkout: nothing was created.
- App store purchase rules: `decide-provider-directory` records the risk; the design keeps payment on the provider's web page.

## TODO

- Descriptor format and OAuth flow, documented in docs/architecture.md → Provider Integration.
- OAuth reference endpoints in cadre-provider.
- `rentNode` client; reference-app screen.
- Integration test against a local cadre-provider with a fake OAuth provider and a phone-shaped requester.
