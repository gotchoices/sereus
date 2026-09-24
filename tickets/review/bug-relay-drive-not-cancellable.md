description: A node shutting down while it was contacting a relay used to keep that attempt running for up to ten seconds, logging failures that looked real but were not. It is now cancelled the moment the node is told to stop.
architecture: docs/architecture.md#relay-integration
files: packages/cadre-core/src/relay-reservation.ts, packages/cadre-core/test/relay-reservation.spec.ts, docs/architecture.md
repro: verified
----

# Review: one relay-reservation attempt is now cancellable, and `stop()` cancels it

## What changed

`driveRelayReservation` (the single-shot "dial the relay, ask for a slot, wait for the circuit address to appear" primitive in `packages/cadre-core/src/relay-reservation.ts`) now takes an `AbortSignal` and returns `{ error: string | null; cancelled: boolean }` instead of `{ error }`. `RelayReservationSupervisor.stop()` — which previously cleared only its retry timer — now also trips a signal that ends the attempt already in flight.

Concretely:

- `RelayReserveOptions` gained `signal?: AbortSignal`. A new exported `RelayReserveResult` names the widened return. `cancelled: true` always implies `error: null`, and the success check runs *before* the cancellation check, so a reservation that lands in the same turn the signal trips is still reported as landed rather than as cancelled.
- All three waiting phases honour the signal: the concurrent dial (the caller's abort is relayed into the controller that already carries the deadline), the `addRelay` reservation request (its deadline race now ends on either route), and the circuit-address poll.
- Two small helpers carry the cancellation plumbing. `delay(ms, signal?)` is the single place every wait goes through, and it `clearTimeout`s on **both** endings rather than only its own — a losing `Promise.race` arm leaves its timer pending, and a pending timer is precisely what held the process open. `linkAbort(from, to)` relays one signal into a controller and hands back the detach that runs in a `finally`; `AbortSignal.any` is banned by `eslint.config.mjs` (Hermes/React Native) and would have leaked listeners anyway.
- `RelayReservationSupervisorOptions` is now `extends Omit<RelayReserveOptions, 'signal'>`, because these options are spread straight into every drive: an inherited `signal` would cancel each attempt without the loop knowing, leaving it rescheduling drives that return instantly forever. Its doc says `stop()` is how you cancel a supervisor. No caller passed `signal` before, so nothing outside the module changed.
- `RelayReservationLoop` owns one `AbortController`, aborted in `stop()`, spread into every drive. `driveOnce` skips recording `failure` for a `cancelled` result, so cancellation never reaches a caller through `getRelayReservationState()`.

Docs and comments that stated the old behaviour outright are corrected: the module header's "single-shot primitive" paragraph, `RelayReservationSupervisor.stop()`'s JSDoc ("A drive that is ALREADY in flight is not aborted"), the `waitForCircuitReservation` JSDoc, the `'stops re-driving once stopped'` spec's inline comment, and the `releaseRuntime` sentence in `docs/architecture.md` → `### Relay Integration`.

## Measured after the change

Same method as the ticket's original measurement: a standalone Node script against the **built** `packages/cadre-core/dist/relay-reservation.js`, starting a libp2p node with a bare `/p2p-circuit` search listener, driving one unreachable relay with `timeoutMs: 10_000`, then timing the process's `exit` event from the moment `stop()` is called. The script was deleted after the run.

| case | before (ticket) | after |
| --- | --- | --- |
| aborted while dialing a blackholed relay (`/ip4/192.0.2.1/…`) | 9499 ms to process exit | **1028 ms** |
| aborted while polling, against a live peer with no `circuitRelayServer()` | 8496 ms to process exit | **1021 ms** |
| **baseline**: the same node started and stopped with no supervisor at all | — | **1025 ms** |

The baseline is the number that matters for judging the fix: the residual ~1 s is libp2p's own shutdown, present when no drive ever ran, so the cancelled drive now contributes nothing measurable to teardown. `driveRelayReservation` itself returned `{"error":null,"cancelled":true}` in **1–2 ms** in both phases.

## Tests added

Three, all in `packages/cadre-core/test/relay-reservation.spec.ts`:

- `driveRelayReservation cancellation` → **'returns promptly, and reports cancelled, when aborted while dialing'** — verifies the dial phase honours the signal and that the result is `{ error: null, cancelled: true }` rather than a relay failure. Uses `blackholeRelayAddr` (a dial that hangs), aborts after 200 ms, asserts the drive settles within 1 s of a 10 s budget.
- `driveRelayReservation cancellation` → **'returns promptly when aborted while polling for a circuit addr'** — verifies the poll phase, which is a different code path and the one that absorbed the delay the other phases shed. Uses `startFixedNonRelay` (dial succeeds, hop request rejected), aborts after 750 ms.
- `superviseRelayReservation` → **'cancels the drive that is in flight when stopped'** — verifies the wiring from `stop()` to the drive: `supervisor.driving` goes false within 1 s of `stop()` on a 10 s `timeoutMs`, and `lastError` stays `null`, which is the `driveOnce` skip.

No test for the reservation-request phase: holding `addRelay` open deterministically needs a peer that accepts the connection and then never answers the hop stream, which is more fixture than the phase is worth. It shares the `waitOver` shape with the other two.

## Known gaps — where to push

**Prompt return does not prove the timers were cleared.** This is the main review point on the diff, and it is deliberately not something the three specs assert: a `Promise.race` can return early with its loser still pending, and the test would pass while the process still hung. The clearing is what makes the process exit, which is why the measurement table above exists — but that was a one-off script, not a standing check. Read `delay`, `linkAbort`, `dialRelays`'s `finally` and `requestOneReservation`'s `finally` as the actual proof, and check that every `setTimeout` in the drive path is reachable by a `clearTimeout` on the cancellation route. If you think that deserves a standing guard, the honest shape is a process-exit test (spawn a child, time its exit), not another assertion on return latency.

**The 750 ms sleep in the polling spec is a timing assumption, not a synchronisation point.** There is no observable for "the drive has reached the poll", so the spec waits long enough for a loopback dial plus a rejected hop request and assumes the drive has settled into `waitForCircuitReservation`. If it hasn't, the test still passes — it would just be re-testing the request phase instead. That is a weaker test than it reads as; the assertion is still correct either way.

**`aborted(signal)` exists to defeat TypeScript, not for style.** `AbortSignal.aborted` is a readonly boolean, so one `if (signal?.aborted)` narrows every later read to `false` and TS rejects the re-check as dead code. The helper's comment says so. Worth a look that the narrowing problem is real and the helper is the right answer rather than a `// @ts-expect-error`-shaped workaround.

**Cancellation is reported by an end-of-function check, not per phase.** `driveRelayReservation` runs its three phases and asks `aborted(signal)` once at the end rather than after each await. That is fewer branches and the phases all return early on their own, but it means the decision "was this a cancellation or a real failure" rests on one read. The ordering against the success check is the subtle part and carries a comment.

**One behaviour intentionally not changed.** `requestOneReservation` builds a distinct message for a cancelled request (`…was cancelled`), but that string is always discarded at the top level, since a cancelled drive reports `error: null`. It exists so a future caller of `requestReservation` on its own is not handed the misleading deadline message. Reviewer's call whether that is worth keeping or is dead weight.

## Verification run

- `yarn workspace @serfab/cadre-core build` — clean
- `yarn workspace @serfab/cadre-core typecheck` — clean (covers the spec tree, which `build` does not)
- `yarn workspace @serfab/cadre-core test` — **138 files, 2264 passed, 1 skipped** (the skip is pre-existing, not from this change)
- `yarn lint` — clean

Note for anyone re-running these: the suite's stale-build guard blocked every run for roughly the first half of this ticket, because `../quereus`'s `dist` was behind its `src` while that sibling was being edited. Per `tickets/rules/sibling-repos.md` it was not built from here; the run above is from after its own build landed. Nothing was skipped or disabled to get the green.
