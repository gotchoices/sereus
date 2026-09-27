description: A machine that re-opens a shared strand after being away, over a slow relayed link, can take longer to get its data back than a machine joining for the first time, and Sereus gives up on it too early and tells the app, wrongly, that no other member was reachable. Lengthen the wait to cover the measured re-attach, fix the error text, and document the re-attach case.
architecture: docs/strands.md#joining-no-writes-before-the-first-sync
files:
  - packages/cadre-core/src/strand-first-sync-gate.ts (DEFAULT_STRAND_FIRST_SYNC_TIMEOUT_MS and its doc comment; StrandAwaitingFirstSyncError message; the module doc's "never gated" claim; StrandFirstSyncGate.open's log line)
  - packages/cadre-core/test/strand-first-sync-gate.spec.ts (line 127 matches the old message text)
  - packages/integration-tests/src/scenarios/strand-chat-participants-converge.integration.ts (line 398 matches the old message text)
  - packages/integration-tests/src/scenarios/strand-reattach-first-sync-measure.integration.ts (NEW in the fix pass, opt-in, the measurement below)
  - packages/cadre-core/src/link-budget.ts (line 84 restates 120 000 ms)
  - packages/cadre-core/src/types.ts (CadreNodeConfig.strandFirstSync doc)
  - docs/strands.md (line ~215, the addStrand bullet; the "Joining" section's claim that a machine that synced before is never gated)
  - docs/testing.md (lines 61-63: the re-measure recipe that the new scenario now implements; "Where measurements live")
  - docs/reference-app-rn.md (line 143 states "120 seconds")
  - docs/architecture.md (line 1251, "default 120 s")
  - tickets/backlog/debt-cadre-deadlines-sized-against-old-optimystic-bounds.md (its table row for this constant)
  - .release-notes.pending.md
----

# Size the first-sync wait for a re-attach, and stop the error blaming reachability

## Background

A machine that has never received a strand's data must not write to it, so `CadreNode.addStrand` withholds the strand database until the data arrives from another member (the "first-sync gate", `strand-first-sync-gate.ts`), and rejects with the retryable `StrandAwaitingFirstSyncError` after `DEFAULT_STRAND_FIRST_SYNC_TIMEOUT_MS` (120 s). That 120 s was sized from fresh joins only. On optimystic #22 a reporter's re-attach (`stopStrand`, the partner writes, one-way delay raised to 900 ms, `addStrand` again) saw the gate open at about 150 s, after `addStrand` had already rejected. A real Galaxy S7 fresh join over relay.sereus.org took 178 s.

## What the fix pass measured

New opt-in scenario `packages/integration-tests/src/scenarios/strand-reattach-first-sync-measure.integration.ts` (skipped unless `REATTACH_SYNC_MEASURE=1`; its doc comment says how to run it). Topology is the blind-relay one the fresh-join band was taken on: two relay-only `CadreNode`s on one loopback dedicated relay, closed strand, one-table schema, formation on an undelayed link, then 900 ms one-way `pipelined` delay on every dialed WebSocket (`harness/ws-latency.ts`) before the measured `addStrand`. One Windows developer machine, 2026-09-27. Times are from the `addStrand` call.

| Arm | Runs | Gate armed? | B's strand node connected | Writable | Row written while away readable |
| --- | --- | --- | --- | --- | --- |
| `fresh` (never attached) | 3 | yes, all | 11.1 s | 38.7, 38.7, 56.9 s | 60.5, 60.5, 89.6 s |
| `reattach-empty` (store minted fresh per launch, the harness and cadre default) | 4 (one with 20 missed writes) | yes, all | 11.0-11.1 s | 38.7, 42.3, 56.8, 49.5 (20 missed) s | 56.9, 60.5, 89.6, 75.0 s |
| `reattach-kept` (same raw store across the stop, like a phone with durable storage) | 8 (one with 20 missed writes) | 3 no, 5 yes | 11.0-11.1 s | ungated: 5.6 s (x3); gated: 64.1 (20 missed), 74.9, 74.9, 78.6, 78.7 s | ungated: 19.4-24.3 s; gated: 140.5-162.5 s |

What that says:

- **No re-attach path does extra work that sereus owns.** B's strand node reconnects at 11 s in every arm, the same as a fresh join, so it is not a redial. The number of missed writes does not move the result (1 vs 20 is inside the run-to-run spread), so it is not a catch-up per missed revision. No probe ever threw: the gate's probes simply read "not held yet" until the data arrived.
- **A re-attach over a kept store is bimodal, and its slow mode is about twice a fresh join.** In 5 of 8 runs B's store did not hold the `Strand.Header` collection although B had read it during its first attach. With tracing on (`DEBUG=optimystic:db-p2p:coordinator-repo*`), B's launch-time Header read is served locally as absent (`cluster-fetch:solo-self-skip` for `default/strand/Header`, no repair); in the 20-missed-write run it threw `Missing block` instead, i.e. the collection was there but a block it references was not. B stayed attached only a few seconds before `stopStrand`, so the likely cause is that replication to B had not finished; the scenario does not prove that. Syncing on top of that partial store took 64-79 s against 39-57 s from an empty one. The trace shows each block B reads routed to A as coordinator, which consults B's stale copy before answering (two link round trips per block). Writable times also repeat across separate runs to within about 50 ms (38.7 s three times, 56.9, 74.9 and 78.6 s twice each, out of 12 gated runs), which suggests a periodic timer decides when a stalled sync moves on. Both of these are inside optimystic; they are written up for optimystic in `tickets/blocked/report-reattach-over-partial-replica-to-optimystic`.
- **The reporter's ~150 s was not reproduced here.** The closest thing is the gated kept-store arm's row readable at 140-162 s; its gate opened at 64-79 s. Their harness, storage and delay injector are not known to us, so their 150 s stands as a real sample of this shape, not an outlier to discard.
- **The fresh band is wider than recorded.** One fresh run took 56.9 s, above the 35-46 s band in the constant's comment.

Logs of these runs (git-ignored, pruned automatically): `tickets/.logs/reattach-*.log`; `reattach-kept-trace2.log` holds one ungated and one gated kept-store run with optimystic tracing.

## Decision taken here: 300 s

Raise `DEFAULT_STRAND_FIRST_SYNC_TIMEOUT_MS` to `300_000`. It clears the worst sample measured here (79 s) by about 3.8x, the reporter's re-attach (~150 s) by 2x, and the real-device fresh join (178 s) by about 1.7x. 240 s was considered and rejected: it clears the device sample by only 1.35x, and the device sample did not include a re-attach.

The cost, to be stated at the constant in the existing `NOTE: accepted tradeoff` (updated, not duplicated): a strand none of whose members is reachable now takes five minutes, not two, before `addStrand` reports. The revisit condition already there still applies and is now more valuable: if the gate learns whether any other member is connected, "no peer at all" can be reported at once and this long budget is only ever spent on a sync that is in progress.

## The error message is wrong for this case

`StrandAwaitingFirstSyncError` says "no member of this strand has been reachable since this machine joined". In every measured run, and in the reporter's, a member WAS connected and the sync was progressing. The message should say the strand's data has not finished arriving from another member, that this may be a slow link or no reachable member, and name `whenStrandWritable(strandId)` next to `addStrand` and the `'strand:writable'` event as the ways to keep waiting (the reporter now uses `whenStrandWritable`, and the message does not mention it). Update the two tests that match the old text: `strand-first-sync-gate.spec.ts:127` and `strand-chat-participants-converge.integration.ts:398`. Those test the message on a strand with no peer at all, so pick a phrase that is true in both cases and match on it.

## The "never gated" claim is wrong

The gate's module doc says a machine that already holds the Header "(a restart, a hibernation resume, a founder) passes the probe on the first try and is never gated", and `docs/strands.md` repeats it. The kept-store arm shows a machine that synced before can come back without the Header collection in its store and be gated like a joiner. The gate's behaviour is right (writing into a collection this machine does not hold would fork it); the documentation should say that "has synced before" is decided by what the local store actually holds, and that a machine which left soon after its first sync may hold less than it read.

Also: `StrandFirstSyncGate.open` logs "first-sync gate opened by the caller (Header written locally)", but `publishDatabase` calls it on every ungated launch too, including a re-attach whose first probe found the Header. Make the line say what happened in both cases (for example "database published; gate not needed or force-opened").

## TODO

- Raise `DEFAULT_STRAND_FIRST_SYNC_TIMEOUT_MS` to `300_000`. Rewrite its doc comment: keep the fresh-join measurement (widen its band to include the 56.9 s run), add the re-attach table's figures in prose (both kept-store modes, the empty-store band, the reporter's ~150 s, the 178 s device join), name the new scenario as the instrument, and update the accepted-tradeoff NOTE to the five-minute cost.
- Reword `StrandAwaitingFirstSyncError`'s message as above; update the two tests that match its text.
- Correct the "never gated" claim in the module doc and `docs/strands.md`; fix `StrandFirstSyncGate.open`'s log line.
- Update every other statement of the number to point at the constant rather than restate it: `link-budget.ts:84`, `types.ts` (`CadreNodeConfig.strandFirstSync`), `docs/strands.md:215`, `docs/reference-app-rn.md:143`, `docs/architecture.md:1251`. `quereus-plugin-sereus/src/cluster-size.ts:46-48` records history against "the 120 s budget"; leave it as history or reword so it does not read as the current value.
- `docs/testing.md`: the recipe at lines 61-63 ("the shape to build") is now committed as `strand-reattach-first-sync-measure`; replace the recipe with a pointer to it and list it under "Where measurements live" beside the other opt-in scenarios. Do not copy the numbers there.
- Update the `DEFAULT_STRAND_FIRST_SYNC_TIMEOUT_MS` row in `tickets/backlog/debt-cadre-deadlines-sized-against-old-optimystic-bounds.md`.
- Add a `.release-notes.pending.md` entry: the default wait is now 300 s, why (re-attach over a slow relayed link), what it costs, and that `whenStrandWritable` / `strand:writable` are the way to keep waiting past it.
- Read the new scenario file once more with fresh eyes (it was written in the fix pass to reproduce, not reviewed); `yarn lint`, `yarn workspace @serfab/cadre-core typecheck`, `yarn workspace @serfab/integration-tests typecheck`, `yarn workspace @serfab/cadre-core build`, `yarn workspace @serfab/cadre-core test`. Re-running the scenario is optional (about 1-3 minutes per arm per run): `REATTACH_SYNC_MEASURE=1 REATTACH_ARMS=reattach-kept REATTACH_RUNS=3 yarn workspace @serfab/integration-tests exec vitest run strand-reattach-first-sync-measure`.
