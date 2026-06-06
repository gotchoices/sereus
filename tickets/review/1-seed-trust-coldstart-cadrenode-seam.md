description: Review the CadreNode node-wide `seedTrustPolicy` seam — an optional service-default trust anchor forwarded into all three SeedBootstrapService construction sites so the inbound libp2p seed-protocol path (and the temp-service applySeed path) can accept a network-delivered seed on a cold-start node.
prereq:
files: packages/cadre-core/src/types.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/seed-bootstrap.ts, packages/cadre-core/src/index.ts, packages/cadre-core/test/cadre-node-seed-trust.spec.ts, packages/cadre-core/test/seed-bootstrap.spec.ts, packages/integration-tests/src/scenarios/deliver-seed-cross-network.integration.ts

## What was implemented

A node-wide default trust policy seam on `CadreNode`, parallel to the existing
`requireSignedSchemas` knob (NOT nested inside `controlNetwork`, which stays
plain file-serializable connection data).

- **`types.ts`** — added `seedTrustPolicy?: SeedTrustPolicy` to `CadreNodeConfig`
  with the doc-comment specified by the ticket; imported the `SeedTrustPolicy`
  type from `./seed-trust-policy.js`.
- **`cadre-node.ts`** — forwarded `this.config.seedTrustPolicy` into **all three**
  `SeedBootstrapService` construction sites:
  - `initializeSeedBootstrap` (authority path)
  - `enableSeedListener` (receive-only listener path)
  - the temp-service branch of `applySeed` (added a comment noting `seed.partyId`
    only labels logs — trust rests solely on `signerKey` vs the anchor set).
- **`seed-bootstrap.ts`** — doc-comment only: added a pointer from
  `SeedBootstrapConfig.trustPolicy` back to the `CadreNode` seam. No behavior
  change; `config.trustPolicy ?? dbAnchoredTrustPolicy()` (line ~170) already
  preserves the secure default when `undefined` is passed.
- **`index.ts`** — no change needed; the `SeedTrustPolicy` *type* was already
  exported alongside the policy factories (verified).

### Precedence (verified by tests)

```
applySeed(seed, { trustPolicy })   ← per-call override (highest)
  └─ CadreNode.config.seedTrustPolicy  ← service default (this ticket)
       └─ dbAnchoredTrustPolicy()       ← secure fallback (unchanged; cold reject)
```

The protocol-handler path (`registerProtocolHandler` → `applySeed(seed)` with no
options) resolves to the service default — the only seam a wire-delivered seed
can use. The handler was deliberately NOT changed to take an override (no caller
to supply one).

## How to validate

- `yarn workspace @serfab/cadre-core build` — passed (full `tsc`, exit 0).
- `yarn workspace @serfab/cadre-core test --run` — **334 passed (27 files)**.
- `npx eslint <touched files>` — **0 errors**. 4 warnings remain, all
  pre-existing and outside the edited lines (`cadre-node.ts:88,228` `any`;
  `seed-bootstrap.ts:4,6` unused `PeerId`/`Multiaddr` imports). The new test file
  is lint-clean (no `any` — uses `unknown`/`never` casts).

### Test coverage added (`packages/cadre-core/test/cadre-node-seed-trust.spec.ts`)

All exercise the seam **through a real started `CadreNode`** except the last:

- Cold node, **no** `seedTrustPolicy`, `applySeed(coldSeed)` → `{ success:false }`
  with the db-anchored reason (regression guard for the secure default;
  temp-service path).
- Cold node, `seedTrustPolicy: pinnedKeyTrustPolicy([signerKey])`,
  `applySeed(coldSeed)` with no per-call override → `{ success:true }`
  (temp-service / configured-default path — the cold-start network case).
- Per-call override beats the forwarded configured default (configured default
  rejects; override accepts). Routed through `enableSeedListener` so both calls
  share one persistent service — see the temp-service note in **Known gaps**.
- Listener path: configured pinned default applies a cold seed via
  `getSeedBootstrapService().applySeed(seed)` (the same entry the protocol
  handler uses), while the same node with no policy rejects it.
- `enableSeedListener` idempotency: a second call early-returns and returns the
  **same** service instance — the first-construction policy is retained, not
  dropped/replaced.
- Authority path (`initializeSeedBootstrap`) forwards the policy, and a
  different-key pinned default never **narrows** DB-anchored trust (a DB-anchored
  signer still applies because `pinnedKeyTrustPolicy` unions DB ∪ pinned).
- Protocol-handler ack propagation: a configured-default rejection surfaces as
  `SeedAckMessage.reason` (matched `/pinned-key trust policy/i`), not swallowed.
  Driven through the registered handler via a mock libp2p (see **Known gaps**).

This means all three construction sites are covered: temp-service (tests 1–2),
listener (tests 3–5), authority/`initializeSeedBootstrap` (test 6).

## Known gaps / honest flags for the reviewer

- **Temp-service path registers a protocol handler it doesn't need (pre-existing
  wart, surfaced by this work).** `applySeed`'s temp-service branch calls
  `tempService.initialize(...)`, which registers the `/sereus/seed/1.0.0` handler
  on the shared control libp2p node. Calling `applySeed` twice on a service-less
  node therefore throws a `DuplicateProtocolHandlerError` — emitted as an
  *unhandled rejection* (the `void this.libp2pNode.handle(...)` is fire-and-forget,
  so the second `applySeed` still returns its result, but the handler leaks).
  This is **not introduced by this ticket** (the temp service pre-existed; this
  ticket only adds `trustPolicy` to its config), but it became visible while
  testing. I worked around it in the override test by routing both calls through
  `enableSeedListener` rather than the temp path. Worth a reviewer's judgment on
  whether a follow-up `fix/` ticket is warranted (e.g. the temp service shouldn't
  register an inbound handler at all, or `initialize` should be idempotent / guard
  the duplicate). Not fixed here to stay in scope.
- **Ack-propagation test uses a mock libp2p, not two real networked nodes.** It
  drives the captured handler with a mock stream/connection. The genuine
  cross-network path lives in
  `packages/integration-tests/src/scenarios/deliver-seed-cross-network.integration.ts`,
  which still constructs the receiver `SeedBootstrapService` **directly** with a
  `trustPolicy` (lines ~379–387), bypassing `CadreNode`. With this seam that test
  *could* now bring up a receiver `CadreNode` configured with `seedTrustPolicy`
  instead — a clean follow-up that would give true end-to-end coverage of the
  wire path through the node. Left untouched (this ticket is cadre-core only).
- **Downstream wiring is intentionally deferred.** Nothing yet *sets*
  `seedTrustPolicy` — the CLI and reference-app callers that construct a
  `pinnedKeyTrustPolicy` from a `CadreInvite` are separate tickets for which this
  is the prereq (see `wire-pinned-trust-into-coldstart-seed-callers`).
- **Test cost.** Six of the seven new tests start/stop a real `CadreNode`
  (libp2p bring-up) under 60s timeouts; the suite runs in ~7s locally but is
  heavier than the mocked unit tests around it. The self-registration timer is
  cleared after `start()` in each (matching existing patterns) to keep them
  deterministic.

## Suggested reviewer focus

- Confirm all three construction sites forward the policy and that none silently
  reverts to `dbAnchoredTrustPolicy()` (a missed site fails only in production —
  the cold-start node would reject a legitimately-pinned network seed).
- Sanity-check the `undefined`-preserves-secure-default contract end to end
  (unset config → cold node still rejects with the db-anchored reason).
- Decide whether the temp-service duplicate-handler wart deserves a `fix/` ticket.
