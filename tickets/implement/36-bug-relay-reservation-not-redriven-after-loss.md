description: When a relay restarts or its connection blips, a browser tab that was reachable through it goes permanently unreachable and never recovers on its own — only reloading the page brings it back. Make the node keep retrying in the background instead.
prereq:
files: packages/cadre-core/src/relay-reservation.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/test/relay-reservation.spec.ts, packages/reference-app-web/src/Home.svelte, packages/reference-app-web/README.md
difficulty: medium
repro: verified
----

## The defect, as measured

A node that cannot accept incoming connections (a browser tab, a machine behind
NAT) becomes dialable by holding a *reservation* on a relay. `CadreNode.reserveRelays()`
obtains that reservation once, at startup, and nothing ever obtains another one.

Reproduced against a real loopback relay started from a FIXED private key on a
FIXED port, so it can be stopped and restarted at the same address and peer id:

| step                                        | observed                                            |
| ------------------------------------------- | --------------------------------------------------- |
| drive reservation against live relay        | `error: null`, one `/p2p-circuit` addr held          |
| stop relay                                  | circuit addrs drain to `[]`                          |
| restart relay, same peer id + port, wait 12s | still `[]` — **never recovers on its own**           |
| call `driveRelayReservation` again by hand   | `error: null`, circuit addr back                     |

So the reservation is entirely recoverable; the only thing missing is something
to ask for it again. libp2p's own relay discovery cannot be that something — it
nominates a peer only after the *identify* handshake writes the relay-hop
protocol into the peer store, and cadre nodes speak a per-party identify protocol
(`/optimystic/control-<partyId>/id/1.0.0`) that the deployed relay
(`ops/docker/libp2p-infra`, stock identify) never answers. The module header of
`relay-reservation.ts` already documents that mismatch at length.

## What blocks a naive retry loop, measured precisely

`ReservationStore` in `@libp2p/circuit-relay-v2` keeps a per-process blocklist
(`relayFilter`, a cuckoo filter) of peers whose reservation request failed. The
original ticket assumed any retry would trip it. It is narrower than that, and it
is also fixable:

- **Relay simply down.** Our own `node.dial()` in `dialRelays` fails first, so
  `addRelay` is never reached and the filter stays clean. A second drive after
  the relay returns succeeds. Verified: filter `has` → `false`, second drive →
  `error: null`. *A retry loop is safe on this path with no special handling.*
- **Dial succeeds, reservation request then fails** with `UnsupportedProtocolError`
  or `DialError` (peer at that address is up but is not a relay; or the relay dies
  between our dial and the hop request). Filter is poisoned and never self-clears
  on this path — `#removeReservation` early-returns when no reservation existed,
  so `#checkReservationCount` (the only thing that resets the filter) never runs.
  Verified: after the peer came back **as a genuine relay**, the next drive still
  reported `relay reservation on … failed: The relay was previously invalid`, and
  the filter still read `has` → `true`.
- **Un-poisoning works.** `relayFilter` is an ordinary (non-`#private`) field, and
  `@libp2p/utils`' `Filter` interface declares an optional `remove(item)`.
  `store.relayFilter.remove(peerId.toMultihash().bytes)` returned `true`, `has`
  dropped to `false`, and the immediately following drive reserved successfully.

So: the retry loop must clear each target relay from `relayFilter` before every
attempt. The peer id is available without dialing — it is in the relay multiaddr
(`multiaddr(addr).getPeerId()`), so this can happen up front.

## Shape of the fix

Add a **supervisor** to `relay-reservation.ts` — a self-rescheduling loop that
owns the retry cadence — and have `CadreNode` hold one instead of the current
`driving` counter and `lastError` string. Nothing about `driveRelayReservation`
itself changes; it stays the single-shot, never-throws primitive.

```ts
export interface RelayReservationSupervisorOptions extends RelayReserveOptions {
  /** Gap between liveness checks while a reservation is held. Default 5_000. */
  checkMs?: number;
  /** Backoff before the first re-drive after a failure. Default 2_000. */
  minBackoffMs?: number;
  /** Backoff ceiling. Default 60_000. */
  maxBackoffMs?: number;
}

export interface RelayReservationSupervisor {
  /** Resolves when the FIRST drive settles, so callers keep today's await semantics. */
  readonly firstAttempt: Promise<void>;
  /** True while a drive is in flight. */
  readonly driving: boolean;
  /** Epoch ms of the next scheduled drive; null while one is running. */
  readonly retryAtMs: number | null;
  /** Reason the last drive produced no reservation; null once one lands. */
  readonly lastError: string | null;
  /** Idempotent. Clears the timer; a drive already in flight has its result ignored. */
  stop(): void;
}

export function superviseRelayReservation(
  node: Libp2p,
  addrs: readonly string[],
  opts?: RelayReservationSupervisorOptions
): RelayReservationSupervisor;
```

Loop, per tick:

1. If a reservation is held (`circuitMultiaddrs(node).length > 0`) — reset the
   backoff to `minBackoffMs`, clear `lastError`, sleep `checkMs`, tick again. No
   drive; a healthy node must not re-request every few seconds.
2. Otherwise — clear each addr's peer id from the store's `relayFilter`, run one
   `driveRelayReservation`, record the error, then sleep the current backoff and
   double it (capped at `maxBackoffMs`).

Timers must be `unref()`'d where that method exists (Node keeps the process alive
otherwise, and the CLI/test suites would hang); optional-chain it, since browsers
and React Native have no `unref`.

### Status gains a "trying again" value

`RelayReservationStatus` gains `retrying`, and `RelayReservationState` gains
`retryAtMs: number | null`, so a UI can say "reconnecting, next try in 8s" rather
than showing a bare `error` for a node that is in fact recovering. New precedence
in `resolveRelayReservationState`:

| condition                       | status     |
| ------------------------------- | ---------- |
| no addrs supplied               | `none`     |
| live circuit addrs held         | `reserved` |
| a drive is in flight            | `dialing`  |
| a retry is scheduled            | `retrying` |
| otherwise                       | `error`    |

`error` therefore now means *nobody is going to try again* — no supervisor
running, or no control node. That is the distinction the ticket asks for.

`resolveRelayReservationState` takes a fifth positional parameter,
`retryAtMs: number | null`. The eight existing precedence specs call it
positionally and several use `toEqual` on the whole state object, so they need
the extra argument and the extra field.

### CadreNode wiring

Replace `relayReserveError` / `relayReserveDriving` with a single
`relayReserveSupervisor: RelayReservationSupervisor | null`. `relayReserveError`
stays only for the pre-start `'control node unavailable'` case, where there is no
node to supervise.

- `reserveRelays(addrs, opts)` — stop any existing supervisor first (a second call
  with a different list must not leave two loops running), record the list, then:
  empty list → clear and return `none`; no control node → record
  `'control node unavailable'` and return; otherwise start a supervisor and
  `await supervisor.firstAttempt` before returning `getRelayReservationState()`.
  Callers keep exactly today's semantics: the promise resolves once the first
  attempt has settled, and retries continue in the background afterwards.
- `stop()` (`cadre-node.ts:774`, which already clears the posture at lines 784-785)
  must also stop the supervisor. A live timer past `stop()` would re-dial a
  torn-down node and hold the process open.
- `getRelayReservationState()` reads `driving` / `lastError` / `retryAtMs` off the
  supervisor when one exists.

### Reference web app

`Home.svelte` renders `node.relay.status` as raw text inside `class="value relay-{status}"`,
and has CSS rules for `.relay-reserved` / `.relay-dialing` / `.relay-error` /
`.relay-none` only — a `retrying` status would render unstyled. Add a
`.relay-retrying` rule alongside `.relay-dialing`. Nothing else in the app
branches on the status string except `Home.svelte:18`
(`relayReady = status === 'reserved'`) and `Diagnostics.svelte:140`, both of which
stay correct. `store.svelte.ts:137` `syncRelay()` already records every transition,
so `relay:retrying` shows up in the transition log for free.

## Stale comments to correct

Three places currently document "this never recovers" as settled behaviour and
will be wrong once this lands:

- `relay-reservation.ts` — the `resolveRelayReservationState` docblock (final
  paragraph, "That precedence is not a promise that a lost reservation comes
  back…"), which also names this ticket by its old `backlog/` path.
- `relay-reservation.ts` — the `NOTE:` inside `describeReservationFailure` about
  `relayFilter` ("Harmless today — every caller drives once at startup. If a retry
  or re-drive loop is ever added, that filter has to be dealt with first."). The
  loop now exists; point the note at where the filter is cleared.
- `cadre-node.ts` — the `getRelayReservationState()` docblock ("nothing re-drives…
  tracked by `tickets/backlog/bug-relay-reservation-not-redriven-after-loss`").
- `packages/reference-app-web/README.md` around line 127 describes
  `reserveRelays()` as a one-shot dial-and-reserve.

## Test notes

The existing suite has no fixed-address relay helper — `startRelay()` uses an
ephemeral key on port 0, so it cannot be restarted as the same peer. The new
specs need a relay started from a caller-supplied `PrivateKey` on a caller-supplied
port. Do **not** hard-code the port: other spec files run in parallel. Bind a
`node:net` server on port 0, read the assigned port, close it, and hand that port
to the relay — same trick the repro used, minus the collision risk.

Keep supervisor timings tight in tests (`checkMs: 250, minBackoffMs: 250,
maxBackoffMs: 1_000`) so a recovery spec costs seconds, not a minute.

## TODO

Phase 1 — supervisor in `relay-reservation.ts`

- Add `RelayReservationSupervisorOptions`, `RelayReservationSupervisor` and
  `superviseRelayReservation` as sketched above; keep every existing export's
  behaviour unchanged.
- Extend `RelayReservationStoreLike` with the optional `relayFilter` slice
  (`{ has(item): boolean; remove?(item): boolean }`) and add a small
  `clearRelayFilterEntry(store, addr)` helper that resolves the peer id from the
  multiaddr and calls `remove` when present. Fail soft: a libp2p version without
  `relayFilter` or without `remove` must degrade to "no un-poisoning", not throw.
- Unref supervisor timers where `unref` exists.
- Add `retrying` to `RelayReservationStatus` and `retryAtMs` to
  `RelayReservationState`; extend `resolveRelayReservationState` with the fifth
  parameter and the new precedence row.
- Re-export the new types from `packages/cadre-core/src/index.ts` (the existing
  relay types are exported around line 374).

Phase 2 — `CadreNode`

- Swap `relayReserveDriving` / `relayReserveError` for the supervisor handle;
  rewrite `reserveRelays` to stop-then-start and await `firstAttempt`.
- Stop the supervisor in `stop()` alongside the existing posture reset.
- Feed `retryAtMs` through `getRelayReservationState()`.

Phase 3 — reference web app

- Add the `.relay-retrying` CSS rule in `Home.svelte`.
- Update the `reserveRelays()` paragraph in the web README.

Phase 4 — tests, in `packages/cadre-core/test/relay-reservation.spec.ts`

- Fixed-key / free-but-fixed-port relay helper (see *Test notes*).
- **Regression spec**: reserve, stop the relay, wait for circuit addrs to drain,
  restart the relay at the same peer id and port, assert the circuit addr comes
  back **with no manual re-drive**. This spec fails on today's code.
- **Un-poisoning spec**: first attempt hits a live peer that is not a relay
  (poisons `relayFilter`, verified above), that peer is replaced by a real relay
  at the same peer id and port, assert the supervisor recovers. Without the
  `remove` call this stays stuck on `The relay was previously invalid`.
- **`stop()` spec**: stop the supervisor while unreserved, bring the relay back,
  assert no circuit addr appears — the loop really stopped, and no timer outlives it.
- Precedence specs for `retrying` vs `dialing` vs `error`; update the eight
  existing `resolveRelayReservationState` specs for the new parameter and field.
- Confirm the existing `CadreNode … clears the posture on stop` spec still passes
  and that the suite exits cleanly (a leaked supervisor timer shows up as a
  hanging vitest process).

Phase 5 — comment/doc corrections listed under *Stale comments to correct*.

Validation: `cd packages/cadre-core && yarn vitest run test/relay-reservation.spec.ts`,
then the package build + lint. `packages/reference-app-web` has a Playwright e2e
(`e2e/solo/formation-rbac.spec.ts:30`) asserting the relay badge reads `none` in
the solo posture — unchanged by this work, but worth not breaking.
