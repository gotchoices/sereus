description: A phone's shared workspaces lose their relay address and never get it back on their own — when the relay connection drops for any reason, and also, with no network change at all, about two hours after they first reserved. Workspace nodes need the same keep-it-alive loop the main node already has, so phones sharing a workspace through a relay stay reachable without an app restart.
files: packages/cadre-core/src/relay-reservation.ts, packages/cadre-core/src/strand-instance-manager.ts, packages/cadre-core/src/strand-network-config.ts, packages/cadre-core/src/relay-addrs.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/test/relay-reservation.spec.ts, packages/cadre-core/test/strand-network-config.spec.ts, packages/cadre-core/test/strand-instance-manager-network-addrs.spec.ts, packages/cadre-core/test/relay-addrs.spec.ts, packages/cadre-core/test/strand-listen-port-collision.spec.ts, packages/integration-tests/src/scenarios/strand-circuit-same-party-e2e.integration.ts, docs/architecture.md, docs/strands.md
difficulty: hard
repro: verified
----

# Strand nodes lose their relay slot and nothing re-acquires it

A node that cannot accept inbound connections (a phone, `listenAddrs: []`) is reachable only through a relay reservation: a slot on a relay server that lets peers dial it at `<relay>/p2p-circuit/p2p/<node>`. The CONTROL node keeps its slot alive with a supervisor loop (`superviseRelayReservation` in `relay-reservation.ts`). STRAND nodes (one libp2p node per shared workspace) have no supervisor and reserve through a different libp2p listener shape, and that shape loses its address in three situations, none of which recover.

## Measured

Throwaway specs in `packages/cadre-core/test/` (deleted; logs in `tickets/.logs/strand-relay-resupervise.scratch*.log` until pruned) ran a loopback relay (`circuitRelayServer`, `applyDefaultLimit: false`) and a client listening on the CONFIGURED shape `<relay>/p2p-circuit` — exactly what a strand node inherits today (`strand-network-config.ts` → `resolveListenAddrs(network)`, default `'configured'` route).

| trigger | client circuit addrs | client store `hasReservation` | connection to relay | recovers? |
| --- | --- | --- | --- | --- |
| relay restart, same key + port (`strand-circuit-same-party-e2e`) | 0 | — | — | no (inverted 15 s gate) |
| client `hangUp(relay)` | 0 after 8 s | false | 0 | no |
| relay `hangUp(client)` | 0 after 8 s | false | 0 | no |
| **reservation refresh**, relay `reservationTtl: 40_000` | 1 until t≈25 s, **0 from t=30 s** | **true** | **still 1** | no |

The refresh row is new and is the worst one: with the production relay (`ops/docker/libp2p-infra/src/main.ts` sets no TTL → libp2p default 2 h), every configured-route strand node goes undialable ~1 h 55 min after reserving, with no network event at all. A SEARCH-shaped listener (bare `/p2p-circuit`, reservation filled with `addRelay(peer, 'discovered')`) sampled across the same 40 s window kept its circuit addr throughout (the refresh firing on that side is inferred from identical timer math, not separately observed).

Candidate fixes tried against the configured shape:

- `reservationStore.addRelay(relay, 'configured')` after a loss: the store gets its reservation back (and the relay counts it) but **no circuit addr is published**. Ruled out.
- `transportManager.listen([<relay>/p2p-circuit])` after a loss: addr comes back, but every loss adds another listener (1 → 2 → 3 → 4 over three losses). Leaks.
- Calling `listen()` again on the EXISTING configured listener object: addr comes back, no leak, across three connection losses — but after a **refresh** loss it does nothing (the store still holds the reservation, so `listen()` skips the request) and the addr stays 0. Does not cover the refresh trigger. Ruled out.

## Why (libp2p `@libp2p/circuit-relay-v2` 4.1.3, `dist/src/transport/`)

- `reservation-store.js:53-63` — any `connection:close` on the reservation's connection runs `#removeReservation` → `relay:removed`; the listener (`listener.js:27-40`) clears its addrs.
- `reservation-store.js:136-157, 177-187` — the refresh timer calls `addRelay(peer, type)`, which REMOVES the existing reservation (dispatching `relay:removed`, clearing the listener's addrs) and creates a new one of the same type.
- `listener.js:41-50` — `relay:created-reservation` is ignored when `type === 'configured'`; only a `'discovered'` reservation whose pending id matches the listener's `reservationId` republishes addrs. A configured listener publishes only from inside its own `listen()` (`listener.js:57-72`), which skips when `hasReservation` is already true.
- `reservation-store.js:324-350` — removal re-queues a pending id only for `'discovered'` reservations, so the search shape's slot is re-fillable and the configured shape's is not.
- libp2p relay discovery cannot refill anything for cadre nodes: db-p2p namespaces identify, so the relay's hop protocol never reaches the peer store (`relay-reservation.ts` module doc).

## Fix

Put strand nodes on the same route the control node uses — search listener plus supervisor — keeping one reservation per configured relay.

**Listen entries.** `strandNodeAddrs` resolves relays to ONE bare `/p2p-circuit` entry PER configured relay (each bare listener registers its own pending reservation id; measured: two identical bare entries passed to `createLibp2p` produce two listeners, each filled by a different relay). The existing `dedupe` in `resolveListenAddrs` / `strandNodeAddrs` collapses identical strings, so the per-relay entries must bypass it; verify `@optimystic/db-p2p`'s `createLibp2pNode` does not dedupe them either (count circuit listeners on a built strand node). A hand-written `<relay>/p2p-circuit` entry in `network.listenAddrs` counts as a relay (strip `/p2p-circuit` for the dial addr) — `CadreNode.circuitRelayTargets` already unions both sources for the delegate announce. `StrandNodeAddrs` gains the relay dial addrs to supervise; destructure it in `buildStrandRuntime` so the new field is not spread into `createLibp2pNode` options. Transport derivation is unaffected: `listenTransportKind` classifies both `<relay>/p2p-circuit` and bare `/p2p-circuit` as `'circuit'`.

Once no caller builds listeners from the `'configured'` route, remove it (`RelayListenRoute`, the `'configured'` branch of `resolveListenAddrs`) so a cadre-built node cannot get an unsupervised configured circuit listener again. `warnIfAnnounceAddrsDiscardRelay` (`cadre-node.ts:1505`) uses the default route only to ask "does this config name a relay"; rewrite it to read `relayAddrs`/`listenAddrs` directly. `relayCircuitAddrs` stays (validation + `circuitRelayTargets`).

**Per-relay supervisor.** One `superviseRelayReservation(node, [relayAddr], opts)` per relay, with default timings (same backoff as the control node — 2 s doubling to 60 s, 5 s liveness check). Two changes in `relay-reservation.ts`:
- "Held" must be per relay: a circuit multiaddr containing `/p2p/<relayPeerId>/p2p-circuit` for one of the supervisor's addrs, not "any circuit addr". Otherwise relay X's supervisor sees relay Y's addr and never re-drives X. Apply it in both `RelayReservationLoop.reservationHeld` and `waitForCircuitReservation`. An addr with no `/p2p/` component falls back to any-circuit (keeps `CadreNode.reserveRelays` callers that pass such addrs working); the control node passes its whole list, so its behaviour is unchanged.
- Optional `beforeRedrive` hook on the supervisor options, awaited before every drive AFTER the first; a thrown/rejected hook is logged and the drive still runs.

**Wiring in `strand-instance-manager.ts`.** After `createLibp2pNode` in `buildStrandRuntime`, start one supervisor per relay and store them in a per-strand map (same pattern as `backfills` / `revocationEnforcers` / `membershipReconcilers`). Await all first attempts concurrently before the strand goes `active`, so the happy path still publishes its circuit addr before `addStrand` resolves (the scenario asserts it; strand-addr RPC answers read it). Fail-SOFT: a first attempt that lands nothing does not fail the launch — the strand's database comes up and the supervisor keeps trying, instead of today's throw → `StrandWatcher` full-rebuild retry. Stop the supervisors FIRST in `releaseRuntime` (before database close and `libp2pNode.stop()`), which covers quiesce, stop, failed-launch rollback and removal after revocation. Supervisors come from the network config, not from transport derivation, so explicit `network.transports` embedders (the React Native phone) get them too.

**Delegate re-announce.** A party control node running the relay server admits a member's strand node on an in-memory delegate grant, lost when that relay restarts; `refreshDelegateGrants` re-announces at most every 15 min per (relay, strand). `StartStrandConfig` gets a callback that `CadreNode` implements: announce this strand's delegate peerId to THAT relay, unthrottled (`collectStrandAddrs(controlNode, [relayStrandAddrPeer(target)], strandId, { delegatePeerId })`, then `recordDelegateAnnounces`). Wire it as the supervisor's `beforeRedrive`. Against a dedicated ops relay the RPC fails per-peer and folds to `[]` — one wasted protocol negotiation per re-drive attempt, bounded by the backoff. Resumed strands get fresh supervisors from the rebuild.

## Edge cases

- **Teardown mid-attempt.** `stop()` cannot abort an in-flight drive (`tickets/backlog/bug-relay-drive-not-cancellable.md`); the drive is fail-soft against a stopped node. This change does not add an `AbortSignal`, so leave that ticket open, and append one line to it: per-strand supervisors now exist, and each strand stop/quiesce during a relay outage can leave one drive running to its 10 s deadline.
- **Several relays.** Losing one re-drives only that relay (per-relay held check). Test it.
- **Relay gone.** Backoff caps at 60 s; `stop()` is synchronous and `releaseRuntime` never awaits a drive, so shutdown is not blocked.
- **libp2p relay discovery.** A search listener with a pending id makes libp2p start relay discovery; control nodes already run with this. Watch for extra dial churn on strand nodes in the scenario logs; if seen, record a `NOTE:` at the listen-entry site.

## Tests

Unit specs over plain libp2p nodes MUST block libp2p's own relay discovery, or discovery refills the slot and the spec proves nothing (the scratch search-route arms were confounded this way): give the client `identify({ protocolPrefix: '<something-not-ipfs>' })` so, like a cadre node, it never identifies the stock-identify relay. Before asserting recovery, assert the loss was observed (circuit addrs through that relay reach 0) — a gate that samples too early passes vacuously.

- Search-route client + per-relay supervisor recovers after client-side `hangUp(relay)`, and after relay-side `hangUp(client)` — no relay restart (the phone case).
- Refresh: relay `reservations.reservationTtl: 40_000` (client refresh fires at the 30 s floor); circuit addr still present at ~45 s. Pins the refresh trigger.
- Two relays, two supervisors: lose relay 1 → relay 1's addr returns, relay 2's addr is never withdrawn, relay 2's supervisor never drove.
- `beforeRedrive` is not called before the first attempt, is called before a re-drive, and a throwing hook does not stop the drive.
- Strand-manager level: supervisors are stopped by quiesce and by stop (no drive after `releaseRuntime`), and a launch whose relay is unreachable still reaches `active`.
- Update the specs pinning the configured route: `strand-instance-manager-network-addrs.spec.ts:143`, `strand-network-config.spec.ts` (circuit cases around lines 117-160), `relay-addrs.spec.ts` (configured-route cases), `strand-listen-port-collision.spec.ts`.
- `strand-circuit-same-party-e2e.integration.ts`: flip the inverted gate to a positive one — both strand nodes republish a circuit addr within `GATE`, and `relay.reservationCount()` returns to 4 (2 control + 2 strand; the restarted relay starts at 0, so 4 is unambiguous). Rewrite the file header (lines 34-44) and the NOTE at 311-317. Re-run `blind-relay-phone-to-phone-e2e.integration.ts` too (same strand relay shape).

## Docs

- `docs/architecture.md`: 903-907 (strands "still take the configured shape"), 916 ("configured-route reservations"), 942-948 (launch while relay down → now fail-soft with a supervisor), 950-958 (asymmetry paragraph → both recover; name all three triggers), 969 (table row for the `<relay>/p2p-circuit` entry).
- `docs/strands.md`: 81-82 (reservation-loss asymmetry pointer), 127-132 (grant window "until the next refresh pass… recovers on its own" → the re-drive re-announces first).
- Module docs/comments: `relay-reservation.ts:18-32`, `relay-addrs.ts:1-40`, `strand-network-config.ts:89-93`, `strand-instance-manager.ts:467-477, 562-571`.

## Working note — concurrent optimystic runner

A tess runner works `../optimystic`, which sereus links. If the stale-build guard (`test-harness/build-freshness.ts`) aborts a suite naming an `@optimystic/*` package, rebuild just that package as the message says (`yarn workspace @optimystic/db-p2p build` from `../optimystic` was needed during this fix stage) and re-run; do not edit `../optimystic` source and do not report it as a pre-existing failure.

## TODO

- `relay-reservation.ts`: per-relay held check (reservationHeld + waitForCircuitReservation, any-circuit fallback for addrs without a peer id); `beforeRedrive` option on the supervisor; update module doc.
- `strand-network-config.ts` / `relay-addrs.ts`: one bare `/p2p-circuit` per relay (bypass dedupe), hand-written circuit listen entries treated as relays, return relay dial addrs; remove the `'configured'` route once unused; rewrite `warnIfAnnounceAddrsDiscardRelay`'s check.
- Verify a built strand node has one circuit listener per relay (db-p2p does not dedupe).
- `strand-instance-manager.ts`: per-strand supervisor map; start after `createLibp2pNode`, await first attempts, fail-soft; stop first in `releaseRuntime`; add the re-announce callback to `StartStrandConfig`.
- `cadre-node.ts`: implement the unthrottled per-relay delegate re-announce callback and pass it at launch and resume.
- Unit specs listed above (namespaced identify on clients); update the configured-route specs.
- Flip the scenario's inverted gate; run `strand-circuit-same-party-e2e` and `blind-relay-phone-to-phone-e2e`.
- `yarn lint`, cadre-core build + test.
- Update the docs listed above; append the one-line instance note to `backlog/bug-relay-drive-not-cancellable.md`.
