description: When relay-only nodes restart within a moment of each other, the relay sometimes closes one node's new WebSocket right after accepting it. Nodes now dial again and carry on, about a second later, but why the relay closes the socket is not known.
files: packages/cadre-core/src/relay-reservation.ts (`dialUntilAnswered`), packages/integration-tests/src/scenarios/strand-relay-only-restart-reconverges.integration.ts, packages/integration-tests/src/harness/dedicated-relay.ts
repro: verified
severity: edge-case
likelihood: unusual
tradeoffs: The cost is now about one second on a restart, and finding the cause means tracing the relay side of js-libp2p for a failure seen so far only on a loopback relay.
----
# The relay closes a dial after a quick restart

## Observed

`strand-relay-only-restart-reconverges`, whole file, 2026-11-02: in 9 of 12 runs the relay dropped one dial during the restart. The dialer saw WebSocket close code 1005 with `wasClean` true about 1 ms after connecting, then `Unexpected EOF - stream closed while reading 0/1 bytes` from multistream-select.

## Ruled out

libp2p's per-host inbound limit (`inboundConnectionThreshold`) and its other refusals: a run with `DEBUG=libp2p:*` that failed this way logged no `refused -` line.

## To find out

Log the relay's side of that one socket, in `@libp2p/websockets`'s listener and in the upgrader. Then decide whether a deployed relay can do the same to a real node.
