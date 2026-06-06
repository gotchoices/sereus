description: CadreNode's two temp-`SeedBootstrapService` paths (`applySeed` and `dialInvite`, used when no persistent seed service exists) call `tempService.initialize(...)`, which registers the inbound `/sereus/seed/1.0.0` protocol handler on the shared control libp2p node and then discards the service. This leaks a handler bound to a throwaway service, makes a second temp-service call throw `DuplicateProtocolHandlerError` (as an unhandled rejection, since `registerProtocolHandler` fire-and-forgets `void libp2pNode.handle(...)`), and lets a temp service silently own the node's inbound-seed trust decision.
prereq:
files: packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/seed-bootstrap.ts, packages/cadre-core/test/cadre-node-seed-trust.spec.ts

## Context

Surfaced while reviewing `seed-trust-coldstart-cadrenode-seam`. `CadreNode` builds a
**temporary** `SeedBootstrapService` in two places when no persistent service exists:

- `applySeed` (cadre-node.ts ~1327) — apply an out-of-band seed.
- `dialInvite` (cadre-node.ts ~1455) — dial an authority from an invite.

Both call `tempService.initialize(this.controlNode, this.controlDatabase)`. But
`SeedBootstrapService.initialize` (seed-bootstrap.ts:199) does two unrelated things:

1. stores `libp2pNode` + `controlDatabase` (needed: dial / peerStore / known-key lookup), and
2. `registerProtocolHandler()` (seed-bootstrap.ts:204) — registers the inbound
   `/sereus/seed/1.0.0` handler on the **shared** control libp2p node.

The temp service only needs (1). Registering (2) is wrong here:

- **Handler leak.** The temp service is discarded after the call, but its handler
  closure stays bound to the shared libp2p node — a throwaway service now owns the
  node's inbound seed protocol.
- **Duplicate-handler crash.** `registerProtocolHandler` does
  `void this.libp2pNode.handle(SEED_PROTOCOL, ...)` (seed-bootstrap.ts:646) —
  fire-and-forget. A second temp-service call (two `applySeed`s, or `applySeed`
  then `dialInvite`, on a service-less node) calls `handle()` for an
  already-registered protocol → libp2p throws `DuplicateProtocolHandlerError`,
  which becomes an **unhandled promise rejection** (the call still returns its
  result, but the process logs/relies-on-luck for the leak).
- **Trust-policy capture confusion.** Because the leaked handler applies inbound
  seeds with whatever policy the *temp* service held, the order in which temp vs.
  persistent services are created decides which trust policy the wire path uses.
  The `seed-trust-coldstart-cadrenode-seam` review forwarded
  `config.seedTrustPolicy` into both temp services to keep this *correct*, but the
  underlying design — temp services registering the shared handler at all — is the
  real defect.

The `seed-trust-coldstart-cadrenode-seam` implementer worked around the duplicate
crash in tests by routing the override test through `enableSeedListener` (one
persistent service) instead of two temp `applySeed` calls.

## Desired behavior

A temp `SeedBootstrapService` used only to apply/dial should NOT register the
inbound protocol handler. Only the persistent services created by
`initializeSeedBootstrap` / `enableSeedListener` (the ones the node keeps in
`this.seedBootstrapService`) should own the `/sereus/seed/1.0.0` handler.

Calling `applySeed` (or `dialInvite`) repeatedly on a service-less node must be
idempotent and must not emit an unhandled rejection or leak a handler.

## Constraints / things to get right

- The handler-registration crash is currently *masked*: `void libp2pNode.handle()`
  swallows the rejection from the caller's perspective. A fix must not turn a
  previously-"working" double-`applySeed` into a hard throw — make the repeat case
  genuinely safe, not loudly broken.
- Whatever the shape (e.g. an `initialize` variant / flag that skips handler
  registration, an idempotent guard in `registerProtocolHandler`, or making the
  temp services not call `initialize` at all but set the fields they need),
  preserve the existing secure-default and trust-policy precedence
  (`options.trustPolicy ?? config.trustPolicy ?? dbAnchoredTrustPolicy()`).
- Don't break `deliverSeed` / authority / listener paths that legitimately need
  the handler.

## Tests

- Two consecutive `applySeed` calls on a started, service-less cold node succeed
  (or both return a result) with **no** unhandled rejection and **no**
  `DuplicateProtocolHandlerError`. (Add to `cadre-node-seed-trust.spec.ts`; the
  current override test had to dodge this by using `enableSeedListener`.)
- After a temp-service `applySeed`/`dialInvite`, the shared libp2p node has no
  lingering `/sereus/seed/1.0.0` handler owned by a discarded service (assert via
  the node's registered-protocols, or that a subsequent `enableSeedListener`
  registers cleanly without throwing).
- Regression: the persistent listener/authority paths still register and apply
  seeds correctly.
