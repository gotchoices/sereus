description: Re-measured what strand reads and inserts cost over a relay after optimystic's two fixes. Reads of unchanged tables now make at most one request (before, 2 to 7), and inserts no longer set off block pushes back to the members that just stored them. The commit failure seen with a storage-node joiner came back more often, though: 7 of 16 concurrent insert pairs failed with a torn-write error. Through the proxy, the super-majority failures seen before did not occur.
files:
  - tickets/blocked/optimystic-strand-operations-cost-dozens-of-relay-round-trips.md (the measurement this repeats)
  - packages/integration-tests/src/scenarios/blind-relay-phone-to-phone-e2e.integration.ts (topology the scenario copied)
  - ../optimystic/packages/db-core/src/collection/collection.ts, ../optimystic/packages/db-p2p/src/cluster/rebalance-monitor.ts (the two fixes)
----

# Relay round trips re-measured at optimystic 012573a2

2026-09-17, 11:20–11:41 MDT. Sereus `906a872`, clean.

## Versions

- `git -C ../optimystic log --oneline -1` printed `c08f4235 tickets: record the midday run — …`. That commit changes only `tickets/.garden-report.md`. Its parent is `012573a2`, and `012573a2..HEAD` has no source changes, so the code under test is `012573a2`. The ancestors include both fixes: `299e1499`/`012573a2` (refresh of an unchanged collection) and `065b73bc`/`3e7b2d0c` (rebalance pushing fresh blocks back).
- The newest files in the `dist` folders of db-core, db-p2p and quereus-plugin-optimystic are from 11:17, newer than `012573a2` (11:17:13). Nothing in `../optimystic`, `../quereus` or `../Fret` was rebuilt or modified. The stale-build guard passed on every run.

## Method

The method is the same as the blocked ticket's, with these details:

- A temporary scenario, deleted afterwards, copied the `blind-relay-phone-to-phone-e2e` topology: a dedicated loopback relay, and two parties that are each one `CadreNode` with `listenAddrs: []` and `enableRelay: false`. A founds a closed strand, and B forms and joins it. Both use the chat schema (`Participant`, and `Message` with a foreign key to `Participant`), signed. A is always `transaction`.
- Setup: A inserts `Participant` `pa`, B inserts `pb`, and each side waits to see the other's row. Stream counting starts after that, followed by 5 s of quiet.
- A's `relayAddrs` point at a counting TCP proxy in front of the relay's WebSocket port. A's connection gater refuses dials to the relay's real port. Each run recorded A's strand-node paths at setup and at the end. Every one was `/tcp/<proxy port>/…`, and the relay's real port never appeared, so A did not bypass the proxy. Runs marked "no proxy" skip both the proxy and the gater.
- **Outbound streams** are counted by wrapping `newStream` on every connection of each party's strand node, grouped by protocol. **Exchanges** are direction changes on A's proxied sockets, summed over A's control-node and strand-node connections.
- Each operation runs alone, then 3 s of settle time. The tables give counts **during** the operation (from its start until its promise resolves) and **after** (the 3 s settle window). Background traffic in the "after" window is listed only when it is not FRET or libp2p ping. Every window contains 2–3 `fret/ping`, 2 `fret/neighbors` and 0–2 `/ipfs/ping` per side, plus about 20–50 exchanges of that background.
- Reads are unfiltered scans: `select Id from App.<table>`. Insert pairs: "sequential" is A's insert, awaited, then B's. "Concurrent" is `Promise.allSettled` of both.

Runs, one vitest file at a time:

| Label | B profile | Proxy | Delay | Reps | Insert pairs |
|---|---|---|---|---|---|
| Config 1, 2 runs | transaction | yes | 0 | 5 each | no |
| Config 2, 3 runs | storage | no | — | 4 each | yes |
| Config 2 through the proxy, 1 run | storage | yes | 0 | 4 | yes |
| Control run for the pairs, 1 run | transaction | no | — | 4 | yes |
| Delayed, 1 run | transaction | yes | 150 ms each way | 3 | no |

The previous runs used a one-table `Data` schema for the storage-joiner runs and one concurrent pair per run. These runs use 4 pairs per run and write to `App.Message`.

## Config 1: both parties `transaction`, through the proxy, no delay (10 reps)

| Operation | Before (ab67fa47) | After (012573a2) |
|---|---|---|
| **A inserts a message**: time | 220–250 ms | 115–228 ms |
| exchanges on A's link | 48–64 | 40–51 |
| streams from A | 9 `/cluster`, 0–3 `/repo`, 0–2 `/db-p2p/sync` | 9 `/cluster`, 1–3 `/repo` |
| streams from B | — | 0–1 `/db-p2p/sync`, 0–3 `/db-p2p/block-transfer` (first insert only) |
| after, not FRET/ping | — | **27 `/db-p2p/block-transfer` from A after the first insert of every run**, then 0 |
| **B inserts a message**: time | 300–620 ms | 109–164 ms |
| exchanges | 84–130 | 44–53 |
| streams from B | 9 `/cluster`, 12 `/repo`, 0–20 `/db-p2p/block-transfer` | 9 `/cluster`, 1–4 `/repo`, 0–2 `/db-p2p/sync`, **0 block-transfer** |
| streams from A | — | none |
| **B reads unchanged `App.Message`**: time | 45–80 ms | 2–17 ms (repeat read 9–44 ms) |
| exchanges | 18–30 | 0–6 (repeat 4–12) |
| streams from B | 2–7 `/repo` | 0–1 `/repo`, 0–2 `/db-p2p/sync` |
| streams from A | — | 0–1 `/db-p2p/sync` |
| **B reads unchanged `App.Participant`**: time | 32–70 ms | 14–35 ms |
| exchanges | 16–18 | 8–15 |
| streams from B | 4 `/repo` | 1 `/repo`, 0–1 `/db-p2p/sync` |
| streams from A | — | 1–2 `/db-p2p/sync` |
| **A reads the table B just wrote to**: time | 5–14 ms | 6–40 ms |
| exchanges | 0 | 3–15 |
| streams from A | none | 1–3 `/repo` (B 0–1 `/db-p2p/sync`) |

Errors: none.

## Config 2: B `storage`, A `transaction`

### Stream counts and timings (3 runs without the proxy and 1 through it, 16 reps)

Exchange counts come from the proxied run only.

| Operation | Before (ab67fa47) | After: no proxy (12 reps) | After: through the proxy (4 reps) |
|---|---|---|---|
| A inserts a message | one A insert set off 32 `/db-p2p/sync` + 15 `/db-p2p/block-transfer` from B | 125–225 ms. A: 9 `/cluster`, 0–4 `/repo`, 0–3 sync. B: 0–2 sync during, 0–3 sync and 0–3 block-transfer after (block-transfer only after the first insert). A: 27 block-transfer after the first insert. | 123–181 ms, 49–67 exchanges. A: 9 `/cluster`, 2–4 `/repo`. B: 0–3 sync, 0–1 block-transfer during, 0–6 sync and 0–2 block-transfer after. |
| B inserts a message | — | 93–153 ms. B: 9 `/cluster`, 1–6 `/repo`, 0–2 sync. A: 0–1 sync. No block-transfer. | 121–158 ms, 49–62 exchanges. B: 9 `/cluster`, 0–4 `/repo`, 0–2 sync. A: 0–2 sync. |
| B reads unchanged `Message` | — | 7–11 ms, B 1 `/repo` (repeat read 11–35 ms, B 1 `/repo` + 0–1 sync, A 1–2 sync) | 3–28 ms, 0–11 exchanges, B 0–1 `/repo` |
| B reads unchanged `Participant` | — | 17–49 ms, B 0–1 `/repo`, 0–2 sync, A 0–2 sync | 7–39 ms, 5–15 exchanges, B 0–1 `/repo`, 0–2 sync |
| A reads the table B wrote to | — | 3–26 ms, A 0–2 `/repo` | 15–36 ms, 7–15 exchanges, A 2–3 `/repo` |
| Sequential pair (A, then B) | 0.3 s | 211–284 ms (A 94–146, B 107–142). 9 `/cluster` from each. | 225–305 ms, 93–128 exchanges |
| Concurrent pair | 0.9–3.2 s | 483–2390 ms. A 23–71 `/cluster`, 0–13 `/repo`. B 20–79 `/cluster`, 4–10 `/repo`. | 451–2271 ms, 155–375 exchanges. A 23–77 `/cluster`, 5–17 `/repo`. B 20–92 `/cluster`, 3–10 `/repo`. |

Control run with both parties `transaction` and no proxy (4 reps): concurrent pairs took 612–1550 ms, with A sending 25–45 `/cluster` and B 30–65. Every pair succeeded.

### Error tally

| Set of runs | Before (ab67fa47) | After (012573a2) |
|---|---|---|
| No proxy, `storage` joiner | 1 of 3 runs failed (1 concurrent pair per run): `TornActionError` | **5 of 12 concurrent pairs failed, in 2 of 3 runs** (run 1: 1 of 4, run 2: 4 of 4, run 3: 0 of 4). All were `TornActionError`, all on B's insert. Sequential inserts, single inserts and reads: 0 errors. |
| Through the proxy, `storage` joiner | 4 of 4 runs failed: 3 `Failed to get super-majority: 1/2 approvals`, 1 `Block … is unavailable (cohort-unreachable)` | **2 of 4 concurrent pairs failed** (reps 1 and 2): `TornActionError` on B. **No `Failed to get super-majority` and no `cohort-unreachable`.** |
| Control run, both `transaction`, no proxy | — | 0 of 4 concurrent pairs failed |
| Delayed run, both `transaction` | — | 0 errors |

All runs reached final convergence: A's and B's `Message` Id sets matched within 30 s.

Every error, verbatim:

```
c2np-r1 rep 1  B: TornActionError: collection default/app/Message: action u3N7tNUtx4Q1A4p7TPFXXQ is torn at rev 5 — its log entry is stored but block(s) uVn3u4yU51BcgqxOZ1YT8oX6CnFwIOnh1sJ9fRyiZrU do not hold that revision, and the write cannot be finished: stale revision: block uVn3u4yU51BcgqxOZ1YT8oX6CnFwIOnh1sJ9fRyiZrU at rev 6, requested rev 5 (block uVn3u4yU51BcgqxOZ1YT8oX6CnFwIOnh1sJ9fRyiZrU is at rev 6)
c2np-r2 rep 1  B: TornActionError: collection default/app/Message: action kouQv8S8kuvIMAlZPLkMEg is torn at rev 5 — its log entry is stored but block(s) Jo8WbNmOa1p0Cvx89lGYW1fJe6ioFsOb5dn1YteNNUo do not hold that revision, and the write cannot be finished: stale revision: block _ym9JFTjynZoyVwt8gyUEFu-Llonyj_q2xeP4z6UKHs at rev 6, requested rev 5 (block _ym9JFTjynZoyVwt8gyUEFu-Llonyj_q2xeP4z6UKHs is at rev 6)
c2np-r2 rep 2  B: TornActionError: collection default/app/Message: action i83AZKbqTVL6VWyAyaMz0g is torn at rev 11 — its log entry is stored but block(s) Jo8WbNmOa1p0Cvx89lGYW1fJe6ioFsOb5dn1YteNNUo do not hold that revision, and the write cannot be finished: stale revision: block Jo8WbNmOa1p0Cvx89lGYW1fJe6ioFsOb5dn1YteNNUo at rev 12, requested rev 11 (block Jo8WbNmOa1p0Cvx89lGYW1fJe6ioFsOb5dn1YteNNUo is at rev 12)
c2np-r2 rep 3  B: TornActionError: collection default/app/Message: action Vg8_-crz-51aKbn86LLmGA is torn at rev 17 — its log entry is stored but block(s) Jo8WbNmOa1p0Cvx89lGYW1fJe6ioFsOb5dn1YteNNUo do not hold that revision, and the write cannot be finished: stale revision: block Jo8WbNmOa1p0Cvx89lGYW1fJe6ioFsOb5dn1YteNNUo at rev 18, requested rev 17 (block Jo8WbNmOa1p0Cvx89lGYW1fJe6ioFsOb5dn1YteNNUo is at rev 18)
c2np-r2 rep 4  B: TornActionError: collection default/app/Message: action qemF-bEXEkciMqDNX-5bAg is torn at rev 23 — its log entry is stored but block(s) Jo8WbNmOa1p0Cvx89lGYW1fJe6ioFsOb5dn1YteNNUo do not hold that revision, and the write cannot be finished: stale revision: block Jo8WbNmOa1p0Cvx89lGYW1fJe6ioFsOb5dn1YteNNUo at rev 24, requested rev 23 (block Jo8WbNmOa1p0Cvx89lGYW1fJe6ioFsOb5dn1YteNNUo is at rev 24)
c2px-r1 rep 1  B: TornActionError: collection default/app/Message: action VGUe1uS4h4zaeHrKqeXFcQ is torn at rev 5 — its log entry is stored but block(s) ZNHaRIzZdKTc5qn_JJSpb9j3ep_Y62BOdrZMZrL1p28 do not hold that revision, and the write cannot be finished: stale revision: block ZNHaRIzZdKTc5qn_JJSpb9j3ep_Y62BOdrZMZrL1p28 at rev 6, requested rev 5 (block ZNHaRIzZdKTc5qn_JJSpb9j3ep_Y62BOdrZMZrL1p28 is at rev 6)
c2px-r1 rep 2  B: TornActionError: collection default/app/Message: action oqAueRY_Ic4BkpjAbqK2xg is torn at rev 11 — its log entry is stored but block(s) ZNHaRIzZdKTc5qn_JJSpb9j3ep_Y62BOdrZMZrL1p28 do not hold that revision, and the write cannot be finished: stale revision: block ZNHaRIzZdKTc5qn_JJSpb9j3ep_Y62BOdrZMZrL1p28 at rev 12, requested rev 11 (block ZNHaRIzZdKTc5qn_JJSpb9j3ep_Y62BOdrZMZrL1p28 is at rev 12)
```

The error is inconsistent about whether the write was saved. The message count A read at the start of the next rep shows the outcome. The torn row was **absent** for c2np-r1 rep 1, c2np-r2 rep 1, c2px-r1 rep 1 and c2px-r1 rep 2. It was **present** for c2np-r2 reps 2 and 3: the counts went 7 → 13 → 19, where +5 would mean the row was lost. So a write reported as failed sometimes lands anyway. Rep 4 in each run had no later read to check. In every failure the "stale revision" was exactly one revision ahead of the requested one (5→6, 11→12, 17→18, 23→24), which fits both writers taking the same revision.

## Delayed run: 150 ms each way on A's link, both `transaction`, 3 reps (timings)

The proxy counted 2604 exchanges and 3.9 MB over its 2 connections, and A's strand paths used only the proxy port, so A did not bypass the proxy.

| Operation | Time | Exchanges |
|---|---|---|
| A inserts a message | 8.9–9.5 s | 82–134 |
| B inserts a message | 10.1 s, 10.2 s, **37.9 s** (the first rep: B sent 36 `/cluster` and 12 `/repo`, 385 exchanges) | 85–385 |
| A reads the table B wrote to | 1.9–2.5 s | 18–24 |
| B reads unchanged `Message` | 0.63 s, 0.64 s, **5.6 s** (first rep, 76 exchanges) | 5–76 |
| B reads unchanged `Participant` | 1.26–1.29 s | 8–11 |
| B reads unchanged `Message` again | 1.28–1.30 s | 8–20 |

Before (chat-shaped polling rather than one operation at a time, so not directly comparable): reads 2–33 s, commits 6–45 s. Reads are now about 1 s, but an insert still costs about 9–10 s at a 300 ms round trip. That is the 9 `/cluster` streams and their exchanges, which neither fix touched.

## Also seen

- **27 `/db-p2p/block-transfer` from A after the first `Message` insert of every run with no delay** (7 of 7 runs plus a smoke run, always exactly 27, whichever profile B used; not seen in the delayed run), and 1–3 from B at the same point. It never happened after later inserts. It is probably the first placement of the newly created `Message` collection's blocks. It is larger than the "one fetch+push" leftover described in the fix.
- **One burst of exactly 45 `/cluster` streams (5 commits' worth), with 16–42 `/repo`, from B about 25–30 s after the join**, once per run in all 7 runs with no delay, whichever profile and operation. In config 1 it landed after rep 2's B insert. In the runs with pairs it landed after rep 1's concurrent pair. Its fixed timing points to a periodic sereus or cadre job committing on B, not to the operation being measured. Not investigated. In the runs with pairs it overlapped the concurrent pair and may have contributed to a first-rep `TornActionError`, but run 2 also failed in reps 2–4, well after it.
- `/db-p2p/sync` streams (0–2 per side) now show up during reads and inserts on both sides where the earlier table listed none for reads. They are small, and they probably come from the other party's handling of the request.

## Conclusions

- **Fix 1 (refresh of an unchanged table): confirmed.** An unchanged read makes 0–1 `/repo` requests from B, down from 2–7, and 0–15 exchanges on A's link, down from 16–30. Behind 150 ms each way, a read takes about 0.6–1.3 s. There is one side effect: A reading a table B just wrote to now makes 1–3 `/repo` requests (3–15 exchanges, about 2 s when delayed) where before it made none.
- **Fix 2 (commit copies pushed back): confirmed.** After the first insert, B's inserts open no `/db-p2p/block-transfer` streams (before: 0–20), and B's `/repo` fetches fell from 12 to 1–4. A `storage` joiner no longer reacts to an A insert with 32 sync and 15 block-transfer streams: at most 0–6 sync and 0–3 block-transfer. B's inserts are 2–4× faster (109–164 ms, before 300–620 ms). The first-insert push of 27 block-transfer streams from A is still there.
- **Commits still open 9 `/cluster` streams**, as expected. On a delayed link that is now the main cost (about 9–10 s per insert at a 300 ms round trip).
- **`TornActionError` recurred, and more often.** 7 of 16 concurrent pairs with a `storage` joiner failed: 5 of 12 without the proxy (2 of 3 runs) and 2 of 4 through the proxy. Each time it was B's insert, with the block one revision ahead. None of the 4 concurrent pairs with a `transaction` joiner failed. Some writes reported as torn were saved anyway. Through the proxy, the earlier `Failed to get super-majority` and `cohort-unreachable` failures did not recur. The blocked ticket's third question, `bug-a-two-member-cohort-refuses-a-commit-both-members-hold` or a new ticket, is still open, and the reproduction is now reliable: 4 back-to-back concurrent pairs with a storage joiner.
