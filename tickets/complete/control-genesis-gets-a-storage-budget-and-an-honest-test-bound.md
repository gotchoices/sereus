description: Founding a party costs about two seconds on disk, and a test that watched for a hang during founding gave it only fifteen, so a busy machine failed the test with nothing wrong. The real cost is now recorded and guarded by a counted budget, the time limit matches the one the product itself uses, and the review found and corrected a commit count the comments had wrong.
architecture: docs/cadre/control-replication.md#every-control-table-has-a-collection-from-genesis
files: packages/cadre-core/src/control-database.ts, packages/cadre-core/src/edge-node/config.ts, packages/cadre-core/test/control-start-storage-op-budget.spec.ts, packages/cadre-core/test/control-database-solo-warm-start.spec.ts, packages/cadre-core/test/control-database-offline-peers.spec.ts, packages/cadre-core/test/control-founding-consult-budget.spec.ts, packages/quereus-plugin-sereus/src/empty-collections.ts, docs/cadre/control-replication.md, docs/contributing/testing.md, tickets/.pre-existing-known.md
----

# Complete: control genesis gets a storage budget and an honest test bound

## What landed

Founding a party (`ControlDatabase.ensureOwnerKey` on a party with no owner key) commits an empty collection for each of the 35 control collections one at a time, then inserts the founding `OwnerKey` row. That is 36 durable commits, 1,010 raw-storage operations over 105 distinct blocks and 183 `flush` barriers, which is about 2 s on file-backed storage when the machine is idle. Nothing recorded the cost and nothing guarded it; the only thing that noticed it growing was a 15 s per-operation hang detector in `control-database-solo-warm-start.spec.ts`, which failed on loaded machines and in 2 of 3 `check:published` runs. Nothing about what the code does changed — every change records or bounds:

- **`ControlDatabase.commitEmptyControlCollections`'s NOTE** carries the 2026-11-23 figures against npm Optimystic 1.29.1 in place of the 2026-10-20 ones (750–820 ms over 32 collections), and says what the measurement found: on disk the cost is the durability barriers, not the writes — `flush` 183× was 1.4–1.5 s of a 2.1 s run while every non-barrier method together was under 40 ms. So the closing instruction keeps its shape but names the lever: fewer commits, which means the Optimystic batched-commit API requested on `blocked/report-control-genesis-commits-one-collection-at-a-time`, not a private batching path.
- **`syncInventedCollections` (`packages/quereus-plugin-sereus/src/empty-collections.ts`)** carries a `NOTE:` recording that issuing the syncs concurrently was measured and does not help (1,701/1,967/2,568 ms as one `Promise.all` against 2,004/2,103/2,170 ms sequential; the file store's write group serializes them either way), so the next reader does not re-try it.
- **`control-database-solo-warm-start.spec.ts`** has `GENESIS_TIMEOUT_MS = 60_000` for its two `ensureOwnerKey` sites, which is the bound the product allows the same owner step (`DEFAULT_OWNER_GENESIS_TIMEOUT_MS`). `OP_TIMEOUT_MS` no longer claims every operation under it answers from local rows; it names the operations that do, and says it is not for `ensureOwnerKey`. `registerSelf()` and the reads stay on `OP_TIMEOUT_MS` — one commit each, and the measurement gives no reason to move them.
- **`control-start-storage-op-budget.spec.ts`** has a third phase. It snapshots the `ensureOwnerKey` call the spec already made and budgets the operation total, the distinct-block count and the barrier count at 1,100 / 115 / 200 against the measured 1,010 / 105 / 183, with a floor at half each. `expectWithinBudget` grew a barrier arm, `expectBarriersWithinBudget`, two-sided like the operation arms. Provenance is per phase rather than per spec (`Budget.measuredOn` and `Budget.upstream`), because the genesis figures could not be taken against the linked sibling checkout at all and come from a published-dependency worktree instead.
- **`docs/cadre/control-replication.md` → "Limits and accepted tradeoffs"** carries one item: founding commits one collection at a time, which costs a couple of seconds on file-backed storage and scales with the table count, because there is no API to commit several as one transaction. The measurements stay in the source NOTE that owns them.

The review added, on top of that: a corrected commit count at every site that quoted it, a reusable rule for choosing a per-step deadline in `docs/contributing/testing.md`, and comment corrections at the two other specs that bound the same call.

## Review findings

Read the implement-stage diff (`ticket(implement): control-genesis-gets-a-storage-budget-and-an-honest-test-bound`) first, then the handoff.

### Major: the commit count was wrong at five sites, and the spec's own output said so

The comments stated genesis makes **37 durable commits and 74 fsyncs**, and built the barrier decomposition on that (74 per-commit barriers plus 109 per-block flushes). The budget spec's own printed breakdown says `saveCommitProof 36` — one commit proof per commit, 35 collections plus the owner-key insert — and `control-founding-consult-budget.spec.ts` has independently pinned `commits: 36` for the same phase since before this ticket. So 37 was an inference that the measurement contradicts, and "74 fsyncs" doubled it; the real figure is 183 barriers in total, about two per commit plus roughly one per block written (109 block writes over 105 distinct blocks).

Fixed at all five sites — the NOTE on `commitEmptyControlCollections`, both spec constants' doc comments, the `GENESIS` budget's doc comment, and the `tickets/.pre-existing-known.md` entry — with the correction tied to how a reader re-derives it (`saveCommitProof` in the printed breakdown, and the consult spec's `commits` figure). No ticket: one wrong derived number in comments, corrected in place.

### Major: a cross-spec claim the change invalidated

`control-founding-consult-budget.spec.ts`'s head comment said of the storage-budget spec "it snapshots before genesis, so genesis is budgeted only here". That stopped being true the moment this ticket gave genesis its own storage phase, and the implement pass did not touch that file. Rewritten to say what each spec now counts for the same step. Found by reading the files the change *should* have touched rather than the ones it did.

### Minor, fixed in this pass

- **`Budget.barriers`'s doc said "a start commits nothing, so its barrier count is noise".** The cold phase issues 1 commit and 5 `flush` barriers, measured in this review's runs. Reworded to the measured facts, and to say the field counts `flush` and `whenDurable` together.
- **The operation-arm failure message still began "Start duration is operations × …"** after the phase label stopped being a start, so a genesis failure read as a start failure. Made phase-neutral.
- **`DEFAULT_OWNER_GENESIS_TIMEOUT_MS`'s own doc said its step "runs control reads and one control write".** Two specs now take their bound from that constant, and on a founding start the step is 36 commits, not one write. Added that, with the pointer to the NOTE that holds the cost.
- **Two other specs bound the same `ensureOwnerKey` call with the bound this ticket diagnosed as wrong,** and `control-database-offline-peers.spec.ts`'s comment asserted that "All reads/writes answer from local rows" while doing it. Both comments corrected. The bounds themselves are deliberately left at 15 s and 30 s: every node in those two specs is `MemoryRawStorage`-backed, where genesis is 0.1–0.35 s — 40–150× inside the bound, against the 5–7× that made the file-backed spec fail. Each comment now says that, and says the file-backed bound is what a move to file storage would need.
- **Mannered prose in a new comment** ("a throughput measurement wearing a hang detector's clothes", against `AGENTS.md` → "Mannered prose"). Replaced with the direct statement, which is also shorter.
- **A one-sided ratio.** "28× the measured idle cost" used the fast end of a 2.0–2.9 s range; now 20–30×.
- **`tickets/.pre-existing-known.md`'s new blocked entry understated the symptom.** It describes the linked-sibling `NodeStorage` break as a cadre-core typecheck failure, but `@serfab/quereus-plugin-sereus` fails to build against the linked checkout for the same reason, so what a run in the main tree actually hits first is the stale-build guard refusing to start vitest on a package that cannot be rebuilt there. Confirmed by trying it. Added to the entry.

### Class-level fix rather than a point one

The root cause behind both this ticket and the fix ticket before it is a convention nobody had written down: a per-step deadline was chosen from what an idle developer machine achieves instead of from what the product allows. That had cost a month of intermittent failures, one fix ticket and this one, and the lesson existed only inside two spec-local comments. `docs/contributing/testing.md` now has **"A per-step deadline is a hang detector, not a budget"**, which states the rule, names `DEFAULT_OWNER_GENESIS_TIMEOUT_MS` as the worked example, and says the cost itself belongs in a counted budget. The warm-start spec's constant cites it. This is what stops the next spec inventing the same too-tight bound, which no point ticket would have done.

### Checked and found sound

- **The genesis counts are deterministic at this budget's tightness.** Two full runs in the same worktree gave byte-identical per-method breakdowns (1,010 / 105 / 183, `saveMetadata 218/105` and the rest identical), which is what makes a 9% ceiling safe. The background self-address publish that makes other specs flaky cannot land inside this window: it needs a membership row that genesis is in the middle of creating.
- **Both `ensureOwnerKey` sites in the warm-start spec were moved,** and the other `within`-bounded sites in the repo were checked one by one rather than assumed.
- **The 60 s bound fits every case's own `it()` timeout** in the warm-start spec (300 s each), so a genuine hang still fails with the spec's labelled message rather than vitest's generic one.
- **The barrier floor firing when batching lands is the intended behaviour,** not an oversight: `floor(183 / 2) = 91` with the ops floor at 505, and both messages name the batching ticket and say to re-measure. Accepted as the handoff proposed it — a large deliberate improvement should announce itself instead of leaving stale headroom.
- **The `syncInventedCollections` concurrency measurement is weak but honestly reported.** Three samples a side with overlapping ranges cannot show "no improvement" strictly; the NOTE prints all six numbers so the next reader can judge, and its purpose — stopping a re-try on performance grounds — holds either way. Left as written.
- **The doc bullet carries no measurements,** which is what `AGENTS.md` requires of a "Limits and accepted tradeoffs" item, and cites the open ticket by slug only.
- **The 30 s `first.stop()` bound** named in the same known-failures entry was deliberately left alone by the implement pass with nothing measured for it, and this review measured nothing for it either. It stays a load symptom; changing it would need its own measurement, not a guess.

### Not filed

No ticket. The one finding with real work behind it — genesis commits one collection at a time — already has `blocked/report-control-genesis-commits-one-collection-at-a-time` open on it, which is where these measurements belong; the site-claim grep over every open stage found nothing else touching these files. Everything else was a wrong or stale number, a comment, or a convention, all fixed in this pass. No tripwires were added beyond the two the implement pass parked (the `NOTE:`s on `commitEmptyControlCollections` and `syncInventedCollections`), because nothing conditional was found that those two do not already cover.

## Validation

The whole package is blocked in the main tree and the review ran in a published-dependency worktree, as the implement pass did. `yarn workspace @serfab/cadre-core typecheck` and every cadre-core spec fail against the linked siblings for a reason this ticket does not touch: `../optimystic/packages/db-p2p` now takes `NodeOptions.storage` as a whole `NodeStorage` value where this repo still passes a bare `IRawStorage`. That is the sibling's own landed work, reaching here with an Optimystic release and a dependency-floor bump. It is recorded in `tickets/.pre-existing-known.md` as `blocked`, so no `.pre-existing-error.md` was written.

Everything below ran in a `node scripts/check-published.mjs --skip-gates --keep --allow-dirty` worktree at 7cf5250a (Optimystic 1.29.1, Quereus 5.6.1 from the registry) with the six changed files copied in and `@serfab/config-check`, `@serfab/quereus-plugin-sereus` and `@serfab/cadre-core` built there.

| Command | Result |
| --- | --- |
| `yarn lint` (main tree; eslint + `check:docs`) | clean, 66 Markdown files OK, run twice |
| `yarn workspace @serfab/cadre-core typecheck` (worktree) | clean |
| `control-start-storage-op-budget.spec.ts` | 1 passed, twice, byte-identical counts: genesis `1010 ops over 105 distinct blocks … flush 183`, cold `65 / 38 … flush 5` |
| `control-founding-consult-budget.spec.ts` | 1 passed |
| `control-database-solo-warm-start.spec.ts` | 6 of 6 passed; genesis step 1,834–2,153 ms on `FileRawStorage`, which confirms the "about 2 s idle" figure the confirm protocol tells readers to compare against |
| `control-database-offline-peers.spec.ts` | 13 of 13 passed (19 with the warm-start file, 126 s together) |
| `control-database-genesis` + `-solo` + `-close` specs | 6 of 6 passed |

The worktree was removed through the documented path: all 12 reparse points found by walking without following them, every target verified to be inside the worktree, each unlinked with a non-recursive delete, then the directory removed. `git worktree list` shows only the repository, the scratch directory is gone, and `../optimystic` still has its 15 packages and only the three dirty files that were already there (someone else's in-flight `NodeStorage` work).

**Not run: the full `yarn workspace @serfab/cadre-core test`.** It is the better part of an hour in the worktree, past the agent-runnable bound, and cannot start at all in the main tree. The ten specs above are the ones this ticket touches or neighbours. The exposure is small — across both stages, every change to shipped code is a comment — but it is the one gap: a reviewer with the time, most easily once the Optimystic floor bump lands, should run the package suite whole.
