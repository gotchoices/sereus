description: Saving one chat message between two parties takes 50 to 130 back-and-forth network exchanges, and even re-reading unchanged messages asks the other party several times. Over a relay to a phone that multiplies into seconds per action, and the fix belongs in the optimystic storage library, not in sereus. Also, commits sometimes fail when the joining party runs as a storage node.
files:
  - ../optimystic/packages/quereus-plugin-optimystic/src/optimystic-module.ts (live read arm refreshes each tree from the network, ~line 1215)
  - ../optimystic/packages/db-p2p/src/repo/cluster-coordinator.ts (`collectPromises`, the "Failed to get super-majority" shortfall)
  - ../optimystic/tickets/complete/1-a-two-member-cohort-refuses-a-commit-both-members-hold.md (fixed upstream after 1.0.0; see 2026-09-18 status)
  - packages/integration-tests/src/scenarios/blind-relay-phone-to-phone-e2e.integration.ts (the scenario the measurements were taken from)
repro: verified
----

# Optimystic: strand reads and commits cost dozens of round trips, which a relay turns into seconds

Blocked because the code is in `../optimystic`, a separate repository with its own ticket board. Sereus has already reduced how often it reads (`complete/0-rn-chat-poll-overlaps-slow-reads`), but not what one read or commit costs.

**Carried upstream 2026-09-17:** optimystic `tickets/fix/strand-reads-and-commits-cost-dozens-of-round-trips-over-a-relay.md` (`c5540380`). Unblock when that lands: re-measure with the scenario below and re-run the device relay chat.

**Upstream status 2026-09-17:** two fixes landed at optimystic `012573a2` (unchanged-table refresh, no push-back of commit copies). Remeasure: `complete/relay-round-trips-remeasure-optimystic-012573a2` — reads and B inserts roughly halved or better, 9 `/cluster` per commit remains the main cost, and `TornActionError` with a `storage` joiner rose to 7 of 16 concurrent pairs (2 of them saved despite reporting failure). Stays blocked on those two.

**Upstream status 2026-09-18:** optimystic main `e6ab12c6` + `30f04bd4` (after 1.0.0, not yet published) fixes the two-member `commit-not-durable: 1 of 2 … (local-executed)` refusal: when the coordinator lacks the base block, it now gets one more fetch-and-restore after a remote member reports holding the write. Its ticket is now complete (`bug-a-two-member-cohort-refuses-a-commit-both-members-hold`, `3647c95a`). Checked here at sereus `a4a1bff9` against the local link: `strand-chat-participants-converge` "writes IMMEDIATELY" passed 3 of 3 with no `commit-not-durable` or `local-executed` in the `optimystic:db-p2p:*` debug log. Upstream still open: the joiner never stores the log-tail block it reads through the host, and the "1/2 approvals" shortfall through the delaying relay proxy. Re-measure the round-trip counts and the `storage`-joiner `TornActionError` rate when those land, or when the next optimystic release ships.

## How it was measured

2026-09-17, sereus `25a5010`, optimystic `ab67fa47` (dist built). Two parties, each a single `CadreNode` with `listenAddrs: []`, connected only through the dedicated loopback relay (the `blind-relay-phone-to-phone-e2e` topology). Chat schema (`Participant`, `Message` with a foreign key to `Participant`). Party A (founder, the phone's role) on `profile: 'transaction'`. A's relay connection went through a counting TCP proxy. Each operation below ran alone, with no polling. Outbound streams were counted by wrapping `newStream` on each strand node's connections. "Exchanges" means how many times traffic on A's relay socket changed direction, roughly one request plus its response per two.

Both parties `transaction`, no added delay, sequential operations:

| Operation | Time | Exchanges on A's link | Streams opened |
|---|---|---|---|
| A inserts a message | 220–250 ms | 48–64 | 9 `/cluster`, 0–3 `/repo`, 0–2 `/db-p2p/sync`, plus FRET neighbour/ping |
| B inserts a message | 300–620 ms | 84–130 | 9 `/cluster`, 12 `/repo`, 0–20 `/db-p2p/block-transfer` |
| B reads `App.Message` (nothing changed) | 45–80 ms | 18–30 | 2–7 `/repo` from B |
| B reads `App.Participant` (nothing changed) | 32–70 ms | 16–18 | 4 `/repo` from B |
| A reads a table B just wrote to | 5–14 ms | 0 | none (B's commit had already pushed it to A) |

So the joiner (B) re-asks the founder for blocks on every read, even when nothing changed. Every commit runs 9 cluster-protocol streams plus block fetches.

With 150 ms added each way on A's link (a stand-in for a phone on Wi-Fi behind a relay; the device run's path was also tunnelled over USB), the same work took: reads 2–33 s, commits 6–45 s (chat-shaped polling that waits for the previous read, both parties `transaction`). The device run measured PC inserts at 6.5–16 s and PC reads at 18–24 s, which is the same order.

## Commit failures when the joiner is a storage node

The device's PC party ran `profile: 'storage'`. With B switched to `storage` (A still `transaction`):

- No proxy, 3 runs of sequential then concurrent inserts: 2 passed (concurrent commits 0.9–3.2 s, against 0.3 s sequential). 1 failed on the concurrent pair with `TornActionError: collection default/app/Data: action … is torn at rev 7 — its log entry is stored but block(s) … do not hold that revision, and the write cannot be finished: stale revision`.
- Through the proxy with no added delay, 4 of 4 runs failed: 3 with `Failed to get super-majority: 1/2 approvals (needed 2, 0 rejections)` on an insert, 1 with `Block default/app/Message is unavailable (cohort-unreachable)` on a read. Treat these as weaker evidence. The proxy adds an async hop, and A had a connection gater that refused direct dials to the relay's real port. Neither is present on a device.
- A `storage` joiner also generates much more traffic: one A insert set off 32 `/db-p2p/sync` and 15 `/db-p2p/block-transfer` streams from B.

The device phone ran optimystic `7cd71341`, from before `a-write-whose-log-entry-landed-alone-is-reported-saved`. There, refusals like these were retried rather than raised, which would show up as latency rather than errors. That fits the device log (no errors, minutes of delay). It has not been confirmed.

## What to carry to optimystic

- Does a live read have to go to the network for every tree on every statement? Could a read skip the refresh when a recent refresh, or a push from the cohort, already proved the tree current? The joiner's 2–9 requests per unchanged read are the cost that polling multiplies.
- Why does a commit need 9 `/cluster` streams and up to 15 `/repo` fetches in a two-member cohort, and can the round trips be batched?
- The `storage`-joiner commit failures, especially the `TornActionError` without a proxy, as evidence for `bug-a-two-member-cohort-refuses-a-commit-both-members-hold` or as a new ticket.

## Reproducing

Nothing was committed. Copy `blind-relay-phone-to-phone-e2e.integration.ts` and replace its "Data BOTH ways" section with timed inserts and reads. For the latency cases, point A's `relayAddrs` at a local TCP proxy in front of the relay's WebSocket port that delays each chunk in order. Without a gater, A soon opened a direct connection to the relay's real port and bypassed the proxy (exchange count dropped to 0), so check the counter before trusting any delayed timing. `backlog/debt-relay-scenarios-never-see-link-latency` tracks turning this into a reusable fixture.
