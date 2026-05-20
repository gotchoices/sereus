---
description: Enable browser peers to be dialable via circuit-relay reservations so the three Tier 2 data-convergence specs pass; turn relay-server on by default for service peers with an inbound address; verify the browser-side reservation flow
files: ../optimystic/packages/reference-peer/src/cli.ts, ../optimystic/packages/db-p2p/src/libp2p-node-base.ts, ../optimystic/packages/db-p2p/src/libp2p-node.ts, packages/reference-app-web/src/lib/optimystic.ts, packages/reference-app-web/e2e/fixtures/reference-peer.ts, packages/reference-app-web/e2e/distributed/two-tab-convergence.spec.ts, packages/reference-app-web/e2e/distributed/cross-tab-activity.spec.ts, packages/reference-app-web/e2e/distributed/disconnect-mid-session.spec.ts
---

## Why this exists

The Tier 2 data-convergence specs in `@serfab/reference-app-web` —
`two-tab-convergence`, `cross-tab-activity`, and `disconnect-mid-session`
— need real cluster consensus to ferry blocks between browser tabs via
shared service peers. The companion ticket
`tickets/review/web-e2e-tier2-data-convergence` landed a 3-node mesh
fixture (one `--offline` bootstrap + two headless `service` peers) but
the three data-convergence specs still fail.

This ticket supersedes the prior backlog draft
`web-e2e-tier2-data-convergence-thin-client`, which proposed a new
`role: 'cluster-member' | 'thin-client'` mode in db-p2p. That framing
conflated two orthogonal axes:

- **Reachability** — whether a peer can be dialed at all (direct
  inbound, circuit-relay reservation, or WebRTC). A peer with no
  reachability isn't a libp2p peer in any useful sense.
- **Role** — whether a reachable peer participates as a transactor
  (Ring Zulu) or a storage node (inner rings) in Arachnode. This is a
  capacity/intent axis, separate from reachability.

The actual failure mode is purely a **reachability** problem. Browsers
have no listen addresses and no active relay reservation, so when
`findCluster` picks a browser as a cluster member for some blockId,
the dial from the other browser stalls until `NetworkTransactor`'s 30s
timeout. There's no need to mark browsers as ineligible cluster
members; making them dialable is sufficient to land the specs.

The Arachnode role axis is deferred — most of Arachnode isn't
implemented yet, and `findCluster` does not currently consult
`ArachnodeInfo.ringDepth` (`libp2p-key-network.ts:316-484` filter only
on connection state and reputation bans). When role-aware selection
lands later, it can refine the cluster picks; it is not a prerequisite
for the specs.

## Current state (from spelunking optimystic)

- **Relay client transport is always on.** `circuitRelayTransport()` is
  hardcoded into `../optimystic/packages/db-p2p/src/libp2p-node.ts:30`
  (comment: "Always include the relay transport so this node can dial
  through relays"). Browsers can already *use* a relay for outbound
  dials.
- **Relay server is opt-in.** `relay?: boolean` on
  `libp2p-node-base.ts:73` conditionally enables `circuitRelayServer()`
  at `:223`; exposed via `--relay` in
  `../optimystic/packages/reference-peer/src/cli.ts:666,701,735`. Not
  enabled by default — and the e2e fixture's service peers do not pass
  it today.
- **Browser-side relay *reservation* is unverified.** Having
  `circuitRelayTransport()` in transports lets a node *dial through* a
  relay. To become dialable *via* a relay, the node must actively
  reserve a slot with a relay server (in libp2p-js this is typically
  `circuitRelayTransport({ discoverRelays: N })` or explicit
  `peerStore` reservation). Whether the current configuration does this
  is the open implementation question.
- **Cluster selection is purely topological.** `findCoordinator`
  (`libp2p-key-network.ts:348-352`) and `findCluster` (`:470-479`)
  filter on `connectedSet`, `excludedSet`, and `reputation.isBanned`
  only. No `ArachnodeInfo` consultation. Once browsers are dialable,
  no selection-layer change is needed.

## Required outcome

The three failing specs pass:

- `e2e/distributed/two-tab-convergence.spec.ts` — A sends → B sees,
  B edits → A sees, A deletes → B sees.
- `e2e/distributed/cross-tab-activity.spec.ts` — concurrent writes
  from A and B converge to the same set, both sides' activity is
  newest-first.
- `e2e/distributed/disconnect-mid-session.spec.ts` — A's first send
  reaches B, A disconnects → solo with local cache intact, B remains
  distributed and error-free.

## Design

Three changes, in roughly this order:

### 1. Default `--relay: true` for service peers with an inbound address

In `../optimystic/packages/reference-peer/src/cli.ts`, flip the
default so that any peer with a configured listen address (TCP, WS, or
both — anything other than `--offline` / browser) advertises a
circuit-relay-v2 server. Explicit `--no-relay` (or equivalent)
preserves the opt-out for benchmarks / minimal nodes. The bootstrap
node in the e2e mesh already has inbound (WS on 9191), and service
peers have TCP — both qualify.

Rationale (from the user): "all incoming Optimystic services should
double as relay nodes." This makes the relay set co-extensive with the
always-on, dialable peer set — no separate relay tier to provision.

### 2. Make browser peers actively reserve a relay slot

In `../optimystic/packages/db-p2p/src/libp2p-node.ts:30`, pass the
options needed to discover and reserve with relay servers — most
likely `circuitRelayTransport({ discoverRelays: 1 })` plus
`identify` / `identifyPush` (likely already present, verify) so the
reservation multiaddr propagates via libp2p's identify protocol. The
browser's announced peer record then includes
`/p2p/<relay>/p2p-circuit/p2p/<self>`, and the other browser can dial
that.

Verify on a real run: after a browser connects to a service peer with
`--relay`, the browser's peerStore for itself should contain a
`p2p-circuit` multiaddr; the other browser's peerStore for that peer
should also see it.

### 3. Tighten the `NetworkTransactor` dial timeout (deferrable)

Today an unreachable cluster member hangs the full 30s. Once (1) and
(2) land, no peer in the e2e fixture should be unreachable — but the
30s ceiling is still the wrong shape for a transaction layer. Drop it
to a short, surfaceable per-peer deadline so a flaky peer fails fast
and the consensus retries elsewhere. Treat this as a separate
implement/ ticket if it grows; otherwise fold it in.

## Out of scope / explicit follow-ups

- **Arachnode role-aware cluster selection.** Defer until more of
  Arachnode lands and `ringDepth` actually constrains cluster picks.
  Track separately from this ticket.
- **WebRTC transport.** A natural second leg (browser↔browser direct
  via service peers as signaling) and a good scaling story, but not
  required for these specs. Park in `backlog/` if it doesn't already
  have a ticket.
- **Production relay infrastructure.** Captured by
  `tickets/backlog/4-relay-bootstrap-infrastructure.md` (multi-region,
  rate limiting, dnsaddr). Distinct concern.
- **README's manual two-tab demo path.** Once the e2e specs work, the
  README's acceptance check should mirror the same mesh shape (≥ 1
  relay-enabled service peer in the bootstrap set).

## Acceptance criteria

- All 6 Tier 2 specs pass on a clean checkout (`yarn workspace
  @serfab/reference-app-web test:e2e --grep "Tier 2"` → 6 passed).
- Full sweep is 16/16 (`yarn workspace @serfab/reference-app-web
  test:e2e` → 16 passed, 10 Tier 1 + 6 Tier 2).
- `@optimystic/db-p2p` and `@optimystic/reference-peer` own test
  suites still pass — the relay-default change is additive.
- README's Tier 2 fixture section reflects the new mesh recipe
  (relay-enabled service peer required for browser↔browser
  convergence).

## Risks

- Touches `@optimystic` packages, not just sereus. Coordinate any
  in-flight optimystic work.
- The `--relay: true` default expands every service-peer's surface
  (open reservation slots). Acceptable for the reference peer; if a
  downstream consumer of `@optimystic/reference-peer` runs it in a
  hostile environment they can opt out, but make sure the opt-out
  exists and is documented.
- If browser reservation discovery isn't deterministic in the e2e
  timing budget, the fixture may need an explicit "ensure reservation"
  step before the test exercises convergence. Surface this in the
  implement ticket as a known-watch item.
