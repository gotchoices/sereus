description: When a node lets a stranger connect only so it can ask for a relay reservation, and the stranger never asks, the node is meant to drop the connection after 5 seconds on both sides. In fact the stranger's side stays "open" until its own liveness ping fails. That took about 15 s with libp2p's defaults, but takes up to about 65 s since sereus lengthened the ping schedule, so two integration tests now fail and the release gate is red.
files:
  - packages/cadre-core/src/membership-connection-gater.ts (`PendingReserveDeadlines.expire` → `entry.maConn.abort(...)`; `createMembershipConnectionGater`, `denyInboundEncryptedConnection` arming it)
  - packages/cadre-core/src/types.ts (`DEFAULT_CONNECTION_MONITOR`: 35 s interval, 30 s deadline — what exposed this)
  - packages/integration-tests/src/scenarios/control-stream-authz.integration.ts ("denies an un-announced stranger connection…", waits 20 s for D's side)
  - packages/integration-tests/src/scenarios/relay-only-control-addr.integration.ts ("an admitted-for-relay stranger … is dropped when it never reserves", waits 20 s for S's side; its comment says the deadline "aborts the connection on both sides")
----

# The relay-only deadline doesn't close the stranger's side of the connection

## Observed (2026-09-23, sereus `973ece7f`, optimystic linked at `b2523990`)

The full `yarn check` fails 2 of 317 integration tests, and both are the cases above. Both passed in the previous full check (`fff9f777`), before `DEFAULT_CONNECTION_MONITOR` (`f18b8bb2`/`5c0f7bf4`) changed the ping schedule from 10 s interval with a 5 s deadline to 35 s with a 30 s deadline.

- With the scenario's nodes given `network.connectionMonitor: {}` (libp2p's stock ping), `control-stream-authz`'s case passes.
- With the default, a probe polling both sides every 250 ms after `D.dial(A)` found: **A never lists an open connection to D, at any point; D lists its connection to A as `open` for the full 60 s probed.**

So A's admission holds, and the stranger never gets a usable connection on A. But A's 5 s abort never reaches D. D learns only when its own ping to A fails, which now takes up to one interval plus the deadline (≈65 s). The tests' comments assume the abort closes both sides; it never did.

## Questions the fix has to answer

- **What does `maConn.abort()` at 5 s actually do on A?** A doesn't list the connection as open even at t≈0, which fits the gater note that the dialer's upgrade can complete (muxer negotiated in Noise early data) before the receiver-side hook runs. Find out whether A's upgrade finishes, fails or hangs for an `admit-for-relay` peer, and whether the TCP/WebSocket socket is actually closed when the timer fires. **If A's socket isn't closed, A is leaking a socket per stranger for as long as the stranger holds it**, which is a resource-exhaustion path on a public relay. Check this first.
- The fix is whatever makes A's deadline close the transport, so the stranger sees the close promptly (FIN/RST), not when its ping fails. Candidates: abort the upgraded `Connection` rather than the raw `maConn`, or close through the connection manager once it is registered, or both, depending on what the first question shows. Don't lengthen the tests' waits and don't pass `connectionMonitor: {}` in the tests; either would hide the defect.
- Check that a legitimate `admit-for-relay` peer that DOES reserve within the deadline is unaffected (`disarm`), and that aborting an already-closed connection stays harmless.

## Done when

- Both scenarios pass under the default connection monitor, with the stranger's side closing within a few seconds of A's deadline (tighten the 20 s waits if the result allows).
- If a socket was leaking on A, a test at the lowest layer that reproduces it (gater + real transport) pins the close.
- The two scenarios' comments match what now happens.
