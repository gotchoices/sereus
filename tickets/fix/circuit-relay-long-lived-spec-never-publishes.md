---
description: The regression spec `packages/db-p2p/test/circuit-relay-long-lived.spec.ts` (added in ../optimystic commit 6d075ec under the wrong ticket title) does not work end-to-end. Under `RUN_LONG_TESTS=1`, the browser-shaped client never publishes a `/p2p-circuit` multiaddr, so the test fails immediately at `waitForCircuitListen` with `(have: )` — i.e. zero advertised addrs after 15 s (also reproduced with 30 s and an explicit `client.dial(relayWs)`). The spec therefore does not actually exercise the surface it claims to. As a result the second acceptance criterion of `optimystic-circuit-relay-reservation-lifetime` ("targeted regression test holds a relayed connection productive for the configured sweep without the relay resetting it") is unproven.
files: ../optimystic/packages/db-p2p/test/circuit-relay-long-lived.spec.ts, ../optimystic/packages/db-p2p/src/libp2p-node-base.ts, ../optimystic/packages/db-p2p/src/libp2p-node.ts, ../optimystic/node_modules/@libp2p/circuit-relay-v2/dist/src/transport/discovery.js
---

## Repro

```powershell
cd C:\projects\optimystic\packages\db-p2p
$env:RUN_LONG_TESTS = '1'
yarn test:verbose --grep "Circuit-relay long-lived"
```

Note: the docstring inside the spec advertises `--grep "circuit-relay-long-lived"` (lowercase with dashes), which matches **nothing** — the actual `describe` title is `Circuit-relay long-lived connections`. Fix the docstring as part of this ticket.

Observed output (truncated):
```
  Circuit-relay long-lived connections
    1) sustained ~2 KiB dials through a relay survive past the default 128 KiB cap
    - control: ...
  0 passing (30s)
  1 pending
  1 failing
  1) ... Error: Browser-shaped client never published a /p2p-circuit multiaddr (have: )
       at waitForCircuitListen (test\circuit-relay-long-lived.spec.ts:111:8)
```

`have: ` is empty — the client published **no** multiaddrs at all, including no observed addrs or candidate `/p2p-circuit/` entries. This was reproduced with the spec as committed (15 s timeout, reliance on bootstrap-driven discovery) and also with an inline patch that added `await client.dial(relayWs)` immediately after `spawnBrowserShaped` and bumped the timeout to 30 s. Same failure.

## What is supposed to happen

The browser-shaped client is configured with:
- `transports: [webSockets(), circuitRelayTransport()]`
- `listenAddrs: ['/p2p-circuit']`
- `bootstrapNodes: [relayAddr.toString()]`

The circuit-relay-v2 transport's listener only publishes `/.../p2p/<RELAY>/p2p-circuit/p2p/<CLIENT>` *after* a HOP reservation succeeds. The reservation is driven by `RelayDiscovery` (`@libp2p/circuit-relay-v2/dist/src/transport/discovery.js`), which:

1. Registers a topology listener for `RELAY_V2_HOP_CODEC` (`/libp2p/circuit/relay/0.2.0/hop`).
2. Listens for `peer:discovery` events from libp2p (fed by the `bootstrap` module here).
3. Dials discovered peers; once identify completes and the relay is recorded as supporting HOP, the topology `onConnect` fires.
4. The transport listener makes a reservation; on success it adds the circuit addr to the announce set.

Something in this chain is not completing within 30 s on localhost. The dial itself almost certainly succeeds (it's WS to `127.0.0.1`), so likely culprits:

- Identify protocol prefix mismatch. `libp2p-node-base.ts` line 226 sets `identify({ protocolPrefix: '/optimystic/${networkName}' })` for *both* nodes — both use `NETWORK = 'circuit-relay-long-lived-it'`, so the identify protocols line up. ✓ — not this.
- HOP protocol isn't being registered on the relay's libp2p (e.g. because the wrapped `circuitRelayServer(init)` factory returns a service that registers HOP but isn't being started, or is being started after `relay-discovery` has already given up on its first sweep).
- `RelayDiscovery.onPeer` runs only when `startDiscovery()` has been called. `startDiscovery()` is invoked by the transport listener when `transport.listen('/p2p-circuit')` is called. If libp2p never calls `listen()` on `/p2p-circuit` because no transport advertises support for the multiaddr filter (transports filter via the `multiaddrs` mechanism), the listener never starts and discovery never runs. This is the most likely root cause and should be tested first.
- `peer:discovery` events from `bootstrap` may fire before the transport listener has registered its `addEventListener('peer:discovery', this.onPeer)` handler, so the bootstrap-published relay is missed on the first sweep, and the fallback "search peer store" path finds nothing because identify hasn't run yet against the relay.

## Investigation hooks

- Add `process.env.DEBUG = 'libp2p:circuit-relay:*'` (or pass through mocha) before the spec runs to surface the discovery loop's log lines.
- Add an explicit `expect(client.getMultiaddrs()).to.have.length.greaterThan(0)` after `client.dial(relayWs)` to confirm at least the dial happened.
- After dial, inspect `client.peerStore.get(relayPeerId)` to confirm the HOP codec is recorded in `peer.protocols`.
- Try registering `await client.handle('/dummy/1.0.0', () => {})` *before* `listenAddrs: ['/p2p-circuit']` is requested to confirm `transport.listen` is being driven.

## Acceptance

- [ ] `RUN_LONG_TESTS=1 yarn test:verbose --grep "Circuit-relay long-lived"` produces `1 passing` (primary case) reliably.
- [ ] `RUN_LONG_TESTS=1 RUN_LONG_TESTS_CONTROL=1 ...` produces `2 passing`, with the control case observing a reset under `applyDefaultLimit: true`.
- [ ] The docstring grep example inside the spec uses the actual title (`"Circuit-relay long-lived"`), not the slug-style placeholder.
- [ ] Once the spec is green, re-validate that the production fix (`applyDefaultLimit: false` in `reference-peer/src/cli.ts`) actually buys what the cohort/circuit-relay-reservation-lifetime tickets claimed by running `yarn workspace @serfab/reference-app-web test:e2e` (Tier 2 e2e) and checking the `dial:fail` rate. If the rate is still ≥ 1 %, file a follow-up that uses the now-richer `dial:fail` log fields (`code=…`, `msg=…`) to root-cause the remaining failures.

## Out of scope

- The upstream commit-trail anomaly (changes for one ticket folded under another's commit title in `../optimystic`) — already tracked in `../optimystic/tickets/fix/circuit-relay-trusted-limits-followup.md`.
- Touching the production source path. The `relayServerInit` plumbing in `libp2p-node-base.ts` and `reference-peer/src/cli.ts` is fine and reviewed; only the spec is broken.
