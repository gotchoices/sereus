description: Sereus now declares Optimystic 1.17.0 (with its peer-discovery library FRET 1.2.1) and Quereus 4.20.3 as the oldest versions it accepts; this records what that upgrade changed, the measurements showing which fixes took effect, and which waiting tickets it closed.
architecture: docs/testing.md#declared-dependency-range-vs-linked-workspace-keep-them-equal
files: packages/cadre-core/src/control-schema-version.ts (review: stale comments), packages/cadre-core/test/control-start-storage-op-budget.spec.ts (review: cold re-pin), packages/*/package.json and yarn.lock (`@optimystic/*` ^1.17.0, `@quereus/quereus` ^4.20.3), .release-notes.pending.md, packages/integration-tests/src/scenarios/message-cost-accounting.integration.ts (new 2026-10-20 block at the end of the doc comment), docs/cadre-consistency.md ("Deadlines Below Cadre" rows, the ~52 failed-cancel paragraph), docs/architecture.md (~72, ~2374), packages/cadre-core/src/types.ts (`DEFAULT_CONNECTION_MONITOR` comment), packages/cadre-core/src/strand-formation-protocol.ts (~895-901), packages/integration-tests/src/scenarios/joiner-first-commit-over-slow-relay.integration.ts (header, `FIRST_SYNC_MS` NOTE, third arm's comment), packages/integration-tests/src/scenarios/strand-workload-on-a-phone-link.integration.ts, packages/integration-tests/src/scenarios/control-write-degraded-cohort-member.integration.ts (header), ops/docker/libp2p-infra/src/main.ts (~102), tickets/complete/ (six tickets moved there), tickets/blocked/ (three rewritten, one new), tickets/implement/degraded-cohort-covers-a-member-silent-after-the-pend.md, tickets/.pre-existing-error.md, tickets/.pre-existing-known.md
----
# Adopt Optimystic 1.17.0

No runtime code changed. The workspace already ran this code through the root `link:` resolutions; what changed is the declared floors, the release notes, docs and comments that described the pre-1.16.0 behaviour, and the board.

## What was done

- **Floors.** `yarn upgrade:optimystic` moved every `@optimystic/*` range from ^1.15.0 to ^1.17.0 in eight packages; `check:dep-ranges` passes. No package declares `p2p-fret`. `yarn upgrade:quereus` also moved `@quereus/quereus` from ^4.20.1 to ^4.20.3 in six packages: `@optimystic/quereus-plugin-optimystic` 1.17.0 peer-requires ^4.20.3, and the catalog-only ticket asked for it.
- **Release notes**: a Dependencies section for 1.16.0 and 1.17.0, and one known limitation (FRET 1.2.0's dead-verdict grace). They say #42 does not reduce write requests yet.
- **`message-cost-accounting`**: a new dated block after the existing ones (none overwritten), with the table and one line per upstream change.
- **`docs/cadre-consistency.md` → "Deadlines Below Cadre"**, re-stamped at 1.17.0 (`a22eb133`) and p2p-fret 1.2.1 (`439b85e`). Rows changed: ping handler (60 000 ms, derived), read-repair window (silent-consult hold), read retry and coordinator retry (wait one round trip, doubling, or the failed request's outstanding time). New row: FRET's dead-verdict grace. To recheck the others I diffed `rpc-deadline.ts`, `cluster-policy.ts`, `cluster-coordinator.ts`, `cluster/structs.ts` and `collection-factory.ts` between `v1.15.0` and `v1.17.0`: no deadline value changed except the new retry base and the ping handler. FRET's maintenance constants are unchanged at 1.2.1.
- **Comments and docs** that named a moved ticket under `blocked/`, or described the 10 s ping handler or the no-wait retries as current, now describe 1.17.0. `cadre-core` was rebuilt after its two comment-only edits so the stale-build guard stays green.

## Step 3: before and after

`MESSAGE_COST_MEASURE=1 yarn workspace @serfab/integration-tests exec vitest run message-cost-accounting`, all three cases, one run, 248 s (log `tickets/.logs/adopt-optimystic-1-17-0.cost.log`). The 2026-10-19 baseline already ran 1.16.0's code (`f22a8cb7`), so only #39, #42, #43 and Fret#3 are new against it. Many Sereus changes also landed between the two, so the attribution in the last column comes from earlier logs in `tickets/.logs/` that bracket each upstream landing.

| what | 2026-10-19 | 2026-10-20 | moved by |
|---|---|---|---|
| strand, B addStrand `sync` B→A | 25 | 2 | #39: 25 → 13 between the 23:28 and 00:46 runs, when both #39 changes landed and nothing on Sereus's attach path did; then `join-backfill-pushes-once-and-is-waited-for` 13 → 2 |
| strand, B first insert | 20 sync + 4 cluster | 16 sync + 4 cluster | `cluster` unchanged (#42 is groundwork only) |
| strand, settle 15 s, B→A | 38 sync + 20 cluster | 17 sync + 20 cluster | `cluster` unchanged |
| strand, idle 60 s | 56 upkeep; 20 FRET pings + 12 failed (23:28 run) | 30 upkeep; 6 FRET pings, 0 failed | Fret#3 |
| cadre, idle 60 s | 103 sync | 0 sync (32 block-transfer, the drain) | Sereus's change-driven reads (2026-10-20 block); #43 cannot show here |
| invite, idle 60 s | 134 sync | 0 sync (28 block-transfer) | the same |

The cadre and invite rows equal `cohort-join-catch-up-runs-once-per-node`'s runs from 12:55 that day, as expected: the linked code is the same.

## Disposition of each blocked ticket

- `optimystic-catalog-only-alter-table` → **complete** (1.16.0). Its resolution lists three facts of the shipped form, also noted on `implement/control-store-migrates-on-start`, which is now runnable (not started).
- `optimystic-attach-fetches-each-block-twice` (#39) → **complete**, measured 25 → 13 as above.
- `optimystic-background-consults-cost-a-request-per-block` (#43) → **complete**: all three items shipped. The ticket says plainly that this instrument cannot show the effect, and names upstream's specs.
- `fret-maintenance-probes-peers-off-its-ring` (Fret#3) → **complete**, measured as above. Its item 3 (`dcutr`, still 9 streams per join) is split into the new `blocked/optimystic-dcutr-between-relay-only-peers`, as that ticket said to do. Item 2 (FRET's idle cap) is not filed; the reason is in the ticket.
- `optimystic-retries-do-not-back-off` (#48) → **complete**. Phone arm, one run: 15 coordinator retries, 9 waiting 3.5 s and 6 waiting the failed request's outstanding time (6.1–14.9 s); 110 consult holds of 3.5 s, 7 s and 14 s.
- `optimystic-ping-handler-timeout-below-the-monitor-deadline` → **complete**. On the frame-cap arm, 8 of 14 connection aborts are now the pinging side's own 30 s deadline; the arm stays `it.fails`, as the ticket predicted.
- `optimystic-multi-collection-commit-costs-four-requests-per-collection` (#42) → **stays blocked**. Its status says what shipped (`pendMany`/`commitMany`), the unchanged counts, and that it now waits on upstream `blocked/a-transaction-pends-and-commits-its-collections-together`.
- `optimystic-failed-cancel-strands-the-writers-pend-record` → fixed upstream in **1.14.0** (`ed98ef15`), but the ticket had stayed in `blocked/`. The Sereus-side work it listed (a scenario case, removing the header paragraph) is now `implement/degraded-cohort-covers-a-member-silent-after-the-pend`. `docs/cadre-consistency.md` ~52, the scenario header and the 2026-10-12 entry in `.pre-existing-known.md` now state the 1.14.0 behaviour.
- `optimystic-write-made-alone-owes-no-one` and `fret-maintenance-deadlines-below-the-declared-link` → **stay blocked**. Nothing in 1.16.0, 1.17.0 or FRET 1.2.1 addresses either; each got a dated recheck line (the sixth arm still reports `unconfirmed []`; FRET's constants are unchanged).
- `report-dependency-floor-bump-to-embedding-app` → **unchanged**. Its form asks the sender to re-check Sereus's own latest release before sending, not to list each floor bump.

## Gate

| run | result |
|---|---|
| `yarn lint`, `yarn typecheck` | pass, before and after the doc/comment edits |
| cadre-core | 187 files, 2522 passed, 1 skipped |
| cadre-cli / cadre-host / cadre-provider / cadre-rn | 295 (1 skipped) / 444 (4 skipped) / 234 / 170 passed |
| quereus-plugin-sereus / reference-app-ns / -rn / -web | 157 (1 todo) / 71 / 180 / 11 passed |
| root `test:*` script suites (12) | all pass |
| integration, 76 files in 10 runs (`tickets/.logs/adopt-optimystic-1-17-0.it-{b1..b8,j1,j2}.log`) | all green except `blind-relay-phone-to-phone-e2e`, 3 of 3 red |
| `node scripts/smoke-published-install.mjs --skip-build` | PASSED, 5/5, installing the published Optimystic 1.17.0 and Quereus 4.20.3 |

- **`blind-relay-phone-to-phone-e2e` is pre-existing**, recorded in `tickets/.pre-existing-error.md`. Its assertion samples B's control connection to A right after formation, and its own NOTE says it breaks if formation connections are closed eagerly. `formation-connection-closed-after-formation` (`7791e5d2`) started closing them and did not run this file.
- **Not run:** a full `yarn check` in one command (over the ten-minute limit), and `yarn build` across every workspace (only cadre-core was rebuilt). After the final comment edits, only lint, typecheck, the cadre-core build and two integration files (`basic-connectivity`, `happy-path`) were re-run.

## Pinned budgets

- `strand-solo-write-budget` and `control-founding-consult-budget` measured exactly their 2026-10-20 pins. Neither moved.
- `control-start-storage-op-budget` warm restart: 13/3, its pin.
- Its cold start measured 60 ops over 35 blocks against a 56/31 pin (2026-10-06), at the block ceiling of 35. The review re-pinned it (see Review findings).

## Known gaps and observations for the reviewer

- **The phone-link workload ran slower in its one run.** `STRAND_WORKLOAD_PHONE=1` on 2026-10-20: B's seat failed its first attempt after 340.5 s, and rounds 1–3 took 322, 174 and 154 s, each with a failed write; on 2026-10-17 the figures were 94.4 s and 91, 95, 3 s. The run was stopped in round 4 by the command limit (it ran 20 minutes). One run against one, on a link whose runs vary widely, so it is not attributed. It is recorded with its table on `blocked/decide-link-deadlines-from-measured-response-time`. A series is needed before anyone reads it as a regression from 1.16.0's longer ping handler. That ticket's own 2026-10-13 experiment saw the same direction: connections that stay up stay saturated.
- **4 `StreamResetError` connection aborts on the frame-cap arm were not traced.** Every node in that run, the harness relay included, answers pings for 60 s.
- `packages/cadre-core/src/control-schema-version.ts` said tag changes are not persisted; the review corrected it (see Review findings).
- **#43's effect is asserted from upstream, not measured here.** Say so if the reviewer wants a targeted Sereus measurement (a stale multi-block read on a strand).

## Tests

None added. This ticket changes no behaviour, only declared ranges, docs, comments and tickets.

## Review findings

Read the `ticket(implement): adopt-optimystic-1-17-0` diff first, then the handoff.

**Checked**
- Floors: `yarn check:dep-ranges` passes (10 linked packages). Optimystic `db-p2p` 1.17.0 declares `p2p-fret` ^1.2.1, as the release notes say; tag `v1.17.0` is `a22eb133`, the hash the deadline table cites.
- Every upstream fact the deadline table and the comments now state, read in `../optimystic` and `../Fret` (read only): `resolvePingHandlerTimeoutMs` (twice `pingTimeout.maxTimeout`, 10 000 floor, 10 s with no `pingTimeout`, which `DEFAULT_CONNECTION_MONITOR`'s comment says); `SilentConsultHolds` (base `retryBackoffBaseMs`, cap `reconcilePassTimeoutMs`, as the read-repair row says); `retryWaitWithinBudget` exists where cited; FRET `deadGraceMs` (0 under 10 minutes of tenure, T/12, cap 300 000; Optimystic passes no `maxDeadGraceMs`); FRET's negotiate-failure threshold is 3, as `strand-formation-protocol.ts` now says, and FRET still re-probes foreign peers with backoff, so that comment's last sentence stays true.
- Stale references: no doc or source still names a moved ticket under `blocked/` (only `tickets/.garden-report.md`, which is a dated log, and an untracked NativeScript build bundle).
- Board moves: the six `complete/` tickets, the three rewritten `blocked/` tickets, `blocked/optimystic-dcutr-between-relay-only-peers` (category and unblock condition on its first line), `implement/degraded-cohort-covers-a-member-silent-after-the-pend` and the `.pre-existing-known.md` entry. The pre-existing `blind-relay-phone-to-phone-e2e` failure was already triaged and fixed in `tess: triage pre-existing test failure`.
- Gate after the review edits: `yarn lint`, `yarn typecheck` pass; cadre-core rebuilt; cadre-core 187 files, 2522 passed, 1 skipped; `control-start-storage-op-budget`, `control-store-incompatible`, `control-schema-versions` pass. Integration scenarios were not re-run: the review edits are a test constant, comments, one non-fault counter and docs.

**Found and fixed**
- `control-start-storage-op-budget.spec.ts`: the cold pin (56/31, 2026-10-06) was stale and its run sat on the block ceiling (35). Re-measured 60 ops over 35 blocks, the extra 4 all `getMetadata`, nothing else moved; warm still 13/3. Re-pinned to 60/35 with ceilings 70/39 (same headroom), `MEASURED_ON` 2026-10-21, `BASELINE_UPSTREAM` `0e70f551`, and a history line. The history does not attribute the 4 blocks to `owner-grant-tables` alone: 11 commits changed `schemas/control.qsql` after 2026-10-06 and none was measured on its own (`git log --since=2026-10-07 -- schemas/control.qsql`). Also corrected the warm history's 2026-10-01 entry, which pointed at the baseline commit instead of `461a01bc`.
- `control-schema-version.ts`: the module `NOTE` said the plugin does not persist `set tags`, and two comments said `catalog-only` changes wait on the upstream ticket. All three were false since 1.16.0 and are corrected; the NOTE still says `control-store-migrates-on-start` replaces it. That ticket's Design paragraph and TODO were updated to match.
- `.release-notes.pending.md`: the known limitation said FRET waits 5 minutes; it waits one twelfth of the peer's observed uptime, at most 5 minutes.
- `strand-workload-on-a-phone-link.integration.ts`: its comment now names `cluster-fetch:consult-held` but nothing counted it, so the 110 holds in the handoff were counted by hand. Added a non-fault `consult held` row to `DEADLINE_EVENTS`, so the next phone run reports them.

**Not changed, with reason**
- The phone-arm slowdown (one run against one) stays recorded on `blocked/decide-link-deadlines-from-measured-response-time` without attribution. Nothing more can be concluded from one run, and that ticket already asks for a series.
- #43 is not measured here. `message-cost-accounting` counts streams, so it cannot show the change, and upstream's specs pin it. A targeted Sereus measurement would only re-test upstream's code, so none was added.
- The 4 untraced `StreamResetError` aborts on the frame-cap arm are already recorded on `complete/optimystic-ping-handler-timeout-below-the-monitor-deadline`, and that arm stays `it.fails` under `blocked/decide-link-deadlines-from-measured-response-time`. No new ticket.
- Tests: none added or cut. The implementer added none, and the only behaviour this review touched is a budget constant already enforced by its own spec.
- No tickets filed and no tripwires added: every finding was minor and fixed in this pass.
