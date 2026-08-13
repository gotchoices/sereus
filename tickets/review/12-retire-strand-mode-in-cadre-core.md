----
description: Deleted the private, local-only storage path that a workspace started by a lone device used to run on. Every workspace now uses the normal shared path from the start, and all tests, apps, and docs were updated to match.
files: packages/cadre-core/src/types.ts, packages/cadre-core/src/strand-cohort.ts, packages/cadre-core/src/strand-database.ts, packages/cadre-core/src/strand-instance-manager.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/strand-membership-writer.ts, packages/cadre-core/test/strand-solo-write-budget.spec.ts, packages/cadre-core/test/control-database-solo-warm-start.spec.ts, packages/reference-app-web/src/lib/cadre-web.ts, scripts/lib/published-smoke-scenario.mjs, docs/architecture.md, docs/STATUS.md
----

# `StrandMode` retired — implemented, ready for review

Second of three (`strand-network-transactor-solo-parity` proved the ground and is complete;
`drop-strand-mode-option-from-sql-plugin` cleans the SQL plugin's API next and is already in
implement/). This ticket removed the per-strand `bootstrap`/`networked` choice from `cadre-core`
and its public API. Deliberate breaking change; the repo carries no backwards compatibility.

## What was removed (all landed as specified in the implement ticket)

- `types.ts`: `StrandMode`, `StrandInstance.mode`, `StrandConfig.mode`.
- `strand-cohort.ts`: `selectStrandMode`, `hasOtherPeers` (from `CohortMembers`), and the
  `CohortSeed` interface entirely — `resolveCohortSeed` in `cadre-node.ts` now returns `string[]`
  (the bootstrap addresses). The load-bearing "never seed the strand mesh from
  `CadrePeer.Multiaddr`" doc comments were kept.
- `strand-database.ts`: `StrandDatabaseConfig.mode` and `.rawStorage`; `storage` is no longer
  passed to `connectToStrand` (cadre-core always injects the node; the plugin keeps its `storage`
  option for the browser entry point — untouched here, that is ticket three's file).
- `strand-instance-manager.ts`: `StartStrandConfig.mode`, `ResumeStrandOverrides.mode`, every
  resolution site, `instance.mode` writes. **Backfill gate** is now
  `strandStorage && config.backfill?.enabled !== false` — armed for every stored strand, with the
  "inert when alone, armed when a peer arrives; closes the founded-alone-never-replicates hole"
  rationale in the comment at the site.
- `cadre-node.ts`: `launchStrand` lost `explicitMode`; `resumeStrandRuntime` passes only the seed;
  the unbounded-`queryCadrePeers()` `NOTE:` was kept with its last clause rewritten ("degrades to
  an empty seed"). Confirmed by reading `handleStrandWake`, `handleStrandCheckIn`, `serviceWake`
  and `runWakeWindow`: nothing ever triggered work off a mode change.
- `strand-membership-writer.ts` and `docs/architecture.md:670`: the "bootstrap-mode transactor
  enforces deferred CHECKs" misnomer reworded — enforcement is Quereus plus the Optimystic vtab
  session, proven on the network transactor by
  `strand-membership-network-transactor-parity.spec.ts`.

## Call sites the implement ticket did NOT list (reviewer: look here first)

The ticket claimed "no app source passes `mode` to `addStrand`". That was stale. Found and fixed
beyond the ticket's list:

- `packages/reference-app-web/src/lib/cadre-web.ts` (`:502`, `:611`) — passed `mode: 'networked'`
  with comments explaining the inference hazard; both dropped, comments removed/reworded.
- `packages/reference-app-web/e2e/fixtures/formation-responder.ts` (`:221` + header) — same.
- `packages/integration-tests/src/scenarios/strand-formation-e2e.integration.ts` — five
  `mode: 'networked'` addStrand sites plus comments.
- `packages/integration-tests/src/scenarios/push-wake-e2e.integration.ts` — two
  `mode: 'bootstrap'` sites plus the helper doc.
- `scripts/lib/published-smoke-scenario.mjs` — asserted `instance.mode` in two ported warm-start
  cases; plain JS, so it would have failed only at smoke runtime, not compile. Assertions dropped,
  comments ported to match the rewritten spec (its header demands the two stay in sync).
- `packages/cadre-core/test/cadre-node-strand-launch-key.spec.ts` — imported `CohortSeed`.
- `strand-addr-seed-convergence.integration.ts` *asserted* `aStrand.mode`/`bStrand.mode` (the
  ticket listed only its comments); assertions dropped, header rewritten — the file's subject
  (mesh forms from the RPC-resolved seed alone) is intact and the scenario passes.

`rbac-signed-write.integration.ts` was handled as the ticket directed: replication stays an
observation, not a gating assertion, with the comment rewritten to cite
`backlog/debt-read-repair-single-voter-corroboration`. This run actually observed
`replication=true` — the retirement making cross-node replication real on that previously
local-transactor path.

## Judgment call worth a second look

`strand-instance-manager.spec.ts` had a seeded-smoke test whose comment claimed a `networked`
launch against its BOGUS unreachable seed would block on cohort consensus (the reason it forced
`bootstrap`). With the mode gone the test now runs the network transactor against that dead seed;
comment rewritten to say the node never connects and self-coordinates alone (the stale-cohort
shape `control-database-solo-warm-start.spec.ts` pins). Empirically confirmed green in the full
suite run — but the old comment's claim and the new one are contradictory readings of the same
substrate, and the reviewer may want to sanity-check the new comment's reasoning.

## Validation (all run on this change)

- `packages/cadre-core`: `yarn typecheck` clean; `yarn vitest run` **97 files, 1508 passed,
  1 skipped** (the pre-existing platform-conditional Windows `key-store.spec.ts` 0o600 skip).
  Count math vs the prereq review's 1511: −2 `selectStrandMode` tests, −1 budget baseline arm.
- **Post-change numbers, next to the prereq's** (`strand-solo-write-budget.spec.ts`, re-run
  standalone): launch **1613 ops / 17 blocks**, insert ×5 **366 / 3**, select ×5 **230 / 2** —
  byte-identical to the prereq's networked arm. Wall clock this run: launch 327 ms, insert
  ~9 ms/row, select ~4 ms/row (thresholds were 250 ms/insert).
- `strand-transactor-handover.spec.ts` re-run standalone: **passed** — this ticket's data-safety
  evidence that local-transactor-era blocks on disk stay readable and extensible.
- `packages/quereus-plugin-sereus`: typecheck clean; 8 files, 77 passed + 1 todo.
- `packages/reference-app-rn`: 10 files, 190 passed.
- `packages/integration-tests`: typecheck clean. Every scenario this ticket edited was run:
  `websocket-chat`, `rbac-signed-write`, `multi-party-workflows`,
  `strand-unpublish-sibling-convergence`, `convergence-stress`, `strand-addr-seed-convergence`
  all green; `push-wake-e2e` **4/4**, `strand-membership-closed-strand-e2e` **6/6**,
  `strand-formation-e2e` **22/22**. Several of those carry tracked-flaky entries in
  `tickets/.pre-existing-known.md` (closed-strand-e2e, push-wake, strand-addr-seed, unpublish,
  formation Phase 2) — one green whole-file run does **not** clear those entries and none were
  touched; the point is no NEW failure appeared. No `.pre-existing-error.md` written.
- Repo root: `yarn build` clean (all workspaces), `yarn lint` clean.

## Deferred — needs a human before release

- **On-device NativeScript solo smoke** (`packages/reference-app-ns/src/solo-smoke.ts`): the only
  on-device solo exercise of this path; requires a device/emulator, not agent-runnable. No source
  change was needed (it never passed `mode`), but the transactor it gets has changed — run it
  before release.
- **`yarn smoke:published`**: not run (scratch install from packed tarballs + public registry;
  long-running and network-dependent, outside the sandbox budget). Its scenario script WAS updated
  here (the two `instance.mode` assertions would have failed against the new tarballs), so the
  next smoke run validates that edit too.

## Docs updated

- `docs/architecture.md`: "Strand Mode: Bootstrap vs Networked" section replaced by "One
  Transactor Per Strand" (states the storage-engine ownership of the solo case and cites the three
  evidence specs); "Asymmetric bootstrap" bullet fixed; the `:670` misnomer fixed; one
  closed-strand-e2e "in `networked` mode" phrase dropped.
- `docs/STATUS.md`: warm-start entry rewritten for one transactor; a new catalogue entry lists the
  three parity/evidence specs with their numbers; the unpublish-scenario entry's mode phrase
  dropped.
- `docs/strands.md`: grepped, never described the modes — untouched, as the ticket predicted.

## Not this ticket's scope (for the reviewer's map)

The SQL plugin (`@serfab/quereus-plugin-sereus`) still has its `mode`/`transactor` option, its
`connectToStrand({ mode: 'bootstrap' })` test/README usages, and `cadre-core`'s test helpers
(`strand-spec-helpers.ts`, `strand-membership-writer.spec.ts` and the membership suites) still
drive the plugin's local transactor directly. All of that is
`implement/13-drop-strand-mode-option-from-sql-plugin` (which also carries the
transactor-observability arm the prereq review appended).
