description: Sereus now rejects an app's database schema if it contains "seed" rows (pre-filled rows such as a list of roles), since those rows are never inserted into a shared database; the schema guide no longer recommends them.
architecture: docs/schema-guide.md#seeds-local-quereus-databases-only
files: packages/quereus-plugin-sereus/src/compose-strand.ts, packages/quereus-plugin-sereus/test/plugin.spec.ts, packages/quereus-plugin-sereus/test/schema-guide-examples.spec.ts, docs/schema-guide.md, docs/testing.md, .release-notes.pending.md
----
# `applyAppSchema` refuses `seed` items

Maintainer decision (2026-09-30): sApp schema `seed` items are refused rather than applied, because `applyAppSchema` runs on every node at every connect (and on `StrandDatabase.attachAppSchema`), and concurrent same-key seed inserts would collide. Rows an app needs at birth are inserted by the app when it founds the strand.

## What landed

- `compose-strand.ts`: `assertNoSeedItems(db)` runs after `assertNoIgnoredItems` and before `apply schema App;`, throwing an `Error` that names the seeded tables and the remedy. Both checks read the declared items through `declaredAppItems(db)`. `seed` is gone from the ignored-item message's keyword list; `applyAppSchema`'s JSDoc states the refusal and its reason.
- `schema-guide-examples.spec.ts`: no longer applies `with seed`, so a `sql schema` block in the guide containing a seed now fails the spec.
- `docs/schema-guide.md`: Seeds section retitled "Seeds (Local Quereus Databases Only)", its example is a `sql script` against a local memory schema, and it states the refusal with a link to Ordering Events (which covers concurrent same-key inserts). Skeleton and chat schema no longer seed; intro, feature list and Practical Guidance updated.
- `docs/testing.md`, `.release-notes.pending.md` updated.

## Review findings

Read the diff of `ticket(implement): sapp-schema-refuses-seed-rows` first, then the handoff.

- **Correctness / edge cases** — ran against the built plugin rather than adding tests: a schema with both an unrecognized item and a seed reports the unrecognized item first; the `seed <t> values (<cols>) values ((…))` form is refused; a seed naming an undeclared table is refused by name; seeds for two tables are both named; after any refusal, a clean `applyAppSchema` on the same `Database` succeeds (the leftover declared `App` is replaced). No defect found.
- **Simplification (fixed)** — `assertNoSeedItems` deduplicated table names through a `Set`, but Quereus already refuses a second seed for one table at `declare` ("Seed data for table 'a' is declared more than once"), so the names are always distinct. Replaced with a `flatMap` and a one-line comment giving that reason.
- **Error handling / state after failure (filed)** — `StrandInstanceManager.attachSApp` keeps the claiming app's config before the apply, deliberately, so a transient failure retries on the next claim. For a refusal that always recurs (seed, unrecognized item, parse error) that makes every later resume of the replica fail, and on a quiesced replica the claim returns `'attached'` with no check at all. Pre-existing for unrecognized items; this ticket adds another trigger. Filed `backlog/bug-refused-app-schema-kept-for-strand-resume` (repro: static), with the boundary check (validate the schema before retaining it) as the likely fix, so it covers the whole class rather than seeds alone.
- **Docs** — grepped docs, schemas, reference apps and packages for schema `seed` / `with seed` / the old `#seeds-deterministic-bootstrapping` anchor: none remain outside the raw-Quereus intro example (which says Sereus has no equivalent) and the Seeds section. The other `seed` hits are control-network seeds, unrelated. `tickets/blocked/decide-sapp-schema-seed-rows.md` is gone. The plugin README has no seed mention.
- **Tests** — the one new test (`plugin.spec.ts` › "refuses a seed item, before applying any of the schema") pins the refusal and that nothing was applied; kept. No tests added: the edge cases above were checked by running them and have no branching of their own worth pinning.
- **Type safety / resource cleanup / performance** — nothing to find: `declaredSeed` narrows through the discriminated union, no resources are held, and the check is one pass over the declared items.
- **Validation** — `yarn workspace @serfab/quereus-plugin-sereus build` ok; `yarn workspace @serfab/quereus-plugin-sereus test`: 12 files, 156 passed, 1 todo; `yarn lint` exit 0; cadre-core `test/strand-replica-claim.spec.ts` passes against the rebuilt dist.
