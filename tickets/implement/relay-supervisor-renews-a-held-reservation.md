description: When a relay quietly forgets a node's forwarding slot but the connection to it stays open, the node keeps advertising an address that no longer works and never asks for the slot again, so nobody can reach it until the connection drops. Make the node re-ask for the slot on a timer while it believes it holds one.
architecture: docs/network/relay.md#the-supervisor
files: packages/cadre-core/src/relay-reservation.ts (`RelayReservationStoreLike`, `relayPeerIdOf`, `RelayReservationSupervisorOptions`, `RelayReservationLoop`), packages/cadre-core/src/index.ts (new constants on the public surface), packages/cadre-core/test/relay-reservation.spec.ts, docs/network/relay.md
difficulty: medium
repro: verified
----

# The supervisor renews a held reservation

## What is wrong

`superviseRelayReservation` decides a reservation is held by reading the node's own advertised `/p2p-circuit` addresses (`circuitMultiaddrsVia`). That is a local fact and says nothing about whether the relay still keeps the slot. A relay can forget a reservation while the connection to it stays open, and then the supervisor's every tick says "held", requests nothing, and the node stays undialable through that relay until the connection drops.

Reported as sereus#64, seen twice on 2026-11-05 against a public circuit-relay-v2 relay with reservations under 35 minutes old: a joiner of a stale control node sat on "Joining" while the relay answered `NO_RESERVATION` to each redemption dial, and readers of a stale strand node timed out with `StrandReadError`. `hangUp(relay)` recovers within seconds because the supervisor then re-drives.

## Reproduced

Confirmed on 2026-11-22 against a loopback relay, with the supervisor running at the spec's fast timings, by removing the client's reservation from the relay server's own store (`relay.services.relay.reservationStore.removeReservation(clientPeerId)`) and leaving the connection alone. The outcome, all asserted and all passing:

- the relay connection count is unchanged, and the client still advertises the same `/p2p-circuit` address;
- three seconds — twelve liveness ticks — change nothing: the relay still holds no reservation and nothing re-requests one;
- a third node dialing that circuit address, which succeeded a moment earlier, now fails.

The same run confirmed the repair and the shape it has to take:

- `store.addRelay(relayPeerId, 'discovered')` on its own leaves the relay still holding nothing — it returns the entry it already has without contacting the relay;
- setting `expire = 0n` on the object `store.getReservation(relayPeerId)` returns, then calling `addRelay(relayPeerId, 'discovered')`, makes the relay hold the reservation again, and the client's circuit address is never withdrawn.

## Why this is a local change

Optimystic 1.28.0 added exactly this renewal (`../optimystic/packages/db-p2p/src/network/relay-reservation.ts`, `forceReservationRenewal`, `DEFAULT_RELAY_RENEW_MS`, `RELAY_RENEW_JITTER`), and the linked sibling is 1.29.0 — but it is not reachable from here at all. `@optimystic/db-p2p` exports neither that module from its index nor a subpath that reaches it, and agents in this repo may not edit `../optimystic`, so no export can be requested from inside this ticket. Asking for one is also the wrong shape: Optimystic's supervisor covers only the relay-naming listen addresses it rewrites, its module doc says a host passing a bare `/p2p-circuit` is deliberately left alone because Sereus supervises that shape itself, and Optimystic's copy is itself adapted from this file. Two independent supervisors over two different listen shapes is the existing arrangement; the renewal belongs in each. Keep the local implementation, and if the duplication ever needs settling, the move is to lift the whole supervisor into one package rather than to export one ten-line function.

## What libp2p does, pinned at `@libp2p/circuit-relay-v2` 4.2.13

Read from `node_modules/@libp2p/circuit-relay-v2/dist/src/transport/reservation-store.js`, and confirmed by the reproduction above. `addRelay` on a peer the store already holds a reservation for, whose original connection is still open, and whose `expire` is more than `REFRESH_WINDOW` (10 min) away, returns that entry without touching the network. Anything else refreshes in place: it keeps the still-connected reservation advertised, sends a fresh RESERVE over the open connection, reuses the entry's pending-slot id (so a `discovered` renewal never meets `HadEnoughRelaysError`, whose free-slot check an existing entry skips), re-arms libp2p's own refresh timer, renews the keep-alive tag, and dispatches `relay:created-reservation`. If that RESERVE fails, the `catch` removes the entry, which withdraws the address — the truth at that point, and the signal `self:peer:update` already turns into a re-drive.

Zeroing `expire` is the only route into that refresh. It mutates a libp2p-owned object: `expire` is read only by the refresh-window check, a successful refresh replaces the entry with the relay's new expiry, and if `addRelay` throws before its job runs the zero simply stays, which only means the next request refreshes too. On the relay side (`dist/src/server/reservation-store.js`, `reserve`) a RESERVE from a peer that holds a reservation resets its lifetime and one from a peer it forgot creates a new one, so any RESERVE that reaches the relay repairs it.

## The shape to build

`store.getReservation(peerId)` is on the live store and returns the reservation object itself, not a copy. Add it to `RelayReservationStoreLike` as **optional**, alongside `relayFilter` and for the same reason: it is needed to RENEW a reservation, not to drive one, so a libp2p version that renames or drops it must degrade to today's behaviour rather than make `findCircuitRelayTransport` return `null` and break every drive. Leave `isReservationStore`'s duck-typing (`addRelay` + `hasReservation`) alone, and extend the existing `findCircuitRelayTransport (libp2p seam)` spec to assert `getReservation` is a function, so an upgrade that moves it fails loudly.

A renewal helper, fail-soft like everything else in the module: given the store and one relay peer id, zero the held reservation's `expire` and `addRelay(peerId, 'discovered')`; resolve `null` on success, otherwise the reason — including "the store holds no reservation on this relay", in which case nothing is requested. `addRelay` takes no signal, so a caller with a deadline races it; the module's `delay(ms, signal)` helper is the wait to race against, so the losing timer is cleared rather than left pending (see the `NOTE:` on `delay`).

The loop is over a LIST of relays, unlike Optimystic's one-relay supervisor, so a renewal pass walks the supervisor's `addrs`: normalize each to a relay peer id with `relayPeerIdOf` (currently module-private — export it or wrap it in a small internal helper), skip the entries that name none, and renew each. "The store holds no reservation on this relay" is a skip, not a failure: a control node supervising three relays holds one reservation, so two entries answer that way on every pass. A pass fails only when a relay the store did hold a reservation on refused.

Cadence, mirroring Optimystic:

- `DEFAULT_RELAY_RENEW_MS` = `5 * 60_000` and `RELAY_RENEW_JITTER` = `0.1`, each interval `renewMs * (1 ± 0.1)` so many nodes on one relay do not renew in step. The cost is one RESERVE stream per supervised relay per interval, far inside a relay's two-hour reservation lifetime.
- `renewMs` on `RelayReservationSupervisorOptions`, clamped away from 0 as the other cadences are. That is the whole of "tunable by a phone": `CadreNode.reserveRelays(addrs, opts)` already passes supervisor options straight through, and `StrandInstanceManager` can pass one per strand supervisor. **No `NetworkConfig` field** — `checkMs` and the backoffs are not surfaced there either, and nothing in `types.ts` needs to change.
- The renewal clock starts when a drive lands the reservation or a tick first finds one held, and restarts after every renewal whatever its outcome. A drive clears it before running, so whatever that drive lands is a fresh reservation with a fresh clock.
- `onReservationHeld` schedules `min(checkMs, renewAtMs - now)` instead of a bare `checkMs`.
- A tick that finds the reservation held and the renewal due runs one renewal under the loop's own `timeoutMs`, then re-checks. Still held → back to the healthy cadence. No longer held (the relay refused and libp2p withdrew the address) → drive at once, with no backoff: the refusal is already the evidence a backoff would have waited for.
- A renewal in flight sets the same `inFlight` flag a drive does, so drives and renewals stay serialized per supervisor. Export the two new constants from `index.ts` beside the existing `DEFAULT_RELAY_*` ones.

Two things that do NOT change, worth not re-deriving:

- **The state surface.** `resolveRelayReservationState` checks `reserved` before `dialing`, and a renewal only ever runs while circuit addresses are held, so a renewal in flight still reports `reserved`; `tick` nulls `nextTickAtMs` on entry, so it reports `reserved` with `retryAtMs: null`. Nothing in `RelayReservationState` needs a new case.
- **`firstAttempt`.** On the first tick the renewal clock is unset, so a first tick that finds a reservation already held settles `firstAttempt` through the healthy path exactly as it does now. A renewal must never delay that settling.

The `beforeRedrive` hook stays a DRIVE hook and does not run before a renewal. A strand node uses it to re-announce its delegate peer id to a party-run relay, and a relay restart — the event that drops those in-memory grants — also drops the connection, which is the drive path, not the renewal path. A party-run relay that forgot a reservation without restarting still holds the grant. If a renewal against such a relay is nevertheless refused, the refusal withdraws the address and the normal re-drive announces before dialing, so the case is self-healing; record that as a `NOTE:` at the renewal site rather than widening the hook.

## Documentation

`docs/network/relay.md` → "The supervisor" describes the tick as "a reservation is held → check again in 5 s and request nothing", which this change makes wrong. State there that "held" is read from the node's own advertised addresses, that a relay can forget a reservation while the connection stays open, and that the supervisor therefore re-sends the request every renewal interval while held, with the address kept advertised and a refusal falling through to the normal re-drive. The document is at 5,114 words of its 6,000-word budget (`yarn check:docs`), so keep it to a few sentences in that section — no new section.

## Tests

In `packages/cadre-core/test/relay-reservation.spec.ts`, against a live loopback relay with a short `renewMs`. A fake store cannot reproduce this: the defect lives in the interaction with libp2p's real reservation store and a real relay's record, which is also what the reproduction above had to use. Make the relay forget without touching the connection the way the reproduction did — `relay.services.relay.reservationStore.removeReservation(peerId)`, which is public on the server store.

- One test for the renewal: a held reservation whose relay forgot it is held by the relay again within one interval, and the node's circuit address is the same one throughout, never withdrawn.
- One test for a refused renewal falling through to a re-drive. A live relay has to be made to refuse: replacing `reserve` on the relay server's own reservation store is the only lever (`maxReservations` is fixed at construction), and that patches a dependency rather than a module this repository owns. Restore it and assert the address comes back on the following drive.
- Extend the existing seam test rather than adding one: `getReservation` is a function on the store `findCircuitRelayTransport` returns.

Nothing else: the clock arithmetic and the option plumbing are covered by the renewal test running at a short interval, and the state surface does not change.

## TODO

- Add optional `getReservation(peerId): { expire: bigint } | undefined` to `RelayReservationStoreLike`, documenting why it is optional while `addRelay`/`hasReservation` are not.
- Add the fail-soft renewal helper (zero `expire`, `addRelay(peerId, 'discovered')`), and export `relayPeerIdOf` or wrap it for the per-relay pass.
- Add `DEFAULT_RELAY_RENEW_MS`, `RELAY_RENEW_JITTER` and the `renewMs` option, clamped away from 0.
- Teach `RelayReservationLoop` the renewal clock: armed on held, restarted after every renewal, cleared before a drive, and folded into `onReservationHeld`'s next-tick choice.
- Renew on a due tick under the loop's `timeoutMs`, raced through `delay`; re-check afterwards and drive at once when the address is gone.
- Add the `NOTE:` at the renewal site on why `beforeRedrive` is not run before a renewal.
- Export the new constants from `packages/cadre-core/src/index.ts`.
- Add the two renewal tests and extend the seam assertion.
- Update `docs/network/relay.md` → "The supervisor"; keep it inside the word budget.
- `yarn workspace @serfab/cadre-core test`, `yarn workspace @serfab/cadre-core typecheck`, `yarn lint`.
