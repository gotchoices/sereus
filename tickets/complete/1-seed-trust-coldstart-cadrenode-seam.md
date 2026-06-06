description: Node-wide service-default seed trust policy seam on CadreNode — `CadreNodeConfig.seedTrustPolicy` is forwarded into every SeedBootstrapService the node constructs, so the inbound libp2p seed-protocol path (which has no per-call override) and the temp-service applySeed path can accept a network-delivered seed on a cold-start node. The per-call `applySeed(seed, { trustPolicy })` override still wins; unset config preserves the secure db-anchored default.
prereq:
files: packages/cadre-core/src/types.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/seed-bootstrap.ts, packages/cadre-core/src/seed-trust-policy.ts, packages/cadre-core/src/index.ts, packages/cadre-core/test/cadre-node-seed-trust.spec.ts

## Summary

Added `seedTrustPolicy?: SeedTrustPolicy` to `CadreNodeConfig` (parallel to
`requireSignedSchemas`, NOT nested in the file-serializable `controlNetwork`),
and forwarded `this.config.seedTrustPolicy` into the `SeedBootstrapService`
construction sites in `cadre-node.ts`. `SeedBootstrapService` already resolves
`config.trustPolicy ?? dbAnchoredTrustPolicy()`, so `undefined` preserves the
secure cold-reject default. Precedence holds:

```
applySeed(seed, { trustPolicy })       ← per-call override (highest)
  └─ CadreNode.config.seedTrustPolicy  ← service default (this seam)
       └─ dbAnchoredTrustPolicy()       ← secure fallback (cold reject)
```

The inbound `/sereus/seed/1.0.0` protocol handler resolves to the service default
(no per-call override exists for a wire seed) — the only seam a cold-start node
has to accept a legitimately-pinned network-delivered seed.

## Review findings

### Verified correct (implementation)

- **Seam wiring.** `CadreNodeConfig.seedTrustPolicy` (types.ts:245) imports the
  type from `./seed-trust-policy.js`; the type is exported from `index.ts:114`
  (implementer's "no change needed" claim confirmed).
- **Precedence.** `SeedBootstrapService` ctor does
  `config.trustPolicy ?? dbAnchoredTrustPolicy()` (seed-bootstrap.ts:171) and
  `applySeed` does `options?.trustPolicy ?? this.trustPolicy`
  (seed-bootstrap.ts:418) — override > configured default > db-anchored, exactly
  as documented. Verified by source, not just by the handoff.
- **Handler ack path.** `registerProtocolHandler` surfaces a rejected
  `applySeed` as `SeedAckMessage.reason` (seed-bootstrap.ts:698–701) — not
  swallowed.
- **Build / lint / tests** all green on the final tree (see below).

### Found and FIXED in this pass (minor)

- **A FOURTH `SeedBootstrapService` construction site was missed.** The handoff
  claimed "all three construction sites." `cadre-node.ts` actually builds the
  service in **four** places; the implement diff forwarded the policy into three
  (`initializeSeedBootstrap`, `enableSeedListener`, the `applySeed` temp service)
  but **not** the temp service in `dialInvite` (cadre-node.ts:1458). That temp
  service calls `tempService.initialize(...)`, which registers the inbound
  `/sereus/seed/1.0.0` handler — so that handler would apply network-delivered
  seeds against the **db-anchored default** instead of the configured policy,
  silently defeating the seam on any ordering where `dialInvite` is the first
  service-less call. This is precisely the "missed site fails only in production"
  failure the ticket warned about. **Fixed inline**: forwarded
  `this.config.seedTrustPolicy` into the `dialInvite` temp service with an
  explanatory comment. Build + lint + full suite re-run green.

### Found and FILED as a new ticket (major, pre-existing)

- **Temp services leak the shared inbound protocol handler** →
  `tickets/fix/temp-seed-service-leaks-protocol-handler.md`. Both temp-service
  paths (`applySeed`, `dialInvite`) call `tempService.initialize(...)`, which
  registers `/sereus/seed/1.0.0` on the **shared** control libp2p node and then
  discards the service. A second service-less call re-registers → libp2p throws
  `DuplicateProtocolHandlerError`, surfaced as an unhandled rejection (the
  `void libp2pNode.handle(...)` is fire-and-forget). Pre-existing (the temp
  services predate this seam — it only added `trustPolicy` to their config) and
  surfaced by this work; the implementer flagged it and asked for a reviewer
  decision. It is a genuine resource leak + unhandled rejection + trust-policy
  ownership ambiguity, broader than this seam (it touches the `initialize`
  contract), so it is out of scope for an inline fix → new `fix/` ticket. The
  inline `dialInvite` fix above makes the *policy* correct even while the handler
  still leaks; the fix ticket addresses the leak itself.

### Checked, no action needed

- **Other construction sites repo-wide.** Grepped `new SeedBootstrapService`
  across the repo: the only non-test production sites are the four in
  `cadre-node.ts` (all now forward the policy). The integration-tests and
  seed-bootstrap unit tests construct the service directly by design.
- **Docs.** `docs/architecture.md:304–308` already documents the
  `SeedTrustPolicy` priority order (DB-anchored / pinned-out-of-band / TOFU /
  secure cold-start default), including "pinned by operator config" — the exact
  capability this seam realizes. The documented behavior is unchanged by this
  wiring change, so no doc edit is required. (Operator-facing "how to set it"
  belongs with the CLI wiring in `seed-trust-coldstart-cli`, not here.)
- **Edge cases.** Tests cover: unset config → cold reject (secure default,
  temp-service path); configured pinned default → accept (cold-start network
  case); per-call override beats configured default; listener path applies/
  rejects; `enableSeedListener` idempotency retains first-construction policy;
  authority path forwards policy and a different-key pinned default does not
  *narrow* DB-anchored trust (pinned unions DB ∪ pinned); protocol-handler
  rejection surfaces in the ack. All seven pass.

### Known follow-ups (not defects)

- The ack-propagation test drives a **mock** libp2p, not two real nodes. True
  end-to-end coverage of the wire path through `CadreNode` would have
  `deliver-seed-cross-network.integration.ts` (which still builds the receiver
  `SeedBootstrapService` directly at ~379) bring up a receiver `CadreNode`
  configured with `seedTrustPolicy` instead. Left for the downstream wiring work
  (`seed-trust-coldstart-cli` / reference-app callers) where a real configured
  node exists to drive it.
- Nothing yet **sets** `seedTrustPolicy` — that is the downstream CLI /
  reference-app wiring (`seed-trust-coldstart-cli`,
  `wire-pinned-trust-into-coldstart-seed-callers`), for which this is the prereq.

## Validation (final tree, after the inline dialInvite fix)

- `yarn workspace @serfab/cadre-core build` — tsc exit 0.
- `npx eslint packages/cadre-core/src/cadre-node.ts packages/cadre-core/test/cadre-node-seed-trust.spec.ts`
  — 0 errors (2 pre-existing `any` warnings at cadre-node.ts:88,228, outside the
  edited lines).
- `yarn workspace @serfab/cadre-core test --run` — **334 passed (27 files)**.
