description: A machine joining a strand now reads every membership table, not just the strand's header and app tables, before it may write, so the membership rows it writes right after joining add to the founder's copy of those tables instead of starting a second one; the wait budget for joining was raised from 300 s to 360 s because the extra reads made the slowest measured attach slower.
architecture: docs/strands.md#joining-no-writes-before-the-first-sync
files: packages/cadre-core/src/strand-first-sync-gate.ts, packages/cadre-core/test/strand-first-sync-gate.spec.ts, packages/cadre-core/src/types.ts, packages/cadre-core/src/strand-instance-manager.ts, docs/strands.md, docs/architecture.md, docs/cadre-consistency.md, tickets/backlog/debt-first-sync-gate-leaves-index-trees-unfetched.md
----
# Review: the first-sync gate reads every `Strand` table

## What changed

`strand-first-sync-gate.ts`: `appTables` is replaced by `schemaTables(db, schemaName)` (a schema's non-view tables, none when the schema is absent) and `writableTables(db)`, which returns every `Strand` table except `Header` (compared case-insensitively), then every `App` table. `strandFirstSyncComplete` loops over `writableTables`. The loop, the serialization, `FirstSyncProgress`, the wake schedule and the Header-first read are unchanged. On the current `Strand` schema that is seven extra reads: `Invite`, `ConsumedInvite`, `CancelledInvite`, `Member`, `MemberPeer`, `Manager`, `Revocation`.

The invariant wording moved from "the Header and every `App` table" to "every `Strand` and `App` table" in: the module comment (invariant, "Why the other tables too" paragraph, probe-read paragraph), the class comment, the `strandFirstSyncComplete` comment, `probeOnce`'s comment, the gate-opened log line, the `buildStrandRuntime` comment in `strand-instance-manager.ts`, the `strandFirstSync` doc in `types.ts`, `docs/strands.md` (invariant, gate bullet, founder bullet with the backlog reference removed) and `docs/architecture.md` (`syncing` row and state-diagram edge).

## The budget moved: 300 s → 360 s (please weigh this)

The measurement the ticket asked for crossed the 100 s line in the rule on `DEFAULT_STRAND_FIRST_SYNC_TIMEOUT_MS`, so I applied that rule as the ticket said: 3 × 105.9 s = 318 s, rounded up to the next whole minute = **360 s**. Updated with it: the constant, its closing paragraph and accepted-tradeoff `NOTE:` ("six minutes to report instead of two"), the backstop comment's "1% of that 360 s budget", `docs/architecture.md` "Known limits" bullet, and the `docs/cadre-consistency.md` table row.

What I measured (`@optimystic/*` 1.17.0, 1 500 ms one-way, `pipelined`), recorded as a dated paragraph on the constant:

- `fresh`: writable at 28.7 s, not gated (same as 1.15.0).
- `reattach-empty`, with this change: writable at 105.8 s and 105.9 s over two runs. Timing channel: first build fails at 7.0 s (no seed peer answered, `deferUnreachableJoin`), strand node connected at 15.1 s, retried `connectToStrand` 21.2 s, then the caller's first probe **72.6 s**, passing with no read failing (the gate never armed, so no `Strand.*` probe failures were logged; the ticket's "how many `Strand.*` reads failed" is zero).
- `reattach-empty` baseline, with `writableTables` temporarily cut back to `App` only (restored afterwards, `dist` rebuilt from the final source): probe 12.1 s, writable at 45.4 s, row at 63.5 s.

So the seven `Strand` reads added about 60 s on that arm, about 8.6 s each, more than the ticket's 42 s upper bound (it assumed about 6 s per consult). I did not find out why each costs more than a single consult; the comment says only what was measured. What the reviewer should weigh:

- In the baseline the membership loop still has to read those `Strand` tables after publication before it can seat the joiner, so the time until the joiner's membership rows land probably moved less than 60 s. I did not measure when those rows landed; the scenario does not report it.
- The `reattach-kept` arm was not run. One run per arm (two for `reattach-empty` with the change).
- Logs: `tickets/.logs/debt-first-sync-gate-reads-every-strand-table.measure*.log` (pruned automatically).

## Tests

- Extended 'reads one row per table, the Header first, then Strand, then App, stops at the first failing table, and never re-reads what settled' (`strand-first-sync-gate.spec.ts`). `fakeDatabase` now takes `strandTables` (answered from `getSchema('Strand')`, with `Header` included to prove it is read once), and `unreachable` takes qualified names (`'Strand.Member'`, `'App.Message'`). The test asserts: no Header, nothing else read; then Header → `Strand.Invite` → `Strand.Member` (fails, so no `App` read); then `Strand.Member` → `App.Participant` → `App.Message` (fails); then only `App.Message` → `App.Seat`. This pins which tables the gate covers and in what order. Against the old code it fails at the second probe.
- No new test otherwise. The spec header comment now says the manager double declares no schemas.

Ran: `yarn workspace @serfab/cadre-core test` (187 files, 2540 passed, 1 skipped), cadre-core `typecheck`, `yarn lint`, and these integration scenarios, all passing: `blind-relay-phone-to-phone-e2e`, `joiner-first-commit-over-slow-relay` (its existing `it.fails` still reports as an expected fail), `strand-membership-closed-strand-e2e`, `strand-chat-participants-converge`. `message-cost-accounting` is opt-in and was skipped. Its "8 block reads from the table probes" figure on the constant is a dated 1.15.0 record and would be higher now; I left it as recorded rather than re-running it.

## Index trees (the ticket's open question)

I read the plugin (read-only). The probe's `select 1 from T limit 1` is a full scan, and the plugin's live read refreshes only the main tree on a full scan (`optimystic-module.ts` ~1450-1474). Index trees are refreshed only by an index scan or by their own `sync()` at write time. So on a launch with no seed, where schema apply staged every tree empty in memory, the gate can open with a table's index and unique-enforcement trees still unfetched. That affects `Strand.Member`, `MemberPeer` and `Manager` (`StampId ... unique`) as much as `App` tables. I filed it as `tickets/backlog/debt-first-sync-gate-leaves-index-trees-unfetched.md` (`repro: static`, with how to confirm it) and did not widen this change.

## Edge cases (all by inspection, unchanged from the ticket)

- Founder, and a restart or hibernation wake over a complete store: every read answers locally, so the launch is never gated. Covered by the existing manager tests.
- A member restarting offline over a kept store that lacks one `Strand` table's collection is now gated until a peer answers. This is intended, and the existing strands.md sentence "decided by what the local store actually holds" already covers it.
- A missing `Strand` schema yields no entries. The Header read before it already fails in that case.
- `App.Member` and `Strand.Member` are separate `progress.tables` keys.
- A strand founded before `strand-founder-commits-every-table-collection` with no `ConsumedInvite`/`CancelledInvite`/`Revocation` collection settles when the founder is reachable and waits when nobody is. No compatibility work was done, per AGENTS.md.
