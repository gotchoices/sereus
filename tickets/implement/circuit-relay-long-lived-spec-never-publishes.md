---
description: Fix the long-lived circuit-relay regression spec so the browser-shaped client actually obtains a relay reservation and publishes a `/p2p-circuit` multiaddr. Root-caused in the fix stage: listening on the bare `/p2p-circuit` address routes through `@libp2p/circuit-relay-v2` `RelayDiscovery`, whose registrar-topology + cuckoo-filter + pending-reservation handshake never completes a reservation in the db-p2p test runtime (verified: 0 multiaddrs after 15s/30s, even with an explicit `client.dial(relay)`). The deterministic fix is to listen on the *specific* relay circuit address (`<relayWs>/p2p-circuit`), which takes the `CircuitListen` "configured reservation" path and publishes the circuit addr in ~250ms — bypassing discovery entirely while still exercising the relay's HOP reservation + per-circuit data-limit surface the spec cares about. Also fix the stale docstring grep example.
prereq:
files: ../optimystic/packages/db-p2p/test/circuit-relay-long-lived.spec.ts, ../optimystic/node_modules/@libp2p/circuit-relay-v2/dist/src/transport/listener.js, ../optimystic/node_modules/@libp2p/circuit-relay-v2/dist/src/transport/discovery.js, ../optimystic/node_modules/@libp2p/circuit-relay-v2/dist/src/transport/reservation-store.js, ../optimystic/packages/db-p2p/node_modules/libp2p/dist/src/registrar.js, packages/reference-app-web/src/lib/optimystic.ts
---

## Root cause (from fix-stage investigation)

The spec's `spawnBrowserShaped` configures the client with `listenAddrs: ['/p2p-circuit']`
(circuit-relay-v2 **v4.1.3**). When libp2p calls `transport.listen('/p2p-circuit')`:

- `/p2p-circuit` matches `CircuitSearch` (not `CircuitListen`), so the listener calls
  `reservationStore.reserveRelay()` → pushes a pending reservation → fires
  `relay:not-enough-relays` → `RelayDiscovery.startDiscovery()`.
- `startDiscovery()` searches the peer store (0 relays — identify hasn't run yet), then
  attempts a random walk that immediately throws `NoPeerRoutersError: No peer routers
  available` (no DHT/peer routing is configured). That error is caught.
- The remaining path to a reservation is the registrar HOP topology: bootstrap autodials the
  relay, identify completes and records `/libp2p/circuit/relay/0.2.0/hop`, and
  `Registrar._onPeerIdentify` is supposed to drive the topology `onConnect` →
  `relay:discover` → `ReservationStore.addRelay(peerId, 'discovered')` → a reservation.

**This last chain never yields a reservation in the db-p2p test runtime.** Behavioural
evidence gathered with throwaway probe scripts (since deleted):

- Identify completes for the relay with `hop? true` and an **unlimited** connection
  (`connection.limits === undefined`), and the relay's HOP codec is recorded in the client
  peer store. ✓
- The registrar's `_onPeerIdentify` listener **does** auto-fire on the `peer:identify`
  event (confirmed by wrapping the registered listener) — yet no reservation is created and
  `client.getMultiaddrs()` stays empty for 15–30s.
- Manually invoking `registrar._onPeerIdentify(evt)` from a *second* freshly-registered HOP
  topology (no cuckoo filter) **does** make the reservation succeed and publishes the
  `/p2p-circuit/p2p/<client>` address within ~500ms.

The differentiator is the discovery topology's cuckoo `filter` (`peerFilter(...)`, see
`transport/index.js`). In `Registrar._onPeerIdentify` the topology is skipped when
`filter.has(peerId) === true`, and `filter.add(peerId)` runs *before* `onConnect`. The relay
peerId ends up marked in the discovery filter on an early identify pass that races ahead of a
usable reservation attempt (e.g. `addRelay('discovered')` throwing `HadEnoughRelaysError`
when `pendingReservations` is momentarily empty, or the reservation racing the connection
state) — and because the peerId is now in the filter, **no subsequent identify re-triggers
`onConnect`**, so the reservation is never re-attempted. Net: the discovery path is a
one-shot that, when it loses the startup race, never recovers, and the circuit address is
never published.

### The deterministic fix

Listen on the **specific** relay circuit address instead of the bare search address.
`<relayWs>/p2p-circuit` (i.e. `/ip4/127.0.0.1/tcp/<port>/ws/p2p/<RELAY>/p2p-circuit`) matches
`CircuitListen`, so the listener takes the explicit branch in
`transport/listener.js#listen`:

```
const relayAddr = addr.decapsulate('/p2p-circuit');
const relayConn = await connectionManager.openConnection(relayAddr, { signal });
const reservation = await reservationStore.addRelay(relayConn.remotePeer, 'configured');
this.addedRelay(reservation);   // publishes the /p2p-circuit/p2p/<client> addr immediately
```

No `RelayDiscovery`, no registrar topology, no cuckoo filter, no peer-routing dependency.
Verified: circuit address published in ~250ms, deterministically. The reservation still goes
through the relay's HOP `RESERVE` handshake, so the relay still stamps (or omits) the
per-circuit `Limit { data: 128 KiB, duration: 2 min }` according to `applyDefaultLimit` —
exactly the surface the spec exists to exercise. The only thing it stops exercising is
relay *auto-discovery*, which is out of scope for this data-limit regression.

### Scope note on production

`packages/reference-app-web/src/lib/optimystic.ts:175` configures the real browser node with
the same bare `listenAddrs: ['/p2p-circuit']` and no peer routing, so the same discovery race
could in principle affect production. It is **not** reproduced here and is explicitly out of
scope for this ticket (the fix ticket scoped production source out, and the web app is
bundled by vite with a single deduped dependency tree, unlike the db-p2p test runtime's
nested `node_modules/libp2p` alongside the hoisted `@libp2p/circuit-relay-v2`). Acceptance
criterion #4 below (run the web Tier 2 e2e and check the `dial:fail` rate) is the gate that
tells us whether production is affected; if that e2e *also* shows missing `/p2p-circuit`
addrs / a high `dial:fail` rate, file a **separate** fix ticket for the production discovery
path — do not expand this ticket's scope.

## TODO

- In `spawnBrowserShaped` (../optimystic/packages/db-p2p/test/circuit-relay-long-lived.spec.ts,
  ~line 73), change `listenAddrs: ['/p2p-circuit']` to listen on the specific relay address:
  `listenAddrs: [`${relayAddr.toString()}/p2p-circuit`]`. `relayAddr` is already the function's
  parameter (the relay's `/ws/p2p/<RELAY>` multiaddr from `pickRelayWsAddr`). This fixes both
  the primary case and the control case, since both call `spawnBrowserShaped(relayWs)`.
- Fix the docstring grep example (lines ~18-19): replace `--grep "circuit-relay-long-lived"`
  with `--grep "Circuit-relay long-lived"` (the real `describe` title) in both the PowerShell
  and bash example lines.
- Sanity-check `waitForCircuitListen`'s 15s timeout is now comfortable (the configured path
  publishes in well under 1s); leave it as-is unless the full run shows otherwise.
- Validate (stream output with `tee`, never silent redirect):
  - `RUN_LONG_TESTS=1 yarn test:verbose --grep "Circuit-relay long-lived"` from
    `../optimystic/packages/db-p2p` → expect `1 passing`. The primary case also drives 80×2KiB
    (160 KiB) through the relay with `applyDefaultLimit:false`; confirm it completes without a
    reset.
  - `RUN_LONG_TESTS=1 RUN_LONG_TESTS_CONTROL=1 ...` → expect `2 passing`, with the control case
    observing a reset under `applyDefaultLimit:true` (`failureSeen === true`).
- Re-run acceptance criterion #4: `yarn workspace @serfab/reference-app-web test:e2e` (Tier 2
  e2e), check the `dial:fail` rate. If still ≥ 1%, file a follow-up fix ticket using the richer
  `dial:fail` log fields (`code=…`, `msg=…`) — and flag whether the production browser node is
  hitting the same bare-`/p2p-circuit` discovery race described above (see Scope note).
- Do not leave any `_relay-probe*.ts` helper files behind (the fix-stage probes were already
  removed; mentioned only so the reviewer doesn't expect them).

## Acceptance

- [ ] `RUN_LONG_TESTS=1 yarn test:verbose --grep "Circuit-relay long-lived"` → `1 passing` reliably.
- [ ] `RUN_LONG_TESTS=1 RUN_LONG_TESTS_CONTROL=1 ...` → `2 passing`, control observes a reset under `applyDefaultLimit:true`.
- [ ] The docstring grep example uses the actual title `"Circuit-relay long-lived"`.
- [ ] Web Tier 2 e2e re-validated; `dial:fail` rate recorded, follow-up filed if ≥ 1%.
