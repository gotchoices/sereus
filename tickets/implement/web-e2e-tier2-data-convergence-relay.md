---
description: Make browser peers dialable via circuit-relay reservations so the three Tier 2 data-convergence specs pass; default the reference-peer relay server on for any peer with an inbound listen address; verify reservation flow end-to-end
files: ../optimystic/packages/reference-peer/src/cli.ts, ../optimystic/packages/db-p2p/src/libp2p-node.ts, ../optimystic/packages/db-p2p/src/libp2p-node-base.ts, packages/reference-app-web/src/lib/optimystic.ts, packages/reference-app-web/e2e/fixtures/reference-peer.ts, packages/reference-app-web/e2e/distributed/_helpers.ts, packages/reference-app-web/e2e/distributed/two-tab-convergence.spec.ts, packages/reference-app-web/e2e/distributed/cross-tab-activity.spec.ts, packages/reference-app-web/e2e/distributed/disconnect-mid-session.spec.ts, packages/reference-app-web/README.md
---

## Goal

Land the three failing Tier 2 specs in `@serfab/reference-app-web` by making
browser peers reachable as members of the cluster keyspace. The 3-node mesh
fixture (one `--offline` bootstrap on `ws/9191` + two service peers on
`ws/9192,9193`) already provisions the cluster; it's the browser tabs picked
by `findCluster` for some blockId that aren't dialable, which stalls
`NetworkTransactor` until its 30s timeout.

Specs that must pass on a clean checkout:

- `e2e/distributed/two-tab-convergence.spec.ts`
- `e2e/distributed/cross-tab-activity.spec.ts`
- `e2e/distributed/disconnect-mid-session.spec.ts`

Full sweep target: `yarn workspace @serfab/reference-app-web test:e2e` → 16/16.

## Design (the three changes)

### Change A — `relay` defaults on for service peers with inbound

File: `../optimystic/packages/reference-peer/src/cli.ts`

The `interactive`, `service`, and `run` commands currently expose `-r,
--relay` as a flag that defaults off (`options.relay || false` at
`cli.ts:312`). Flip the default to **on**, with `--no-relay` as the explicit
opt-out for benchmarks / minimal nodes. Use commander's automatic negation
by declaring the option with a default of `true`:

```ts
.option('-r, --relay', 'Enable circuit-relay-v2 server (default: on for peers with a listen address)')
.option('--no-relay', 'Disable circuit-relay-v2 server')
```

Resolve the effective value at session start:

- `--no-relay` explicitly given → off.
- `--offline` and no listen addresses (no `--ws-port`, `--no-tcp`) → off
  (nothing inbound to relay through anyway).
- Otherwise → on.

The `startNetwork` body should compute one `effectiveRelay` boolean and pass
that into `createLibp2pNode({ relay: effectiveRelay, ... })` instead of
threading the raw flag through. The e2e fixture's existing `--relay` flags
become no-ops but stay harmless; we can drop them in a follow-up sweep.

Rationale: "all incoming Optimystic services should double as relay nodes."
Makes the relay set co-extensive with the dialable peer set — no separate
relay tier to provision.

### Change B — Browser actually reserves a relay slot

Files:
- `../optimystic/packages/db-p2p/src/libp2p-node.ts` (transport list)
- `packages/reference-app-web/src/lib/optimystic.ts` (browser transports)

The libp2p-js `circuitRelayTransport()` in `@libp2p/circuit-relay-v2`
(installed version under `node_modules`) auto-discovers and reserves via
the `RelayDiscovery` component: it watches the registrar for peers that
speak the HOP codec and calls `ReservationStore.addRelay()` for each. No
`discoverRelays: N` option exists on the modern API (verified against
`@libp2p/circuit-relay-v2/dist/src/index.d.ts:CircuitRelayTransportInit`).

Open implementation question — **verify the reservation flow actually
fires in the browser**:

1. Wire `OPTIMYSTIC_E2E_DEBUG=1` and inspect the per-page console for
   `libp2p:circuit*` traces during `connectToBootstrap`. Look for
   `relay:created-reservation` events from `ReservationStore`.
2. After `connectToBootstrap` returns, the browser's `node.getMultiaddrs()`
   should include at least one `/p2p/<service-peer>/p2p-circuit/p2p/<self>`
   entry. Add a small `expect.poll` in `_helpers.ts:connectToBootstrap`
   that checks for a `p2p-circuit` advertised multiaddr before considering
   the bootstrap complete — this both verifies the wiring and gates the
   spec from racing the reservation handshake.

If the reservation doesn't fire on its own, possible reasons and
mitigations (try in order):

- The browser libp2p instance has no listen entry for `/p2p-circuit`.
  Add `'/p2p-circuit'` to `listenAddrs` in `optimystic.ts` (currently
  `[]`) so the address manager registers the listener; `RelayDiscovery`
  still drives the reservation, but the listener needs to be alive to
  publish the relayed address.
- The transport's discovery topology isn't seeing the service peer's
  HOP codec advertisement. Check that the service peers' `identify`
  output includes `RELAY_V2_HOP_CODEC`. The base node enables
  `circuitRelayServer()` under `options.relay` (see
  `libp2p-node-base.ts:223`), so once Change A lands the service peers
  will advertise it; verify via identify in the browser logs.

Document whichever path was needed in the ticket's "Findings" section
before promoting to review.

### Change C — Tighten NetworkTransactor dial timeout (deferred)

Out of scope for this ticket; tracked in
`tickets/backlog/network-transactor-dial-timeout.md`. The 30s budget is
big enough that the three specs should pass via the reservation fix
alone; if any spec still flakes from a transient unreachable peer
selection, surface that under "Findings" and let the follow-up ticket
tighten the timeout properly.

## TODO

**Phase 1 — optimystic relay defaults**

- In `../optimystic/packages/reference-peer/src/cli.ts`, change the three
  commands to declare `--no-relay` instead of `--relay`, defaulting to on.
- In `startNetwork(options)`, compute `effectiveRelay` from the options +
  listen state (see Change A) and pass into `createLibp2pNode`.
- Add a smoke unit/integration test in `@optimystic/reference-peer` if
  the package has one for CLI option parsing; otherwise document the
  behaviour change in the package README and rely on the e2e fixture.

**Phase 2 — browser reservation**

- Run the existing fixture once with `OPTIMYSTIC_E2E_DEBUG=1` to capture
  baseline traces (does any `relay:created-reservation` event fire?).
- If not, add `'/p2p-circuit'` to `listenAddrs` in
  `packages/reference-app-web/src/lib/optimystic.ts:151` and re-run.
- Extend `connectToBootstrap` in
  `packages/reference-app-web/e2e/distributed/_helpers.ts` to poll for
  a `p2p-circuit` multiaddr in the browser node's
  `getMultiaddrs()` before returning (expose a window hook from
  `src/lib/optimystic.ts` that yields the current multiaddrs, or read
  via existing diagnostics test-ids if present).

**Phase 3 — run the suite**

- `yarn workspace @serfab/reference-app-web test:e2e --grep "Tier 2" 2>&1 | tee /tmp/tier2.log`
  must finish 6/6.
- `yarn workspace @serfab/reference-app-web test:e2e 2>&1 | tee /tmp/full.log`
  must finish 16/16.
- Run `@optimystic/db-p2p` and `@optimystic/reference-peer` own test
  suites to confirm the relay-default change is additive
  (`yarn workspace @optimystic/db-p2p test`,
  `yarn workspace @optimystic/reference-peer test`).
- Pipe long-running test output through `tee` (never silent redirect)
  to satisfy the tess idle-timeout rule.

**Phase 4 — docs**

- Update `packages/reference-app-web/README.md` Tier 2 fixture section
  to note that browser↔browser convergence requires at least one
  relay-enabled service peer in the mesh (now the default).
- Drop the now-redundant `--relay` flag from the fixture's spawn args
  in `packages/reference-app-web/e2e/fixtures/reference-peer.ts` (or
  leave them — they're harmless and explicit; either is acceptable,
  pick one and note it in Findings).

## Acceptance

- `yarn workspace @serfab/reference-app-web test:e2e` → 16/16 (Tier 1
  10 + Tier 2 6).
- `@optimystic` test suites still green.
- The browser node advertises at least one `/p2p-circuit/p2p/<self>`
  multiaddr after `connectToBootstrap` completes (verified by the new
  poll in `_helpers.ts`).
- README's Tier 2 section reflects the relay-on-by-default mesh recipe.

## Risks / known-watch items

- Reservation discovery timing isn't deterministic. If the new
  `_helpers.ts` poll bites, raise the per-step timeout rather than
  weakening the assertion — the production cost of a slow reservation
  isn't visible in the spec window, but the test budget is.
- Changing a default in `@optimystic/reference-peer` is a behaviour
  change for any downstream consumer running the CLI in a hostile
  environment. The `--no-relay` opt-out covers the safety valve.
  Note in the optimystic-side commit.
- If `/p2p-circuit` in `listenAddrs` triggers the libp2p browser
  default connection gater (it generally doesn't — `denyDialMultiaddr`
  is the relevant hook, already lifted in `optimystic.ts:158`), surface
  the gating decision in Findings.

## Follow-ups (out of scope)

- Tighten `NetworkTransactor` per-peer dial timeout — see
  `tickets/backlog/network-transactor-dial-timeout.md`.
- Arachnode role-aware cluster selection (defer until more of
  Arachnode lands and `findCluster` actually consults `ringDepth`).
- WebRTC transport for direct browser↔browser legs.
- Production relay infrastructure — covered by
  `tickets/backlog/4-relay-bootstrap-infrastructure.md`.
