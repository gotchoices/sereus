----
description: Let a self-hosted node's operator approve an unknown control-network invitation from the app's own screen the first time it appears, instead of having to paste the sender's key in ahead of time.
files: packages/cadre-host/src/auth/trust-circle.ts, packages/cadre-core/src/seed-trust-policy.ts, packages/cadre-core/src/cadre-node.ts
----

## Why deferred

The cold-start enrollment use cases (`wire-pinned-trust-into-coldstart-seed-callers`) are fully served by the **pinned** path:

- The cadre-host **inviter** side already embeds owner keys in every invite — `TrustCircleService.issueInvite` → `CadreNode.createInvite` → `SeedBootstrapService.createInvite` populates `invite.ownerKeys` from the issuer's node-local trusted-owner anchor. No host change is needed for an invitee to pin.
- The host's owner node is the seed **creator/inviter**, not a cold-start **receiver**, so it does not normally `applySeed` a foreign seed.

`tofuTrustPolicy` (`seed-trust-policy.ts:93`) already exists as an opt-in interactive policy (`confirm(ctx) => Promise<boolean>`). Wiring it to a real trust-circle confirmation prompt is a genuine but **non-blocking** enhancement: it lets a host operator accept an unknown signer once interactively rather than pre-pinning. It is not required for any current use case, so it is parked here rather than emitted as an implement ticket.

## Scope when promoted

- Expose a host-side `confirm` callback (trust-circle UI prompt: "An unknown authority key <fingerprint> wants to seed this node — accept?") and build a `tofuTrustPolicy(confirm)`.
- Install it as the node's service-default `seedTrustPolicy` (the seam added by `seed-trust-coldstart-cadrenode-seam`) for an interactive host authority node — most relevant if/when a host node is configured to *receive* seeds.
- Decide how the operator prompt should present the key (fingerprint format, party context). Where a confirmed key *lands* is already settled: `tofuTrustPolicy` reports `anchorAs: 'operator'`, so `applySeed` persists it into the node-local trusted-owner anchor and the prompt is not repeated for that key.
- Edge cases to design then: concurrent seed deliveries racing one prompt; prompt timeout → default-deny; declined confirmation surfacing as the `TOFU confirmation declined` reason; non-interactive/headless host falling back to the anchored default (never auto-accept).

## References

- `packages/cadre-core/src/seed-trust-policy.ts` — `tofuTrustPolicy`.
- `trust-circle.ts` — host trust-circle service (currently inviter-side only).
- `seed-trust-coldstart-cadrenode-seam` — the `CadreNodeConfig.seedTrustPolicy` service-default seam this would install into.
