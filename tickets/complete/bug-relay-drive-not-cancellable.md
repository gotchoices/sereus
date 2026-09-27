description: A node shutting down while it was contacting a relay used to keep that attempt running for up to ten seconds, logging failures that looked real but were not. It is now cancelled the moment the node is told to stop, and the review confirmed it.
architecture: docs/architecture.md#relay-integration
files: packages/cadre-core/src/relay-reservation.ts, packages/cadre-core/src/strand-instance-manager.ts, packages/cadre-core/test/relay-reservation.spec.ts, docs/architecture.md
repro: verified
----

# Complete: one relay-reservation attempt is cancellable, and `stop()` cancels it

## What landed

`driveRelayReservation` (`packages/cadre-core/src/relay-reservation.ts`) — the single-shot "dial the relay, ask for a slot, wait for the circuit address to appear" primitive — now takes an `AbortSignal` and returns `{ error: string | null; cancelled: boolean }`. `RelayReservationSupervisor.stop()`, which previously cleared only its retry timer, now also trips a signal that ends the attempt already in flight.

- `RelayReserveOptions` gained `signal?: AbortSignal`; a new `RelayReserveResult` names the widened return. `cancelled: true` always implies `error: null`, and the success check runs before the cancellation check, so a reservation that lands in the same turn the signal trips is still reported as landed.
- All three waiting phases honour the signal: the concurrent dial (the caller's abort relayed into the controller that already carried the deadline), the `addRelay` reservation request (its deadline race now ends on either route), and the circuit-address poll.
- Two helpers carry the plumbing. `delay(ms, signal?)` is the single place every wait goes through and clears its timer on *both* endings, because a losing `Promise.race` arm leaves its timer pending and a pending timer is what held the process open. `linkAbort(from, to)` relays one signal into a controller and returns the detach that runs in a `finally` — `AbortSignal.any` is banned by `eslint.config.mjs` for the phone runtimes and would have leaked listeners anyway.
- `RelayReservationSupervisorOptions` is now `extends Omit<RelayReserveOptions, 'signal'>`: these options are spread straight into every drive, so an inherited `signal` would cancel each attempt without the loop knowing.
- `RelayReservationLoop` owns one `AbortController`, aborted in `stop()`, spread into every drive. `driveOnce` skips recording `failure` for a `cancelled` result, so cancellation never surfaces through `getRelayReservationState()`.

Measured by the implement pass against the built `dist`, same method as the original report: a drive aborted while dialing a blackholed relay went from 9499 ms to 1028 ms of process-exit delay; aborted while polling, from 8496 ms to 1021 ms. The baseline — the same node started and stopped with no supervisor at all — is 1025 ms, so the cancelled drive now contributes nothing measurable to teardown.

## Review findings

### Read and re-derived, no defect

- **Timer audit on the cancellation path** — the thing the implement handoff named as its main review point. Every `setTimeout` a drive can be sitting in is reachable by a `clearTimeout` on the abort route: `dialRelays`' deadline timer (cleared in its existing `finally`, which now also detaches the relay), `requestOneReservation`'s wait arm (the `waitOver` controller is aborted in a `finally` on every exit, which is what clears `delay`'s timer), and `waitForCircuitReservation`'s per-poll `delay`. No wait in the drive bypasses `delay`. Confirmed by running it, not only by reading it — see *Ran* below: process exit lands on the 1025 ms no-supervisor baseline.
- **The `aborted(signal)` helper's justification** — the handoff asked for this to be checked rather than taken on trust. It is real, and reproduced: inlining the six call sites as `signal?.aborted === true` makes `tsc` fail with `TS2367: This comparison appears to be unintentional because the types 'false | undefined' and 'true' have no overlap` at the second check in `driveRelayReservation`. The plain truthy spelling compiles, but only because TypeScript has narrowed the re-check to unreachable — a silent wrong type on the one branch cancellation depends on. The helper defeats the narrowing and the comment stands; left as written.
- **Ordering of the success check against the cancellation check** in `driveRelayReservation`, and the dropping of the phases' accumulated error strings once cancelled. Both correct and both carry the comment that says why.
- **`requestOneReservation`'s distinct "was cancelled" message**, which the handoff offered up as possible dead weight. Kept. The string itself is always discarded at the top level, but the branch is not cosmetic: it is also what suppresses the `log('…still pending at the deadline')` line for a request abandoned at a cancellation, which is half of the original bug report.
- **Interaction with `CadreNode.reserveRelays`'s "stop first, unconditionally" guard** — a second call now genuinely ends the previous drive instead of leaving it to finish against the same pending reservation slot, which is what that comment already claimed.
- **File size**: `wc -l packages/cadre-core/src/relay-reservation.ts` → 1104 after this pass (1098 as the implement pass left it). Not filed as size debt: it is one subject, and the bulk is the explanatory comment that records measured libp2p behaviour. `tickets/backlog/debt-cadre-node-single-file-size.md` already owns the size theme for this package; adding a file I would not split to it would be noise.

### Fixed in this pass

- **A stale comment the implement pass missed**, in `packages/cadre-core/src/strand-instance-manager.ts` → `releaseRuntime`: "a drive ALREADY in flight cannot be aborted (the drive takes no AbortSignal — `backlog/bug-relay-drive-not-cancellable`); it fails soft against the stopped node within its own 10 s deadline". Every word of that is now false, and it cited this ticket by slug. Replaced with what `stop()` actually does. The handoff listed the docs and comments it corrected and this file was not among them — it was outside the ticket's `files:` list.
- **The polling cancellation spec synchronized on a bare `await sleep(750)`**, which the handoff itself flagged as an assumption rather than a synchronization point: if the drive had not reached the poll, the spec would still pass while silently re-testing the request phase the other case already covers. Replaced with the observable that says the request phase is over — `waitFor(() => relayFilterHas(client, id.addr), …)`. libp2p records a refused hop request in the reservation store's `relayFilter`, and the spec file already has that helper and already pins that behaviour elsewhere. Measured at 111 ms against the 750 ms it replaced, so the spec is both honest and faster.

### Recorded as a tripwire, not filed

- **Nothing in the suite fails if a future wait skips the `delay` helper.** The three cancellation specs assert prompt *return*, which a `Promise.race` gives with its losing timer still pending; only the process exiting proves the clearing, and that is measured by hand. Parked as a `NOTE:` on `delay`'s JSDoc in `relay-reservation.ts`, naming the shape a standing guard would take (spawn a child, time its exit). Conditional — it becomes work only if a wait is added outside the helper — so it is knowledge at the site, not a ticket.

### Tests

No test added and none cut. The three the implement pass wrote each pin a distinct contract and all three were weighed against the bar:

- the dial-phase drive spec is the reproduction of the reported bug at the lowest layer that reproduces it, and it is the only one that can see the `{ error: null, cancelled: true }` result shape;
- the poll-phase drive spec covers a different code path (`waitForCircuitReservation`), and it is the phase the original 8496 ms measurement came from — its synchronization was strengthened rather than the test dropped;
- the supervisor spec covers the `stop()` → signal wiring and the `driveOnce` skip that keeps `lastError` null, neither of which is visible from the drive-level specs.

No spec was added for the reservation-request phase, matching the implement decision: holding `addRelay` open deterministically needs a peer that accepts the connection and then never answers the hop stream, which is more fixture than the phase is worth.

### Tickets filed

None. Nothing found was a class-level invariant or a latent defect — the two findings were a stale comment and a weak synchronization point, both cheaper to fix here than to describe in a ticket, and the one conditional concern is a tripwire by the rules above.

## Verification

Run at review:

- `yarn workspace @serfab/cadre-core build` — clean
- `yarn workspace @serfab/cadre-core typecheck` — clean (covers the spec tree, which `build` does not)
- `yarn lint` — clean
- A standalone Node script against the built `packages/cadre-core/dist/relay-reservation.js`, mirroring both drive-level specs including the new `relayFilter` gate: aborted while dialing returned `{"error":null,"cancelled":true}` in 2 ms, aborted while polling in 0 ms, and the process exited 1025 ms after `stop()` — the no-supervisor baseline, so no drive timer outlives the cancellation. Script deleted after the run.

**The cadre-core vitest suite could not be run at review.** The suite's stale-build guard (`test-harness/build-freshness.ts`) reports `@quereus/quereus`'s `dist` behind its `src`, and it stayed that way for the whole review: the sibling was being edited throughout (seven source files under `../quereus/packages/quereus/src` newer than its `dist/src/index.js`, last touched minutes into this run). `tickets/rules/sibling-repos.md` forbids building it from here, and the guard was not bypassed, skipped or loosened. The implement pass hit the same block and ran the full suite green after the sibling's own build landed (138 files, 2264 passed, 1 skipped, the skip pre-existing). What this review changed since that run is two comments and one spec's synchronization — the spec change was exercised directly by the standalone script above. Re-run `yarn workspace @serfab/cadre-core test` once `../quereus` has built.
