description: Sereus retries setting up its shared settings database when the setup fails part-way, and the reason that retry is safe changed underneath it in the new database engine; correct the written reasoning and add a test that holds the engine to it.
architecture: docs/architecture.md#control-network
files:
  - packages/cadre-core/src/control-database.ts (`loadSchema`, the re-run safety comment above the `lockedWithRetry` call, ~lines 627-646)
  - packages/cadre-core/src/control-write-retry.ts (`RETRIABLE_SCHEMA_INIT_MATCHERS` ~line 373 and `SCHEMA_INIT_RETRY_POLICY` ~line 478 — both restate the same argument)
  - packages/cadre-core/test/control-write-retry.spec.ts (the `ControlDatabase.loadSchema` suite doc, ~lines 1020-1034 — restates it a third time)
  - packages/quereus-plugin-sereus/src/compose-strand.ts (`apply schema Strand` / `apply schema App`, ~lines 296-318)
  - packages/cadre-core/test/control-db-node-helpers.ts (`controlNodeConfig`, the storage seam the new test wraps)
  - NEW: packages/cadre-core/test/control-schema-apply-unwind.spec.ts
repro: verified
difficulty: medium
----

# The schema-init retry still holds under Quereus 4.20.0, but not for the reason written down

`ControlDatabase.loadSchema` runs the control schema through `apply schema CadreControl` and retries the whole statement when it fails transiently (`SCHEMA_INIT_RETRY_POLICY`). Three places in the tree carry the argument for why re-running the whole statement is safe, and all three say the same pre-4.20.0 thing:

> `apply schema` is a diff, not a replay, and a failed `create table` leaves the catalog clean — so attempt 2 re-emits exactly the failed table and its successors.

Quereus 4.20.0 changed the second half. A failed apply no longer leaves the steps that already succeeded standing: the engine runs an undo journal in reverse, checks the result against a fingerprint of the pre-apply catalog, and only then reports the failure. So attempt 2 does not re-emit "the failed table and its successors" — it re-emits **the whole schema**, because the catalog is back where the apply started.

The conclusion survives: re-running is still safe. But it is now safe for a different reason, and that reason depends on something the old one did not — the storage module's own batch hooks. Quereus unwinds the *catalog*; whether *storage* follows is up to the optimystic plugin, which runs each undo step (`drop table`, `drop index if exists`) through its ordinary hooks inside one write batch and commits the restored state. A plugin without those hooks leaves storage holding objects the catalog no longer lists.

## What was measured

Verified on 2026-09-25 against the linked tree: `@quereus/quereus` 4.20.0 and `@optimystic/quereus-plugin-optimystic` at `../optimystic` HEAD (the unwind-hooks fix, unreleased).

The reproduction wraps the `IRawStorage` a `CadreNode` is configured with and refuses every call naming one control table's block id. Block ids are readable at that seam — `default/cadrecontrol/CadrePeer`, `default/cadrecontrol/FormationUsage/index/FormationUsageByToken` — so a gate can pick exactly which step of the apply dies. Two refusals are needed rather than one: the layer below retries a refused read once and carries on.

What happened:

- `node.start()` failed with `Failed to execute DDL: create table CadreControl.CadrePeer …\nError: Module 'optimystic' create failed …: Block default/cadrecontrol/CadrePeer is unavailable (unmaterializable)`.
- The message carried **no** `The schema is partially migrated and could not be restored` sentence, which is how Quereus reports an unwind that did not complete. So this was the verified-restore path: everything the apply had done was taken back.
- A second `CadreNode` over the same blocks came up with the complete schema — all nine `CadreControl` tables plus the `FormationUsageByToken` index. Storage and the catalog were left in step, and the next apply healed.

So the property the retry rests on holds. Nothing in the suite pins it.

## Two things the reproduction also settled, which change what the test can be

**A refusal injected at raw storage cannot drive the retry loop.** The injected message does not survive the trip: the layer below rewrites it to `Block … is unavailable (unmaterializable): the repo could not determine whether it exists`, and that is the whole cause chain — `isRetriableSchemaInitFailure` returns `false` for it. That is correct behaviour (an unavailable block is a convergence fault, not a cohort that stayed silent), but it means a storage-gated test exercises the *re-run safety property*, not the retry loop. The loop itself is already covered by `control-write-retry.spec.ts`'s stubbed-`exec` harness. Keep the two separate; do not try to forge a retriable message at the storage seam.

**`CadreNode` discards its `ControlDatabase` when `start()` fails,** so the failed node cannot be used to re-run the apply on the same `Database` — which is what the retry actually does. See the TODO below for the two ways out.

## One shape the written argument does not cover

If the outage that failed a step also fails one of the undo statements, Quereus reports the schema as partially migrated. It builds that error as the original message, then the partial-migration sentence, with the original error as `cause`. Sereus's classifier walks `cause` chains and matches on message text, so it still sees the original transient message and still claims the failure retriable — the retry fires over a partially migrated schema. Neither veto (`reportsPossiblyStoredWrite`, `reportsIndeterminateCommit`) looks for that sentence.

This is very likely fine: the plugin commits whatever its batch holds at that point, so memory and storage stay in step either way, and the next apply diffs against what is really there. But it is a decision nobody has made out loud. Make it explicitly — either the comment says why retrying a partially migrated schema is fine, or the classifier declines it. Do not leave it unstated. It is not worth its own test.

## The strand and sApp applies

`compose-strand.ts` applies `Strand` and `App` with no retry at all: a failure tears the strand down and throws, and a later connect builds a fresh `Database` and hydrates from storage. So 4.20.0 changes nothing about the control flow there — it inherits the same "storage follows the unwind" property the control path does.

One thing is new and worth writing down at that seam: an sApp schema is supplied by the embedder, and a `drop table` step is *irreversible* to Quereus's differ. One in a migration poisons the undo journal, so any later step that fails leaves the schema partially migrated rather than restored. Nothing in this repo supplies such a schema today, so this is a note for the next reader, not work.

## TODO

- Rewrite the re-run safety argument at `control-database.ts`'s `loadSchema` call site. State what 4.20.0 actually does — whole-apply unwind, verified against a pre-apply catalog fingerprint — and that a re-run therefore re-emits the whole schema, not just the failed table onward. Name the new dependency plainly: the catalog unwind is Quereus's, but storage following it is the optimystic plugin's batch hooks, so this argument is only true on a plugin build that has them.

- Bring the two restatements in `control-write-retry.ts` (`RETRIABLE_SCHEMA_INIT_MATCHERS`, `SCHEMA_INIT_RETRY_POLICY`) and the one in `control-write-retry.spec.ts`'s suite doc into line with it. Keep them short and point at the call site for the full argument rather than growing a fourth copy.

- Decide the partially-migrated case in the open, at the classifier. Either add a sentence to `RETRIABLE_SCHEMA_INIT_MATCHERS` saying why a retry over a partially migrated schema is safe, or add the veto. Recommendation: document rather than veto — declining it would turn a healable transient outage into a dead start, and the diff-based re-apply handles the partial state.

- Add `packages/cadre-core/test/control-schema-apply-unwind.spec.ts`, pinning one behaviour: **a refused DDL step part-way through `apply schema CadreControl` leaves storage and the catalog in step, and the next apply reaches the complete schema.** Recipe that worked:
  - Wrap the `IRawStorage` passed to `controlNodeConfig` in a proxy that throws for a chosen block id while a budget lasts. Two refusals of `default/cadrecontrol/CadrePeer` are enough to fail that step; one is absorbed below.
  - Assert `start()` rejects, and that the message does **not** contain `partially migrated` — that assertion is what would notice the engine's unwind silently stopping working.
  - Heal the gate, then assert the next apply reaches all nine tables and the index. Read the catalog with `select * from schema()` filtered to `schema = 'cadrecontrol'`; there is no `quereus_tables()` function.
  - Prefer the **same-`Database`** re-apply, since that is what the retry does. `CadreNode` cannot give it (it drops the `ControlDatabase` on a failed start), so build `ControlDatabase` directly the way `CadreNode` does — `createLibp2pNode` from `@optimystic/db-p2p` attaches the `coordinatedRepo` the constructor needs, and `packages/integration-tests/src/harness/test-party.ts` (~lines 41, 139) is the worked example. If that harness turns out to cost more than it is worth here, fall back to a second `CadreNode` over the same blocks — which is what the reproduction did — and say in the spec's doc comment which shape it is and what the weaker one cannot catch (stale in-memory plugin state left by the unwind; optimystic's own `schema-batch.spec.ts` covers that for a two-table fixture).
  - One test. Do not also test the retry loop here — `control-write-retry.spec.ts` owns that.

- Add a `NOTE:` at `compose-strand.ts`'s `apply schema App` about irreversible steps: an embedder migration containing a `drop table` cannot be unwound, so a later failing step leaves the strand's schema partially migrated instead of restored. No code change, no test.

- Leave every `@optimystic/*` and `@quereus/*` range in `package.json` alone. The plugin fix is unreleased; raising the floors is the gardener's move once it ships.

- Run `yarn workspace @serfab/cadre-core test` and `yarn lint`.
