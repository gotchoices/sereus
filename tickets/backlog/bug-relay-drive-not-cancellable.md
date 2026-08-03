description: When a node shuts down while it is in the middle of contacting a relay, that attempt keeps running against the half-dismantled node for up to ten seconds — logging failures that look real but are not, and possibly delaying the program's exit.
prereq:
files: packages/cadre-core/src/relay-reservation.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/test/relay-reservation.spec.ts
difficulty: medium
repro: static
----

## What happens

A node that cannot accept incoming connections keeps itself reachable by holding
a *reservation* on a relay. A background loop (the "supervisor") re-requests that
reservation whenever it is lost, so one attempt or another is in progress a fair
share of the time during a relay outage.

Shutting down does not cancel an attempt that has already started. Both
`RelayReservationSupervisor.stop()` and `CadreNode.stop()` cancel the *next*
attempt and throw away the current one's result, but the current one keeps
running: it finishes its dial, then polls the node's addresses every 250 ms until
its own timeout (10 s by default) expires.

Two consequences, both bounded and neither corrupting anything:

- **Misleading logs.** The dial and reservation request run against a node whose
  transports are being torn down, so they fail. Those failures are logged as
  ordinary relay errors, indistinguishable from a genuinely unreachable relay.
- **Possibly a delayed exit.** The supervisor's own retry timer is `unref`'d
  precisely so a pending retry cannot hold a Node process open. The polling wait
  *inside* an attempt is a plain `setTimeout` and is not, so an attempt still
  running at shutdown may keep the process alive until it times out. This is read
  from the code, not measured — see "How to confirm" below.

## Root cause

`driveRelayReservation` in `packages/cadre-core/src/relay-reservation.ts` accepts
no `AbortSignal`. It builds its own internal one from its deadline, so it can
stop itself when it runs out of time, but no caller can stop it early. Everything
above follows from that one gap; the supervisor's `stop()` is already correct
about everything it *can* control.

## Expected behaviour

An attempt in progress should end promptly when the thing that started it is shut
down — no dial against a torn-down node, no polling loop outliving the node it is
polling, no exit delay. Shutdown should be observably immediate rather than
"immediate, and then some background noise for a few seconds".

This means the single-shot drive needs to take a caller-supplied cancellation
signal alongside its existing deadline, and the supervisor needs to trip that
signal in `stop()`. All three of the drive's phases — the dial, the reservation
request, and the wait for the circuit address to appear — have to honour it, or
the last one simply absorbs the delay the first two shed.

Cancellation is not an error: a drive that is cancelled has no reservation to
report and no failure worth surfacing, so it should not turn into a status a user
sees.

## How to confirm the exit-delay half

Start a supervisor against an address nothing answers at, wait until an attempt
is genuinely in flight, call `stop()`, and time how long the Node process takes
to exit. If it lingers to the drive timeout, the claim holds; if it exits at once,
only the misleading-logs half is real and the ticket shrinks accordingly.

## Context

Found reviewing `36-bug-relay-reservation-not-redriven-after-loss`, which added
the supervisor. That ticket's own handoff flagged the same window and asked for a
second opinion on whether it matters for `CadreNode.stop()`; this ticket is that
opinion. `CadreNode.stop()` was changed during that review to stop the supervisor
*before* tearing the node down, which removes the case where a *newly scheduled*
attempt starts during shutdown — it does not touch an attempt already running.
