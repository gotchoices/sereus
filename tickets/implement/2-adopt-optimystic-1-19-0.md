description: Sereus moves onto Optimystic 1.19.0, which sends a write spanning several tables in one round of requests and lets larger writes and blocks travel between machines. This pass records what that changed, settles the waiting tickets it answers, writes the release notes, and runs the full release gate so Sereus can be released.
prereq: backfill-pushes-blocks-in-the-optimystic-1-19-form, hermes-text-decoding-and-cloning-fast-paths
architecture: docs/testing.md#declared-dependency-range-vs-linked-workspace-keep-them-equal
files: .release-notes.pending.md, packages/integration-tests/src/scenarios/message-cost-accounting.integration.ts (dated blocks at the end of the doc comment), packages/integration-tests/src/scenarios/joiner-first-commit-over-slow-relay.integration.ts (`it.fails` frame-cap arm ~584-592), docs/cadre-consistency.md ("Deadlines Below Cadre"), tickets/blocked/optimystic-multi-collection-commit-costs-four-requests-per-collection.md, tickets/blocked/optimystic-write-made-alone-owes-no-one.md, tickets/blocked/forked-control-collection-sync-livelocks.md, tickets/blocked/fret-maintenance-deadlines-below-the-declared-link.md, tickets/blocked/decide-link-deadlines-from-measured-response-time.md, tickets/.pre-existing-known.md, tickets/.garden-report.md, ../optimystic/tickets/complete/ (read only)
----
Optimystic 1.19.0 is on npm (tag `v1.19.0`, `f1f774ea`). The floors were raised to `^1.19.0` by `backfill-pushes-blocks-in-the-optimystic-1-19-form`, which also fixed the one API break (`pushBlocks`, GitHub #52). This ticket follows the shape of `complete/adopt-optimystic-1-17-0`; read it first.

## What 1.19.0 contains

**Upstream's `.release-notes.pending.md` lists only two of these changes** (the held-block consult cap and the remote-cancel reply). For the rest, read each ticket in `../optimystic/tickets/complete/` (all landed between `v1.18.0` and `v1.19.0`; `git -C ../optimystic log --oneline v1.18.0..v1.19.0`):

- `a-transaction-pends-and-commits-its-collections-together`: GitHub #42 in effect. A transaction writing several collections sends one reservation request and one commit request per member for all of them. Upstream measured a one-row insert into a table with five indexes, on a two-machine group, at 3 cluster requests instead of 24.
- `bug-a-commit-cert-is-looked-up-by-action-alone`: each collection's change notification carries its own round's signatures (found with #42).
- `a-transaction-larger-than-the-control-frame-can-commit`: writes over about 1 MiB no longer fail once a second machine shares the data; an oversized transaction is refused on the writer by name.
- `a-log-block-rolls-over-by-size`, `a-tree-node-splits-by-size`, `a-writer-refuses-a-block-too-large-to-copy`, `a-block-copy-travels-unencoded`, `a-remote-read-reply-fits-one-message`: every block stays under `MAX_BLOCK_BYTES`, so it can always be copied in one message.
- `a-watch-wakes-after-every-collection-of-a-commit-applies`: a watcher woken by a remote write is woken only after the table's indexes have also arrived.
- `the-reactivity-backstop-check-costs-nothing-while-idle`: the 20–30 s reactivity backstop reads all watched tables in one read per tick (upstream measured an idle phone watching 18 tables at about 54 requests a minute before).
- `a-read-does-not-reassemble-its-cohort-from-the-peer-store`: reads stop re-reading peer records from libp2p's peer store.
- `joins-over-optimystic-tables-get-the-plans-memory-tables-get`: the planner gets in-memory-table row estimates, so joins pick hash joins and index seeks.
- `a-held-block-consult-cap-counts-requests-not-blocks`, `a-remote-cancel-that-succeeds-is-reported-as-a-failure` (GitHub #46 upstream): as in upstream's notes.

The Quereus peer range is unchanged (`^4.20.3`). Check whether `db-p2p`'s `p2p-fret` range moved.

## Required work

- **Measure #42.** `MESSAGE_COST_MEASURE=1 yarn workspace @serfab/integration-tests exec vitest run message-cost-accounting`, all cases, one run, tee'd to `tickets/.logs/`. Add a new dated block at the end of the scenario's doc comment (do not overwrite earlier blocks) with the before/after table against the 2026-10-21 run. The rows to watch are `cluster` on the strand first insert and the settle window, which stayed unchanged through 1.17.0 and 1.18.0.
- **Settle `blocked/optimystic-multi-collection-commit-costs-four-requests-per-collection`** from that measurement: move it to `complete/` with the numbers if the per-collection cost is gone, or rewrite its status if not.
- **Recheck the other upstream-blocked tickets**: `optimystic-write-made-alone-owes-no-one`, `forked-control-collection-sync-livelocks`, `fret-maintenance-deadlines-below-the-declared-link`, and the phone-arm series on `decide-link-deadlines-from-measured-response-time`. Give each a dated recheck line, or move it if 1.19.0 resolves it. Do not route anything to `blocked/` for "upstream not done" without naming the upstream ticket.
- **The frame-cap `it.fails` arm** in `joiner-first-commit-over-slow-relay` fails on purpose. If 1.19.0's frame changes make it pass, `it.fails` turns red. Follow the instructions in its own comment (~587) rather than loosening it.
- **Sereus-side workarounds upstream may have made unnecessary.** Look for code or comments that work around (a) a watch wake arriving before index trees (strand reactivity, the first-sync gate, `debt-first-sync-gate-leaves-index-trees-unfetched` in backlog), (b) the 1 MiB control frame, or (c) per-table backstop cost. Correct comments and docs that describe pre-1.19 behaviour. File removals of real code as backlog `debt-` tickets, not inline, unless they are one-line comment fixes.
- **Deadlines Below Cadre** in `docs/cadre-consistency.md`: re-stamp at 1.19.0 (`f1f774ea`). Diff `rpc-deadline.ts`, `cluster-policy.ts`, `cluster-coordinator.ts`, `cluster/structs.ts`, `collection-factory.ts` and any new reactivity-backstop timing between `v1.18.0` and `v1.19.0`, and change only the rows that moved.
- **Release notes.** `.release-notes.pending.md` is empty after v1.18.0. Write the Sereus release: Fixes (#52; #51 from its own ticket), Dependencies (Optimystic 1.19.0, with one line per upstream change that a Sereus embedder can observe), Known limitations. **One limitation must be stated plainly:** cadre-core 1.18.0 installed fresh resolves Optimystic 1.19.0 and its joins silently receive nothing (#52); an embedder on 1.18.0 must upgrade, or pin `@optimystic/*` to `~1.18.0`. Follow the existing house style of these notes (see git history of the file).
- **Gate**, as the 1.17.0 adoption ran it: `yarn lint`, `yarn typecheck`, `yarn build`, every workspace's tests, the root `test:*` suites, all integration files in batches each under the 10-minute idle limit (tee each batch to `tickets/.logs/adopt-optimystic-1-19-0.it-*.log`), and `node scripts/smoke-published-install.mjs --skip-build` against the published 1.19.0. Check `tickets/.pre-existing-known.md` for every red before reporting it.
- **Pinned budgets** (`strand-solo-write-budget`, `control-founding-consult-budget`, `control-start-storage-op-budget`): #42 and the size-based splits may move them. Re-pin only with a measured run and a history line, as the 1.17.0 review did.
- Append a dated entry to `tickets/.garden-report.md` saying whether Sereus is ready to release (`yarn release`).

## Edge cases & interactions

- **Mixed versions.** Upstream says #42's sender has no mixed-version handling (`296e195a`: "unblock #42 sender (no mixed-version handling)"). Find out from the upstream ticket what a 1.19.0 coordinator does with a 1.18.x member, and state that in the release notes. A party's machines (phone, cadre-host, provider) upgrade separately.
- **Size-based splits change block layout** for new writes only. Existing stores keep their blocks. Confirm from upstream's tickets that a 1.19.0 node reads blocks written by 1.18.0 without migration, and say so in the notes.
- The measurement and integration runs exercise the linked workspace. Only `smoke-published-install` exercises npm 1.19.0; it must pass.

## Tests

None expected. This ticket changes ranges (already done), docs, comments, notes and tickets. A budget re-pin is a constant change in an existing spec.

## TODO

- Read the upstream tickets listed above.
- Run and record the message-cost measurement; settle the #42 blocked ticket.
- Recheck the other blocked tickets; handle the frame-cap arm.
- Sweep for pre-1.19 workarounds and comments.
- Re-stamp Deadlines Below Cadre.
- Write `.release-notes.pending.md`.
- Run the full gate; record results in the handoff and the garden report.
