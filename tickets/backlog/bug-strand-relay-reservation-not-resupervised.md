description: If the relay server a shared workspace depends on restarts, the workspace's connections never come back on their own — the main node recovers its relay slot automatically, but each workspace's network does not, so two phones sharing a workspace through a relay go silent until the workspace is restarted.
files: packages/cadre-core/src/strand-instance-manager.ts, packages/cadre-core/src/relay-reservation.ts, packages/cadre-core/src/cadre-node.ts, packages/integration-tests/src/scenarios/strand-circuit-same-party-e2e.integration.ts
repro: verified
severity: wrong-result
likelihood: unusual
tradeoffs: Relay restarts are rare in practice and a strand wake/resume (hibernation cycle, process restart) rebuilds the reservation anyway, so a maintainer may accept the outage window on interactive strands rather than grow a per-strand supervisor.
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
