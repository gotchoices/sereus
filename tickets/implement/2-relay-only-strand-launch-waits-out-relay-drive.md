description: A machine reachable only through relays takes about 18 seconds longer than it should to open a shared workspace in roughly half of launches, because libp2p's automatic relay search hands its relay slots to other members' machines and silently drops the request for a configured relay. Turn that automatic search off wherever cadre itself fills the slots for the relays the operator configured.
architecture: docs/strands.md
files: packages/cadre-core/src/relay-reservation.ts (module header "One measured refinement" paragraph ~83-100, requestOneReservation ~627, findCircuitRelayTransport ~294), packages/cadre-core/src/strand-instance-manager.ts (`transports` spread ~858, startRelaySupervisors ~1307, await ~1024), packages/cadre-core/src/strand-network-config.ts (NOTE on discovery ~147-152), packages/cadre-core/src/cadre-node.ts (buildControlNodeOptions ~2040-2125), packages/cadre-core/src/relay-addrs.ts (resolveListenAddrs ~117, resolveTransportOptions ~227), packages/cadre-core/test/relay-reservation.spec.ts, ../optimystic/packages/db-p2p/src/libp2p-node.ts (db-p2p's default transport list, read-only), node_modules/@libp2p/circuit-relay-v2/dist/src/transport/{index,reservation-store,discovery}.js, node_modules/@libp2p/utils/dist/src/queue/index.js (Queue.clear)
repro: verified
----
# Supervised relay slots must not be filled by libp2p's relay discovery

Reported as gotchoices/sereus#34 (risavian; three-process Node rig in the issue body). A relay-only "phone" (transaction profile, `listenAddrs: []`, `relayAddrs: [member A control, member B control]`) has `addStrand` take either ~0.2 s or the whole relay-reservation drive (`relayReservationBudgetMs`, 18 s at the default declared link) — 17 of 35 launches slow. Each slow launch ends with `Relay reservation request (<configured relay>) still pending at the deadline`, and in every slow launch the strand node held a reservation on another member's **strand node**, which was never configured as a relay.

## Root cause (confirmed)

A cadre strand node gets one bare `/p2p-circuit` listen entry per configured relay. Each entry registers one pending reservation slot in circuit-relay-v2's `ReservationStore`, and the per-relay supervisor fills its slot with `reservationStore.addRelay(relay, 'discovered')` (`requestOneReservation`).

libp2p's own `RelayDiscovery` fills the same slots. It registers a topology on the relay-hop protocol, and every connected peer whose identify lists that protocol is passed to `addRelay(peer, 'discovered')`. A storage-profile member's strand node runs the circuit-relay server, and it is in the same identify namespace as the phone's strand node (`/optimystic/strand-<id>/…`), so as soon as the phone's strand node connects to it as a cohort seed, discovery queues a reservation on it. The configured relays are control nodes in a different identify namespace, so discovery never nominates those (see the `relay-reservation.ts` module header).

The reservation store runs its requests one at a time (`reservationConcurrency` 1). When a request takes the last free slot, `#checkReservationCount` calls `this.reserveQueue.clear()`, and `@libp2p/utils` `Queue.clear()` (7.4.1) only splices the jobs out of the array: **a queued job is dropped without its promise ever settling**. So:

1. discovery's job for member A's strand node takes slot 1;
2. the supervisors for configured relays A and B call `addRelay`; A's job runs, B's waits in the queue;
3. A's job takes slot 2, the last one, and `clear()` drops B's queued job;
4. B's `addRelay` promise never settles, `requestOneReservation` waits for the drive's deadline, and `awaitFirstRelayAttempts` holds `addStrand` for the whole drive.

This was reproduced in-process (`relay-reservation.spec.ts`-style, three loopback relays): a client with two bare `/p2p-circuit` entries, connected first to an unconfigured relay C, then supervised against A and B. Six of six runs waited out a 3 s drive, ending with "B … did not complete before the deadline" and the reservations on A and C. Wrapping `reserveQueue.clear` showed it drop `queued:<B>`.

Even when B's request does not get dropped, it loses: it arrives after the slots are gone and fails with `HadEnoughRelaysError`, which `describeReservationFailure` reports as "this node is not listening on the bare /p2p-circuit address". B's supervisor then retries on its backoff for as long as the discovered reservation holds the slot, and reports B as failed.

## Decision: no relay discovery on a node whose search slots cadre supervises

The reporter's first candidate. The other two were weighed and rejected:

- **Count the first attempt as done once the node holds as many reservations as configured relays, wherever they landed.** That removes the 18 s but leaves the configured relay starved: its supervisor keeps failing and retrying, and the status (`circuitMultiaddrsVia`, which only counts reservations through configured relays) reports that relay as failed while the node is reachable through a peer nothing supervises.
- **Stop awaiting the first attempts before `active`.** The await exists so the circuit address is published before `addStrand` resolves (the strand-addr RPC answers read it; the same-party circuit scenario asserts it). Removing the await hides the 18 s from `addStrand` and leaves the slot theft and the dropped request as they are.

**Is a reservation on a member's strand node acceptable?** Not as something that happens by default. It is not a security problem, since the peer is a strand member. It is a problem because the reservation is unpredictable and nothing manages it:

- Only the configured relays have supervisors and appear in the status. A reservation discovery made is re-driven by nobody but discovery, and it hides the configured relay's slot from that relay's supervisor.
- A member's strand node listens on an ephemeral port and stops whenever that member hibernates or drops the strand, so a circuit address through it goes stale far more often than one through the operator's always-on relay.
- `relayAddrs` is where the operator says which machines carry this machine's inbound traffic, and the party-run relay admission (delegate announce, `announceDelegateToRelay`) is set up for exactly those machines.

**What turning discovery off loses.** The module header's "One measured refinement" paragraph notes that discovery currently refills a freed slot within ~25 ms when a relay hangs up while it stays up. Without discovery, that refill comes from the supervisor's liveness check (5 s while held). That is acceptable; update the paragraph.

## How to turn it off

circuit-relay-v2 4.2.13 has no init option to disable discovery (`discoveryFilter` only filters the topology; `startDiscovery`'s peer-store scan still nominates every stored hop-capable peer after each slot loss). The class declares the field optional (`private readonly discovery?`), and every use of it is guarded (`this.discovery?.startDiscovery()`; `start`/`stop` skip a non-startable value), so a transport whose `discovery` is `undefined` **before `start()`** registers no topology and never starts discovery.

Recommended mechanism: a cadre helper that wraps transport factories. Each wrapped factory builds the transport, and when the result is the circuit-relay transport (duck-typed the way `findCircuitRelayTransport` already is: a `reservationStore` that passes `isReservationStore`, plus an own `discovery` property), sets `discovery` to `undefined` and returns it. libp2p calls the factories in its constructor and db-p2p builds with `start: false`, so this runs before anything starts. If a transport has a reservation store but no `discovery` property, the libp2p shape has changed. Log that loudly once instead of failing the node; the spec below will catch it.

Doing this after the node is built (finding the live transport and calling `discovery.stop()`) was rejected because it races. db-p2p's `createLibp2pNode` starts the node before returning, and in that window a cohort-seed connection can already have queued a discovered reservation.

**Where the transport list comes from.** If the embedder supplied `network.transports` (React Native and the browser do), wrap that list. Otherwise db-p2p builds its default list internally (`../optimystic/packages/db-p2p/src/libp2p-node.ts`: `tcp()` unless `disableTcp`, `webSockets()` when `wsPort` is set, and always `circuitRelayTransport()`), which cadre cannot wrap. In that case cadre has to pass an explicit list: the same three, with `webSockets()` included exactly when `resolveTransportOptions` would set its `wsPort` switch. Passing `transports` makes db-p2p ignore `wsPort`. That is equivalent here because the listen addresses are always explicit. cadre-core gains runtime imports of `@libp2p/tcp`, `@libp2p/websockets` and `@libp2p/circuit-relay-v2`, all already dependencies in its `package.json`. db-p2p's `libp2p-node.ts`, which cadre-core already imports, imports `tcp` statically, so browser bundles get nothing new. Check that against the reference web app's build. Keep the default list in one function shared by the control and strand builds, so it cannot drift from itself; record with a `NOTE:` that it mirrors db-p2p's defaults.

**Which nodes.** Apply the wrapper exactly when cadre generated the node's bare search entries for configured relays:

- **Strand nodes**: `strandNodeAddrs` returned a non-empty `relayAddrs` (`relayDialAddrs.length > 0` in `buildStrandRuntime`). This is the reported case.
- **Control node**: `network.relayAddrs` names a relay, so `resolveListenAddrs` added the search entry. `repro: static`. The control identify namespace is per party (`/optimystic/control-<partyId>/…`), so a phone's control node identifies every storage-profile member's control node, and those run relay servers. A phone whose `relayAddrs` lists only some members can lose its single slot to an unlisted member. The control node has one slot, so its supervisor fails, either at the deadline or with `HadEnoughRelaysError`, and with `requireRelay` not set to false that makes `start()` throw `RelayReservationFailedError`. Same helper, one more call site. To confirm, run the spec below with one slot and one configured relay.
- **Unchanged**: a node whose bare `/p2p-circuit` entry was hand-written with no `relayAddrs`. Discovery is the only thing filling that slot, unless the embedder later calls `CadreNode.reserveRelays()`. That browser-tab case is exposed to the same theft. Leave it as it is, and record a `NOTE:` at `reserveRelays` saying that a tab holding unconfigured relay-capable connections can lose its slot the same way.

## The test (one reproduction)

In `packages/cadre-core/test/relay-reservation.spec.ts`, using its existing `startRelay` helper and loopback relays. Build the client with two bare `/p2p-circuit` listen entries and its transports passed through the new helper (`[tcp(), circuitRelayTransport()]`). Start three relays: A, B and C. Dial C, then wait until either the client holds a circuit address through C or about 1 s has passed. Without the helper, discovery reserves on C within milliseconds of identify, and that is the state the confirming run started the supervisors from. With the helper, the wait simply times out. Then start one `superviseRelayReservation` each over A and B with a short `timeoutMs`, for example 3 s. Assert three things: both first attempts settle well inside the deadline, neither supervisor has `lastError`, and the client's circuit addresses go through A and B and not C. Without the helper this fails every time. It took 3 s on 6 of 6 runs while the theft was being confirmed, because C's discovered job has already taken a slot before the supervisors queue. One `it`, no loop.

Nothing else needs a new test. The wrapping and call-site wiring are glue, and the issue's three-process rig is not worth porting once this spec reproduces the bug in-process.

## Residual, record as tripwires (not tickets)

- `NOTE:` at `requestOneReservation`. libp2p's `Queue.clear()` drops queued reservation jobs unsettled whenever the last slot fills. With discovery off, slots never outnumber the supervised relays, so a first request cannot be dropped. A **refresh** of an existing reservation that happens to be queued at the moment another relay's first reservation takes the last slot is still dropped, and that reservation then lapses at the relay without being refreshed. If that is ever observed, or if anything other than the supervisors gains a way to fill these slots, also end the wait on the store's `relay:found-enough-relays` event when this relay holds no reservation. The upstream fix is for `#checkReservationCount` to abort queued jobs instead of clearing them; that belongs to js-libp2p, outside this repo.
- Update the NOTE in `strand-network-config.ts` (~147-152), which describes discovery starting on every slot loss: with this change that no longer happens on these nodes.

## Out of scope

- The 60–299 s device-side joins in the report; this 18 s is only a lower bound inside them.
- `backlog/debt-relay-reservation-decision-repeatable-cost` and `backlog/debt-strand-relay-redrive-on-party-run-relay-unscenarioed` touch the same supervisor and are unaffected.

## TODO

- Add the transport-wrapping helper next to `findCircuitRelayTransport` in `relay-reservation.ts`, sharing its duck-typing.
- Add one shared function for cadre's default transport list (tcp, WebSocket when a listen entry needs it, circuit relay), with a `NOTE:` that it mirrors db-p2p's defaults.
- Strand build (`buildStrandRuntime`): when `relayDialAddrs` is non-empty, pass `transports` built from the embedder's list or the default list through the wrapper.
- Control build (`buildControlNodeOptions`): the same, when `network.relayAddrs` names a relay.
- Add the spec described above and see it fail without the wrapper and pass with it.
- Update the `relay-reservation.ts` module header (the "One measured refinement" paragraph and the "WHY … RATHER THAN LEFT TO DISCOVERY" section) so it says discovery is switched off on supervised nodes, and why. Update the `strand-network-config.ts` NOTE and the `startRelaySupervisors`/listen-entry comments in `strand-instance-manager.ts` (~875). Search `docs/` for relay discovery wording, add one sentence to the section that owns relay reservations, and name issue #34 only as the reason.
- Add the `NOTE:` tripwires at `requestOneReservation` and `reserveRelays`.
- Run `yarn workspace @serfab/cadre-core test` (relay specs at least) plus `yarn lint`, and check that the reference web app still builds with the new transport imports.
