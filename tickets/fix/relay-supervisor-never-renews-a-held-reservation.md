description: cadre-core's relay reservation supervisor decides a reservation is held from the node's own advertised circuit addresses, so when a relay forgets the reservation while the connection stays open the node stays undialable through that relay until the connection drops. Re-send the reservation request on a timer while held, as Optimystic 1.28.0 does for the listeners it supervises (sereus#64).
architecture: docs/network/relay.md#the-supervisor
files: packages/cadre-core/src/relay-reservation.ts (`superviseRelayReservation`, `circuitMultiaddrsVia`), packages/cadre-core/src/types.ts (the supervisor's options, if the interval is made configurable), docs/network/relay.md
----

## Symptom

Reported as sereus#64 against cadre-core 1.23.0 and seen twice on 2026-11-05 against a public circuit-relay-v2 relay, with reservations under 35 minutes old. The relay dropped the node's reservation while the connection stayed open. The node kept its reservation record and its `/p2p-circuit` address, and the supervisor kept judging the reservation "held". The consequences:

- A joiner of a stale control node sat on "Joining" while the relay answered `NO_RESERVATION` to every redemption dial.
- Readers of a stale strand node timed out with `StrandReadError`.

`hangUp(relay)` recovers within seconds, because the supervisor then re-drives. The reporter has a local patch that re-sends RESERVE every 5 min, ±10 %, and it fixed the symptom.

## Why adopting Optimystic 1.28.0 does not fix it

Optimystic 1.28.0 added exactly this renewal (`packages/db-p2p/src/network/relay-reservation.ts`, `forceReservationRenewal`, `DEFAULT_RELAY_RENEW_MS` = 5 min, `RELAY_RENEW_JITTER` = 0.1). It applies only to the relay-naming listen addresses Optimystic rewrites and supervises. Its module doc says: "A host that passes a bare `/p2p-circuit` itself is left alone and not supervised: it owns that reservation (Sereus runs its own supervisor over exactly that shape)." Every cadre-built node listens on the bare shape (`RELAY_SEARCH_LISTEN_ADDR` in `relay-addrs.ts`), so in 1.24.0 nothing renews a held reservation.

## Expected

While a supervisor's reservation is held, it re-sends the reservation request to that relay every renewal interval, over the open connection, without withdrawing the address. A relay that forgot the reservation then holds it again within one interval, and if the relay refuses, libp2p withdraws the address and the supervisor's normal re-drive takes over.

## Direction

Mirror Optimystic's `forceReservationRenewal`. It is not exported from `@optimystic/db-p2p`. It marks the store's held reservation on the relay as expired (`expire = 0n`) and calls `store.addRelay(relayPeerId, 'discovered')`; a plain `addRelay` without the expiry does not reach the relay. Schedule it per supervisor, from the moment the reservation is held, at 5 min ± 10 % with an `unref`'d timer, and make it fail-soft like the rest of the supervisor. Expose the interval as an option so phones can tune it, defaulting to 5 min.

Check before choosing the copy: if asking Optimystic to export `forceReservationRenewal` (or the reservation-store accessors it uses) is cheap, prefer that over a second copy, per "Stay DRY". Agents here may not edit `../optimystic`; say so in the handoff and keep a local copy meanwhile.

Test the renewal with the supervisor's existing fakes: a held reservation whose relay "forgot" it is renewed within one interval, the address is never withdrawn during a successful renewal, and a refused renewal leads to a normal re-drive. Document the behaviour in `docs/network/relay.md` → "The supervisor".
