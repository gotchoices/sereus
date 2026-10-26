description: Sereus moves onto Optimystic 1.19.0, which sends a write spanning several tables in one round of requests and lets larger writes and blocks travel between machines. This pass measured what that changed, settled the waiting tickets it answers, wrote the release notes, and ran the release gate; one integration test that fails by timing is still with triage.
prereq: backfill-pushes-blocks-in-the-optimystic-1-19-form, hermes-text-decoding-and-cloning-fast-paths
architecture: docs/testing.md#declared-dependency-range-vs-linked-workspace-keep-them-equal
files: .release-notes.pending.md, test-harness/build-freshness.ts (`linkedRemedy`, review), docs/testing.md (sibling-build paragraph, review), packages/integration-tests/src/scenarios/message-cost-accounting.integration.ts (new 2026-10-25 block at the end of the doc comment), packages/integration-tests/src/scenarios/control-write-degraded-cohort-member.integration.ts (`SILENT_AFTER_PEND_FAILURE_MS` and the header's figures), packages/integration-tests/src/scenarios/joiner-first-commit-over-slow-relay.integration.ts (frame-cap arm NOTE), packages/cadre-core/src/strand-membership-reconciler.ts (the two-commit NOTE in `attempt`), docs/cadre-consistency.md ("Deadlines Below Cadre" stamp and new change-hold row; the silent-after-pend paragraph), docs/architecture.md ("Table change subscriptions" → What it hears), docs/strands.md (redemption bullet; reactivity "Known cost"), tickets/complete/optimystic-multi-collection-commit-costs-four-requests-per-collection.md, tickets/blocked/ (four rechecked), tickets/backlog/debt-first-sync-gate-leaves-index-trees-unfetched.md, tickets/.pre-existing-error.md, tickets/.garden-report.md
----
# Adopt Optimystic 1.19.0

No runtime code changed. The floors (`^1.19.0`) and the one API break (#52) landed in `backfill-pushes-blocks-in-the-optimystic-1-19-form`. This pass changed release notes, docs, comments, one scenario's derived bound, and the board.

## What was done

- **Upstream read.** All 14 tickets between `v1.18.0` and `v1.19.0` (`f1f774ea`). Upstream's own notes cover 2 of them. db-p2p 1.19.0 still declares `p2p-fret` ^1.2.1. The Quereus plugin still peer-requires `@quereus/quereus` ^4.20.3. FRET has no release after 1.2.1.
- **Mixed versions** (for the release notes), from upstream's tickets and source at both tags:
  - #42's batches need no version check: the receiving half shipped in 1.17.0, and a 1.18.x writer still sends one request per collection.
  - The block-push wire form changed with no version gate. A push between a 1.19.0 machine and a 1.18.x machine is answered "every block missing", in either direction, and raises no error.
  - A 1.18.x member still decodes consensus messages at 1 MiB. A batched record carries every collection of a transaction, so the 1 MiB limit applies to the transaction's total size, not to each collection.
  - Stores need no migration. Upstream's upgrade-check reads trees that older releases wrote, and a block an older release grew past 7.5 MiB stays readable, with the write rules the notes describe.
- **Release notes** (`.release-notes.pending.md`):
  - Upgrading: the cadre-core 1.18.0 + Optimystic 1.19.0 limitation, stated plainly with the `~1.18.0` pin; mixed versions; store compatibility.
  - Breaking: the `MAX_BLOCK_MESSAGE_BYTES` removal.
  - Fewer messages: #42.
  - Fixes: #52, plus the two #51 entries already there.
  - Dependencies: one line per upstream change an embedder can observe.
  - Known limitations: the 210 s silent-after-pend failure below.
- **Docs:**
  - `docs/cadre-consistency.md` → "Deadlines Below Cadre" re-stamped at 1.19.0 (`f1f774ea`). I diffed `rpc-deadline.ts`, `cluster-policy.ts`, `cluster-coordinator.ts`, `cluster/structs.ts`, `collection-factory.ts`, `collection-watch.ts` and `reactivity/config.ts` between the tags; no deadline value moved. The backstop is still TTL/3, which is 30 s on a strand node. Added one row: the change hold (`DEFAULT_CHANGE_HOLD_MS`, 10 s, a `StorageRepo` option the node does not expose), because cadre's table watches now hear a multi-collection replicated commit through it.
  - The silent-after-pend paragraph went from nine rounds/189 s to ten rounds/210 s.
  - `docs/architecture.md` → "What it hears" states the hold.
  - `docs/strands.md`: the redemption bullet no longer says the two tables "commit separately". The reactivity "Known cost" states that the idle tail read is now one read per tick.
- **Comments.**
  - The reconciler's two-commit NOTE claimed one transaction would save no `/cluster` requests. That was false from 1.19.0; the NOTE now gives the measured cost, keeps its other reasons for two commits, and drops batching from its revisit condition.
  - The frame-cap `it.fails` NOTE gained a dated line.
  - cadre-core was rebuilt after its edit.
- **Workarounds swept** (the three areas the ticket named):
  - No Sereus code works around a watch waking before index trees, the 1 MiB frame, or per-table backstop cost.
  - `strand-formation-concurrent-redemption` waits for the index (`waitForUsageCount`). It reads by pull, which the change hold does not affect, so it stays.
  - `debt-first-sync-gate-leaves-index-trees-unfetched` is not closed by the hold (the gate uses the never-held catch-all feed, and its gap is an unfetched tree). A dated note on that ticket says so.
  - The `createEmptyCollections` tripwires (cadre genesis, strand founding) are about local storage operations on a lone node, which batching does not touch, so they still stand.
  - Nothing qualified for a `debt-` removal ticket.

## Step: #42 measured

`MESSAGE_COST_MEASURE=1 yarn workspace @serfab/integration-tests exec vitest run message-cost-accounting`, all three cases, one run, 238 s (`tickets/.logs/adopt-optimystic-1-19-0.cost.log`). The full table is in the scenario's new 2026-10-25 block.

| strand case | 2026-10-20/21 | 2026-10-25 |
|---|---|---|
| settle 15 s, `cluster` B->A | 20 | 6 |
| settle 15 s, app streams | 31 | 17 |
| B first insert (`App.Seat`, one collection) | 16 sync + 4 cluster | 16 sync + 4 cluster |
| one steady write | 4 cluster + 2-3 sync | 4 cluster + 2-3 sync |
| idle 60 s | 0 app, 30 upkeep | 0 app, 30 upkeep |

- The settle window's `cluster` streams are B's `consumeInvite` and `registerMemberPeer` commits (top callers in the log), so the per-collection cost is gone.
- The cadre and invite joins also fell (27→10, 51→33 app streams), but the cadre settle window rose 16→26. Without a per-protocol breakdown for 2026-10-21, I did not attribute the rest, nor B addStrand's 7→9.

## Disposition of each blocked ticket

- `optimystic-multi-collection-commit-costs-four-requests-per-collection` (#42) → **complete**, with the numbers above.
- `optimystic-write-made-alone-owes-no-one` → **stays blocked, with a recommendation.**
  - The sixth arm now meets the ticket's own check in 4 of 4 runs: the founder's write with the joiner stopped reports `local (1/2, unconfirmed [<other strand node>])`. Before, it reported `1/1, unconfirmed []`.
  - I did not attribute this to 1.19.0. The linked upstream was past the tag, and dirty, during the runs.
  - The dated line asks a human to confirm it on a clean release build, then close the ticket and reply on #44.
- `forked-control-collection-sync-livelocks` → **stays blocked**. Neither upstream ticket it waits on landed. The dated line names them.
- `fret-maintenance-deadlines-below-the-declared-link` → **stays blocked**. FRET is unchanged at 1.2.1, and Optimystic still builds FRET with no link round trip.
- `decide-link-deadlines-from-measured-response-time` → **stays blocked, and the phone-arm series was not run.** The arm's last run took 3 464 s, and one command here may run for 10 minutes, so the series needs a human or CI. The dated section says what in 1.19.0 bears on it: no deadline moved, but #42 and the change hold did change things.
- **The frame-cap `it.fails` arm still fails** (one run, 250 s), so it stays `it.fails`.

## Gate

| run | result |
|---|---|
| `yarn build` (all workspaces), `yarn lint`, `yarn typecheck`, `yarn check:dep-ranges` | pass (lint, typecheck re-run after the last `.ts` edits) |
| cadre-core | 187 files, 2543 passed, 1 skipped |
| cadre-cli / cadre-host / cadre-provider / cadre-rn | 295 (1 skipped) / 444 (4 skipped) / 234 / 172 passed |
| quereus-plugin-sereus / reference-app-ns / -rn / -web | 157 (1 todo) / 71 / 180 / 11 passed (`config-check` has no test script) |
| root `test:*` suites (12) | all exit 0 |
| integration, in batches (`tickets/.logs/adopt-optimystic-1-19-0.it-{b0..b14}.log`; from b6 on, each log ends with an `upstream:` line naming the linked upstream commit and its count of dirty package files) | 77 files in 15 batches (b5 re-run as `b5r`): 75 green, opt-in measurement arms skipped as designed. **2 red**, both sent to triage through `tickets/.pre-existing-error.md`: `control-write-degraded-cohort-member` (stalled-read case, 2 of 2 whole-file runs) and `strand-always-on-replica-hosts-cross-party-join` (3 of 5 runs). The silent-after-pend case in the first file was red too, and is fixed (below). |
| `node scripts/smoke-published-install.mjs --skip-build` | **PASSED**, 5/5, installing the published Optimystic 1.19.0 and Quereus 4.20.3 |

**Red 1, filed through `tickets/.pre-existing-error.md`:** `control-write-degraded-cohort-member` → "a control read answers locally while a write is stalled".
- Failed in 2 of 2 whole-file runs, and passed alone at 84 s.
- The stalled write's transaction ran its pend phase twice, about 105 s each. Before each pend, the transactor re-sent the previous case's owed cancel, which had not discharged. Between the two pend phases, the coordinator re-read the blocks and re-drove the write. The write failed at 210.3 s against the scenario's 210 s hang bound.
- It is upstream behaviour, and it fails on HEAD with no edit of mine involved: the first failing run was made before I touched that file.
- The linked upstream was past `v1.19.0`, with three offline-sync tickets that change how a refused pend is classified, so whether published 1.19.0 shows it is open. The debug trace is in the error file.

**Red 2, filed through the same file:** `strand-always-on-replica-hosts-cross-party-join` failed 3 of 5 runs with "join recorded on the phone: expected []".
- This is the shape the scenario's own NOTE predicts. With `DEBUG='sereus:cadre:*'`, the always-on machine's boot-time `CadrePeer` write lost a concurrent-modification race and committed on its second attempt.
- That landed about 0.7 s after the scenario's fixed 2 s settle (`ALWAYS_ON_BOOT_WRITE_SETTLE_MS`), so its replicated change started the phone's reconcile pass, which published the join during step 1.
- It is a test-choreography problem: a fixed sleep stands in for "the boot write committed". It ran against an upstream tree with 8 uncommitted files, so I did not judge whether 1.19.0 made the race likelier.

**Fixed inline, the degraded-cohort file:** "fails in its commit when a member goes silent after answering the pend" measured 210.3–210.4 s in 3 runs, against a 189 s derivation with a 210 s ceiling. I traced it with debug, against `v1.19.0` source:
- `NetworkTransactor.commitMany` sends the batched commit; it throws after one round ("WARN: batched commit threw; committing each request on its own").
- The transactor then commits each collection on its own, three attempts each, two rounds per attempt.
- So the path is 1 + 6 + 3 cancel = 10 rounds. `SILENT_AFTER_PEND_FAILURE_MS` now counts the extra round, with a history line, and passed on the rerun. `docs/cadre-consistency.md` and the release notes state the 210 s.

## Pinned budgets

All three, measured with `--silent=false`, equal their pins exactly, so nothing was re-pinned:
- `strand-solo-write-budget`: launch 366/39, insert 78/2, select 0.
- `control-founding-consult-budget` (pinned 2026-10-25 by triage): cold 41/33/1, genesis 24/23/33, foundStrand 1/1/1 and 29/15/14, reconcile 0.
- `control-start-storage-op-budget`: cold 60/35, warm 13/3.

#42 does not reach them: two are solo-node storage counts, and the consult budget counts consults and commits, not cluster requests.

## Known gaps and observations for the reviewer

- **The linked upstream moved under the gate.** Optimystic's runner was live (as the 2026-10-25 garden entry predicted). It was already two tickets past `v1.19.0` when this pass started (`cc87a138`). During the pass it committed three more offline-sync tickets and a plan (`58cfb679` … `7cf076af`), and once rebuilt `db-core` from uncommitted work.
  - The message-cost run was at `cc87a138`. The guard passed; whether that tree had uncommitted work was not recorded.
  - The stale-build guard stopped two batches; I did not build the sibling.
  - Integration results are against that moving tree, not against 1.19.0. Only `smoke-published-install` tested the published 1.19.0.
- **Mixed-version claims in the release notes are from upstream's tickets and source, not from a run.** Nothing here runs two builds in one cohort; upstream has the same gap in its backlog (`debt-no-scenario-runs-two-builds-in-one-cohort`).
- **The reactivity "54 → 6 requests a minute"** is upstream's: the 54 was counted, the 6 is derived. Sereus has reactivity off by default.
- **Upstream backlog relevant to Sereus:**
  - `feat-a-network-watch-wake-sees-the-whole-commit`: a push wake to a machine storing none of the table can still precede its indexes. The release notes say so.
  - `debt-no-mesh-fixture-forces-two-coordinator-batches`.
- **The garden report** says Sereus is ready to release apart from the two triaged reds, which a human should weigh. One is a slower failure on a deliberately degraded cohort, the other a test whose fixed sleep loses a race; neither loses or corrupts data.

## Tests

None added. One scenario bound (`SILENT_AFTER_PEND_FAILURE_MS`) now counts the batched commit's round. It is a derived constant in an existing case, re-measured three times.

## Review findings

Read the implement diff (`ticket(implement): adopt-optimystic-1-19-0`) and the triage commit after it (`tess: triage pre-existing test failure`) before the handoff.

**Checked against upstream source, no change needed:**
- The silent-after-pend derivation: `NetworkTransactor.commitMany` at `v1.19.0` logs "batched commit threw; committing each request on its own", and the coordinator takes the batched path when a transaction has more than one collection. So 1 + 2×3 + 3 = 10 rounds of 21 s, which is 210 s, with the ceiling one round above it (231 s). The scenario constant, its doc comment, `docs/cadre-consistency.md` and the release notes agree.
- `DEFAULT_CHANGE_HOLD_MS` is 10 000 in db-p2p `storage/storage-repo.ts` at `v1.19.0`, and only a `StorageRepo` option sets it, so the new "Deadlines Below Cadre" row and the `docs/architecture.md` sentence are accurate.
- The reactivity "one read per tick" claim (`docs/strands.md`, release notes) matches upstream's `the-reactivity-backstop-check-costs-nothing-while-idle`.
- The reconciler NOTE's figures (6 vs 20) match the scenario's 2026-10-25 block. The new revisit condition is coherent now that batching has landed.
- No other doc or source still says 189 s or nine rounds (grep over `docs/` and `packages/*/src`).
- Docs touched follow the "system as it is now" rule. The dated history is kept in the scenario comments and ticket bodies, where this repo keeps measurements.

**Fixed in this pass:**
- *Red 1 was lost after triage.* The triage pass fixed red 2 but ended before it reached a conclusion on red 1: it had left its runs waiting in the background, and the runner ended the turn. It still deleted `tickets/.pre-existing-error.md`, and no ticket or `.pre-existing-known.md` entry recorded red 1. In this pass, the stall case followed by the stalled-read case **passed at 209.1 s against the 210 s limit**, so the doubled pend phase is still present on the current upstream (`81f81d69` dirty → `39f75db5` clean during the run). Re-filed in `tickets/.pre-existing-error.md` with the original trace and the new run, for the runner's triage to pick up.
- *The stale-build guard told agents to build a sibling.* For a linked sibling, the message's remedy was the bare command `Run in ../optimystic: yarn workspace … build`, which `tickets/rules/sibling-repos.md` forbids. The triage agent ran it, building `../optimystic`'s `db-core` and Quereus plugin from that repository's uncommitted work (log line ~973). This is the class-level fix (the message at the seam), not a ticket. `linkedRemedy` in `test-harness/build-freshness.ts` now says the package is a read-only sibling, not to build it from here, and to record the work as blocked; it still names the owner's command. The three spec expectations changed with it (37/37 pass). `docs/testing.md` → "When it fires because a sibling's own runner is mid-ticket" contradicted the rule ("Check before building") and now says agents never build a sibling and only a human checks before building.
- *Release-notes wording.* "Sereus 1.18.0 installed fresh today" became "installed fresh now", because "today" will be wrong by the time anyone reads the notes.
- *Garden report.* The 2026-10-26 entry now says red 2 is fixed and red 1 is re-filed.

**Verified, the triage fix for red 2:** none of triage's four runs of its own fix ran: each stopped at the stale-build guard (`triage-always-on.fix{1..4}.log`). In this pass `strand-always-on-replica-hosts-cross-party-join` passed **8 of 8** (`tickets/.logs/adopt-optimystic-1-19-0.review.always-on.r{1..8}.log`), where it had failed 3 of 5 before the fix. Read the fix: `awaitBootRecordOnPhone` waits until the phone holds a `CadrePeer` row with a later `UpdatedAt` than the vouched one, bounded by the 30 s converge budget, and describes what it waited for. It replaces the fixed sleep at the one site the scenario's NOTE named. No change.

**Gate in this pass:** `yarn lint` (exit 0), `yarn typecheck`, `yarn check:dep-ranges` pass; `test-harness/build-freshness.spec.ts` 37/37. The full integration gate was not re-run: the implement pass ran it in 15 batches, and this pass changed only the guard's message text and docs.

**Tests:** none added. The implementer added none either. The one changed scenario bound is a derived constant re-measured three times; the guard's spec expectations follow the new message.

**Tripwires:** none new.

**Not done, needs a human:**
- `blocked/optimystic-write-made-alone-owes-no-one` still needs its sixth arm confirmed on a clean release build before it closes.
- Whether the release goes out with red 1 open is a human's call. It is a slower failure on a deliberately degraded cohort that now lands either side of its hang limit, and it loses no data.
- The phone-arm series on `blocked/decide-link-deadlines-from-measured-response-time` takes longer than one agent command may run.
