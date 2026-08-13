----
description: Deleted the private, local-only storage path that a workspace started by a lone device used to run on. Every workspace now uses the normal shared path from the start, and all tests, apps, and docs were updated to match.
files: packages/cadre-core/src/types.ts, packages/cadre-core/src/strand-cohort.ts, packages/cadre-core/src/strand-database.ts, packages/cadre-core/src/strand-instance-manager.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/strand-membership-writer.ts, packages/cadre-core/test/strand-instance-manager-backfill.spec.ts, packages/cadre-core/test/strand-solo-write-budget.spec.ts, packages/cadre-core/test/control-database-solo-warm-start.spec.ts, packages/reference-app-web/src/lib/cadre-web.ts, scripts/lib/published-smoke-scenario.mjs, docs/architecture.md, docs/STATUS.md, docs/cadre-consistency.md
----

# `StrandMode` retired — implemented and reviewed, complete

Second of three. `strand-network-transactor-solo-parity` proved the ground and is complete;
`drop-strand-mode-option-from-sql-plugin` cleans the SQL plugin's API next and sits in
`implement/`. This ticket removed the per-strand `bootstrap`/`networked` choice from
`cadre-core` and its public API. Deliberate breaking change; the repo carries no backwards
compatibility.

## What shipped

- `types.ts`: `StrandMode`, `StrandInstance.mode`, `StrandConfig.mode` deleted.
- `strand-cohort.ts`: `selectStrandMode`, `hasOtherPeers`, `CohortSeed` and (in review)
  `CohortMembers` all gone. `deriveCohortMembers` returns `string[]`; `resolveCohortSeed`
  in `cadre-node.ts` returns `string[]`. The load-bearing "never seed the strand mesh from
  `CadrePeer.Multiaddr`" doc comments were kept.
- `strand-database.ts`: `StrandDatabaseConfig.mode` and `.rawStorage` gone; `storage` is no
  longer passed to `connectToStrand`.
- `strand-instance-manager.ts`: `StartStrandConfig.mode`, `ResumeStrandOverrides.mode`,
  every resolution site and `instance.mode` write gone. **Backfill gate** is now
  `strandStorage && config.backfill?.enabled !== false` — armed for every stored strand,
  which is what closes the "founded alone, never replicates" hole.
- `cadre-node.ts`: `launchStrand` lost `explicitMode`; `resumeStrandRuntime` passes only
  the seed.
- `strand-membership-writer.ts` + `docs/architecture.md`: the "bootstrap-mode transactor
  enforces deferred CHECKs" misnomer reworded — enforcement is Quereus plus the Optimystic
  vtab session.
- Call sites cleaned beyond the implement ticket's list: `reference-app-web`
  (`cadre-web.ts`, `e2e/fixtures/formation-responder.ts`), five integration scenarios,
  `scripts/lib/published-smoke-scenario.mjs`, and several cadre-core specs.

## Review findings

### What was checked

The full 37-file implement diff was read before the handoff summary. On top of that: a
repo-wide sweep for surviving `StrandMode` / mode references across `cadre-core`,
`cadre-cli`, `cadre-host`, `cadre-provider`, both reference apps, `integration-tests`,
`scripts/`, `docs/` and every package README; every doc file the change touched plus the
ones it should have; the SQL plugin's consumption of its `storage` option traced end to
end; Optimystic's `findCluster` read to adjudicate the judgment call the implementer
flagged; and test coverage of the one real behaviour change in the diff (the backfill
arming gate).

### Minor — fixed in this pass

- **Three stale doc sites the diff missed.** `docs/STATUS.md:201` and
  `docs/architecture.md:700` both still described the wake path as "re-resolving the cohort
  seed + mode (`bootstrap → networked`)"; `docs/cadre-consistency.md:26` still called the
  closed-strand scenario "a two-node `networked` strand". All three now describe the seed
  alone.
- **`CohortMembers` was left as a degenerate one-field wrapper.** The diff collapsed the
  exactly analogous `CohortSeed` to `string[]` but stopped short here, leaving an interface
  whose only member was `otherPeerIds: string[]`. Collapsed to a bare `string[]` return; it
  is internal (not exported from `index.ts`), so nothing downstream moved. `strand-cohort.ts`
  is now 38 lines, one function.
- **The warm-start "revoked" case's replacement comment was wrong.** It claimed "one fewer
  row for `queryCadrePeers`'s revocation join to keep" — the case revokes *two* siblings —
  and compared transactors that no longer differ. Reworded to state the membership-of-one
  the revocation join produces, and to name what the case actually tests (the tombstone
  re-read on the launch path costs no liveness). Worth noting for the record: dropping the
  `instance.mode` assertions did **not** leave the vanished/revoked/cold cases
  indistinguishable, because `expectWarmState` already pins each case's membership set
  before `addStrand` runs — that assertion is the discriminator now.
- **The diff's one behaviour change had no test.** The backfill gate went from
  `mode === 'networked' && strandStorage && …` to storage-only, which is the change that
  closes the founded-alone hole — and nothing pinned it.
  `packages/cadre-core/test/strand-instance-manager-backfill.spec.ts` is new, 6 cases:
  arms for a strand launched with an empty seed (the regression that matters), correct
  wiring of the strand's own store and the node's own protocol prefix, and the three
  negative arms (no per-strand storage, embedder-disabled, node without a `keyNetwork`),
  plus stop-on-quiesce / re-arm-on-resume.

### The judgment call the implementer flagged — resolved, their rewrite is right

`strand-instance-manager.spec.ts`'s seeded-smoke test used to force `bootstrap` on the
claim that a networked launch against its BOGUS unreachable seed would block on cohort
consensus ("the seed is a phantom 2nd cluster member"). The rewritten comment says the
opposite — the node never connects and self-coordinates alone. The new comment is correct,
and the mechanism is in `optimystic/packages/db-p2p/src/libp2p-key-network.ts:822`
(`findCluster`): the cohort is assembled from the FRET routing table and then filtered to
peers the peerStore positively classifies as *serving* this network's protocol. A peer
that was never dialled is never identified, so it classifies as `unknown` and is
explicitly never admitted. The cohort collapses to self-only, which completes the write
under `allowClusterDownsize`. A configured-but-unreachable bootstrap address cannot become
a phantom cluster member. Consistent with `control-database-solo-warm-start.spec.ts`'s
stale-cohort cases and green in the full suite run.

### Tripwires — recorded at the site, not filed

- Arming the peer-join catch-up for every stored strand costs one `StrandBackfill` object
  and one `connection:open` listener per running strand — linear in strand count, and
  negligible at the handful a device or host runs today. `NOTE:` at the gate in
  `strand-instance-manager.ts` with the revisit condition (a node hosting strands by the
  hundred should move to one shared listener dispatching by strand id).

### Major — one filed, not caused by this diff

- `backlog/debt-cadre-node-single-file-size` — `cadre-node.ts` measures 4,770 lines
  (`wc -l`, 2026-08-13) against a next-largest logic file of 535. Pre-existing; this diff
  *shrank* it. Filed with the honest decline argument in `tradeoffs:` because the split's
  churn may not be worth it yet. No open ticket claimed the site's size (checked all of
  `backlog/ fix/ plan/ implement/ review/`; the eleven tickets that name `cadre-node.ts`
  are about specific behaviours), and there is no accepted-tradeoff `NOTE:` in the file.

### Checked and clean — with the reason, not just "looks good"

- **Nothing in production read `StrandInstance.mode`.** Grepped `cadre-cli`, `cadre-host`,
  `cadre-provider`, `reference-app-rn` and `reference-app-ns` for it: zero hits outside
  tests and tickets. Its removal breaks no status reporting or serialized DTO, so no
  compatibility arm was owed.
- **Dropping `storage` from cadre-core's `connectToStrand` call is behaviour-neutral, and
  the browser worry is void.** In `compose-strand.ts` the resolved storage feeds exactly
  two consumers: `pluginConfig.rawStorageFactory` (only when `resolvedTransactor === 'local'`)
  and `platform.createNode` (only when no node is injected). cadre-core is neither. The
  concern that a browser build might now eagerly open an unused IndexedDB store via
  `connect-browser.ts`'s `resolveStorage` does not apply: the plugin's `.` export has no
  `browser` condition, so cadre-core always resolves the shared `connect.ts` platform,
  which defines no `resolveStorage` at all.
- **Resource cleanup.** `releaseRuntime` stops the backfill *before* closing the database
  and stopping the node, so a wider arming gate cannot leave a catch-up pushing at a
  torn-down transport. Now pinned by the quiesce/resume case in the new spec.
- **Error handling and type safety: nothing to report.** The diff adds no `catch`, no
  `any`, and no new throw site — it is a deletion plus one gate widening. Stated
  explicitly rather than left as a silent empty category.
- **Docs beyond the three stale sites: accurate.** `docs/strands.md` never described the
  modes (grepped). The backfill descriptions in `architecture.md:72` and
  `cadre-consistency.md:26` never mentioned the mode gate, so the gate change left them
  correct. `docs/STATUS.md`'s release-readiness table is an explicitly dated 2026-08-03
  snapshot and was correctly left alone.

## Validation

Run in review, after the review's own edits:

- `packages/cadre-core`: `yarn typecheck` clean; `yarn vitest run` **98 files, 1514 passed,
  1 skipped**. Against the implement run's 97/1508, the deltas are the 6 new backfill-gate
  cases in 1 new file. The single skip is the pre-existing platform-conditional Windows
  `key-store.spec.ts` 0o600 case.
- Repo root: `yarn lint` clean, `yarn build` clean (all workspaces).
- Implement-stage validation not re-run in review, and still standing: the storage-op
  budgets (launch 1613 ops / 17 blocks, insert ×5 366/3, select ×5 230/2 — byte-identical
  to the prereq's networked arm), `strand-transactor-handover.spec.ts` (old local-transactor
  blocks stay readable and extensible), `quereus-plugin-sereus` 77 passed + 1 todo,
  `reference-app-rn` 190 passed, and every integration scenario the ticket edited
  (`push-wake-e2e` 4/4, `strand-membership-closed-strand-e2e` 6/6, `strand-formation-e2e`
  22/22, plus `websocket-chat`, `rbac-signed-write`, `multi-party-workflows`,
  `strand-unpublish-sibling-convergence`, `convergence-stress`,
  `strand-addr-seed-convergence`).
- Several of those integration files carry tracked-flaky entries in
  `tickets/.pre-existing-known.md`. One green whole-file run does not clear those and none
  were touched; the point was that no NEW failure appeared. No `.pre-existing-error.md` was
  written at either stage.

## Deferred — needs a human before release

Both carried forward unchanged from implement; neither is agent-runnable.

- **On-device NativeScript solo smoke** (`packages/reference-app-ns/src/solo-smoke.ts`):
  the only on-device exercise of the solo path. No source change was needed (it never
  passed `mode`, confirmed in review), but the transactor it now gets has changed.
  Requires a device or emulator.
- **`yarn smoke:published`**: a scratch install from packed tarballs against the public
  registry — long-running and network-dependent. Its scenario script was updated here (the
  two `instance.mode` assertions would have failed against the new tarballs), so the next
  smoke run validates that edit too.

## Left to ticket three

The SQL plugin (`@serfab/quereus-plugin-sereus`) still carries its `mode`/`transactor`
option, its `connectToStrand({ mode: 'bootstrap' })` test and README usages, and
cadre-core's test helpers (`strand-spec-helpers.ts`, `strand-membership-writer.spec.ts`
and the membership suites) still drive the plugin's local transactor directly. All of it
belongs to `implement/13-drop-strand-mode-option-from-sql-plugin`, which also carries the
transactor-observability arm the prereq review appended.
