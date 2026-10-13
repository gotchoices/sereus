description: The slow-link test's comments and the testing guide say a relay that answers liveness pings makes a joining phone's first sync slower for an unknown reason. The reason is now known, and it is not a cost of answering pings: without them the founder's phone silently loses its relay connection, the joiner is cut off sooner, and the test finishes sooner by taking the known broken path. The comments and docs should say so.
architecture: docs/testing.md
files: packages/integration-tests/src/scenarios/joiner-first-commit-over-slow-relay.integration.ts (header paragraph "Why the joiner has no strand peer in the third arm", ~lines 40-56; `FIRST_SYNC_MS` NOTE ~line 140), packages/integration-tests/src/harness/dedicated-relay.ts (header bullet "The ping service, with the ops relay's handler timeout"), docs/testing.md (~line 693, the `joiner-first-commit-over-slow-relay` item), docs/architecture.md (~line 2081, the `connectionMonitor` comment in the config listing), tickets/blocked/report-libp2p-websockets-buffered-amount.md (the upstream defect, second arm), tickets/blocked/optimystic-ping-handler-timeout-below-the-monitor-deadline.md (the drops)
difficulty: easy
----

# Explain why the slow-link arms run longer when the relay answers pings

Comments and docs only. No behaviour changes: the harness relay keeps its ping service, because the deployed relay answers pings and the faster runs without it take the path the third arm reproduces as a bug.

## What was found (fix stage, 2026-10-13)

Twelve runs of `joiner-first-commit-over-slow-relay.integration.ts`'s fourth arm (`-t "kept storage$"`), with a temporary connection log on the relay and both strand nodes. Relay answering pings: joiner writable at 98, 93, 90, 92 s, then 161 s, and two runs still not writable when stopped at 180 s and 290 s. Relay not answering: 99, 96, 88, 103, 93 s. Running 30 CPU-burning processes beside the test changed nothing (92 s and 93 s). The implement stage of `slow-relay-joiner-strand-connection-keeps-dropping` saw every run with the relay answering pings come out slow (7 of 7); this pass saw 3 of 7. That earlier rate was not reproduced; the mechanism below is the same in both sets.

The chain, every step seen in the logs:

1. **The joiner becomes writable only once it is cut off from the founder.** In every run that reached the commit (10 here, 9 in the earlier ticket's logs) the joiner's seat committed without reaching the founder (`founder held the joiner's rows when it stopped: false`), and in the 10 with connection logs the founder's strand node had no connection to the joiner's when the joiner's first-sync gate opened. This is the third arm's known solo commit (`blocked/optimystic-write-made-alone-owes-no-one`). So the arm's duration is how long until the joiner, already holding the founder's blocks, is cut off from the founder.
2. **About 80 s in, the relay drops the founder's relay connection.** The relay's ping to the founder's strand node is reset by that node's 10 s ping handler (`blocked/optimystic-ping-handler-timeout-below-the-monitor-deadline`), and the relay's monitor aborts the connection. This happens in both columns.
3. **The abort does not close the WebSocket.** `@libp2p/websockets` resets with `close(1006)`, which every WebSocket implementation refuses to send (`blocked/report-libp2p-websockets-buffered-amount`, second arm). The founder's side keeps a connection whose muxer is closed and learns of it only when it next opens a stream on it.
4. **Whether the founder notices at once depends on the relay answering pings.** With the ping service, the founder's own monitor ping to the relay is usually still in flight: the echo has to cross a socket queue of 10 to 20 s, so it occupies most of the 35 s interval. The abort resets that stream, the founder's monitor drops the connection, and the founder re-dials the relay and reserves again within about 2 s (6 of 7 runs; in the seventh, where the abort came after the joiner was already writable, no ping was in flight and the founder held the dead connection for 50 s). Without the service, the founder's ping ends at protocol negotiation and nothing is in flight, so the founder holds the dead connection for 25 to 32 s until its next ping fails with `ConnectionClosedError: The connection muxer is "closed"` (4 of 4 runs where the abort came before writable). Meanwhile it is unreachable through the relay.
5. **An unreachable founder ends the arm sooner.** The joiner's member redial fails, the joiner is cut off, and the gate opens on blocks it already holds (step 1). When the founder is reachable again within 2 s, the redial reconnects the strand nodes about 20 s later, and the first sync waits for a later cut-off: the next ping-handler drop about 40 s after each reconnect, or the relay dropping the joiner. That is the 161 s and the stopped runs.

So the deployed relay's configuration is right as it is. What makes the first sync slow on that link is the drop cycle (step 2) and the saturated link. Lifting the cadre nodes' handler timer to 60 s in memory (a test-only experiment) did not make the first sync fast: pings then outran the 30 s monitor deadline, and in one run a circuit stayed up for 154 s at the frame cap while one first-sync probe ran for 3 minutes and failed. That evidence is on `blocked/optimystic-ping-handler-timeout-below-the-monitor-deadline`.

Logs: `tickets/.logs/slow-link-joiner-first-sync-slower-when-relay-answers-pings.fix-*.log` (`ping*`/`noping*` are the two columns; `*-h60*` the handler experiment; `-ping-h60-streams` samples open streams per protocol every 5 s). Pruned after 14 days. The temporary instrumentation is not in the tree.

## What to write

Follow AGENTS.md's docs rules: state the mechanism as it is now, name tickets by slug, no run-by-run history.

- **Scenario header** ("Why the joiner has no strand peer in the third arm"): replace the sentence ending "why the relay's ping handler costs that much is `fix/slow-link-joiner-first-sync-slower-when-relay-answers-pings`" and the 385 s / 85 s figures with steps 1 and 3 to 5, condensed: the joiner becomes writable only once it is cut off from the founder; a relay abort leaves the aborted node holding a dead connection until it next opens a stream (upstream defect, slug); with the relay answering pings that is usually at once, because the node's own ping to the relay is in flight, so the strand nodes reconnect and the first sync waits for a later cut-off.
- **`FIRST_SYNC_MS` NOTE**: the 400 s first syncs are the cost on that link with the relay behaving as deployed, not a fixture artifact. If the fourth or fifth arm times out, the causes are the drop cycle (`blocked/optimystic-ping-handler-timeout-below-the-monitor-deadline`) and the saturated link; removing the fixture's ping service would make the arm pass by cutting the joiner off sooner, so do not do that. Keep the existing warning that a first sync past 600 s would keep the third arm's `it.fails` green for the wrong reason.
- **`dedicated-relay.ts` header**, ping-service bullet: add the second reason the service is part of parity. A client learns that the relay aborted its connection mostly through its own in-flight ping being reset, because the abort does not close the WebSocket (upstream defect, slug). Without the service, clients keep connections the relay aborted until their next ping, which shortens the slow-link arms.
- **`docs/testing.md`** (~line 693): replace "(the slow first sync behind those figures is ticket `slow-link-joiner-first-sync-slower-when-relay-answers-pings`)" with a short pointer: the first sync lasts until the joiner is cut off from the founder (scenario header). The fix ticket's slug will no longer be on the board.
- **`docs/architecture.md`** (`connectionMonitor` comment, after "Cost: a dead peer is reclaimed 30-65s after it stops answering"): one sentence saying that an aborted WebSocket connection is not closed on the wire (`blocked/report-libp2p-websockets-buffered-amount`), so the far end finds out only when it next opens a stream, at the latest on its next ping, up to 35 s later.

No test changes. The arms' behaviour is unchanged, and none of this is checkable by a test cheaper than the arms themselves.

## TODO

- Rewrite the scenario header sentence and the `FIRST_SYNC_MS` NOTE as above.
- Extend the ping-service bullet in `dedicated-relay.ts`'s header.
- Update the `docs/testing.md` item and add the sentence to `docs/architecture.md`'s `connectionMonitor` comment.
- `grep -rn "slow-link-joiner-first-sync-slower-when-relay-answers-pings" --include=*.ts --include=*.md . | grep -v node_modules | grep -v tickets/` returns nothing.
- `yarn lint` passes on the two changed `.ts` files (comments only; no test run needed).
