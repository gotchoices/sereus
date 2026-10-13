description: The slow-link test's comments and the testing guide now explain why a relay that answers liveness pings makes a joining phone's first sync slower: without pings the founder's phone silently loses its relay connection and the joiner is cut off sooner, which ends the test early along the known broken path. Check the wording is accurate and plain.
architecture: docs/testing.md
files: packages/integration-tests/src/scenarios/joiner-first-commit-over-slow-relay.integration.ts, packages/integration-tests/src/harness/dedicated-relay.ts, docs/testing.md, docs/architecture.md
difficulty: easy
----

# Review: explanation of the slow-link first-sync difference

Comments and docs only; no behaviour or test changes.

## What changed

- `joiner-first-commit-over-slow-relay.integration.ts` header: the 385 s / 85 s single-run figures and the pointer to the fix ticket are gone. A new paragraph ("Why the joiner's first sync takes minutes there") states the mechanism: the joiner becomes writable only once cut off from the founder; a relay abort leaves the aborted node holding a dead connection until it next opens a stream (`blocked/report-libp2p-websockets-buffered-amount`, second arm); with the relay answering pings that is usually at once (the node's own in-flight ping is reset), so it reconnects within ~2 s and the first sync waits for a later cut-off; without the ping service it stays unreachable up to 35 s and the joiner is cut off sooner.
- `FIRST_SYNC_MS` NOTE: the ~400 s is the cost with the relay as deployed; causes of a timeout are the drop cycle (`blocked/optimystic-ping-handler-timeout-below-the-monitor-deadline`) and the saturated link; do not remove the fixture's ping service; kept the 600 s / `it.fails` warning.
- `dedicated-relay.ts` header, ping-service bullet: second reason the service is part of parity (clients learn of aborts through their in-flight ping being reset).
- `docs/testing.md`: the fix-ticket pointer replaced by "the first sync lasts until the joiner is cut off from the founder; the scenario's header says why".
- `docs/architecture.md` `connectionMonitor` comment: one sentence on aborted WebSocket connections not being closed on the wire, so the far end finds out at the latest on its next ping, up to 35 s later.

## Validation

- `grep -rn "slow-link-joiner-first-sync-slower-when-relay-answers-pings" --include=*.ts --include=*.md . | grep -v node_modules | grep -v tickets/` returns nothing.
- `npx eslint` on the two `.ts` files passes.
- No tests added or run: comment-only change.

## For the reviewer

- Check the claims match the evidence recorded in the fix stage (now in git history, commit 055bf635's ticket); in particular "usually at once" reflects 6 of 7 runs, and "up to 35 s" is the monitor interval.
- The header now has two "Why ..." paragraphs back to back; consider whether they read better merged.
