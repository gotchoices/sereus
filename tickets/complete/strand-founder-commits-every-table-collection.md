description: When a strand is founded, the founder now creates an empty storage collection for every table the strand declares, so reading a table nobody has written is answered from the machine's own store instead of asking the other member, and still works while the other member is offline (GitHub #47).
architecture: docs/strands.md#joining-no-writes-before-the-first-sync
files: packages/quereus-plugin-sereus/src/empty-collections.ts, packages/quereus-plugin-sereus/src/compose-strand.ts, packages/quereus-plugin-sereus/src/types.ts, packages/quereus-plugin-sereus/README.md, packages/quereus-plugin-sereus/test/e2e/empty-collections.e2e.spec.ts, packages/cadre-core/src/strand-membership-writer.ts, packages/cadre-core/src/strand-database.ts, packages/cadre-core/src/strand-first-sync-gate.ts, packages/cadre-core/test/strand-solo-write-budget.spec.ts, packages/cadre-core/test/control-founding-consult-budget.spec.ts, packages/cadre-core/test/strand-spec-helpers.ts, packages/integration-tests/src/scenarios/strand-read-cost-over-relay.integration.ts, docs/strands.md, docs/architecture.md
----
# The founder commits every declared table's collection before its Header

## What was built

Optimystic creates a table's collection only on its first write, so before this a table nobody had written had no collection: every read of it asked the other member (about two relayed round trips) and threw `BlockUnavailableError` (`cohort-unreachable`) with the other member offline.

- **Plugin** (`@serfab/quereus-plugin-sereus`): `SereusPluginResult.createEmptyCollections(): Promise<number>` (`src/empty-collections.ts`). It opens every non-view Optimystic table in the `Strand` and `App` schemas (which registers its main, index and unique-enforcement trees with the transaction bridge), throws naming the table if any declared table's main collection is not registered, then `sync()`s every registered collection still in Optimystic's invented state and returns the count.
- **cadre-core**: `FounderBootstrapParams.createEmptyCollections` is required; `StrandDatabase` passes the composition's step. `bootstrapFounderMembership` → `foundIfHeaderAbsent`: when no `Strand.Header` row exists, `createDeclaredCollections` (logs count and elapsed ms) then `insertHeader`; when the Header exists, both are skipped. Peer-join backfill hands the collections to joiners.
- Measured cost (NOTE on `createDeclaredCollections`, with the batching tripwire): about 23 ms per collection on `FileRawStorage`, once per strand; 20 collections took 465–486 ms, the reference chat schema's 13 took 298–350 ms.
- Budgets re-baselined at optimystic `28e6e044`: solo launch 80 → 380 operations (17 → 39 blocks), solo insert 88 → 78 with its budget tightened to 88 so it still catches the return of the 11 no-op `deletePendingTransaction` calls; `foundStrand` strand side 21/15/3 → 30/16/15 consults/blocks/commits. Two control-side figures moved without this change (idle reconcile 4 → 5, marker table 6 → 5) and are recorded as unattributed.
- Docs: `docs/strands.md` "Joining" (rule bullet; first residual narrowed to tables a later schema version adds, `backlog/feat-strand-tables-added-by-a-later-schema-get-their-collection`), `docs/architecture.md` § Strand Membership Bootstrap, plugin README section.
- Tests: `empty-collections.e2e.spec.ts` (commits > 0, a reopen over the same storage commits 0); `strand-read-cost-over-relay.integration.ts` reproduces #47 (all 51 reads per pass local with the other member connected; none fail with it stopped).
- Known consequence, filed by the implementer: arms 4 and 5 of `joiner-first-commit-over-slow-relay` now fail, because the joiner is connected to the founder when it becomes writable and its first commit needs the founder's approval over a link that resets the connection: `fix/slow-link-restart-arms-lost-their-lone-commit` (prereq: this ticket).

## Review findings

Read the diff of `ticket(implement): strand-founder-commits-every-table-collection` and the plugin files from the interrupted earlier run (`39eb312f`), then the gate, `StrandInstanceManager.foundExistingStrand` / `ensureFounderBootstrap` / `attachSApp`, and Optimystic's absence ruling (`CoordinatorRepo.absenceFlagFor`, read only).

**Runs (this pass):** `yarn lint` and `yarn typecheck` clean; `@serfab/quereus-plugin-sereus` 13 files, 157 passed, 1 todo; `@serfab/cadre-core` 184 files, 2522 passed, 1 skipped; `strand-read-cost-over-relay` on the 100 ms link passed (founded in 931 ms; max read 1–4 ms on both sides connected, 3 ms on the founder with the joiner stopped, no streams opened, no failures; phone arm opt-in, not run). `joiner-first-commit-over-slow-relay` was not re-run; the implementer's evidence of arms 4 and 5 failing is in the fix ticket.

**Correctness, checked and found sound:**
- Header guard: the step runs only when the Header count is 0, before the Header insert, so a crash between them repeats it and commits only what is still invented. A founder resume (retained `founder: true`) finds the Header and pays one count read.
- `foundExistingStrand` on a tracked joiner or storage replica: the step can run only against a database still behind the first-sync gate (a published one holds the Header), which no app writer or background loop can reach; `attachSApp` runs before it, so a replica's `App` tables are declared when the step opens them.
- Error path: a failed `sync()` propagates out of the bootstrap, so a fresh launch rolls back and an in-place founding withdraws its founder flip, as for any other bootstrap failure.
- Durability listeners see nothing from these syncs (they bypass the SQL transaction bridge); no app asks about those collections, so that is correct.
- Budget re-baselines: each figure's movement is explained in its comment and the insert budget was tightened, not loosened; the unattributed control-side figures are stated as unattributed rather than absorbed.

**Major, filed:** the first-sync gate reads the Header and every `App` table before a joiner may write, but not the other `Strand` tables the membership reconciler writes on the joiner (`ConsumedInvite`, `Member`, `MemberPeer`). Those now all have a collection on the founder, so a joiner that loses its connection after becoming writable and before backfill delivers one could create a second copy (static; `Member`/`Manager`/`Invite`/`MemberPeer` were already exposed before this change, which widened it to `ConsumedInvite`, `CancelledInvite`, `Revocation`). Filed at the boundary-invariant rung, "the gate reads every table this machine may write": `backlog/debt-first-sync-gate-reads-every-strand-table`.

**Minor, fixed:** `docs/strands.md` claimed "no joiner can invent a collection that already exists", which the gate's coverage does not guarantee. Reworded to what holds (tables the gate reads) and linked the new backlog ticket.

**Considered, not filed:**
- A founder whose store was wiped but whose peer id survived, restarting alone, would read the Header as absent and now commit every table's collection beside the joiners' copies. That fork already happened through the Header insert before this change, and it needs the control database to survive while the strand store does not; no change.
- `strand-database.ts` passes `this.createEmptyCollections!`; it matches the file's existing `this.db!` pattern, set in `initialize()` before either bootstrap path can run.
- `openTables` quotes the table name but not the schema name; the schema names are the fixed `Strand` and `App`.
- Founding-time cost (≈4.75× storage operations for a solo launch): once per strand and measured; the batching tripwire is already recorded as a `NOTE:` on `createDeclaredCollections`, not a ticket.

**Tests:** the one new plugin e2e test pins the invented-versus-committed branch and passes its bar; the integration scenario is the bug's reproduction. No cadre-core unit test for the Header guard (one `if`, exercised by every spec that founds through the helpers); none added in review, as the filed gap needs a design choice first, not a test.

**Docs read:** `docs/strands.md` (Joining), `docs/architecture.md` (Strand Membership Bootstrap), plugin README, the gate's module comment. Accurate after the one reword above.
