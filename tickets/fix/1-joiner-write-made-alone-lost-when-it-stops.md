description: On a slow relayed link, a machine that has just joined a shared workspace can save its first change while connected to no other member; the save reports success, but if the machine then stops (an app sent to the background, a restart) the change never reaches anyone else. Commit the reporter's reproduction and find what Sereus itself should do about it.
architecture: docs/strands.md#joining-no-writes-before-the-first-sync
files: packages/integration-tests/src/scenarios/joiner-first-commit-over-slow-relay.integration.ts (new, from GH #44), packages/integration-tests/src/harness/ws-latency.ts, packages/integration-tests/src/scenarios/blind-relay-phone-to-phone-e2e.integration.ts, packages/cadre-core/src/strand-first-sync-gate.ts, packages/cadre-core/src/strand-instance-manager.ts (publishDatabase, buildStrandRuntime), packages/cadre-core/src/peer-join-backfill.ts, packages/cadre-core/src/cadre-node.ts (whenStrandWritable), docs/strands.md
repro: none
----
# A joiner's write made alone is lost when the joiner stops

Reported as gotchoices/sereus#44 by kjeib (Taleus, two phones over the public relay). The issue body carries a complete scenario file; `gh issue view 44 -R gotchoices/sereus` prints it. Run against v1.14.0 (`e20ef9cf`) with Optimystic 1.12.1.

## What happens

Two relay-only parties, one dedicated relay, a closed two-member strand formed by bound invitation (the `blind-relay-phone-to-phone-e2e` topology). The joiner passes its first-sync gate (`whenStrandWritable` resolves). Then its first transaction writes three tables (a seat, its key, its profile).

| Arm | Joiner strand's connections when writable | Commit | Rows on founder after joiner stops |
|---|---|---|---|
| loopback | relay + founder's strand node | 1.5 s | 0.1 s, pass |
| 100 ms pipelined latency | relay + founder's strand node | 6.9 s | 2.0 s, pass |
| 20 ms serial frame cap + event loop 70% busy | relay only | 0.1 s | never (180 s gate), 3 of 3 runs |

In the failing arm every block resolves a cohort of only the joiner (`cluster-tx:cluster-members { peerIds: [ '<joiner strand>' ] }`) and Optimystic commits locally (`commit:solo-cohort { cohortSize: 1, soleIsSelf: true, quorum: 'local' }`). If the joiner stays up, the rows reach the founder 38–83 s later once it reconnects. If it stops at once, they never do. On the phones, the founder still lacked the rows 30+ minutes later **after both apps restarted**, so a restart did not deliver them either.

## Ownership

- **Upstream (Optimystic):** a solo commit records nobody as owed a copy, so neither its under-replication drain nor anything after a restart pushes it. Optimystic has this as `../optimystic/tickets/fix/1-a-write-made-alone-while-other-members-are-known-never-reaches-them`. Tracked here by `blocked/optimystic-write-made-alone-owes-no-one`. Do not fix Optimystic from this repo (`tickets/rules/sibling-repos.md`).
- **Sereus:** three questions below. They are this ticket.

## Part 1: commit the reproduction

Add the scenario from the issue body as `packages/integration-tests/src/scenarios/joiner-first-commit-over-slow-relay.integration.ts`, as given, with its third arm as `it.fails`. Confirm it reproduces here: both control arms pass, and the third arm's `it.fails` passes (the inner assertion fails at the 180 s gate). Fix only what lint or the harness's current exports require; keep the reporter's assertions.

Cost: the failing arm takes about 4 minutes. `docs/testing.md` keeps measurement-style scenarios opt-in behind an env variable (`REATTACH_SYNC_MEASURE=1`, `RELAY_RRT_MEASURE=1`). This one is a regression reproduction, which argues for the default suite, at least for the failing arm; decide, document the choice in `docs/testing.md`, and say why in the handoff.

## Part 2: why a restart did not deliver (Sereus side)

`peer-join-backfill.ts` pushes every block in a strand's raw store to a peer the moment the strand's libp2p node connects to it, and the receiver stores it through Optimystic's monotonic `saveReplicatedBlock`. So after the joiner restarts and reconnects, its solo-committed blocks should reach the founder through Sereus's own backfill, whatever Optimystic's ledger says. The phones say they did not. Add an arm, or extend the failing arm, where the joiner stops, restarts over the same storage and reconnects, and assert the founder then holds the rows. Then find which of these holds:

- backfill never ran for that peer after the restart (for example, the peer was marked caught up from a previous runtime);
- it ran, and the founder refused or ignored the pushed revisions (a revision conflict with blocks the founder wrote meanwhile, which is a fork, not a delivery failure);
- it delivered the blocks but the founder's reads do not see them (header or index blocks missing).

The first and third are Sereus defects to fix here. The second belongs upstream, with the evidence attached to the blocked ticket.

## Part 3: should Sereus refuse or hold a write it knows would be made alone?

The reporter proposes that cadre-core, on a strand with other members, treat "no strand peer connected" as not writable: re-gate, or refuse the write with a retryable error. Research and decide which shape fits, against these constraints:

- `docs/strands.md` → "Joining: no writes before the first sync" says a restarted machine over a store that has synced before is never gated, "so offline-first writes on such a machine keep working". A blanket "no peer, no write" rule contradicts that.
- Optimystic's `docs/architecture.md` → "Supported deployment sizes": one- and two-machine groups are ordinary, so a lone survivor of a pair must still be able to write.
- Optimystic's ticket rejects refusing every self-only commit for the same reasons, and leaves "wait briefly for cohort assembly before committing alone" open as its hypothesis 3. If Optimystic adopts that wait, Sereus may need nothing here.

Narrower candidates worth measuring:

- Gate only the window right after first sync: a joiner whose strand node has never committed with another member present stays `'syncing'` (or is re-gated) while it has no strand peer connected. That covers the reported case without touching offline-first on a machine that has synced and written before.
- Surface durability instead of refusing: when Optimystic's SQL path reports a commit's durability class (`../optimystic/tickets/plan/5.5-feat-sql-commit-durability-reaches-the-app`), pass it through `StrandDatabase` so an app can keep a phone awake, or show "not yet delivered", until a `local` commit becomes `full`.

If the answer needs a product call (any shape that refuses writes a user expects to work offline), route it to `blocked/` as `decide-…` with proposed text per `tess/agent-rules/tickets.md`, and still land Parts 1 and 2.

## Out of scope, reported in the same issue

- Reads of never-written tables failing with `cohort-unreachable` on the phones (not reproduced here; upstream read path).
- `appTablesReadable` (`strand-first-sync-gate.ts`) probes the sApp's tables one at a time and restarts from the first on any failure; on the phones' 17 tables over a slow link it took 155–390 s. kjeib offered to file it separately. If you confirm it while here, park it as `backlog/feat-first-sync-probe-remembers-settled-tables`.
