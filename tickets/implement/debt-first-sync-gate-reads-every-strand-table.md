description: A machine joining a strand must read every membership table, not just the strand's header and app tables, before it may write, so that the membership rows it writes right after joining always add to the founder's copy of those tables instead of starting a second, conflicting copy.
architecture: docs/strands.md#joining-no-writes-before-the-first-sync
files: packages/cadre-core/src/strand-first-sync-gate.ts (`appTables`, `strandFirstSyncComplete`, module comment, `StrandFirstSyncGate` class comment, the open log line, `DEFAULT_STRAND_FIRST_SYNC_TIMEOUT_MS` comment), packages/cadre-core/test/strand-first-sync-gate.spec.ts (`fakeDatabase`, 'reads one row per table…'), packages/cadre-core/src/types.ts (~line 942, `strandFirstSync` doc), docs/strands.md (invariant paragraph ~228, the gate bullet ~234, the founder bullet ~239), docs/architecture.md (~1715 and ~1724, the `syncing` row and state diagram), packages/integration-tests/src/scenarios/strand-reattach-first-sync-measure.integration.ts (run only, for the measurement)
difficulty: medium
----
# The first-sync gate reads every declared table this machine may write

## Why

The first-sync gate (`strand-first-sync-gate.ts`) withholds a joining machine's database until it holds `Strand.Header` and a one-row read of each `App` table has settled. Its reason: a write to a table whose collection this machine has not fetched creates a new collection, and with no strand peer connected that is a second history beside the founder's; Optimystic keeps one and drops the other's rows.

The membership reconciler writes `Strand` tables on the joiner about a second after the database is published (`ConsumedInvite` and `Member` when it redeems its invitation, then `MemberPeer`), and a manager machine can write `Invite`, `CancelledInvite`, `Manager` and `Revocation`. None of those are read by the gate. They reach the joiner by peer-join backfill, separately from the Header and the `App` tables. If the joiner loses the founder after becoming writable and before backfill delivers one of them, and Optimystic then rules that table's block absent with a self-only cohort, the reconciler's insert creates a second collection and one side's rows are lost (for `ConsumedInvite`, a spent invitation goes unrecorded). This is inferred from the code, not observed; whether a disconnected joiner rules an unheld block absent or reports `cohort-unreachable` was not settled. It does not need settling: the gate's own invariant ("never write a table this machine has not fetched") is the fix either way, and since `strand-founder-commits-every-table-collection` every declared `Strand` table has a collection from founding on, so a settled read of one means its collection was fetched.

## The change

`strandFirstSyncComplete` reads, after the Header, every non-view table of the `Strand` schema except `Header` itself, then every non-view `App` table, one after another, stopping at the first that fails, skipping what `progress` already records. Replace `appTables(db)` with one function returning `{ schema, name }` entries for both schemas in that order (Strand first: a fixed set every strand has; App second), built from one helper that lists a schema's non-view tables. Nothing about the loop, the serialization, the wake schedule or `FirstSyncProgress` changes: `progress.tables` is already keyed by qualified name, so `Strand.Member` and an app's `App.Member` stay distinct.

Exclude `Header` by name, compared case-insensitively (SQL identifiers are), because it is read first and alone, and its read has a different meaning (held = a row came back) from a table read (settled = no throw).

A missing `Strand` schema yields no entries, as a missing `App` schema does today. The Header read before it already fails when the `Strand` schema is absent, so no separate check is needed.

Update every place that states the invariant as "the Header and every `App` table" to "the Header and every `Strand` and `App` table":

- the module comment's invariant, its "Why the app tables too" paragraph (extend it: the same holds for the `Strand` tables the membership loop writes), and the probe-read paragraph; the `NOTE:` at its end already says "app and membership tables" and stays;
- the `StrandFirstSyncGate` class comment, the `strandFirstSyncComplete` comment, and the log line `first-sync gate opened: …`;
- `types.ts` `strandFirstSync` doc;
- `docs/strands.md`: the bold invariant (~228), the gate bullet (~234, "of each table the sApp declared in `App`"), and the founder bullet (~239): drop the sentence ending in `backlog/debt-first-sync-gate-reads-every-strand-table` and say the gate reads every `Strand` and `App` table;
- `docs/architecture.md` ~1715 (`syncing` row) and ~1724 (state-diagram edge label).

Docs describe the system as it is now: do not narrate that the gate used to skip the `Strand` tables.

## Measurement

The ticket that filed this asked for the added time on a gated join to be measured and recorded against `DEFAULT_STRAND_FIRST_SYNC_TIMEOUT_MS`. Bound it first: on a gated join where backfill has already delivered the `Strand` tables, the seven extra reads answer locally (milliseconds). Where it has not, each costs a consult, about 6 s at the supported link per the 1.8.0 figures in that constant's comment, so up to seven consults, about 42 s, serialized. That is an upper bound computed from those figures, not a measurement; against the worst harness sample of 64 s on 1.8.0 it would cross the 100 s rule the comment sets, so the measured figure decides whether the budget moves.

Measure on the arm that is gated at the supported link, after the code change:

```
REATTACH_SYNC_MEASURE=1 REATTACH_DELAY_MS=1500 REATTACH_ARMS=reattach-empty,fresh REATTACH_RUNS=1 DEBUG=sereus:cadre:strand-first-sync yarn workspace @serfab/integration-tests exec vitest run strand-reattach-first-sync-measure
```

Run it in the foreground (it streams progress). Record per arm: whether it was gated, writable time from the `addStrand` call, and, from the `sereus:cadre:strand-first-sync` debug lines, how many `Strand.*` probe reads failed before the gate opened and how long the probes spent on `Strand.*` reads. Add the result as one dated paragraph to the `DEFAULT_STRAND_FIRST_SYNC_TIMEOUT_MS` comment ("AT THE SUPPORTED LINK ON `@optimystic/*` <version> (<date>), probe reads every `Strand` table …"), keeping its existing structure, and apply its stated rule: keep 300 s while the worst harness sample is at most 100 s, else raise to 3x the worst sample rounded up to the next whole minute. Check the installed `@optimystic/*` version from `node_modules/@optimystic/db-core/package.json` rather than assuming.

If the run hits the stale-build guard on a sibling's `dist`, stop the measurement and record in the review handoff that it is blocked on the sibling build (project rule: never build a sibling). If one run takes more than about 10 minutes of wall clock, record it as deferred to a human rather than skipping silently.

## Edge cases & interactions

- **Founder, and a restart or hibernation wake over a complete store.** Every read answers locally; the first probe still passes and the launch is never gated. Verified by the existing manager tests ('a founder launch publishes its database at once', 'a non-founder over a store that already holds the Header comes up active').
- **A member restarting offline over a kept store that lacks one `Strand` table's collection.** Before this change it came up writable; now it is gated until a peer answers. Intended, by the existing rule that "has synced before" is decided by what the store holds: writing a table it does not hold would fork it. By inspection; mention it in the strands.md gate bullet only if the existing "decided by what the local store actually holds" sentence does not already cover it (it does — leave it).
- **An open strand.** The reconciler writes no membership rows, but the founder still commits an empty collection for every `Strand` table, so the reads settle from backfill. Cost only, no behaviour change. By inspection.
- **A strand founded before `strand-founder-commits-every-table-collection`,** where `ConsumedInvite`, `CancelledInvite` or `Revocation` has no collection. With the founder reachable the read is ruled absent and settles (staged empty in memory, not committed); with nobody reachable it throws and the gate waits. No compatibility work is wanted (AGENTS.md: no backwards compat yet). By inspection.
- **An app table named like a `Strand` table** (`App.Member`). Distinct qualified names in `progress.tables`; both read. By inspection.
- **Index and unique-enforcement trees.** Opening a table opens its index trees through the same `createOrGetCollection` path as the main tree (`optimystic-module.ts` `openIndexTree`), so an unreachable index tree makes the table's initialization throw. Not checked: whether the serialized probe read refreshes an index tree that schema apply staged empty before any peer answered, the way it refreshes the main tree (the `NOTE:` on `strandFirstSyncComplete`). That question applies equally to `App` tables and is outside this change; check by reading the plugin (read-only), and if it does not, file a `debt-` backlog ticket with `repro: static` rather than widening this one.
- **The probe's failure path.** A throw from the `Strand` schema lookup is caught by `probeOnce`'s outer guard exactly as the `App` lookup's is. Covered by the existing 'a throwing read, or a throw outside the read guards…' test.
- **Membership reconciler timing.** Unchanged: it is kicked at publication (`publishDatabase`), which now happens only after the `Strand` tables settled, so its first pass appends.

## Tests

Extend the existing unit test 'reads one row per table, the Header first, stops at the first failing table, and never re-reads what settled' rather than adding one: give `fakeDatabase` a `strandTables` list (include `Header` in it, to prove it is not read twice) answered from `getSchema('Strand')`, match `from Strand\."(\w+)"` for unreachable tables alongside `App`, and assert the read order Header, then the `Strand` tables other than Header, then the `App` tables, with a failing `Strand` table stopping the probe before any `App` read. That pins which tables the gate covers, the one piece of branching this change adds. No integration test: the fork it prevents needs a disconnect timed inside a backfill window, and the measurement run above exercises the real path.

## TODO

- Replace `appTables` with a function listing the non-view tables of `Strand` (minus `Header`, case-insensitive) then `App`; use it in `strandFirstSyncComplete`.
- Update the module comment, class comment, `strandFirstSyncComplete` comment and the gate-opened log line.
- Extend `fakeDatabase` and the 'reads one row per table…' test as above.
- Update `types.ts` `strandFirstSync` doc, `docs/strands.md` (~228, ~234, ~239, removing the backlog reference) and `docs/architecture.md` (~1715, ~1724).
- Read the plugin's index-tree refresh path; file a `debt-` backlog ticket if index trees are not refreshed by a serialized read.
- `yarn workspace @serfab/cadre-core test strand-first-sync-gate strand-instance-manager`, `yarn lint`, and the cadre-core type check.
- Run the measurement, record it on `DEFAULT_STRAND_FIRST_SYNC_TIMEOUT_MS`, apply the 100 s rule.
