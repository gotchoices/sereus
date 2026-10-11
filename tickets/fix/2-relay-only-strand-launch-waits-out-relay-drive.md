description: A phone-like machine that is reachable only through relays takes about 18 seconds longer than it should to open a shared workspace in roughly half of launches, even with every relay up, because one relay reservation request is left waiting until its deadline.
architecture: docs/strands.md
files: packages/cadre-core/src/strand-instance-manager.ts (bare `/p2p-circuit` listen entries ~720 and ~852, startRelaySupervisors ~1177, awaitFirstRelayAttempts ~1214, the await ~1035), packages/cadre-core/src/relay-reservation.ts (requestOneReservation ~627, the `addRelay(peerId, 'discovered')` call ~637, "still pending at the deadline" ~646), packages/cadre-core/src/link-budget.ts (relayReservationBudgetMs), node_modules/@libp2p/circuit-relay-v2/dist/src/transport/reservation-store.js
repro: none
----
# A relay-only machine's addStrand waits out the relay-reservation drive

Reported as gotchoices/sereus#34 by risavian, with a one-file Node reproduction in the issue body (`gh issue view 34 -R gotchoices/sereus`). Confirmed by the reporter on a pristine `@serfab/cadre-core@1.14.0` install with `@optimystic/db-p2p` 1.12.1 and `@libp2p/circuit-relay-v2` 4.2.13.

## What happens

Rig: two storage-profile members with WebSocket listeners (member A founds an open strand and writes one row; member B redeems a cadre invitation and joins), and a transaction-profile "phone" with `listenAddrs: []` and `relayAddrs: [A control, B control]`. Each node is its own OS process on loopback. The phone redeems, then `addStrand({ founder: false, awaitFirstSync: false })` and `whenStrandWritable`.

`addStrand` takes either about 0.2 s or about 18.1 s (the whole relay-reservation drive at the default declared link, `relayReservationBudgetMs`), nothing in between; 17 of 35 launches were slow. The phone's timing channel shows the time in `buildStrandRuntime` awaiting the relay supervisors' first attempts (`relay first attempts: 17863ms`), and each slow launch ends with `Relay reservation request (<configured relay>) still pending at the deadline`.

In 16 of 16 classified launches: slow launches had a reservation on another member's **strand node** (never configured as a relay; it runs a relay server because it is a storage-profile strand node, and the phone's strand node is connected to it as a cohort seed). Fast launches had every reservation on a configured relay.

## Reporter's hypothesis (not confirmed)

The strand node gets one bare `/p2p-circuit` listen entry per configured relay; each registers a pending reservation slot that its supervisor is meant to fill through `reservationStore.addRelay(relay.peerId, 'discovered')`. libp2p's own relay discovery fills those same slots with any connected relay-capable peer, here a member's strand node. The configured relay's supervisor then has no slot left. In circuit-relay-v2 4.2.13, `addRelay` with no free slot rejects with `HadEnoughRelaysError`, which cadre would log as a failure, not as "still pending", so the call must be held earlier (an existing queue job for that peer, or `openConnection`). The reporter stopped there.

## What to find

- Reproduce with the issue's script, or port it into `packages/integration-tests` as child processes if a scenario fits better (the rig is three processes on loopback, about 20 s per slow launch). One reproduction only.
- Confirm where the configured relay's `addRelay` waits.
- Pick the fix. Candidates, in rough order of preference:
  - The strand node does not discover relays it was not given (turn off circuit-relay-v2's discovery-driven reservations for strand nodes, so only the supervisors fill the slots).
  - A first attempt counts as done once the strand node holds as many reservations as it has configured relays, whichever relays they landed on.
  - The supervisors do not block `active` at all, and reachability arrives when it arrives (weigh against why the await exists: the comment above it, and `complete/1-bug-strand-relay-reservation-not-resupervised`).
- Whether a reservation on a member's strand node is acceptable at all. A peer the operator never configured as a relay carrying this machine's inbound traffic may be fine (it is a strand member) or not; say which and why.

## Related, not this ticket

- The device runs behind the report took 60–299 s to become writable; this 18 s is only a lower bound inside that and the rig does not reproduce the rest.
- `backlog/debt-relay-reservation-decision-repeatable-cost` and `backlog/debt-strand-relay-redrive-on-party-run-relay-unscenarioed` touch the same supervisor code.
