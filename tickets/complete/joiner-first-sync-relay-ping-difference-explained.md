description: The slow-link test's comments and the testing guide now explain why a relay that answers liveness pings makes a joining phone's first sync slower: without pings the founder's phone silently loses its relay connection and the joiner is cut off sooner, which ends the test early along the known broken path.
architecture: docs/testing.md
files: packages/integration-tests/src/scenarios/joiner-first-commit-over-slow-relay.integration.ts, packages/integration-tests/src/harness/dedicated-relay.ts, docs/testing.md, docs/architecture.md, tickets/blocked/report-libp2p-websockets-buffered-amount.md
difficulty: easy
----

# Explanation of the slow-link first-sync difference

Comments and docs only; no behaviour or test changes (`ticket(implement): joiner-first-sync-relay-ping-difference-explained`).

- Scenario header: a "Why the joiner's first sync takes minutes there" paragraph replaces the single-run 385 s / 85 s figures and the fix-ticket pointer. It says the joiner becomes writable only once cut off from the founder, and that a relay abort leaves the aborted node with a dead connection (upstream WebSocket reset defect). With the relay answering pings, the node usually finds out at once through its in-flight ping being reset, so it reconnects and the first sync waits for a later cut-off.
- `FIRST_SYNC_MS` NOTE: the ~400 s is the cost with the relay as deployed. The note names the causes of a timeout and warns against removing the fixture's ping service.
- `dedicated-relay.ts` header: gives the second reason the ping service is part of parity with the deployed relay.
- `docs/testing.md` and `docs/architecture.md` (`connectionMonitor` comment) updated to match.

## Review findings

- **Accuracy against the fix-stage evidence (commit `ticket(fix): slow-link-joiner-first-sync-slower-when-relay-answers-pings`).** The scenario header, NOTE and relay-header claims match: "usually at once" reflects 6 of 7 runs, and the 25–32 s figure without the ping service is consistent with "until its next ping, up to 35 s". One overstatement fixed inline: `docs/architecture.md` said the far end finds out "at the latest on its next ping, up to 35s later". libp2p's monitor (`connection-monitor.js`, `repeating-task.js`) does send pings every 35 s, but the fix stage measured a dead connection held for up to 50 s. The comment now says "usually its next ping, sent every 35s (25-50s measured on a saturated link)".
- **Pointers that would go stale.** The bullet in `blocked/report-libp2p-websockets-buffered-amount` about the measured consequence pointed to this ticket, which will leave the board once archived. It now points to the scenario header paragraph. The fix ticket's slug no longer appears outside `tickets/` (grep from the ticket returns nothing).
- **Two back-to-back "Why ..." paragraphs in the scenario header.** Kept separate. The first explains why the joiner loses its strand peer, the second why that takes minutes. Each one answers its own question, and merging them would make one very long paragraph.
- **Docs rules (AGENTS.md).** The new text describes the mechanism as it is now, refers to tickets by slug and leaves out run-by-run history. No other doc refers to the old figures.
- **Tests.** None added or cut. The change is comments and docs only, and no test cheaper than the arms themselves could check the mechanism.
- **Lint.** `npx eslint` on the two `.ts` files passes. The suite was not run, because nothing executable changed.
- **Tripwires, new tickets.** None. Nothing conditional came up.
