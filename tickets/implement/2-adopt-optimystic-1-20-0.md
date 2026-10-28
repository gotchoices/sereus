description: Sereus moves onto Optimystic 1.20.0 and Quereus 4.21.0. Upstream's release is mostly an opt-in offline mode for the Quereus plugin, which Sereus adopts for strand databases in `strand-offline-mode`. It also gives commit and read failures typed errors and changes the error a read throws when no peer answers. This pass checks Sereus's retry classifier against those errors, writes the release notes, and runs the release gate so Sereus can be released.
prereq: control-write-retries-an-unanswered-read-again, strand-offline-mode
architecture: docs/testing.md#declared-dependency-range-vs-linked-workspace-keep-them-equal
files: .release-notes.pending.md, packages/cadre-core/src/control-write-retry.ts (`SUPER_MAJORITY_SHORTFALL_UNANSWERED`), docs/cadre-consistency.md ("Deadlines Below Cadre"), tickets/blocked/ (recheck), tickets/.pre-existing-known.md, tickets/.garden-report.md, ../optimystic/tickets/complete/ (read only), ../optimystic/docs/offline-sync.md (read only)
----
Optimystic 1.20.0 is on npm (tag `v1.20.0`, `59679072`); it raises its Quereus peer range to `^4.21.0`, and Quereus 4.21.0 is on npm (tag `v4.21.0`, `cfb7fd8c7`). Upstream published no release notes for 1.20.0. This ticket follows the shape of `complete/adopt-optimystic-1-19-0`; read it first.

**Floors already raised** in the commit that filed this ticket: every `@optimystic/*` range `^1.19.0` → `^1.20.0` and `@quereus/quereus` `^4.20.3` → `^4.21.0` across the eight workspace `package.json` files, `yarn.lock` refreshed. `yarn check:dep-ranges` and `yarn typecheck` pass against the linked 1.20.0 workspace.

## What 1.20.0 contains

All 31 tickets in `git -C ../optimystic log --oneline v1.19.0..v1.20.0` are offline-sync stages (`../optimystic/docs/offline-sync.md`). The public API changes only by additions: db-core exports `./offline/*` and `visit-every`, db-p2p exports `cohort-reachability`, and the plugin exports `OfflineMode` and its errors and status types. Offline mode is opt-in (the `offline` register option). Sereus adopts it for strand databases in the prereq `strand-offline-mode`; read its complete ticket(s).

Parts that reach a Sereus node without offline mode, from the upstream tickets in `../optimystic/tickets/complete/`:

- `1-offline-sync-typed-promise-shortfall`: a super-majority shortfall is now thrown as `PromiseShortfallError` (db-core), carrying the approval and rejection counts and the silent peers, and it crosses the network typed. Its message keeps the old wording (`Failed to get super-majority: a/b approvals (needed n, r rejections)`).
- `1.04-offline-sync-typed-validity-rejection` + `1.02-signed-validity-marker-on-reject-votes`: a write that the cohort judges invalid now fails with a distinct permanent rejection error, and the signed reject vote carries a validity marker.
- `1.06-offline-sync-commit-failure-classifier`: db-core exports a classifier that sorts a commit failure by error type (wait for network, back off, refused for good, too large, expired, possibly saved, partly saved).
- `6.3-network-get-names-unreachable-blocks`: **a behaviour change on the normal read path.** `NetworkTransactor.get` now returns a block that no peer answered as `unavailable: 'peers-unreachable'`, and the read then throws `BlockUnavailableError` (`Block <id> is unavailable (peers-unreachable): …`). Before, it threw the `Some peers did not complete: …` aggregate. A write whose refresh hits such a block fails with the new error. The upstream ticket's "Consequences" section lists every changed path.
- `6.2-offline-sync-solo-refusal`: a per-write option to refuse a lone-node commit. The offline queue sets it; plain writes do not.
- `10-offline-sync-already-applied-guards-in-db-core`, `2.x`/`3.x` segment and coordinator work: internal restructuring of how a collection stages and commits its pending changes. Sereus sees it only through the commit path, which the gate covers.

Quereus 4.21.0 adds a write-scope analyzer and a module hook (`write-scope-*` tickets in `../quereus`), which the plugin's offline outlook uses. Both are additive. Confirm that `@serfab/quereus-plugin-sereus` doesn't implement the module interface the hook extends in a way the change breaks. If typecheck passes, that is enough.

Check whether `db-p2p`'s `p2p-fret` range moved (FRET is still 1.2.1 on npm).

## Required work

- **Retry classifier against the new errors.** The unanswered-read change (`BlockUnavailableError` in place of the `[block:` aggregate) is handled by the prereq `control-write-retries-an-unanswered-read-again`; read its complete ticket.
  - The shortfall wording is unchanged, so `SUPER_MAJORITY_SHORTFALL_UNANSWERED` still fires. Confirm this from a spec or a degraded-cohort run, not only by reading.
  - Decide whether to move the shortfall matcher to `instanceof PromiseShortfallError`. Moving it is the direction the code's own NOTEs ask for, but the message regex distinguishes "0 rejections". If you move it, read `rejections` off the error. If the change is larger than this ticket, file it as a backlog `debt-` ticket and leave the regex.
  - Do not adopt upstream's `classifyCommitFailure` wholesale in this pass. Its categories are offline-queue categories, and Sereus's retry rules differ (see the file's header). If it would retire most of the text matchers, file a `debt-` ticket.
- **Recheck the upstream-blocked tickets** (`optimystic-write-made-alone-owes-no-one`, `forked-control-collection-sync-livelocks`, `fret-maintenance-deadlines-below-the-declared-link`, `decide-link-deadlines-from-measured-response-time`). Give each a dated recheck line. The first one asked a human to confirm its sixth arm on a clean release build. 1.20.0 is that build, so run the arm and close or keep the ticket accordingly. 1.20.0's cohort-reachability and solo-refusal work also bears on it.
- **Deadlines Below Cadre** in `docs/cadre-consistency.md`: re-stamp at 1.20.0 (`59679072`). Diff the same files the 1.19.0 pass listed between `v1.19.0` and `v1.20.0`, add `network/cohort-reachability.ts` if it introduced a timing value on the normal (non-offline) path, and change only the rows that moved.
- **Release notes.** `.release-notes.pending.md` is empty after v1.19.0. Follow the house style (see that file's git history):
  - Dependencies: Optimystic 1.20.0 and Quereus 4.21.0, with one line per upstream change an embedder can observe (typed shortfall and rejection errors, the unreachable-read error, offline mode).
  - New: offline mode for strand databases, as `strand-offline-mode` built it. Cover what an app turns on, what a locally acknowledged commit promises, the journal per platform, and the Sereus tables that stay network-acknowledged.
  - Upgrading: mixed versions (below).
  - Fixes: the control-write retry for an unanswered read (from the prereq), stated as what an embedder would have seen on 1.19 cadre-core + 1.20 Optimystic (a control write failing on its first attempt while a connection forms), and any shortfall-matcher change.
- **Gate**, as the 1.19.0 adoption ran it: `yarn lint`, `yarn typecheck`, `yarn build`, every workspace's tests, the root `test:*` suites, all integration files in batches each under the 10-minute idle limit (tee each batch to `tickets/.logs/adopt-optimystic-1-20-0.it-*.log`, with the `upstream:` line naming the linked upstream commit and its dirty-file count), and `node scripts/smoke-published-install.mjs --skip-build` against the published 1.20.0. Check `tickets/.pre-existing-known.md` for every red before reporting it. Pinned budgets (`strand-solo-write-budget`, `control-founding-consult-budget`, `control-start-storage-op-budget`) are re-pinned only with a measured run and a history line.
- Append a dated entry to `tickets/.garden-report.md` saying whether Sereus is ready to release (`yarn release`).

## Edge cases & interactions

- **Mixed versions.** A party's machines upgrade separately. From the upstream tickets, find out:
  - whether a 1.19.x node accepts a 1.20.0 reject vote that carries the signed validity marker (the vote's signature input changed);
  - what a 1.19.x writer sees from a 1.20.0 member's typed shortfall or rejection reply.

  State both in the release notes. Verify by reading the upstream tickets and source at both tags. No mixed-version test is expected.
- **Error crossing two module copies.** The `instanceof` checks in `control-write-retry.ts` already depend on Sereus and the plugin sharing one db-core copy. The prereq's `instanceof BlockUnavailableError`, and a `PromiseShortfallError` check if you add one, have the same dependency. Verify it under `smoke-published-install`, which installs from npm, not only in the linked workspace.
- **Stores.** Confirm from upstream's `upgrade-check` (`1db4ff9a` records a 1.20.0 fixture) that a 1.20.0 node opens stores written by 1.19.0 without migration, and say so in the notes. The segment restructuring changes in-memory state, not the stored format, but confirm that.
- The integration runs use the linked workspace. Only `smoke-published-install` exercises npm 1.20.0, and it must pass.

## Tests

None expected. The classifier spec belongs to the prereq. A shortfall-matcher change, if made, updates its existing spec.

## TODO

- Read the upstream tickets named above (especially `6.3` "Consequences" and `1`/`1.04`).
- Decide on the shortfall matcher.
- Recheck the blocked tickets; run the `optimystic-write-made-alone-owes-no-one` sixth arm on the release build.
- Re-stamp Deadlines Below Cadre.
- Write `.release-notes.pending.md`.
- Run the full gate; record results in the handoff and the garden report.
