description: A party's shared membership/control database is kept only in each node's memory, so a change written on one node never reaches the others; wire the control tables to the network layer so they actually replicate — the foundation the architecture assumes but that isn't currently in place.
prereq:
files: packages/cadre-core/src/control-database.ts (initialize ~156-211 — plugin registration, no default-vtab/hydrate), packages/quereus-plugin-sereus/src/compose-strand.ts (connectToStrand ~170-245 — the working pattern: setDefaultVtabName + setDefaultVtabArgs + hydrate before apply), packages/cadre-core/src/control-schema.ts (CONTROL_SCHEMA — no per-table `using optimystic`), packages/cadre-core/src/control-database.ts (redeemInvitation/recordFormationUsage/execFormationUsageInsert ~687-813 — deferred-CHECK transactions), packages/integration-tests/src/scenarios/control-db-two-node-convergence.integration.ts (the tripwire + skipped target), packages/cadre-core/test/control-formation-invite.spec.ts, packages/cadre-core/test/strand-formation-consent.spec.ts, packages/cadre-core/test/control-authorization-binding.spec.ts (the 9 consent tests the naive fix breaks), docs/architecture.md (~167 "Convergence prerequisites and current status")
difficulty: hard
----

## Problem (discovered while building `control-db-two-node-convergence-test`)

The architecture says the `CadrePeer` row (and the rest of the `CadreControl` store) is the **authoritative, replicated** form that converges peer-to-peer across a party's cadre nodes. **It does not replicate at all today.** The `CadreControl` tables are backed by Quereus's built-in **in-memory** vtab, not the Optimystic network transactor:

- `ControlDatabase.initialize()` registers the optimystic plugin with `default_transactor: 'network'`, but **never** calls `db.setDefaultVtabName('optimystic')` / `db.setDefaultVtabArgs({...})`. The `declare schema CadreControl { table ... }` tables carry no per-table `using optimystic(...)`, so they resolve to the default (in-memory) vtab. The plugin's `default_transactor` only affects tables actually routed to the optimystic vtab — none of the control tables are.
- The strand path does it correctly: `connectToStrand` (`@serfab/quereus-plugin-sereus/compose-strand.ts`) calls `setDefaultVtabName('optimystic')` + `setDefaultVtabArgs({ networkName, transactor, keyNetwork })` + `hydrate(db)` **before** applying its schema. That is exactly why strand databases converge (≈1.5s in `strand-formation-e2e` / `convergence-stress`) and the control DB never does.

### Evidence

- `DEBUG=optimystic:*` on a two-node control write emits **zero** optimystic lines (no transactor/cluster/coordinator activity). The analogous strand write emits **thousands** (`network-transactor`, `coordinator-repo`, `cluster`, `libp2p-key-network`, ...).
- A spike adding `setDefaultVtabName` + `setDefaultVtabArgs` + `hydrate` to `ControlDatabase.initialize()` (mirroring `connectToStrand`) made a two-node control pair **converge for real**: the connect-then-write CadrePeer row reached the peer in ≈2.0s, and a write-then-connect (local-only) row **healed via pull-on-read** once the cohort formed. This is captured as the **skipped target test** in `control-db-two-node-convergence.integration.ts` — un-skip it (and delete the in-memory tripwire beside it) when this lands.

## Why it isn't a one-line change — the blocker to design around

The same spike **broke 9 cadre-core tests** in the consent path with `QuereusError: CHECK constraint failed: Monotonic` (and `approved:false` downstream):

- `control-formation-invite.spec.ts`, `strand-formation-consent.spec.ts`, `control-authorization-binding.spec.ts`.

Root cause: the control DB leans on Quereus semantics that the **in-memory vtab honours but the Optimystic network transactor does not (yet) reproduce identically**:

- **Multi-statement transactions** — `redeemInvitation` wraps `Strand` + `FormationUsage` inserts in an explicit `begin … commit` so two mutually-circular **deferred** `CHECK`s (`Strand.Authorized` consent branch ↔ `FormationUsage.StrandExists`) both see both rows at commit.
- **Deferred `CHECK` + `committed.*` snapshots** — `FormationUsage.Monotonic` reads `committed.FormationUsage` (the pre-transaction snapshot) to compute `UseNumber = max+1`. The failure originates in `DeferredConstraintQueue.evaluateEntry` / `TransactionManager.commitTransaction`, i.e. the deferred queue's view of committed rows over the network transactor differs from the in-memory vtab.
- **Single-use `StampId` uniqueness** — `control-authorization-binding` relies on unique-column enforcement across rows.

So the fix is **not** just "set the default vtab." It must make the Optimystic network transactor (or the control DB's use of it) honour Quereus's deferred-`CHECK` / `committed.*` snapshot / multi-statement-transaction / unique-constraint semantics for the `CadreControl` schema — possibly work in `../optimystic` (the network transactor / `db-core` transaction layer) and/or `../quereus`, not just `cadre-core`. Reproduce the 9 failures first, decide where the semantics gap lives, then implement.

## Requirements / acceptance

- `CadreControl` tables are backed by the Optimystic **network** transactor (mirror `connectToStrand`: default vtab + args + hydrate-before-apply, so warm restarts with persistent storage don't re-emit DDL).
- A `CadrePeer` row written on one connected node becomes readable on a peer (the skipped target test in `control-db-two-node-convergence.integration.ts` passes when un-skipped).
- **No regression** in the consent path: `control-formation-invite.spec.ts`, `strand-formation-consent.spec.ts`, `control-authorization-binding.spec.ts` (and the rest of the cadre-core suite) stay green.
- Solo nodes (no peers) still work (local-only branch) and don't hang on cluster lookups.

## Relationships

- **Prerequisite of `control-network-cohort-discovery`** (plan/) and `2-push-wake-replication-backed-authorization` (implement/). Both assume the control store replicates; it cannot until this lands — even with perfect connectivity, in-memory tables never replicate. Cohort-discovery is the *connect-the-nodes* concern; this is the *make-the-tables-replicate* concern. This one is the foundation.
- The convergence **recipe** (direct dial + both-sides wait + read-driven poll) and the harness helper `waitForCrossNodeControlSync` / `waitForCadrePeerConverged` already exist (from `control-db-two-node-convergence-test`); this ticket only has to make the storage layer actually replicate, then flip the skipped test.
