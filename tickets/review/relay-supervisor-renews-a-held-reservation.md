description: A relay can quietly forget that a node reserved a forwarding slot while the connection to that node stays open, and the node never asked again, so nobody could reach it until the connection dropped. The node now re-asks for the slot every five minutes while it believes it holds one.
architecture: docs/network/relay.md#the-supervisor
files: packages/cadre-core/src/relay-reservation.ts, packages/cadre-core/src/index.ts, packages/cadre-core/test/relay-reservation.spec.ts, docs/network/relay.md
repro: verified
----

# Review: the supervisor renews a held reservation

## What changed and why

`superviseRelayReservation` decided a reservation was held by reading the node's own advertised `/p2p-circuit` addresses. That is a local fact: a relay can forget a reservation while the connection to it stays open, and then every tick said "held", nothing was requested, and the node stayed undialable through that relay until the connection dropped (gotchoices/sereus#64). The supervisor now re-sends the reservation request every `renewMs` (5 min, jittered ±10%) while the reservation reads as held — the renewal is the only thing that asks the relay itself.

The mechanism, all in `packages/cadre-core/src/relay-reservation.ts`:

- `RelayReservationStoreLike.getReservation?(peerId)` — new, **optional** member, alongside `relayFilter` and for the same reason: it is needed to renew a reservation, not to drive one, so a libp2p rename must degrade to no renewal rather than make `findCircuitRelayTransport` return `null` and break every drive. `isReservationStore`'s duck-typing (`addRelay` + `hasReservation`) is unchanged.
- `renewRelayReservation(store, relayPeerId)` — module-private, fail-soft: zero the held reservation's `expire`, then `addRelay(peerId, 'discovered')`. Resolves `null` on success, else the reason. Zeroing `expire` is the only route into libp2p's in-place refresh; a plain `addRelay` on a held reservation with an open connection and a far expiry returns the entry without touching the network. Its TSDoc carries that whole chain of libp2p facts (pinned at `@libp2p/circuit-relay-v2` 4.2.13) so the next reader does not re-derive it.
- `renewOneReservation(...)` — bounds one renewal by the loop's `timeoutMs` and by the loop's cancel signal, raced through the module's `delay(ms, signal)` helper so the losing timer is cleared rather than left pending.
- `DEFAULT_RELAY_RENEW_MS` (300 000), `RELAY_RENEW_JITTER` (0.1), a `jittered(ms, jitter)` helper, and `renewMs` on `RelayReservationSupervisorOptions` (clamped away from 0 like the other cadences). Both constants are exported from `packages/cadre-core/src/index.ts`.
- `RelayReservationLoop` learned the renewal clock: armed when a drive lands the reservation or a tick first finds one held, restarted after every renewal whatever the outcome, cleared before every drive. `onReservationHeld` now schedules `min(checkMs, renewAtMs - now)`. A due tick runs one renewal pass over the relays the store holds reservations on, then re-checks: still held → the healthy cadence; no longer held → drive at once with no backoff. A renewal sets the same `inFlight` flag a drive does, so drives and renewals stay serialized per supervisor. The drive tail moved into a `driveAndSettle()` method so both arms share it.

No `NetworkConfig` field, as specified — `CadreNode.reserveRelays(addrs, opts)` already spreads caller options into the supervisor, so `renewMs` is reachable from a phone without touching `types.ts`.

`docs/network/relay.md` → "The supervisor" now says that "held" is read from the node's own advertised addresses, that a relay can forget a reservation with the connection still open, and what a renewal and a refused renewal do. `yarn check:docs` passes (the file is gated at 6 000 words).

## Deviations from the implement ticket — please check these two

**1. `relayPeerIdOf` was not exported.** The ticket said to "export it or wrap it in a small internal helper", but `RelayReservationLoop` lives in the same module, so neither was needed. Instead `relayPeerIdOf` was split: a new module-private `relayPeerOf(addr): PeerId | null` does the parse (what the store's methods are keyed by) and `relayPeerIdOf` is now `relayPeerOf(addr)?.toString() ?? null`. Public surface unchanged apart from the two constants.

**2. The refused-renewal test does NOT patch the relay's `reserve`.** The ticket said replacing `reserve` on the relay server's reservation store was "the only lever" because `maxReservations` is fixed at construction. There is another: build the relay with `maxReservations: 1`, then move the client's own reservation record to a throwaway peer id. libp2p's server refuses when `reservations.size >= maxReservations` and the asking peer holds nothing, so the refusal comes from the relay's own code path with nothing patched. The helper is `occupyTheOnlySlot`, and it returns the undo. This also meant `startFixedRelayWithTtl` was folded back into `startFixedRelay(id, reservations?)` rather than a third near-duplicate node starter being added — the one `reservationTtl: 40_000` call site moved with it.

Both are judgement calls that a reviewer should sanity-check; neither changes the behaviour the ticket asked for.

## Tests

In `packages/cadre-core/test/relay-reservation.spec.ts`, new `describe('superviseRelayReservation — renewing a held reservation')`, both against a live loopback relay with `renewMs: 500`:

| Test | What it verifies |
| --- | --- |
| `re-requests a reservation the relay forgot, without withdrawing the address` | The repair: the relay forgets the reservation with the connection untouched, and within one renewal interval it holds one again. Also that the circuit address was never withdrawn — not by polling, but by watching the client store's `relay:removed`, the single event libp2p's circuit listener withdraws on. |
| `re-drives when the relay refuses the renewal` | The fall-through: a refused renewal makes libp2p remove the entry and withdraw the address, and the supervisor's `beforeRedrive` hook shows it re-drove. Freeing the slot again brings the address back on the following drive. |

Extended rather than added, as specified: `findCircuitRelayTransport (libp2p seam)` now also asserts `getReservation` is a function on the store, so an upgrade that moves it fails loudly instead of silently reverting to the never-renewing behaviour.

Nothing was added for the clock arithmetic, the option plumbing or the state surface — the first two are exercised by the renewal tests running at a short interval, and `RelayReservationState` gained no case.

**Both new tests were confirmed non-vacuous.** With `renewalDue()` forced to `false` they fail, each on the renewal's own `waitFor` (30 s timeout), not on an earlier assertion; the patch was reverted and the file re-verified.

## Validation run

| Command | Result |
| --- | --- |
| `yarn workspace @serfab/cadre-core test` | 200 files, 2 708 passed, 1 skipped (that skip is pre-existing) |
| `yarn workspace @serfab/cadre-core typecheck` | clean |
| `yarn lint` (includes `yarn check:docs`) | clean, 66 Markdown files OK |

No pre-existing failures surfaced, so no `tickets/.pre-existing-error.md` was written. Working tree holds only the four files above; no logs or artifacts left behind.

## What a reviewer should look hardest at

- **Mutating a libp2p-owned object.** `renewRelayReservation` writes `expire = 0n` on the object `getReservation` returns. The reasoning for why that is bounded is in its TSDoc (`expire` is read only by the refresh-window check; a successful refresh replaces the entry; a throw before the queued job runs leaves the zero, which only means the next request refreshes too). If that reasoning is wrong anywhere, this is where it bites.
- **The renewal does not clear the `relayFilter` first,** unlike a drive. The ticket did not ask for it and it looks like dead code here: to hold a reservation you must already have passed the filter, and a renewal that fails with `DialError`/`UnsupportedProtocolError` poisons the filter and then immediately removes the reservation, which resets the whole filter via `#checkReservationCount`. Optimystic's sibling implementation does clear it. Worth a second opinion on whether the reset is as unconditional as that reads.
- **Nothing is renewed for an addr that names no relay peer id.** The pass skips it, because the store is keyed by peer id and the connection is the only other place to read one. That addr is already the case `circuitMultiaddrsVia` falls back for, so "held" through it was approximate before this change too. There is a comment at the site; no ticket was filed.
- **`StrandInstanceManager` passes no `renewMs`,** so every strand supervisor renews on the 5-minute default. The ticket listed per-strand tuning as a capability, not a requirement, so nothing was wired. Say so if that reads as an omission.

## Tripwires parked in the code

- `renewOneReservation` carries a `NOTE:` on what happens at the deadline: libp2p's refresh keeps running with the address still advertised, so an abandoned renewal costs a check interval rather than a reservation. Reasoned from the store's code, not measured.
- `renewRelayReservation` carries the `NOTE:` the ticket asked for on why `beforeRedrive` is not run before a renewal, including why the party-run-relay case is self-healing without widening the hook.
