description: The database-engine bug that made a lookup through a secondary index miss rows written on another machine is fixed upstream and verified here, so the invitation-usage index that was removed as a workaround can go back, and the "do not re-add this" warnings that point at the old ticket can be retired. A permanent two-machine test for unique columns comes with it.
prereq:
files: schemas/control.qsql, packages/cadre-core/src/control-schema.ts, packages/cadre-core/src/control-database.ts (the `countFormationUsage` doc comment), docs/architecture.md (the "That bound was broken between 2026-08-04 and 2026-08-25" paragraph and the one after it), packages/integration-tests/src/scenarios/strand-formation-concurrent-redemption.integration.ts (file header), packages/integration-tests/src/scenarios/control-concurrent-same-pk-insert.integration.ts (template for the new unique-column scenario), packages/integration-tests/src/harness/node-fixtures.ts (`bootConnectedPair`), tickets/backlog/debt-composite-pk-point-lookup-unreliable-untracked.md
difficulty: medium
----

# Background

From 2026-08-12 to 2026-09-17 this repo carried `secondary-index-seek-blind-to-sibling-rows`: on a two-machine party, a row written on one machine replicated to the other, but any read that went through a secondary index on the other machine never found it. The engine's own trace eventually showed why. The index sub-collection forked: two different write actions occupied one revision number, and the guard that refuses to move a collection backwards then made the fork permanent. The table's own collection never forked, which is why a full scan and a primary-key lookup on the same machine always found the row.

The one production read affected was the invitation seat cap. `countFormationUsage` in `control-database.ts` counts `FormationUsage` rows per token, and that count is what `enforceFormationUseCap` and `hasOutstandingFormationInvite` decide on. On 2026-08-25 the `FormationUsageByToken` index was removed from both control-schema copies (`complete/formation-usage-index-tripwire-fired`) so that read went back to a table scan, which converges. The `strand-formation-concurrent-redemption` scenario went green as a side effect, and the reproducer was switched off with it.

# What was verified on 2026-09-17

Upstream landed several changes after the 2026-08-29 capture, most directly `../optimystic` `complete/a-commit-over-a-gapped-base-forks-the-block` (`da57d4e9`): a node that missed updates used to apply the next commit over its stale copy, leaving different content under the same revision number. Such a commit is now refused and the node heals from a peer. This fix pass rebuilt nothing (optimystic's dist was already built at `bbecaf28`), re-added the index line to both schema copies, rebuilt `@serfab/cadre-core`, ran the reproducer, and removed the line again.

| measurement | result |
| --- | --- |
| `strand-formation-concurrent-redemption`, five isolated runs, tracing on | 3/3 passed in all five |
| index sub-collection revision and action id, both machines, every run | identical (`rev=2@<same>` then `rev=4@<same>`, `matched=2` on both) |
| `collection:lineage-divergence` / `collection:context-not-lowered` lines | 0 across all five runs (both fired on the first run on 2026-08-29) |
| sequential cross-machine `unique` on `Strand.StampId`, both directions, three runs | refused with `UNIQUE constraint failed: Strand.StampId` in 6 of 6 cases |
| same scenario with the index removed again | 3/3 passed |

Logs: `tickets/.logs/secondary-index-seek-blind-to-sibling-rows.run{1..5}.log` and `.uniq{1..3}.log`. The unique-column check was a throwaway scenario, deleted after the runs; its shape is described under "the unique-column scenario" below.

The result was recorded on optimystic's `tickets/blocked/secondary-index-repro-exhausted-upstream.md` (an uncommitted edit in that checkout, for their runner to pick up) and in this repo's `tickets/.pre-existing-known.md`.

# Decision: restore the index

The index was declared by `formation-unique-token-redesign` for a reason that still holds. `FormationUsage` is append-only and grows for the life of the party, and every per-token read is a full scan of it without the index: the seat-cap count, the outstanding-invite check, `isTokenUsed`, and the `Authorized` cap subquery that runs inside the schema constraint on every insert. Restoring the index puts those reads back on a seek.

The tradeoff is that the seat cap is again coupled to the engine's index convergence, which is the property that failed once. That is acceptable now because the failure has a live guard: with the index declared, `strand-formation-concurrent-redemption` is exactly the scenario that went red for six weeks, and its assertions are unchanged. If a maintainer prefers the scan for its independence from the engine, the alternative is to keep the index out and drop the retirement edits below, but then the only regression guard for this class in this repo is the new unique-column scenario, and the scan cost keeps growing.

# The unique-column scenario

Every `unique` column in the control schema is enforced through a secondary index (the `_uniq_N` sub-collections), so cross-machine uniqueness had the same exposure as the seat cap. Nothing in the suite pins it. The throwaway used in this pass is the shape to keep, as a sibling of `control-concurrent-same-pk-insert.integration.ts` and built on the same `bootConnectedPair` topology:

- Node X inserts a `CadreControl.Strand` row under a chosen `StampId`, signed with the pair's owner key over `(Id, 'o', '', StampId)` through `buildAuthorizationMessage('CadreControl.Strand', 'add', …)` and written with `execWrite`.
- Wait until node Y's table scan (`queryStrands`) shows that row, so the next step is a uniqueness decision and not a race.
- Node Y inserts a different `Id` under the same `StampId`. Assert the error chain contains `UNIQUE constraint failed: Strand.StampId`, and that neither node's view holds the refused row.
- Run both directions (A then B, B then A).

This is deliberately sequential. The same-instant race on a unique column is a different, still-open defect (`blocked/concurrent-unique-value-race-commits-both-rows`: the loser is refused but its row is stored anyway), and this scenario must not be widened into it.

# Related tickets

- `fix/strand-unique-index-sync-stale-revision` is the intermittent writer-side failure on unique-index sub-collections (`stale revision: block … at rev 2, requested rev 1`). It is a separate ticket with its own re-measurement plan; the 6 of 6 result above is evidence for it, not a closure of it.
- `blocked/concurrent-unique-value-race-commits-both-rows` is unaffected by this work.
- `backlog/debt-composite-pk-point-lookup-unreliable-untracked` quotes the old ticket as "upstream and unfixed"; correct that one sentence when passing.

# TODO

Phase 1: restore the index

- Re-add `index FormationUsageByToken on FormationUsage (Token);` after the `FormationUsage` table in both `schemas/control.qsql` and `packages/cadre-core/src/control-schema.ts` (a drift spec holds the two identical). Replace the long "There WAS an index here … DO NOT re-declare it" comment block with a short one: the index serves the per-token reads, and `strand-formation-concurrent-redemption` is the cross-machine guard for it.
- Rewrite the `countFormationUsage` doc comment in `control-database.ts`: it is a seek again; keep a one-line `NOTE:` tripwire that this count is the seat cap, so a both-views failure in `strand-formation-concurrent-redemption` means the engine's index convergence regressed and the assertions must not be weakened.
- Rebuild `@serfab/cadre-core`, then run `strand-formation-concurrent-redemption` at least three times in isolation from `packages/integration-tests`. All three cases must pass every time.

Phase 2: the permanent unique-column scenario

- Add `packages/integration-tests/src/scenarios/control-cross-machine-unique-column.integration.ts` with the shape above. Reuse `control-concurrent-same-pk-insert.integration.ts` for structure; its header notes that a third copy of the error-chain formatter should be hoisted into `src/harness/` rather than copied again, so hoist it.
- Run it three times in isolation.

Phase 3: retire the stale warnings

- `docs/architecture.md`: replace the two paragraphs that say the engine defect is unfixed and that re-declaring the index restores the reproducer. State that the index is declared, the defect was fixed upstream on 2026-09-17, and which scenarios guard it.
- `strand-formation-concurrent-redemption.integration.ts` header: drop the "CURRENTLY RED" paragraph and describe the file as the live guard for cross-machine secondary-index convergence, assertions not to be weakened.
- `tickets/backlog/debt-composite-pk-point-lookup-unreliable-untracked.md`: correct the "upstream and unfixed" sentence.
- `yarn lint`, `yarn typecheck`, and the `cadre-core` unit suite (the schema drift spec lives there) must pass.
