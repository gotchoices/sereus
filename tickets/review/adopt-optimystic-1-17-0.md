description: Sereus now declares Optimystic 1.17.0 (with its peer-discovery library FRET 1.2.1) and Quereus 4.20.3 as the oldest versions it accepts; this records what that upgrade changed, the measurements showing which fixes took effect, and which waiting tickets it closed.
architecture: docs/testing.md#declared-dependency-range-vs-linked-workspace-keep-them-equal
files: packages/*/package.json and yarn.lock (`@optimystic/*` ^1.17.0, `@quereus/quereus` ^4.20.3), .release-notes.pending.md, packages/integration-tests/src/scenarios/message-cost-accounting.integration.ts (new 2026-10-20 block at the end of the doc comment), docs/cadre-consistency.md ("Deadlines Below Cadre" rows, the ~52 failed-cancel paragraph), docs/architecture.md (~72, ~2374), packages/cadre-core/src/types.ts (`DEFAULT_CONNECTION_MONITOR` comment), packages/cadre-core/src/strand-formation-protocol.ts (~895-901), packages/integration-tests/src/scenarios/joiner-first-commit-over-slow-relay.integration.ts (header, `FIRST_SYNC_MS` NOTE, third arm's comment), packages/integration-tests/src/scenarios/strand-workload-on-a-phone-link.integration.ts, packages/integration-tests/src/scenarios/control-write-degraded-cohort-member.integration.ts (header), ops/docker/libp2p-infra/src/main.ts (~102), tickets/complete/ (six tickets moved there), tickets/blocked/ (three rewritten, one new), tickets/implement/degraded-cohort-covers-a-member-silent-after-the-pend.md, tickets/.pre-existing-error.md, tickets/.pre-existing-known.md
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
- **Its cold start measures 60 ops over 35 blocks against a 56/31 pin (2026-10-06), at the block ceiling of 35.** The extra four blocks match the four collections `owner-grant-tables` added on 2026-10-16, and logs show 60/35 from 2026-10-20 01:04 on, before this release's code. So it did not move with 1.17.0 and was not re-pinned here. The next control table added will trip the ceiling. Reviewer: re-pin it with a history line naming `owner-grant-tables`, or decide otherwise.

## Known gaps and observations for the reviewer

- **The phone-link workload ran slower in its one run.** `STRAND_WORKLOAD_PHONE=1` on 2026-10-20: B's seat failed its first attempt after 340.5 s, and rounds 1–3 took 322, 174 and 154 s, each with a failed write; on 2026-10-17 the figures were 94.4 s and 91, 95, 3 s. The run was stopped in round 4 by the command limit (it ran 20 minutes). One run against one, on a link whose runs vary widely, so it is not attributed. It is recorded with its table on `blocked/decide-link-deadlines-from-measured-response-time`. A series is needed before anyone reads it as a regression from 1.16.0's longer ping handler. That ticket's own 2026-10-13 experiment saw the same direction: connections that stay up stay saturated.
- **4 `StreamResetError` connection aborts on the frame-cap arm were not traced.** Every node in that run, the harness relay included, answers pings for 60 s.
- **`packages/cadre-core/src/control-schema-version.ts` still says tag changes are not persisted** (the NOTE at ~18-26, and the "once … ships" wording at ~103 and ~146). That has been false since 1.16.0. `control-store-migrates-on-start`'s Design owns replacing that NOTE, so it was left for that ticket.
- **#43's effect is asserted from upstream, not measured here.** Say so if the reviewer wants a targeted Sereus measurement (a stale multi-block read on a strand).

## Tests

None added. This ticket changes no behaviour, only declared ranges, docs, comments and tickets.
