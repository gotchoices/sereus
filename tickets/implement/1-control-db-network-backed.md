description: A party's shared membership/control database lives only in each node's memory today, so a change made on one node never reaches the others; wire the control tables onto the network layer so they actually replicate, and teach the network transactor the one transaction rule the consent path needs so existing safeguards keep working.
prereq:
files: packages/cadre-core/src/control-database.ts (initialize ~156-211; redeemInvitation/recordFormationUsage/execFormationUsageInsert ~687-813), packages/cadre-core/src/control-schema.ts (CONTROL_SCHEMA; FormationUsage.Monotonic reads committed.FormationUsage ~175-195), packages/quereus-plugin-sereus/src/compose-strand.ts (connectToStrand ~227-266 — the working setDefaultVtabName+setDefaultVtabArgs+hydrate pattern), packages/integration-tests/src/scenarios/control-db-two-node-convergence.integration.ts (tripwire + skipped target to flip), packages/cadre-core/test/control-formation-invite.spec.ts, packages/cadre-core/test/strand-formation-consent.spec.ts, packages/cadre-core/test/control-authorization-binding.spec.ts (the consent tests the naive wiring breaks), docs/architecture.md (~169 "Convergence prerequisites and current status"), ../optimystic/packages/quereus-plugin-optimystic/src/optimystic-module.ts (query ~417-471; executeTableScan/executePointLookup ~496-660; connect ~1291; instantiateTable ~1230), ../optimystic/packages/quereus-plugin-optimystic/src/optimystic-adapter/txn-bridge.ts (markDirty/snapshot ~334-338; getCurrentTransaction ~309), ../quereus/packages/quereus/src/runtime/emit/scan.ts (~71-82 passes _readCommitted to module.connect), ../quereus/packages/quereus/src/vtab/memory/table.ts (~74-79,232-252 reference impl of _readCommitted), ../quereus/packages/quereus/src/vtab/module.ts (BaseModuleConfig._readCommitted ~19-22)
difficulty: hard
----

## Goal

Make the `CadreControl` tables network-backed (Optimystic network transactor) so a row
written on one cadre node converges to peers — **without** regressing the consent path.
The blocker is a single, well-localized transaction-semantics gap in the Optimystic vtab;
once that is closed, the cadre-core wiring is a near-mechanical mirror of `connectToStrand`.

This is the **foundation** ticket: `control-network-cohort-discovery` (plan/) and
`2-push-wake-replication-backed-authorization` (implement/) both assume the control store
replicates. Even with perfect connectivity, in-memory tables never replicate — this lands first.

## Root cause (confirmed in source, both sibling workspaces)

The control tables resolve to Quereus's built-in **in-memory** vtab because
`ControlDatabase.initialize()` never sets the default vtab. Simply setting it (the "spike")
flips storage to the network transactor and makes a two-node `CadrePeer` write converge
(~2.0s) — but it breaks 9 cadre-core consent tests with `CHECK constraint failed: Monotonic`.
That failure is **not** a cadre-core bug; it is a missing feature in the Optimystic vtab:

**Quereus `committed.*` semantics.** A deferred `CHECK` that references `committed.<Table>`
reads the *pre-transaction* snapshot of the table — the committed rows **excluding** any rows
the in-flight transaction has inserted. Quereus signals this to the vtab module by passing
`_readCommitted: true` in the `BaseModuleConfig` options to `module.connect()`:

- `../quereus/.../runtime/emit/scan.ts:71-82` — builds `options = { ...vtabArgs, ...(source.readCommitted ? { _readCommitted: true } : {}) }` and calls `module.connect(..., options)`.
- `../quereus/.../vtab/module.ts:19-22` — `interface BaseModuleConfig { _readCommitted?: boolean }`.
- The in-memory vtab honours it: `../quereus/.../vtab/memory/table.ts:74-79,232-252` — a `_readCommitted` connection is **unregistered** (never `begin()`s) and always scans the immutable `currentCommittedLayer`, so it never sees in-flight rows. This is the reference behaviour to reproduce.

**The Optimystic vtab ignores the flag.** `OptimysticModule.connect()`
(`../optimystic/.../optimystic-module.ts:1291`) takes `_options: OptimysticModuleConfig` and
**discards it** (note the `_` prefix), then returns the **cached singleton** table instance for
that `schema.table` key (`instantiateTable` ~1230 returns `this.tables.get(tableKey)`). Its
`query()` (~417) and the scan helpers (`executeTableScan` ~600, `executePointLookup` ~496)
read the **live** collection `Tree`, whose `Tracker` merges this transaction's *staged* inserts
on top of committed data (`../optimystic/.../db-core/src/transform/tracker.ts` `tryGet`/scan).

So when `FormationUsage.Monotonic` —
`new.UseNumber = coalesce((select max(UseNumber) from committed.FormationUsage U where U.Token = new.Token), 0) + 1`
— is evaluated at commit, the optimystic vtab returns the in-flight row too. With the freshly
inserted `UseNumber = N` already visible, `max(UseNumber) = N`, so the constraint demands
`N = N + 1` and fails. Under the in-memory vtab `committed.*` excludes that row, `max = N-1`,
and `N = (N-1)+1` holds. Same code, different snapshot view → the 9 failures.

The same pre-transaction-snapshot machinery underpins the consent path's other deferred CHECKs
(`Strand.Authorized` consent branch ↔ `FormationUsage.StrandExists`, evaluated together inside
`redeemInvitation`'s explicit `begin…commit`). Closing the `committed.*` gap is the crux; the
multi-statement-transaction and unique-`StampId` behaviours are to be **verified**, not assumed
broken (see Phase 0).

## Where the snapshot already exists

The txn-bridge already captures exactly the pre-transaction state needed: `markDirty(tree)`
(`txn-bridge.ts:334-338`) stores `tree.snapshot()` the first time a tree is staged this
transaction, and keeps that original snapshot across a multi-statement transaction (that is how
rollback restores the starting state). A `_readCommitted` scan should therefore read from that
captured snapshot when the table has been dirtied this transaction, and fall back to the live
collection (== committed state) when it has not. The design work is plumbing that snapshot into
a read path and reconciling it with the **singleton-per-table** vtab caching (a per-instance
boolean would race a concurrent live scan of the same table; prefer a per-scan committed view /
cursor rather than mutating shared instance state).

## Approach

Two phases, landing together so the suite is green at handoff (a split across repos buys no
isolation — the only proof the Optimystic change is correct is the cadre-core consent suite
staying green while the convergence test flips).

### Phase A — Optimystic: honour `_readCommitted` (the substantive change, in `../optimystic`)

Make `committed.<Table>` scans over the network transactor return the pre-transaction snapshot.
Target a per-scan committed read that does not mutate the cached singleton:

- Capture `_readCommitted` where Quereus delivers it (`OptimysticModule.connect()` options) and
  route a committed scan to read from the txn-bridge's captured `snapshot()` for that table's
  tree when it has been dirtied this transaction; else read the live collection.
- Mirror the in-memory contract precisely: a committed read sees committed rows only — never
  this transaction's staged inserts/updates/deletes — across full scans, point lookups, and
  index seeks (all three of `executeTableScan`/`executePointLookup`/`executeIndexScan`).
- Add a focused unit test in the optimystic workspace proving `committed.<Table>` excludes an
  in-flight insert (a minimal `declare schema` table with a `Monotonic`-style deferred CHECK,
  driven through `begin; insert; insert; commit`). This is the regression anchor for the fix
  independent of cadre-core.

### Phase B — cadre-core: network-back the control DB (mirror `connectToStrand`)

In `ControlDatabase.initialize()`, after registering the optimystic plugin + libp2p node and
**before** `loadSchema()`, do what `connectToStrand` does (`compose-strand.ts:227-266`):

- `db.setDefaultVtabName('optimystic')`
- `db.setDefaultVtabArgs({ networkName, transactor: 'network', keyNetwork: 'libp2p' })`
- `await pluginResult.hydrate(db)` (the plugin result already exposes `hydrate`; capture it from
  `optimysticPlugin(...)`). Hydrate-before-apply so warm restarts with persistent storage do not
  re-emit DDL for every control table — same regression `connectToStrand` guards against.

Keep the embedded `CONTROL_SCHEMA` carrying **no** per-table `using optimystic(...)`: the
default-vtab route is what makes the tables network-backed (identical to the strand schema).
Solo nodes (cohort ≤1) must still commit local-only and not hang on cluster lookups — verify
the genesis/authorization specs (which boot a lone `transaction`-profile node) stay green.

### Phase C — flip the test + docs

- Un-skip the target test and delete the in-memory tripwire in
  `control-db-two-node-convergence.integration.ts` (the file header documents this exact handoff).
- Update `docs/architecture.md:169` "Convergence prerequisites and current status": the first
  bullet ("control tables must be network-backed") is now satisfied; reframe to reflect that
  network-backing has landed and cohort discovery (`control-network-cohort-discovery`) remains
  the open prerequisite.

## Acceptance

- `CadreControl` tables are backed by the Optimystic network transactor (default vtab + args +
  hydrate-before-apply).
- A `CadrePeer` row written on one connected node becomes readable on a peer: the previously
  skipped target in `control-db-two-node-convergence.integration.ts` passes when un-skipped, and
  the in-memory tripwire is removed.
- No regression in the consent path: `control-formation-invite.spec.ts`,
  `strand-formation-consent.spec.ts`, `control-authorization-binding.spec.ts`, and the rest of
  the cadre-core suite stay green.
- Solo nodes (no peers) still work (local-only branch) and do not hang on cluster lookups.
- A unit test in the optimystic workspace pins the `committed.*`-excludes-in-flight-row behaviour.

## Risks / open questions for the implementer

- **Cross-repo commit boundary.** Phase A edits `../optimystic` (a sibling git repo linked via
  `resolutions`), which the tess runner does not commit. Land/commit the optimystic change in its
  own repo first (or coordinate with the maintainer); the sereus-side cadre-core/docs/test changes
  are what this ticket commits. Call this out explicitly in the review handoff — the green cadre
  suite depends on the optimystic change being built and linked.
- **Singleton vtab caching.** `instantiateTable` returns one instance per `schema.table`. Do not
  stash `_readCommitted` on that shared instance for the duration of a scan — a concurrent live
  scan of the same table during deferred-constraint drain would read the wrong view. Prefer a
  per-scan committed view/cursor keyed off the txn-bridge snapshot.
- **Verify, don't assume — multi-statement isolation & unique constraints.** The `Monotonic`
  failure is the confirmed gap. The circular deferred CHECKs (`redeemInvitation`'s `begin…commit`)
  and unique-`StampId`/`MemberPrivateKey` enforcement may "just work" once `committed.*` is correct,
  or may surface secondary gaps. Phase 0 below de-risks this before committing to scope.

## TODO

### Phase 0 — Reproduce & scope (do this first)

- Apply the wiring spike (Phase B edits only) on a scratch branch and run the three consent specs
  to reproduce the 9 `Monotonic` failures locally:
  `yarn workspace @serfab/cadre-core test control-formation-invite strand-formation-consent control-authorization-binding 2>&1 | tee /tmp/consent.log` (stream output — do not silently redirect).
- Confirm whether the **only** failure class is `Monotonic`/`committed.*`, or whether the circular
  deferred CHECKs / unique-`StampId` paths add distinct failures. If extra gaps exist, expand
  Phase A scope (or split a follow-up implement ticket via `prereq:`); otherwise proceed.

### Phase A — Optimystic committed-read semantics (`../optimystic`)

- Plumb `_readCommitted` from `OptimysticModule.connect()` options into a per-scan committed read.
- Route committed scans to the txn-bridge pre-transaction `snapshot()` for dirtied tables; fall
  back to the live collection when the table is clean this transaction.
- Cover full scan, point lookup, and index seek so all read shapes honour the flag.
- Add the optimystic-workspace unit test pinning `committed.<Table>` exclusion of in-flight rows.
- Build the optimystic workspace and re-link so sereus picks up the change.

### Phase B — cadre-core wiring

- In `ControlDatabase.initialize()`: capture `hydrate` from the plugin result; set default vtab
  name + args; `await hydrate(db)` before `loadSchema()`. Mirror `connectToStrand` ordering.
- Re-run the full cadre-core suite; confirm consent specs + genesis/authorization specs are green
  and solo nodes don't hang.

### Phase C — flip test + docs

- Un-skip the target in `control-db-two-node-convergence.integration.ts`; delete the tripwire test.
- Run the convergence integration scenario; confirm B observes A's `CadrePeer` row.
- Update `docs/architecture.md:169` to reflect network-backing landed; cohort discovery remains open.

### Validation

- `yarn workspace @serfab/cadre-core test 2>&1 | tee /tmp/cadre.log`
- `yarn lint` (control DB + schema edits).
- The convergence integration scenario un-skipped and passing.
- If any pre-existing, unrelated failure surfaces, follow the `.pre-existing-error.md` flow rather
  than chasing it here.
