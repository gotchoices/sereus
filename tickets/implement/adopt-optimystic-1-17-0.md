description: Optimystic 1.17.0 (with p2p-fret 1.2.1) is published; raise Sereus's declared @optimystic floors from ^1.15.0 to ^1.17.0, record what it changes in the pending release notes, re-measure message-cost-accounting against the 2026-10-19 baseline, and settle the blocked tickets that were waiting on what 1.16.0 and 1.17.0 shipped.
architecture: docs/testing.md#declared-dependency-range-vs-linked-workspace-keep-them-equal
files: package.json (`upgrade:optimystic` script), packages/*/package.json (@optimystic/* floors), yarn.lock, .release-notes.pending.md, packages/integration-tests/src/scenarios/message-cost-accounting.integration.ts (baseline doc comment), tickets/blocked/ (the upstream tickets listed below), tickets/.pre-existing-known.md
----
# Adopt Optimystic 1.17.0

Optimystic v1.16.0 and v1.17.0 are on npm (`npm view @optimystic/db-p2p version` → 1.17.0), requiring p2p-fret 1.2.1. Sereus's workspace already runs that code through the `link:` resolutions in the root `package.json`; what adopting means is the declared ranges (`^1.15.0` in cadre-core and others today), which `yarn check:dep-ranges` requires to equal the linked version, plus the release notes and the evidence that the fixes landed. Earlier adoptions to copy: `35a0bf08` (1.15.0), `3b5bec00` (1.14.0).

## What 1.16.0 and 1.17.0 carry that Sereus waits on

Read optimystic's `.release-notes.pending.md` history and `git log 28e6e044..a22eb133` in `../optimystic` (read only) to confirm each:

- **Catalog-only add and drop column** (optimystic `catalog-only-add-and-drop-column`): `blocked/optimystic-catalog-only-alter-table`, which blocks `implement/control-store-migrates-on-start` (GitHub #46).
- **Retries back off** (`coordinator-and-read-retries-back-off`, `silent-read-repair-consults-back-off`): `blocked/optimystic-retries-do-not-back-off` (#48).
- **File storage lists ids containing `/`** (#41): join backfill on Node file storage now carries collection headers.
- **#39** (`a-cold-read-reuses-the-consults-archives`, `a-collection-open-reads-its-log-ends-once`): `blocked/optimystic-attach-fetches-each-block-twice`.
- **#43** (`a-cohort-consult-sends-bytes-only-when-the-peer-is-ahead`, `a-cohort-consult-asks-each-peer-about-all-its-blocks-at-once`, `a-member-that-applied-a-commit-counts-its-copy-checked`): `blocked/optimystic-background-consults-cost-a-request-per-block`.
- **#42, partly** (`a-consensus-record-carries-several-collections-of-one-action`, `a-coordinator-runs-an-actions-collections-as-one-record`; the final step, `a-transaction-pends-and-commits-its-collections-together`, is blocked upstream on a mixed-version decision): `blocked/optimystic-multi-collection-commit-costs-four-requests-per-collection`.
- **FRET 1.2.1** includes `foreign-peers-not-reprobed-by-the-idle-loop` (gotchoices/Fret#3): `blocked/fret-maintenance-probes-peers-off-its-ring`.

Also check whether 1.16.0/1.17.0 settle `blocked/optimystic-failed-cancel-strands-the-writers-pend-record`, `blocked/optimystic-ping-handler-timeout-below-the-monitor-deadline`, `blocked/optimystic-write-made-alone-owes-no-one` and `blocked/fret-maintenance-deadlines-below-the-declared-link`; settle only those whose upstream fix you can name.

## Steps

1. `yarn upgrade:optimystic` (it runs `ncu` for `@optimystic/*`, `yarn install` and `yarn check:dep-ranges`). Raise any declared `p2p-fret` range the same way if one exists. Never build or install inside `../optimystic` or `../Fret`.
2. `.release-notes.pending.md`: what 1.17.0 changes for a Sereus user (fewer requests per cold read, per idle check and per multi-collection commit; catalog-only column changes for control schema migrations; retry backoff on slow links), in the file's existing style.
3. Re-run `MESSAGE_COST_MEASURE=1 yarn workspace @serfab/integration-tests exec vitest run message-cost-accounting` (all three cases; one case per command if a run nears the ten-minute command limit). Update the scenario's baseline doc comment with a new dated block beside the 2026-10-19 one (do not overwrite it), and say in one line per case what moved: the joiner's `addStrand` `sync` count (#39), the join window's `cluster` counts (#42), the idle minute's upkeep pings (Fret#3) and the cadre cases' idle `sync` (#43).
4. **Settle each blocked ticket above** with the evidence from step 3 or a targeted spec:
   - fix fully shipped and measured → move it to `complete/` with a short summary naming the optimystic version and the measurement;
   - fix partly shipped (#42) → keep it in `blocked/`, rewrite its status paragraph to say what shipped, what remains and the upstream ticket it now waits on;
   - `optimystic-catalog-only-alter-table` → complete, so `control-store-migrates-on-start` becomes runnable; do not start that ticket here.
5. Gate: `yarn lint`, `yarn typecheck`, each workspace's tests, and the integration scenarios in batches under the ten-minute command limit, as `complete/strand-watcher-change-driven-verification` ran them. A full `yarn check` in one command exceeds the limit; say so in the handoff rather than skipping batches. Record any failure that predates this ticket through `tickets/.pre-existing-error.md` as the rules say.

## Edge cases & interactions

- **The stale-build guard.** If optimystic is mid-ticket and its `dist` is stale, stop and move this ticket to `blocked/` naming the stale package and time; do not build the sibling.
- **Pinned budgets** (`control-start-storage-op-budget`, `strand-solo-write-budget`, `control-founding-consult-budget`) may move with 1.17.0's read-path changes. Re-pin each that moves with a new `MEASURED_ON` and a history line naming this ticket; a budget that moves the wrong way (more operations) is a finding to report, not to re-pin silently.
- **Embedding apps.** `blocked/report-dependency-floor-bump-to-embedding-app` is the standing note to tell embedders about floor bumps; add 1.17.0 to it if its form asks for that.

## TODO

- Steps 1–5; handoff lists the before/after table from step 3 and each blocked ticket's disposition.
