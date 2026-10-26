description: A joining machine's first-sync check makes sure it has fetched each table's rows from the founder before it may write, but not each table's indexes, so in a narrow window a joiner could start its own copy of an index and lose entries the founder made.
architecture: docs/strands.md#joining-no-writes-before-the-first-sync
files: packages/cadre-core/src/strand-first-sync-gate.ts (`tableReadable`, `probeSql`, the `NOTE:` on `strandFirstSyncComplete`), ../optimystic/packages/quereus-plugin-optimystic/src/optimystic-module.ts (read-only: the live-read refresh at ~1450-1474, `openIndexTree` ~3714, `ensureUniquePopulated` ~2283)
repro: static
severity: corruption
likelihood: unusual
tradeoffs: The window needs a joiner launched with no seed peer and a disconnect timed between the gate opening and backfill delivering an index's blocks, so a maintainer may judge it too narrow to pay for, and the clean fix (a read that refreshes every tree of a table) may belong in Optimystic, whose repository this project cannot edit.
----
# The first-sync gate does not fetch a table's index trees

## What the gate establishes today

Each table in Optimystic is stored as several collections: the main tree holding the rows, one tree per declared index, and one unique-enforcement tree per `unique` column (`<table uri>/index/<name>`). The first-sync gate (`strand-first-sync-gate.ts`) holds a joining machine's database back until a serialized `select 1 from <table> limit 1` of every `Strand` and `App` table has settled. Its reason: a write to a collection this machine has not fetched creates a second, private history of it, and Optimystic later keeps one history and drops the other's entries.

That probe is a full scan. In the plugin's live read (`optimystic-module.ts`, ~1450-1474) a full scan refreshes the main tree (`mainTree.update()`) and refreshes an index tree only when the plan scans that index. So a settled probe read shows the main tree was fetched and says nothing about the table's index or unique-enforcement trees.

## When that matters

Opening a table opens its index trees through the same `createOrGetCollection` call as the main tree, so on a launch whose seed peer answers, an index tree the founder committed is fetched at open, and one the cohort cannot reach makes the open throw. The gap is the launch with no seed: schema apply opens every table before any peer has answered, and each tree, index trees included, is staged as an empty collection in memory. The probe's refresh later adopts the founder's main tree; nothing adopts the index trees until the first write to that table (each tree's `sync()` refreshes before it pushes) or an index scan.

If the joiner then loses the founder, and backfill has not yet delivered an index tree's blocks, the first write to that table refreshes the index tree against a cohort of only itself. Whether that rules the tree absent (and the write commits a second history) or throws `cohort-unreachable` is the same unsettled question the gate's main-tree reads avoid. If it rules absent, the index forks: index seeks on either machine miss the other's entries, and a unique check can admit a duplicate.

The tables the membership loop writes right after the gate opens carry unique-enforcement trees (`StampId ... unique` on `Strand.Member`, `Strand.MemberPeer` and `Strand.Manager`), so this is the same window `debt-first-sync-gate-reads-every-strand-table` closed for main trees.

## What would confirm it

Run `harness-topology`'s cross-party share (a joiner launched with no seed, dialed afterwards) and print, right after the gate opens, the joiner's revision for each index tree of `Strand.Member` (the plugin's read-revision debug line, `../optimystic/docs/debugging.md` → "Which revision did a read descend?", reports `rev=none` for a collection that has never adopted a revision). `rev=none` on an index the founder committed confirms the gap; then cut the founder off before backfill and write a `Member` row to see whether the write forks or throws.

## Expected behaviour

When the gate opens, every collection of every table the machine may write, index and unique-enforcement trees included, has been fetched from a peer or is held locally, exactly as the main trees are.

## Optimystic 1.19.0 (2026-10-25, `adopt-optimystic-1-19-0`)

Still open. 1.19.0's change hold (gotchoices/Optimystic#47) delays a table's change event on a machine that pended the same commit's index collections until those land too. That does not reach this gap: the gate probes on the storage-wide feed, which is never held, and the gap is an index tree the joiner never fetched, not a wake that came too early.
