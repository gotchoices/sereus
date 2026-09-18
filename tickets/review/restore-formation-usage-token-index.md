description: The invitation seat-cap index that had been removed as a workaround is back, because the database bug that made it miss rows written on another machine is fixed; a permanent two-machine test now guards uniqueness across machines, and the old "do not re-add this" warnings are retired.
files: schemas/control.qsql, packages/cadre-core/src/control-schema.ts, packages/cadre-core/src/control-database.ts, packages/integration-tests/src/harness/error-chain.ts, packages/integration-tests/src/harness/index.ts, packages/integration-tests/src/scenarios/control-cross-machine-unique-column.integration.ts, packages/integration-tests/src/scenarios/strand-formation-concurrent-redemption.integration.ts, packages/integration-tests/src/scenarios/control-concurrent-same-pk-insert.integration.ts, packages/integration-tests/src/scenarios/control-write-degraded-cohort-member.integration.ts, packages/integration-tests/src/scenarios/harness-party-control-cohort.integration.ts, docs/architecture.md, tickets/backlog/debt-composite-pk-point-lookup-unreliable-untracked.md
difficulty: medium
----

# What landed

**Phase 1 — the index is declared again.** `index FormationUsageByToken on FormationUsage (Token);` is back in both copies of the control schema (`schemas/control.qsql` and the embedded `CONTROL_SCHEMA` in `packages/cadre-core/src/control-schema.ts`; a drift spec holds the two byte-identical). The long "There WAS an index here … DO NOT re-declare it" block is replaced by a short one stating what the index serves and which scenario guards it. The `countFormationUsage` doc comment in `control-database.ts` was rewritten: it is a seek again, and it keeps a one-line `NOTE:` tripwire saying that this count IS the seat cap, that a both-views failure in `strand-formation-concurrent-redemption` means index convergence regressed, and that the scenario's assertions must not be weakened to get a green run.

**Phase 2 — a permanent cross-machine uniqueness scenario.** New file `packages/integration-tests/src/scenarios/control-cross-machine-unique-column.integration.ts`. Two mirror-image cases on `CadreControl.Strand.StampId`: one node seats a row under a chosen stamp, the test waits until the other node's table scan shows it, then the other node inserts a *different* row key under the *same* stamp and must be refused with `UNIQUE constraint failed: Strand.StampId`. Deliberately sequential — the same-tick race on a unique value is a separate, still-open defect (`blocked/concurrent-unique-value-race-commits-both-rows`), and the file header says so.

The error-chain formatter that three scenarios had copied is hoisted to `packages/integration-tests/src/harness/error-chain.ts` (exporting `errorChainText` and `describeOutcomes`) and re-exported from `harness/index.js`. The three copies in `control-concurrent-same-pk-insert`, `control-write-degraded-cohort-member` and `harness-party-control-cohort` are deleted and those files import the shared one. The one behaviour change: `control-concurrent-same-pk-insert` previously joined its chain with ` <- ` and now uses ` | ` like the other two — display only, no assertion reads the separator.

**Phase 3 — stale warnings retired.** `docs/architecture.md` no longer says the engine defect is unfixed or that re-declaring the index restores a reproducer; it now states the index is declared, names the 2026-09-17 re-measurement, and names both guarding scenarios. The `strand-formation-concurrent-redemption` header's "CURRENTLY RED" paragraph is replaced by a description of the file as the live guard. The backlog ticket `debt-composite-pk-point-lookup-unreliable-untracked` had three passages asserting the defect was upstream-and-unfixed and that the seat cap had been taken off the index permanently; all three are corrected, and its pointer to `blocked/strand-unique-index-sync-stale-revision` is updated to `fix/`.

# How to exercise it

Everything below runs from `packages/integration-tests` unless stated otherwise, and all of it needs `@serfab/cadre-core` built (`yarn workspace @serfab/cadre-core build`) — the integration suite runs compiled output.

**The seat-cap guard.** `yarn vitest run --reporter=verbose strand-formation-concurrent-redemption`. Three cases; all three must pass. Case 1 and case 2 assert BOTH machines' views of a raced redemption, which is exactly what the index staleness used to break. This is the scenario that was deterministically red from 2026-08-12 to 2026-09-17, so it is worth running several times rather than once.

**The uniqueness guard.** `yarn vitest run --reporter=verbose control-cross-machine-unique-column`. Two cases, one per direction. A quick way to confirm it is not vacuous: change the rival's insert to use a fresh stamp instead of the seated one and the case should fail on "must be REFUSED". The scenario also writes a third row from the rival after the refusal and waits for it on both views — that fence is what keeps "the refused row is nowhere" from passing against a pair that had simply stopped replicating.

**The primary-key sibling, which shares the hoisted helper.** `yarn vitest run --reporter=verbose control-concurrent-same-pk-insert`. See the gap below before judging its result.

**The schema pair.** From the repo root, `yarn workspace @serfab/cadre-core test --run control-schema-drift` — the guard that the `.qsql` file and the embedded string stay identical.

**Repo gates.** `yarn lint` and `yarn typecheck` from the root.

# Known gaps — read before reviewing

**1. The cadre-core unit suite did not run to completion, and the reviewer must run it.** A concurrent agent is working in the sibling `../optimystic` checkout: from about 18:23 on 2026-09-17 it has uncommitted, actively-changing edits under `packages/db-p2p/src/storage/`, and this repo's stale-build guard refuses to start any vitest project while that checkout's `dist` is older than its `src`. Building their tree mid-edit would risk both breaking their run and measuring against half-finished upstream code, so it was not done. What that blocks is the *rest* of the cadre-core unit suite. The drift spec the ticket specifically named did run green (18:14, against the final schema content), and was re-confirmed afterwards by an equivalent direct comparison of `schemas/control.qsql` against the built `CONTROL_SCHEMA` — matched, with the index line present. Every integration measurement below also ran before the guard started firing, against the `bbecaf28`-built optimystic dist the ticket's background describes. Re-run `yarn workspace @serfab/cadre-core test` once that checkout is rebuilt.

**2. `control-concurrent-same-pk-insert` failed once in five runs with the index declared, and zero times in five without it. This is not attributed.** The failing case is case 2 — the *control* case, two same-tick inserts under DIFFERENT `Strand.Id`s, which should both commit. One writer was rejected with `Transaction rejected by validators (2/2 rejected): … content-digest-mismatch`. That fingerprint has a named root cause and owner: `tickets/.pre-existing-known.md` (2026-09-09 entry) identifies it as a member applying a commit over a gapped base and forking the block, owned upstream by optimystic's `a-commit-over-a-gapped-base-forks-the-block` — which is the same fix this ticket's background credits for closing the index defect. So the most likely reading is a residue of that class rather than anything this change introduced, and the mechanism for a causal link is weak: both racing writes are `Strand` inserts, while the restored index is on `FormationUsage`, which has no rows in that scenario.

But "most likely" is not measured. The A/B is one failure in five against zero in five, which is far too small to separate from noise, and the ten follow-up runs intended to settle it never executed — they all died on the stale-build guard from gap 1 (their logs were empty and have been deleted). `control-concurrent-same-pk-insert` is not currently listed in `tickets/.pre-existing-known.md`, and nothing was written to `tickets/.pre-existing-error.md`, because claiming "pre-existing" on this evidence would be a statement this pass cannot support. **The reviewer should run that scenario in isolation at least ten times once the optimystic checkout is rebuilt** and either attach a rate to it or clear it.

**3. The other two scenarios whose copies of the formatter were deleted were not run.** `control-write-degraded-cohort-member` and `harness-party-control-cohort` are heavy and have their own known intermittents, and by the time the edit landed the stale-build guard was up. The change to them is mechanical — delete a local function, import the identical one — and `yarn lint` and `yarn typecheck` both pass, but neither has been executed since. `control-write-degraded-cohort-member` is the more interesting of the two because it logs through `errorChainText` in several places.

**4. The measurements this ticket restores the index on are the prior pass's, not new ones.** This pass did not re-run the five-run traced series with `collection:lineage-divergence` counting; it took the ticket's recorded result as given and confirmed the scenario is green with the index declared over three isolated runs. If the reviewer wants the revision/action-id equality re-confirmed rather than inherited, that needs the tracing run described in the implement ticket.

# What was measured here

| measurement | result |
| --- | --- |
| `strand-formation-concurrent-redemption`, index declared, 3 isolated runs | 3/3 cases passed in all three runs |
| `control-cross-machine-unique-column` (new), 3 isolated runs | 2/2 cases passed in all three runs |
| `control-concurrent-same-pk-insert`, index declared, 5 isolated runs | 4 green, 1 red (case 2, `content-digest-mismatch`) — see gap 2 |
| `control-concurrent-same-pk-insert`, index removed again, 5 isolated runs | 5 green |
| `control-schema-drift` spec | passed; re-confirmed by direct comparison of the two copies |
| `yarn lint` | exit 0 |
| `yarn typecheck` | exit 0 |
| `yarn workspace @serfab/cadre-core test` (full) | **not run** — see gap 1 |

Logs are in `tickets/.logs/restore-formation-usage-token-index.*.log` (`run{1..3}` the redemption scenario, `uniq{1..3}` the new one, `samepk-idx{1..4}` and `same-pk` the with-index series, `samepk-noidx{1..5}` the without-index series).

# Tripwires and notes recorded

- `packages/cadre-core/src/control-database.ts`, `countFormationUsage` doc comment — a `NOTE:` that this count is the seat cap, so reading it through a secondary index makes the cap depend on that index converging across machines; if `strand-formation-concurrent-redemption` fails on both views again, fix the engine or take this read off the index, and do not weaken the scenario.
- `schemas/control.qsql` / `control-schema.ts` at the index declaration — the same dependency stated at the schema site, with the dates and the guarding scenario.
- `packages/integration-tests/src/scenarios/control-cross-machine-unique-column.integration.ts` header — this file must stay sequential; widening it into a same-tick race puts it on top of an open defect.
- `packages/integration-tests/src/scenarios/harness-party-control-cohort.integration.ts` — the note that used to ask for a hoist on the third copy now records that the hoist happened and that the two `settle`/`timedSettle` wrappers are deliberately still separate.

# Review focus

The security question is whether restoring the index re-couples an authorization decision (the invitation seat cap) to a property that failed once. It does, deliberately, and the argument is that the failure now has a live guard. Worth checking: that the guard really is live (the scenario's both-views assertions are intact and reachable), that the new uniqueness scenario cannot pass vacuously, and that nothing else in the repo still tells a reader the index is forbidden.
