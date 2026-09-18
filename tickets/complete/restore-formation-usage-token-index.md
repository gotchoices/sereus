description: The invitation seat-cap index, removed in August as a workaround for a database bug that made it miss rows written on another machine, is back now that the bug is fixed. A permanent two-machine test guards cross-machine uniqueness, and the old "do not re-add this" warnings are gone.
files: schemas/control.qsql, packages/cadre-core/src/control-schema.ts, packages/cadre-core/src/control-database.ts, packages/integration-tests/src/harness/error-chain.ts, packages/integration-tests/src/harness/index.ts, packages/integration-tests/src/scenarios/control-cross-machine-unique-column.integration.ts, packages/integration-tests/src/scenarios/strand-formation-concurrent-redemption.integration.ts, packages/integration-tests/src/scenarios/control-concurrent-same-pk-insert.integration.ts, packages/integration-tests/src/scenarios/control-write-degraded-cohort-member.integration.ts, packages/integration-tests/src/scenarios/harness-party-control-cohort.integration.ts, docs/architecture.md, tickets/backlog/debt-composite-pk-point-lookup-unreliable-untracked.md, tickets/.pre-existing-known.md
----

# Completed 2026-09-17 — `FormationUsageByToken` restored, cross-machine uniqueness guarded

## What landed

- **The index is declared again.** `index FormationUsageByToken on FormationUsage (Token);` is back in both copies of the control schema (`schemas/control.qsql` and the embedded `CONTROL_SCHEMA`, which `control-schema-drift.spec.ts` holds identical). The per-token usage reads that are the invitation seat cap (`countFormationUsage`, the `Authorized` cap subquery, `hasOutstandingFormationInvite`) are index seeks again, not scans of an append-only table. Both the schema site and `countFormationUsage` carry a `NOTE:` that the cap now depends on the index converging across machines, and they name the scenario that guards that.
- **A permanent cross-machine uniqueness scenario.** `control-cross-machine-unique-column.integration.ts` covers both directions on `Strand.StampId`: one node seats a stamp, the other node sees the row, then it tries a different row under the same stamp and must be refused with `UNIQUE constraint failed: Strand.StampId`. The refused row must then be absent on both nodes, checked behind a replication fence. The scenario is sequential on purpose. The same-tick race is a separate, still-open defect (`blocked/concurrent-unique-value-race-commits-both-rows`).
- **One shared error-chain formatter.** `errorChainText` / `describeOutcomes` moved into `packages/integration-tests/src/harness/error-chain.ts`, replacing three copies in scenario files. The only visible change is that `control-concurrent-same-pk-insert` now joins the chain with ` | ` instead of ` <- `. No assertion reads the separator.
- **Stale warnings retired** in `docs/architecture.md`, the `strand-formation-concurrent-redemption` header, the backlog ticket `debt-composite-pk-point-lookup-unreliable-untracked`, and `tickets/.pre-existing-known.md`.

## Review findings

**Read first:** the implement commit `22091760` diff, then the handoff. The handoff listed four gaps, all caused by a concurrent runner's uncommitted edits in `../optimystic`, which made the stale-build guard block every vitest run. While reviewing, that checkout was rebuilt twice by its own runner, which opened two windows where the guard passed. Every test below ran in those windows. Measurements were therefore against optimystic `bbecaf28` plus that runner's uncommitted `db-p2p` storage work (dist built at 18:39:59), not against a committed upstream.

**Tests run (all four handoff gaps closed):**

| run | result |
| --- | --- |
| `yarn lint`, `yarn typecheck` (after all review edits) | exit 0, exit 0 |
| `yarn workspace @serfab/cadre-core test` (full, gap 1) | 2197 passed, **1 failed**: `strand-solo-write-budget`. Not this change, see below |
| `control-schema-drift` spec, plus a direct comparison of the `.qsql` file with the built `CONTROL_SCHEMA`, plus a standalone Quereus parse of the schema | identical; parses |
| `strand-formation-concurrent-redemption` ×4 (with this pass's change) | 3/3 cases every run |
| `control-cross-machine-unique-column` ×4 | 2/2 cases every run |
| same, **mutated** so the rival uses a fresh stamp | both cases red with "cross-machine uniqueness is not being enforced", so the scenario can fail and does |
| `control-concurrent-same-pk-insert` ×10 in isolation (gap 2) | 30/30 cases green |
| `harness-party-control-cohort` (gap 3) | 3/3 |
| `control-write-degraded-cohort-member` (gap 3) | 7/7 |

Logs are in `tickets/.logs/restore-formation-usage-token-index.review-*.log`.

**Gap 2 (the one `content-digest-mismatch` failure in five runs): cleared, not attributed.** No recurrence in 10 isolated runs with the index declared. That makes the tally 1 failure in 15 runs. The mechanism for a link is weak: the index is on `FormationUsage`, which has no rows in that scenario. Not listed as pre-existing, because it did not reproduce.

**Minor findings, fixed in this pass:**

- **The seat-cap guard was comparing the index against itself.** With the index declared, `readUsageRows` in `strand-formation-concurrent-redemption` (`… from FormationUsage where Token = ?`) is claimed by the optimystic vtab and served by the *same* index descent as `countFormationUsage`. The assertion commented "the index-backed count agrees with the row scan" therefore compared two reads through one structure, and the failure-path diagnostic that prints both lost its purpose. `readUsageRows` now reads the whole table and filters in TypeScript, so the count is checked against a read that does not touch the index. This makes the guard stricter. An index that under-reports now fails at once on a count mismatch that names the regression, instead of passing the equality and only surfacing as a 30 s wait timeout.
- **Wrong red-duration claims.** The redemption scenario header said the file was "deterministically RED between 2026-08-12 and 2026-09-17". In fact it was green on master from 2026-08-25, when the index was removed, and failed only when the index was re-declared as a reproducer. `docs/architecture.md` and the debt ticket said "red for six weeks". All three now describe the history accurately.
- **Incomplete list presented as complete.** The uniqueness scenario header claimed to list "every `unique` column" but left out `StrandPartyKey.StampId`, `DeviceToken.StampId` and `FormationInvite.StampId`. It is now correct: every table's `StampId`, plus `Strand.MemberPrivateKey`.
- **Stale scan claim in the debt ticket.** It said `FormationUsage where Token = ? and StrandId = ?` "is served by a scan". With the index declared, that query is served by the index. Corrected.
- **`.pre-existing-known.md` still gave instructions based on the old workaround.** The 2026-08-25 "Resolved in place" entry ended with "the upstream defect is unfixed … re-add that one index line to bring the reproducer back". The delta at the top of the file supersedes it, but the sentence was still an instruction a reader could act on. It now says it is superseded and not to act on it. The delta's pointer to `implement/restore-formation-usage-token-index` now names `complete/`.

**Tripwires recorded (conditional, not tickets):**

- `schemas/control.qsql` / `control-schema.ts`, at the index declaration: a `NOTE:` on the write side. Every `FormationUsage` insert now also maintains this index. `fix/strand-unique-index-sync-stale-revision` is an open, intermittent engine failure in exactly that step. Nothing has been observed here. If joins start failing intermittently with an index-sync error, suspect this index first.
- `control-cross-machine-unique-column.integration.ts`, at the `queryStrandStampId` assertion: that read is a full-primary-key point lookup, the shape `backlog/debt-composite-pk-point-lookup-unreliable-untracked` has not settled. If that line alone flakes while the table scans stay green, treat it as evidence for that ticket, not as a uniqueness regression.

**Pre-existing failure reported:** `packages/cadre-core/test/strand-solo-write-budget.spec.ts`. The insert phase issued 99 raw-storage operations against a ceiling of 90 (baseline 80 at optimystic `03ffadc4`). It is not caused by this change: the spec counts only the strand storage scope and asserts that the control scope contributes nothing, and that assertion passed. This change touches only the control schema. The likely cause is the concurrent runner's uncommitted edits to optimystic's `db-p2p` storage layer, which is exactly what the spec counts. `.pre-existing-known.md` lists this test only for floor trips under a now-complete slug, so this ceiling trip was written to `tickets/.pre-existing-error.md` with a re-measure procedure.

**Security focus from the handoff:**

- The seat-cap guard is live and reachable: both-views assertions intact, now with the independent count check above.
- The uniqueness guard can fail: proved by the mutation run.
- No file in the repo still says the index is forbidden. Checked by grepping `FormationUsageByToken`, "re-declare" and the old slug across source, docs, schemas and open tickets. What remains is history in `complete/` archives and in `.garden-report.md`, left as archives.

**Considered, no change:**

- `describeOutcomes` has one caller but was hoisted with `errorChainText`. It is kept: it pairs naturally with the formatter, and knip is not yet a gate.
- `blocked/report-dependency-floor-bump-to-embedding-app` still names `secondary-index-seek-blind-to-sibling-rows` as a tracked failure. Left alone: it is a human's draft, and it already tells the sender to re-check that list before sending.
- The new scenario uses `execWrite` directly instead of `insertStrand`. That is required, because `insertStrand` generates its own stamp and the test must choose it. The statement and signed field order were checked against `insertStrand` line by line and match.

**Major findings: none.** No new `fix/`, `plan/` or `backlog/` ticket was warranted.

**Accepted tradeoffs:** none of the sites carried a declining `NOTE:`.

**Source hygiene:** the new scenario is 207 lines of small single-purpose helpers. `error-chain.ts` is 43 lines. `control-database.ts` is large (over 3000 lines), but that predates this change, and this change only rewrote one doc comment.
