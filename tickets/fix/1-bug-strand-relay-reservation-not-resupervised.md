description: When a phone's connection to its relay server drops for any reason — a relay restart, but also the phone switching networks — its shared workspaces never become reachable again on their own. The main node recovers its relay slot automatically, but each workspace's network does not, so two phones sharing a workspace through a relay go silent until the app restarts.
files: packages/cadre-core/src/strand-instance-manager.ts, packages/cadre-core/src/relay-reservation.ts, packages/cadre-core/src/cadre-node.ts, packages/integration-tests/src/scenarios/strand-circuit-same-party-e2e.integration.ts
repro: verified
severity: wrong-result
likelihood: normal-use (on phones — see "Promoted 2026-09-14" below)
tradeoffs: A strand wake/resume (hibernation cycle, process restart) rebuilds the reservation anyway, so a maintainer might accept the outage window rather than grow a per-strand supervisor — but the phone configuration runs with hibernation disabled, so on the headline phone-to-phone case nothing ever rebuilds it.
----

# A strand node's relay reservation is never re-driven after the relay restarts

## Measured (strand-circuit-same-party-e2e.integration.ts, restart phase)

Two relay-only `CadreNode`s of one party run a strand through a dedicated relay
(the `ops/docker/libp2p-infra` shape). The relay is restarted with the same
identity key on the same port — the address every node configured still names a
live relay. Within the test's gates:

- both CONTROL nodes re-reserve on their own (the `superviseRelayReservation`
  loop re-drives; recovery observed well inside the 60 s gate), and the relay's
  reservation count returns to 2;
- NEITHER strand node ever regains a `/p2p-circuit` address — pinned by an
  inverted 15 s gate in the scenario, and the reservation count stays at 2
  (control only) instead of returning to 4.

So after a relay restart, a strand whose members are all NAT'd is dead — no
member is dialable on the strand network — while the control mesh over the same
relay heals itself.

## Why (static, confirmed by the measurement)

Strand nodes take the CONFIGURED relay route: `strand-instance-manager.ts`
inherits per-relay `<relay>/p2p-circuit` listen entries and libp2p reserves from
inside `listen()` (`relay-addrs.ts`). In `@libp2p/circuit-relay-v2`
(v4, `transport/reservation-store.js` + `transport/listener.js`), losing the
relay connection runs `connection:close` → `#removeReservation` →
`relay:removed`, and the listener only CLEARS its listening addrs. Nothing ever
calls `addRelay` again for a configured reservation: the expiry-refresh timer
was cleared with the reservation, and `#checkReservationCount` re-triggers
discovery only for pending (search-route) reservations. Discovery is also
permanently out of reach for cadre nodes (namespaced identify — see
`relay-reservation.ts`'s module doc), so no path re-reserves.

The control node does not have this problem because `CadreNode.reserveRelays`
leaves a `superviseRelayReservation` loop running. Strand nodes have no
equivalent: nothing in `strand-instance-manager.ts` or `cadre-node.ts` watches a
strand node's circuit addrs. (`refreshDelegateGrants` re-announces the delegate
peerId to relays on a 15-minute cadence, but a grant is admission state on the
relay — it drives no reservation.)

## What recovery exists today

- A strand quiesce → resume (hibernation wake) or a process restart rebuilds the
  strand's libp2p node, whose configured circuit listener reserves again from
  inside `listen()`. Hibernating (non-realtime) strands therefore self-heal on
  their next wake; a REALTIME strand never hibernates and stays dead
  indefinitely.
- The sibling that lost its peer keeps redialing the stale circuit addr (address
  book refresh, `refreshStrandPeerAddrs`), but the relay holds no reservation
  for the target, so every hop CONNECT fails.

## Shape of a fix (for the planner — not prescribed)

The control node's supervisor is per-libp2p-node machinery
(`relay-reservation.ts` works over any node with a circuit-relay transport), so
the likely fix is running one supervisor per strand node — but strand nodes
reserve via the CONFIGURED listener, not the search listener, so the drive
(`addRelay(peerId, 'discovered')` consuming a pending reservation id) does not
apply as-is: `#removeReservation` only re-queues a pending id when the removed
reservation's `type` was `'discovered'`, and `addRelay(…, 'discovered')` throws
`HadEnoughRelaysError` when the pending list is empty — which for a
configured-only node it always is. Three candidate shapes, in rising cost:
drive the strand node's re-reservation with `addRelay(peerId, 'configured')`
instead (the same store call the configured listener itself makes, and it has
no pending-id precondition — so `driveRelayReservation` would need the type as
a parameter); or switch strand nodes to a search listener plus an explicit
drive; or add a configured-route re-listen. Whichever way, the
tripwire already exists: the scenario's inverted gate FAILS the day strand
reservations start recovering, so this ticket becoming obsolete is self-flagging.

## Promoted 2026-09-14 (garden) — why this is normal-use, not unusual

Pulled from backlog for the morning release. The original rating assumed the trigger was a relay *restart*. It is not that narrow:

- **Any close of the relay connection triggers it.** `@libp2p/circuit-relay-v2` 4.1.3, `dist/src/transport/reservation-store.js:53-59`: on `connection:close`, if a reservation was opened over that connection, `#removeReservation` runs. It does not matter why the connection closed. A phone switching Wi-Fi ↔ cellular, being backgrounded long enough for the socket to die, or the relay pruning an idle connection all take this path.
- **The headline phone shape uses exactly the broken route.** `blind-relay-phone-to-phone-e2e.integration.ts` (the proven product case) runs each phone as `listenAddrs: []` + `relayAddrs: [<relay>]`, so its strand nodes inherit the configured `<relay>/p2p-circuit` listener (`strand-instance-manager.ts:470-477`) that nothing re-drives.
- **Nothing self-heals on a phone.** `packages/reference-app-rn/src/cadre-phone.ts` sets `hibernation: { enabled: false }`, so the wake/resume rebuild described above never happens; only an app restart recovers.

The fix must flip the scenario's inverted gate to a positive one (strand reservations recover, relay count returns to 4 — 2 control + 2 strand) and add a unit-level test that a strand node re-reserves after its relay connection is closed **without** the relay restarting (close the connection from either side), since that is the phone case.

## Edge cases the fix must cover

- **Strand teardown while a re-reservation is in flight.** Strand nodes stop far more often than the control node (quiesce, remove, revocation teardown). A per-strand supervisor must be stopped on every one of those paths and must not re-drive against a stopped node. The existing drive cannot be cancelled mid-attempt (`tickets/backlog/bug-relay-drive-not-cancellable.md`); a per-strand supervisor multiplies how often that matters. If the fix adds an `AbortSignal` to `driveRelayReservation` as part of making it type-parameterised, that backlog ticket may be closed by the same change — say so in the handoff; if not, leave it.
- **Several relays configured.** Losing one relay must re-drive only that relay's reservation, not all of them.
- **Relay genuinely gone.** Back-off must match the control node's supervisor (no tight loop on a phone's battery), and a strand with no live relay must not block strand shutdown.
- **Relay admits the strand peer only after delegate announce.** A re-reservation after a relay *restart* needs the strand's delegate peerId re-announced to the fresh relay instance first, or the relay refuses it; check whether `refreshDelegateGrants`' 15-minute cadence makes recovery wait that long.
- **Explicit `network.transports` embedders** (the RN phone) must get the supervisor too — it must not hang off the transport-derivation path.

## Working note — concurrent optimystic runner

A tess runner is working `../optimystic` overnight, and sereus links it. If the stale-build guard (`test-harness/build-freshness.ts`) aborts a suite naming an `@optimystic/*` package, rebuild just that package as the message says and re-run; do not edit `../optimystic` source, and do not report it as a pre-existing failure.
