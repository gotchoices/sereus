description: A lone machine's control-database genesis now spends about 2 s committing its empty collections on `FileRawStorage`, against 750–820 ms when that step was last measured. The solo warm-start spec's 15 s genesis bound now trips under full-suite load in 2 of 3 `check:published` runs. Find where the time went and decide between asking Optimystic for a batched commit and accepting the cost.
files: packages/cadre-core/src/control-database.ts (`commitEmptyControlCollections` and its NOTE), packages/cadre-core/test/control-database-solo-warm-start.spec.ts, tickets/.pre-existing-known.md (the solo warm-start entry)
----

## Symptom

`control-database-solo-warm-start.spec.ts` failed in `check:published` on 2026-11-22 and 2026-11-23 (at `f637a44c` and `7891e369`) with `solo-warm-start control op ensureOwnerKey() (genesis) timed out after 15000ms`. Each time, two tests failed under the whole cadre-core suite, and the file passed alone.

The known-failures entry for this spec calls it a load one-off, and its confirm protocol says to measure `Committed N empty control collections in Nms` (`DEBUG=sereus:cadre:control-db`) on a quiet machine. Measured 2026-11-23, file alone, idle machine, 6 geneses per run:

- Against npm Optimystic 1.29.1 (the `check:published` worktree): 1,855–2,266 ms over two runs.
- Against the linked `../optimystic` (1.29.1 plus in-flight work): 1,856–2,092 ms.

The NOTE on `commitEmptyControlCollections` records 750–820 ms for the same 35 collections on `FileRawStorage`, measured 2026-10-20 and re-measured on 2026-11-14. That is roughly 25 ms per collection then, against about 57 ms now. The protocol's own threshold, near 15 s on a quiet machine, is not reached, so this is not the regression it names. But the margin under load has shrunk enough that the gate is no longer reliable.

## Likely cause, unverified

Optimystic 1.28.0's commit-proof store (`IRawStorage.saveCommitProof` / `saveProofEntry`) adds storage writes to every commit. Adopting it raised the solo strand launch budget by 30 operations (`strand-solo-write-budget.spec.ts`, 2026-11-20). On the control side the genesis step is one `sync()` per collection in sequence, so each extra write per commit is paid 35 times. Confirm by counting storage operations per genesis with `CountingRawStorage` (`packages/cadre-core/test/storage-op-counter.ts`) and comparing with Optimystic 1.27.0's count, or by timing the proof writes.

## Expected

The genesis cost is understood and recorded, and the solo warm-start spec passes reliably under the suite, without simply raising its bound.

## Direction

- If the extra cost is the proof store's per-commit writes, the NOTE already gives the plan: ask Optimystic for an API that commits several collections as one batch, the same one strand founding would use. Do not build a private batching path. Write that request as a `blocked/report-…` ticket with the measured counts, for a person to carry upstream.
- Update the NOTE's measurement to the current figures, and the solo warm-start entry in `tickets/.pre-existing-known.md`, whose idle baseline is now wrong.
- If the spec still flakes under load once the cost is known, give the reason for its bound before changing it. The bound exists to catch a hang, not to measure speed.
