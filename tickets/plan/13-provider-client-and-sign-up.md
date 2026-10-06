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
