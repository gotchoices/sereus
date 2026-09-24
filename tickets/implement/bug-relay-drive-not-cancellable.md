description: When a node shuts down while it is in the middle of contacting a relay, that attempt keeps running against the half-dismantled node — logging failures that look real but are not, and holding the program open for up to ten seconds after it was told to stop. Measured at roughly nine and a half seconds.
architecture: docs/architecture.md#relay-integration
files: packages/cadre-core/src/relay-reservation.ts, packages/cadre-core/test/relay-reservation.spec.ts, docs/architecture.md
difficulty: medium
repro: verified
----

# Make one relay-reservation attempt cancellable, and cancel it from the supervisor's `stop()`

## What happens

A node that cannot accept incoming connections keeps itself reachable by holding a *reservation* on a relay. A background retry loop (`RelayReservationSupervisor`, in `packages/cadre-core/src/relay-reservation.ts`) re-requests that reservation whenever it is lost, so during a relay outage one attempt or another is in flight a fair share of the time.

Shutting down does not cancel an attempt that has already started. `RelayReservationSupervisor.stop()` clears its retry timer and discards the running attempt's result, but the attempt itself keeps going: it finishes its dial, asks for a slot, then polls the node's addresses every 250 ms until its own timeout (10 s by default) expires — against a node whose transports are being torn down.

## Measured (2026-09-24)

Repro: a standalone Node script against the built `packages/cadre-core/dist/relay-reservation.js` — start a libp2p node with a bare `/p2p-circuit` search listener, call `superviseRelayReservation` over one unreachable relay with the default `timeoutMs: 10_000`, wait until `supervisor.driving` is true, then call `supervisor.stop()` and `node.stop()` and time the process's `exit` event from that moment.

| relay the drive was pointed at | phase the drive was in when `stop()` was called | process exited after |
| --- | --- | --- |
| `/ip4/192.0.2.1/tcp/4001/p2p/<id>` (RFC 5737 TEST-NET-1 — a dial that hangs) | dialing | **9499 ms** |
| a live libp2p peer with no `circuitRelayServer()` (dial succeeds, hop request rejected) | polling for a circuit addr | **8496 ms** |

In both cases `stop()` itself returned in under 5 ms, so the delay is entirely the abandoned drive. Both halves of the original report are therefore real, not just the logging one.

With `DEBUG=sereus:cadre:relay-reservation` the second run also prints a reservation failure for the relay at a moment when the caller has already asked the node to stop — a line indistinguishable from a genuinely unreachable relay.

## Root cause

`driveRelayReservation` accepts no `AbortSignal`. It builds its own deadline internally, so it can stop *itself* when it runs out of time, but no caller can stop it early. Everything above follows from that single gap.

Three timers inside a drive keep a Node process alive, and none of them is `unref`'d (unlike the supervisor's retry timer, which deliberately is):

- `dialRelays` — `setTimeout(() => controller.abort(), deadline - now)`, cleared only once `Promise.allSettled` over the dials resolves.
- `requestOneReservation` — the `expired` arm of its `Promise.race`, cleared only once the race settles.
- `waitForCircuitReservation` → `delay(ms)` — a plain `setTimeout` per poll interval, with nothing that can interrupt it.

Racing a cancellation against these is not sufficient on its own: a `Promise.race` that returns early leaves the losing timer pending, and a pending timer is exactly what holds the process open. **Every one of these timers has to be cleared on the cancellation path**, not merely out-raced.

## Who is exposed

Three call sites start supervisors, and all three already call `stop()` before tearing their node down — so none of them needs a change beyond the drive honouring the signal:

- `CadreNode.driveControlRelayReservation()` (end of `start()`), via `reserveRelays()`. Every node that names `network.relayAddrs` has an attempt in flight during startup, so a `start()` that fails for its own reasons runs `cleanup()` over a live drive.
- `CadreNode.reserveRelays()` called directly by an app (a browser tab, the host UI).
- `StrandInstanceManager.buildStrandRuntime` — one supervisor *per configured relay* per strand node, stopped first in `releaseRuntime`. A strand stop or quiesce during a relay outage can leave one drive per relay running, on top of the control node's one.

## Shape of the fix

**One cancellation signal on the single-shot drive; the supervisor trips it from `stop()`.**

```ts
export interface RelayReserveOptions {
  timeoutMs?: number;
  pollMs?: number;
  /**
   * Ends an in-flight drive early. Aborting is not a failure: the drive returns
   * `{ error: null, cancelled: true }` and every timer it holds is cleared, so
   * the process is free to exit immediately.
   */
  signal?: AbortSignal;
}

export async function driveRelayReservation(
  node: Libp2p,
  addrs: readonly string[],
  opts?: RelayReserveOptions
): Promise<{ error: string | null; cancelled: boolean }>;
```

Why `cancelled` is a separate field rather than folding into `error`: `error: null` currently means *a reservation landed*, and a cancelled drive landed nothing. Conflating the two would let a direct caller read cancellation as success. `driveRelayReservation` is not exported from `packages/cadre-core/src/index.ts` — it is module-internal plus the spec — so widening its return type costs nothing outside this file. `cancelled: true` always implies `error: null`.

**Keep `signal` off the supervisor's options.** `RelayReservationSupervisorOptions` currently extends `RelayReserveOptions` and is passed straight through to the drive, so it would silently inherit a `signal` the supervisor has no story for. Make it `extends Omit<RelayReserveOptions, 'signal'>` and say in its doc comment that the way to cancel a supervisor is `stop()`. The loop then owns one `AbortController`, created in the constructor, aborted in `stop()`, and spread into every drive (`{ ...this.opts, signal: this.cancel.signal }`).

**All three phases, and each timer cleared:**

- *Up front* — if `signal?.aborted` is already true, return `{ error: null, cancelled: true }` without dialing.
- *Dial* — `dialRelays` already owns an `AbortController` for the deadline. Add an `abort` listener on the caller's signal that calls `controller.abort()`, and remove it in the existing `finally` alongside the `clearTimeout`. Do **not** reach for `AbortSignal.any` — the module header already records why `AbortSignal.timeout` is avoided here (React Native / Hermes runs this same code), and `AbortSignal.any` is newer still.
- *Reservation request* — `store.addRelay()` takes no signal, so `requestOneReservation`'s `Promise.race` needs a third arm that settles on abort, alongside the existing deadline arm and with the same `finally` cleanup (the abandoned `addRelay` promise stays handled, as the current comment there explains). `requestReservation`'s loop over connected relays should also break once aborted rather than asking the next relay.
- *Poll wait* — `waitForCircuitReservation` returns `false` once aborted, and its `delay()` helper must resolve early on abort **and** `clearTimeout` its own timer. This is the phase that otherwise absorbs whatever delay the first two shed, and it is the one the 8496 ms measurement above came from.

**Do not record a cancelled drive as a failure.** `RelayReservationLoop.driveOnce` currently guards with `if (!this.stopped) this.failure = error;`. Extend that to skip a `cancelled` result too, so cancellation never becomes a status a caller sees through `getRelayReservationState()`.

## Tests

Three, all in `packages/cadre-core/test/relay-reservation.spec.ts`, using the existing `blackholeRelayAddr` / `startFixedNonRelay` helpers. Give each drive a long `timeoutMs` (10 s) and assert it returns *well* inside that — a ~1 s bound separates "cancelled" from "ran to its deadline" without being timing-fragile.

- **A drive aborted while dialing returns promptly, and reports `cancelled`.** Point it at `blackholeRelayAddr(...)` (a dial that hangs), abort after ~200 ms.
- **A drive aborted while polling for a circuit addr returns promptly.** Point it at a `startFixedNonRelay` peer — the dial succeeds, the hop request is rejected, and the drive settles into the poll — then abort. Different code path from the dial case, and the phase that hid the delay.
- **`supervisor.stop()` cancels the drive that is in flight.** Start a supervisor with a 10 s `timeoutMs` over a blackholed relay, wait for `supervisor.driving`, call `stop()`, and assert `supervisor.driving` goes false promptly.

No test for the reservation-request phase: holding `addRelay` open deterministically needs a peer that accepts the connection and then never answers the hop stream, which is more fixture than the phase is worth. It is covered structurally by the same `finally` shape as the other two.

Note that prompt return does **not** by itself prove the timers were cleared — a `Promise.race` can return early with its loser still pending. The clearing is what makes the process exit, and it is a review point on the diff rather than something these three tests assert. Routing every wait through one `delay(ms, signal?)` helper that clears in a `finally` keeps it to a single place to get right.

## Docs

`docs/architecture.md`, `### Relay Integration`. The strand paragraph says "The supervisors are stopped first in `releaseRuntime`, so quiesce, stop, a failed launch's rollback and removal after revocation all end them before the node they supervise is torn down." That sentence is now true of the *attempt* as well as the loop — extend it by a clause saying `stop()` cancels a drive that is already running, so teardown no longer trails a reservation attempt. One sentence; do not add a section.

Also correct the two places in `relay-reservation.ts` that state the old behaviour outright: the module header's "`driveRelayReservation` stays a single-shot primitive" paragraph, and `RelayReservationSupervisor.stop()`'s JSDoc, which currently reads "A drive that is ALREADY in flight is not aborted — `driveRelayReservation` takes no signal".

## TODO

- Add `signal?: AbortSignal` to `RelayReserveOptions`; widen `driveRelayReservation`'s return to `{ error: string | null; cancelled: boolean }` and update the `addrs.length === 0` early return.
- Return `{ error: null, cancelled: true }` immediately when the signal is already aborted on entry.
- Honour the signal in `dialRelays` (abort listener on the caller's signal, removed in the existing `finally`).
- Honour the signal in `requestOneReservation` (third race arm) and break `requestReservation`'s relay loop once aborted.
- Honour the signal in `waitForCircuitReservation` and its `delay()` helper — resolve early **and** `clearTimeout`.
- Change `RelayReservationSupervisorOptions` to `extends Omit<RelayReserveOptions, 'signal'>`; document that `stop()` is how a supervisor is cancelled.
- Give `RelayReservationLoop` an `AbortController`, abort it in `stop()`, spread its signal into every `driveRelayReservation` call.
- Skip recording `failure` in `driveOnce` when the drive came back `cancelled`.
- Correct the module header and the `stop()` JSDoc.
- Add the three specs above.
- Extend the `releaseRuntime` sentence in `docs/architecture.md` → `### Relay Integration`.
- Verify: `yarn workspace @serfab/cadre-core build`, `yarn workspace @serfab/cadre-core test`, `yarn lint`.
