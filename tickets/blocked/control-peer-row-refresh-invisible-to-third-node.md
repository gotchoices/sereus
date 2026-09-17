description: When a third machine joins a group, one of the machines already there can keep showing an old copy of the newcomer's entry in the shared member directory — one with no network address — so it cannot connect to the newcomer. It holds that old copy in memory and does not look again until something else changes the directory. The code that must change is in a separate repository.
files: ../optimystic/packages/db-core/src/collection/collection.ts, ../optimystic/packages/db-core/src/transactor/transactor-source.ts, ../optimystic/packages/db-core/src/transform/cache-source.ts, ../optimystic/packages/db-p2p/src/repo/coordinator-repo.ts, packages/integration-tests/src/harness/control-trio.ts, packages/integration-tests/src/scenarios/control-cohort-edge-carries-data.integration.ts, packages/integration-tests/src/scenarios/control-cohort-three-node-isolation.integration.ts, tickets/.pre-existing-known.md
difficulty: hard
repro: verified
----

# Blocked — dependency outside this repo: node B caches a stale copy of C's directory row

**Category (b).** Everything that must change is in the sibling checkout `../optimystic` (`@optimystic/db-core`, possibly `@optimystic/db-p2p`), which Sereus runs from its built `dist`. Nothing in this repository can make the failing wait pass, and the wait must not be lengthened — it is the measurement.

**Upstream ticket (filed 2026-09-17, carries the full trace evidence):** `../optimystic/tickets/fix/1-refreshed-collection-caches-a-block-older-than-its-log-entry.md`

**Unblock condition:** that ticket lands and is released or rebuilt (`cd ../optimystic && yarn workspace @optimystic/db-core build && yarn workspace @optimystic/db-p2p build`). Then do the work under "When unblocked" below.

## What a user sees

Three machines: A (the owner), B and C. C joins last and writes its network address into its own row of the shared `CadrePeer` table (the member directory). A sees it. C sees it. B keeps reading the earlier version of that row — the one A wrote when it admitted C, which has a peer id, no address and no signature — so `resolvePeerAddrs` correctly refuses it and B cannot dial C. No error is raised anywhere. In the integration suite this is the boot-gate failure `Timeout waiting for B resolves C's signed CadrePeer address record after 45000ms`, thrown from step 6 of `bootControlTrio` (`packages/integration-tests/src/harness/control-trio.ts`).

## What is actually happening (measured 2026-09-17, optimystic 1.0.0-beta.3)

Earlier passes on this ticket blamed, in turn, a repair that could not reach quorum, a forked table history, and a freshness window armed by B's own writes. The upstream fix for the last of those landed on 2026-09-06 (`../optimystic/tickets/complete/a-reader-cannot-tell-its-view-stopped-advancing`) and is correct, but it is not on this path. A full debug trace of one failing and one passing run shows a different and simpler mechanism:

1. C's two address updates (table revisions 7 and 8) are committed by the two machines C can reach, C and A. B cannot be reached by C, so B takes no part and B's on-disk copy of the block holding the rows stays at revision 6. That is expected; a background repair is meant to catch B up.
2. B polls. Its refresh asks **A** for the end of the table's change log, correctly learns revisions 7 and 8 exist, discards its in-memory copy of the block those revisions changed, and re-reads that block.
3. For that block B asks **itself**. B's storage layer checked the block against the other machines 2 seconds earlier, so its 10-second "recently checked" window is still open and it answers from disk without asking anyone: revision 6 content, returned for a read that asked for revision 7.
4. B's table layer accepts that and keeps it in memory. The change-log entries that would have told it to discard the copy have just been used up, and the in-memory copy has no expiry.
5. Every later poll sees "change log still ends at revision 8, nothing new" and serves the row from memory. In the failing trace B fetched the block exactly twice after C's updates (0.05 s and 0.12 s after them) and never again in the remaining 43 s — 167 identical stale reads.
6. 12 s in, B's background repair corrects B's **disk** copy from revision 6 to 8. It makes no difference: B is not reading its disk.

B had everything needed to notice: the change-log entry says "revision 7 changed this block", and the answer it received says "this content is from revision 6". Nothing compares the two. That comparison is what the upstream ticket asks for.

**Why it is intermittent.** The passing trace contains the same stale self-read, for about 9 s (33 failed polls). It recovered only because in that run B also asked *itself* for the end of the change log, so it did not learn about revisions 7 and 8 until its window expired and one repair pass fixed both blocks together. The stall becomes durable only when B reads the change log from A (current) and the data block from itself (stale). Which machine B picks per block was not investigated. B recovers on the next write that touches the same block, provided its disk copy has been repaired by then; in production the periodic self-registration (every 7.5 minutes by default) would normally do that, so the production exposure is a newly joined machine being undialable from one peer for minutes, not forever. That bound is reasoned from the mechanism, not measured.

**Not a forked history.** With `optimystic:db-core:collection` logging on, the failing run printed none of the divergence or lag diagnostics; B's view of the change log matches A's and C's. The sibling ticket `blocked/forked-control-collection-sync-livelocks` was previously described here as "very probably the same defect". This measurement does not support that: that ticket's symptom is a write that cannot land; this one is a read served from a stale in-memory copy. Treat them as separate until shown otherwise.

## Measured rates, 2026-09-17

| what | result |
| --- | --- |
| `control-cohort-edge-carries-data`, single file, fresh process each time | 2 failed / 6 (1 of 1 without debug logging, 1 of 5 with) — both on the boot-gate fingerprint above |
| `bootControlTrio` repeated 12 times inside one already-warm process (throwaway probe, deleted) | 0 failed / 12 |

A further 54 probe runs and 8 scenario runs from the same session are **void**: part-way through, another agent edited a source file in `../optimystic`, which makes this repo's stale-build guard abort every run before it starts, and the loop counted anything that did not print the failure string as a pass. Anyone re-measuring should make the loop look for a positive pass marker (`Tests  1 passed`), not the absence of a failure.

`control-cohort-three-node-isolation` and `control-write-degraded-cohort-member` share the same boot helper and were not re-run today; their last recorded rates are in `tickets/.pre-existing-known.md`.

## Reproduce and diagnose

From `packages/integration-tests` (build `@serfab/cadre-core` first if the guard says it is stale):

```
DEBUG='optimystic:db-p2p:*,optimystic:db-core:collection*,sereus:cadre:node' DEBUG_COLORS=0 \
  npx vitest run src/scenarios/control-cohort-edge-carries-data.integration.ts
```

Keep the trailing `*`: the db-p2p channel names end in a peer id. In the output B is the second `Control node started with ID` line. The tell-tale is that B's `findCoordinator:start key=…` lines for the row block stop while `resolvePeerAddrs: signature verification failed … addrs=[], sig=(empty)` keeps repeating. Storage-layer lines carry no peer id; attribute them through the peer-tagged `libp2p-key-network:<peer>` and `coordinator-repo:<peer>` lines around them. The instrumentation in `packages/cadre-core/src/cadre-node.ts` that prints `updatedAt`, address count and a signature prefix on both the resolve failure and the `registerSelf` success paths is what made this readable; keep it.

The two traces this was written from are `tickets/.logs/control-peer-row-refresh.failing-trace.log` and `control-peer-row-refresh.passing-trace.log` (pruned automatically after 14 days; the upstream ticket quotes the lines that matter).

## Left alone on purpose

Control writes are allowed to commit on a reduced set of machines (`packages/quereus-plugin-sereus/src/cluster-size.ts`), which is why C's update can land without B. That is deliberate — a one-machine party must be able to write, and `control-write-while-alone-convergence.integration.ts` holds that behaviour — and it is not the defect: being left out of a commit is recoverable; caching an answer that is provably too old is not.

## When unblocked

- Rebuild the upstream packages, then run `control-cohort-edge-carries-data` and `control-cohort-three-node-isolation` alone at least ten times each, with a loop that checks for a positive pass marker.
- If the boot gate no longer fails, remove this slug's entries from `tickets/.pre-existing-known.md` and replace the `NOTE:` above step 6 in `packages/integration-tests/src/harness/control-trio.ts` with a plain statement of what the gate proves.
- If it still fails, take a trace as above and check the same three things first: which machine B read the change-log tail from, which machine it read the row block from, and whether B fetched the row block again after its last refresh.
