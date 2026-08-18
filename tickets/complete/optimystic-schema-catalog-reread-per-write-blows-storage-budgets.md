description: Starting a device now reads its local storage about 30% more times than it did two days ago — roughly 440 extra reads per start — because a change in the Optimystic library we depend on re-reads the whole table catalog before every schema write. Two guard tests fail on it, and the fix has to happen in that other repository, so someone needs to decide who does it and when.
files: packages/cadre-core/test/control-start-storage-op-budget.spec.ts, packages/cadre-core/test/strand-solo-write-budget.spec.ts, ../optimystic/packages/quereus-plugin-optimystic/src/schema/schema-manager.ts, ../optimystic/packages/quereus-plugin-optimystic/src/optimystic-module.ts
repro: verified

# Control/strand start pays ~+29% raw-storage reads; the new cost is an upstream catalog re-read

## The failure

From `packages/cadre-core`:

```
npx vitest run test/control-start-storage-op-budget.spec.ts test/strand-solo-write-budget.spec.ts
```

- `control-start-storage-op-budget.spec.ts > control database start, raw-storage operation budget > stays within its operation budget on a cold start and on a warm restart`
  → `cold start issued 1983 raw-storage operations, over the budget of 1700 (measured 1541 … on 2026-08-12)`
- `strand-solo-write-budget.spec.ts > solo strand write budget > stays within its operation budgets`
  → `solo launch issued 1979 raw-storage operations, over the budget of 1780 (measured 1613 … on 2026-08-13)`

Both **distinct-block** budgets still pass (21 and 17, unchanged). Only the operation counts are over,
and the warm-restart phase is unaffected. So this is pure redundancy, not new persistent structure.

## What moved

Cold start, measured (2026-08-12) → now:

| operation | was | now | delta |
|---|---|---|---|
| `getMetadata` | 720 | 933 | +213 |
| `listPendingTransactions` | 202 | 270 | +68 |
| `listRevisions` | 196 | 264 | +68 |
| `getMaterializedBlock` | 196 | 264 | +68 |
| `getPendingTransaction` | 96 | 121 | +25 |
| `saveMaterializedBlock` | 36 | 36 | — |
| `saveMetadata` | 28 | 28 | — |
| `savePendingTransaction` / `saveRevision` / `promotePendingTransaction` | 22 each | 22 each | — |
| `listBlockIds` | 1 | 1 | — |

**Every write count is identical.** Same 22 committed transactions, same blocks written. The whole
+442 is reads, and `listRevisions` / `getMaterializedBlock` / `listPendingTransactions` move in exact
lockstep (+68) — the signature of 68 extra whole-block *restores* over the same three blocks.

`strand-solo-write-budget`'s launch phase shows the same per-method fingerprint (its `getMetadata` is
929 rather than 933, over 17 blocks not 21), because a solo strand launch brings the same control
database up. Its `insert` and `select` phases are unchanged. One cause, two specs.

## Why it is not this repo (measured, not inferred)

A detached worktree was created at `b54d2d3` — the commit that *set* the 1613/17 strand figure and
left the control figure at 1541 on 2026-08-13 — with `node_modules` junctioned to the main checkout so
the linked sibling `dist` under test was byte-identical to today's. Both specs were re-run there.

**Do not reproduce this the way it was done.** Junctioning `node_modules` into a git worktree is
destructive on Windows: `git worktree remove --force` follows the junction, out through the
`node_modules/@serfab/*` workspace symlinks, and deletes files in the *main* checkout and in every
linked sibling repository (it did, here — ~2,600 tracked files across four repos, plus every `dist/`
and this repo's whole `node_modules`; all were restored, tracked files via `git checkout-index --all`
and the rest via `yarn install` + rebuilds). If the comparison needs repeating, run `yarn install`
inside the worktree, or copy the two spec files onto an older checkout instead.

They fail with **exactly** 1983 / 1979 and byte-identical per-method breakdowns. So no Sereus commit
after the measurement moved the number; what changed is the compiled output of the `link:`ed sibling
workspaces, which advanced on 2026-08-13/14. (The earlier triage note that
`merge-verified-peer-addrs-into-control-peerstore` was not the cause is consistent with this and
remains correct — it just was not the whole story.)

The suite's own build-freshness guard passes, so this is not stale-build drift either.

## Root cause

`../optimystic`, package `@optimystic/quereus-plugin-optimystic` — the virtual-table layer through
which the control tables are stored. Its storage and repo layers (`db-p2p/src/storage/`,
`db-p2p/src/repo/`) are **unchanged** over the window; the whole diff there is new, not-yet-composed
cache files (`cached-raw-storage.ts`, `cached-store-driver.ts`, `shared-cache-pool.ts` — reachable
only from that package's own tests, so they are not in this path and are not implicated).

What did change, on 2026-08-13, is `schema/schema-manager.ts` in commit `1d09e5a`
(`schema-catalog-index-list-is-lossy`). `storeStoredSchema` became a non-destructive union: before
every schema write it now re-reads the current catalog entry through the write tree —

```ts
await tree.update();          // cache-bypassing refresh of the catalog tree
const path = await tree.find(stored.name);
…
const merged = persisted ? { ...stored, indexes: mergeIndexLists(stored.indexes, persisted.indexes) } : stored;
await tree.replace([[merged.name, [merged.name, merged]]]);
```

A cold control start writes **nine** catalog entries (8 tables + 1 index), so it now pays nine
cache-bypassing catalog-tree refreshes it did not pay before. `tree.update()` is precisely a
`listRevisions` + `getMaterializedBlock` + `listPendingTransactions` restore per block touched, which
is the +68 lockstep signature above, and each restore drags several `getMetadata` calls with it.

Two neighbouring commits in the same window push the same way and should be weighed together:

- `680376a` / `faa4d0a` (`index-maintenance-must-track-the-declared-index-set`,
  `index-reattach-leaves-rows-unindexed`, 2026-08-13) introduced `SchemaManager.getSchemaFresh` — a
  deliberately cache-bypassing read — and route every mutating path through it.
- `793aed6` (`index-backfill-scans-an-empty-collection`, 2026-08-14) added `backfillIndexTrees` /
  `hasNoRowsToBackfill`, which take further `collection.update()` refreshes on a `create index` that
  attaches. That ticket was itself a *reduction*, so it is likely a small net win, but it is on the
  same path.

Each of these is a correctness fix worth having. The cost is that correctness was bought with a
cache-bypassing re-read on a path that runs once per schema write, and a cold start is nothing but
schema writes.

## Why this is a human decision

The change is in a separate repository with its own ticket pipeline. Nothing in Sereus can remove the
re-read, and the options are genuinely upstream design calls:

- make the write-time union cheaper than a full `tree.update()` (e.g. reuse the read the caller
  already did when it is provably current, or union against the write tree's staged state);
- batch schema writes so one catalog refresh covers a whole `loadSchema`, rather than one per table;
- accept the cost and re-baseline the budgets here.

## Relationship to the existing blocked ticket

`tickets/blocked/optimystic-block-read-amplification-on-control-start.md` owns the **standing** ~1541
amplification and the "fix upstream, absorb, or change what Sereus asks" decision. This ticket is a
distinct, dated **step** on top of it with a specific identified cause and a specific upstream commit.
If the decision on that ticket is "fix upstream", this is evidence for the same call and the two
should be resolved together; if it is "absorb", this one still needs its own answer, because absorbing
1541 and absorbing 1983 are different answers and the guard cannot be re-baselined without one.

## Design constraints

- **The budgets must not simply be widened to green the suite.** Both specs say so in their own
  headers, and the count is a device-facing cost: start duration is operations × per-operation storage
  latency, which on a loaded disk or a phone is 50–90 ms per operation. Re-baselining is a legitimate
  outcome *only* as a recorded decision on this ticket.
- If the budgets are re-baselined, update **both** the measured figure and `MEASURED_ON` in
  `control-start-storage-op-budget.spec.ts` and `strand-solo-write-budget.spec.ts`. A budget without
  provenance cannot tell the next reader whether the count grew or the budget was always wrong.
- The two-sided **floor** assertions must be re-derived too — they are `Math.floor(ops / 2)` off the
  measured figure and exist to catch the storage silently leaving the path.
- Do not fix this by changing what the control database asks of Optimystic. The control tables must
  stay Optimystic-backed (`packages/cadre-core/src/control-database.ts:438-444`), which the earlier
  blocked ticket already ruled on.
- No cross-cutting obligation is triggered: no determinism edition bump, no byte-format vector, no
  golden fixture, no migration. The catalog format is unchanged — `mergeIndexLists` is a read/merge
  rule, not a new encoding.

## Reproducing after an upstream change

Re-run the two specs from `packages/cadre-core`. Both print a `[storage-op-budget]` /
`[strand-write-budget]` line carrying the full per-method breakdown under
`--reporter=verbose`, and every assertion embeds the breakdown in its own failure message, so a single
run is enough to see which method moved.

## Resolution (2026-08-17)

Resolved together with `optimystic-block-read-amplification-on-control-start` (see its Resolution
section): upstream kept the catalog-correctness re-reads but shipped a write-through raw-storage
cache that absorbs them (and the pre-existing amplification) before they reach the backend;
cadre-core wires it in `src/cached-storage.ts`. The +442-read step this ticket measured is gone
from the backend-facing counts — cold start is now 172 operations — and both budget specs were
re-baselined per this ticket's own design constraints (measurement + date updated, floors
re-derived, history preserved in the comments).
