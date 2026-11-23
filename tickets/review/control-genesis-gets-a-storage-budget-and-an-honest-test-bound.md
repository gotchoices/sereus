description: Founding a party costs about two seconds on disk, and a test that watched for a hang during founding gave it only fifteen, so a busy machine failed the test with nothing wrong. The real cost is now recorded, the time limit matches the one the product itself uses, and a new check fails loudly the next time the cost grows.
architecture: docs/cadre/control-replication.md#every-control-table-has-a-collection-from-genesis
files: packages/cadre-core/src/control-database.ts, packages/cadre-core/test/control-start-storage-op-budget.spec.ts, packages/cadre-core/test/control-database-solo-warm-start.spec.ts, packages/quereus-plugin-sereus/src/empty-collections.ts, docs/cadre/control-replication.md, tickets/.pre-existing-known.md
----

# Review: control genesis gets a storage budget and an honest test bound

## What changed and why

Founding a party (`ControlDatabase.ensureOwnerKey` on a party with no owner key) commits an empty collection for each of the 35 control collections one at a time, then inserts the founding `OwnerKey` row. That costs 37 durable commits, 1,010 raw-storage operations over 105 distinct blocks and 183 `flush` barriers, which is 2.0–2.9 s on file-backed storage when the machine is idle. Nothing recorded that number and nothing guarded it; the only thing that noticed it growing was a 15 s per-operation hang detector in `control-database-solo-warm-start.spec.ts`, which failed on loaded machines and in 2 of 3 `check:published` runs. Five changes, all of them recording or bounding, none of them changing what the code does:

- **`ControlDatabase.commitEmptyControlCollections`'s NOTE** now carries the 2026-11-23 figures against npm Optimystic 1.29.1 in place of the 2026-10-20 ones (750–820 ms over 32 collections), and says what the measurement found: the disk cost is the barriers, not the writes — `flush` 183× was 1.4–1.5 s of a 2.1 s run while every non-barrier method together was under 40 ms, and 74 of those barriers are two per commit across the 37 commits. So the closing instruction keeps its shape but names the lever: fewer commits, which means the Optimystic batched-commit API requested on `blocked/report-control-genesis-commits-one-collection-at-a-time`, not a private batching path. The stale "median 159 ms under suite load, at most 4.6 s" sentence went with the old baseline; the phone-flash cross-reference to the NOTE in `initialize` stayed.
- **`syncInventedCollections` (`packages/quereus-plugin-sereus/src/empty-collections.ts`)** gained a `NOTE:` recording that issuing the syncs concurrently was measured and does not help (1,701/1,967/2,568 ms as one `Promise.all` against 2,004/2,103/2,170 ms sequential; the file store's write group serializes them either way), so the next reader does not re-try it.
- **`control-database-solo-warm-start.spec.ts`** gained `GENESIS_TIMEOUT_MS = 60_000` for the two `ensureOwnerKey` sites, which is the bound the product gives the same step (`DEFAULT_OWNER_GENESIS_TIMEOUT_MS`). `OP_TIMEOUT_MS`'s comment claimed every operation under it answers from local rows; it now names the operations that actually do, and says it is not for `ensureOwnerKey`. `registerSelf()` and the reads stayed on `OP_TIMEOUT_MS` — one commit each, and the measurement gives no reason to move them.
- **`control-start-storage-op-budget.spec.ts`** gained a third phase. It snapshots the `ensureOwnerKey` call the spec already made (over `MemoryRawStorage` under the counter, where it already sat after the cold snapshot) and budgets the operation total, the distinct-block count and the barrier count at 1,100 / 115 / 200 against the measured 1,010 / 105 / 183. `expectWithinBudget` grew a barrier arm, `expectBarriersWithinBudget`, two-sided like the operation arms. The spec's head comment no longer says the genesis is unbudgeted.
- **`docs/cadre/control-replication.md` → "Limits and accepted tradeoffs"** gained one item: founding commits one collection at a time, which costs a couple of seconds on file-backed storage and scales with the table count, because there is no API to commit several as one transaction. No measurements in the doc — the source NOTE owns them.

**Provenance is now per phase, not per spec.** `Budget` grew `measuredOn` and `upstream`; the cold and warm phases still carry `MEASURED_ON` / `BASELINE_UPSTREAM` (`optimystic fe7069f0`, 2026-11-03) and genesis carries its own `GENESIS_UPSTREAM` (`npm optimystic 1.29.1`, 2026-11-23). This is deliberate rather than tidy-minded: the genesis figures could not be taken against the linked checkout at all (see the next section), so folding one constant over two substrates would make the spec unable to say which phase moved against what.

## The suite could not run in this repository — everything was validated in a published-deps worktree

`yarn workspace @serfab/cadre-core typecheck` fails at HEAD, before any edit of mine, at three sites none of which this ticket touches: `src/cadre-node.ts:2614`, `src/strand-instance-manager.ts:1041` and `test/control-db-node-helpers.ts:107`. The linked `../optimystic/packages/db-p2p` now takes `NodeOptions.storage` as a whole `NodeStorage` value and this repo still passes a bare `IRawStorage`, so nothing in the package typechecks and a node that does start throws inside `prepareServingStore`. That is the sibling's own landed work (`1.1-a-node-takes-all-its-storage-as-one-value`, in its `complete/`) and it reaches here with an Optimystic release and a dependency-floor bump — not by editing a read-only sibling and not by patching around it. **This is now recorded in `tickets/.pre-existing-known.md` as `blocked`,** with the workaround, so the next ticket that needs a cadre-core spec does not re-diagnose it. No `tickets/.pre-existing-error.md` was written: the root cause is a read-only sibling's released-but-not-yet-adopted API, which a triage pass can neither fix in place nor usefully re-file.

So every command below ran in a `node scripts/check-published.mjs --skip-gates --keep --allow-dirty` worktree at 8d83da85 (Optimystic 1.29.1, Quereus 5.6.1 from the registry, no linked siblings) with the four changed source and test files copied in and `@serfab/config-check` + `@serfab/quereus-plugin-sereus` built there. **That is also the exact substrate the genesis figures came from,** which is why they reproduced byte-for-byte. The worktree was removed afterwards through the repo's own `unlinkReparsePoints` path; `git worktree list` is clean, the scratch directory is gone, and `../optimystic` has 0 dirty files and all its packages present.

## Validation run

| Command | Result |
| --- | --- |
| `yarn workspace @serfab/cadre-core typecheck` (in the worktree) | clean |
| `control-start-storage-op-budget.spec.ts` (in the worktree) | 1 passed; genesis `1010 ops over 105 distinct blocks … barriers: flush 183`, identical to the measurement |
| `control-database-solo-warm-start.spec.ts` (in the worktree) | 6 of 6 passed, 44.6 s |
| `Committed 35 empty control collections in Nms` on one warm-start case | **2021 ms**, which confirms the "about 2 s idle" figure the new confirm protocol tells readers to compare against |
| `yarn lint` (main tree; eslint + `check:docs`) | clean, 66 Markdown files OK |

**Not run: the full `yarn workspace @serfab/cadre-core test`.** In the worktree it is the better part of an hour, past the agent-runnable bound, and in the main tree it cannot start at all for the reason above. Only the two touched specs were run. That is the main gap in this handoff — if a reviewer can run the full suite (most easily once the Optimystic floor bump lands), that is the thing worth spending the time on.

## Tests

No new test file and no new `it`. The genesis phase is a third phase inside an existing budget spec, which is where the project already pins measured storage costs:

| Added | What it verifies |
| --- | --- |
| `GENESIS` phase in `control-start-storage-op-budget.spec.ts` | That founding a party still issues 1,010 raw-storage operations over 105 distinct blocks and 183 durability barriers (ceilings 1,100 / 115 / 200, floors at half each) — the named cost this ticket measured, which nothing previously guarded. |

Nothing was added for the two timeout constants or the four comments: a bound and a comment have no branching logic to pin, and a test asserting that a constant is 60,000 would test the constant.

**The genesis phase was confirmed non-vacuous by its own numbers** — it printed 1010 / 105 / 183 where the cold phase in the same run printed 65 / 38 / 5, so it is measuring the genesis and not an empty window. It was not confirmed by forcing a failure.

## Known gaps and judgement calls a reviewer should check

- **The cold phase measured 65, not the recorded 63.** Same 38 distinct blocks, comfortably inside the 73 budget. The difference is the substrate — 63 was taken at `optimystic fe7069f0`, this run at npm 1.29.1 — and **which two operations differ was not determined,** because the linked checkout could not be started that day to measure the other side. It is recorded as an observation in `COLD`'s doc comment and `ops: 63` was deliberately left alone rather than restated against a substrate it was not measured on. A reviewer may reasonably prefer that it be re-measured and updated once the floor bump lands; it is not a regression by any reading, since the budget holds and the breakdown shows one `getMetadata` per block as before.
- **The barrier arm counts every barrier, not just `flush`.** `OpSnapshot.barriers` tallies `flush` and `whenDurable`; `whenDurable` was 0 in every run, so the measured 183 is all `flush`. If something starts calling `whenDurable`, it counts against the 200 ceiling. That is deliberate — a barrier is the cost whichever method issues it — but the NOTE and the budget doc both say "`flush` barriers", so the wording is narrower than the assertion.
- **The barrier floor will fail the day the batched commit is adopted.** `floor(183 / 2) = 91`, and the ops floor at 505 fires with it. That is the intended behaviour (it makes a large, deliberate improvement announce itself rather than leave stale headroom), and both failure messages say so by name, but it does mean the Optimystic adoption ticket has to re-measure this spec rather than just pass. Worth a second opinion on whether that is the trade you want.
- **The 30 s `first.stop()` bound in the warm-start spec was not changed.** The known-failures entry lists `first.stop() timed out after 30000ms` alongside the genesis timeout under the same CPU saturation. The ticket did not ask about it and nothing was measured for it, so it stays where it was and the rewritten entry says plainly that it remains a load symptom with no measurement behind it. If a reviewer thinks that bound is wrong for the same reason the genesis one was, it needs its own measurement, not a guess.
- **Two comment-only edits landed after the last worktree run** — the `// --- Genesis: founding the party` banner line in the budget spec and the list of operations in the warm-start spec's `OP_TIMEOUT_MS` doc. `npx eslint` parses both files clean, and neither touches an expression, but neither was re-run through vitest.
- **The `.pre-existing-known.md` solo warm-start entry moved to `one-off`.** It was `in-flight` against the fix ticket this one came from; that ticket has landed, the bound is fixed and no ticket remains open on the test failure, so `one-off` ("diagnosed and resolved, follow the confirm protocol before re-reporting") is the honest state. The cost itself is still open, but on the blocked Optimystic request, which the entry's new confirm protocol points at.

## Tripwires parked in the code

- The `NOTE:` on `syncInventedCollections` is the parked concern that the sequential loop looks like the bottleneck and is not; it carries both sets of figures so the next reader does not re-try `Promise.all`.
- The `NOTE:` on `commitEmptyControlCollections` is the parked concern that this cost grows with the table count and has no API-level fix available here; it names the blocked Optimystic request as the only lever and forbids a private batching path.
- No ticket was filed. The one real finding with work behind it — that genesis commits one collection at a time — already has `blocked/report-control-genesis-commits-one-collection-at-a-time` open on it, which is where the measurements belong.
