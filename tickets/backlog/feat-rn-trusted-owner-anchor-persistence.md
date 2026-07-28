----
description: A phone that joined a party via an invite forgets which authority keys it trusts whenever the app restarts, because its on-device trusted-key list is memory-only on mobile. Give phones a persistent version of that list, like desktop nodes already have.
files:
  - packages/cadre-core/src/trusted-owner-store.ts (the TrustedOwnerStore interface + in-memory store the phone currently falls back to)
  - packages/cadre-core/src/trusted-owner-store-file.ts (the Node-only file-backed reference implementation — not usable on React Native)
  - packages/reference-app-rn/src/use-cadre.ts (the applySeed enrollment seam that seeds invite pins via CadreNode.trustOwnerKeys)
  - packages/reference-app-rn/src/cadre-phone.ts (phone node construction — where an RN-backed store would be injected via CadreNodeConfig.trustedOwners.store)
----

# Persistent trusted-owner anchor for React Native

The node-local trusted-owner anchor (`TrustedOwnerStore`) records which owner
(authority) keys this device trusts, established out of band — from the invite
that enrolled it, or from founding the party. On Node hosts it is file-backed
(`FileTrustedOwnerStore`, persisted next to the identity key) and survives
restarts. On React Native there is no filesystem-backed implementation, so the
phone gets the in-memory fallback: every app restart empties the anchor.

Consequences on a phone, until fixed:

- Invite-pinned trust must be re-established by re-applying the invite after a
  restart.
- Once the authorized-membership predicate anchors on this store (the
  membership-gate ticket chain), a restarted phone authorizes no one until
  re-seeded — safe (fail-closed) but a real usability gap.
- Founder self-trust re-seeds automatically on each start (the owner-genesis
  path re-anchors the derived key), so solo-founder phones are unaffected.

## Expectation

An RN implementation of `TrustedOwnerStore` persisted in platform storage —
alongside (or inside) the same secure storage that already persists the phone's
identity key — injected via `CadreNodeConfig.trustedOwners.store` in the phone
node construction. Interface contract to preserve: `has`/`all` are synchronous
reads; `trust()` must reflect the key synchronously and may persist
asynchronously; absent/corrupt persisted state loads as an empty anchor (cold
start), never a crash; entries are scoped by partyId with no cross-party
leakage.
