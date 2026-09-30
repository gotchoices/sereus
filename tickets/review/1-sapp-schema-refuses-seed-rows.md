description: Sereus now rejects an app's database schema if it contains "seed" rows (pre-filled rows such as a list of roles), since those rows are never inserted into a shared database; the schema guide no longer recommends them.
architecture: docs/schema-guide.md#seeds-local-quereus-databases-only
files: packages/quereus-plugin-sereus/src/compose-strand.ts, packages/quereus-plugin-sereus/test/plugin.spec.ts, packages/quereus-plugin-sereus/test/schema-guide-examples.spec.ts, docs/schema-guide.md, docs/testing.md, .release-notes.pending.md
----
# Review: `applyAppSchema` refuses `seed` items

Maintainer decision (2026-09-30): sApp schema `seed` items are refused rather than applied, because `applyAppSchema` runs on every node at every connect (and on `StrandDatabase.attachAppSchema`), and concurrent same-key seed inserts would collide. Rows an app needs at birth are inserted by the app when it founds the strand.

## What changed

- `compose-strand.ts`: new `assertNoSeedItems(db)` runs after `assertNoIgnoredItems` and before `apply schema App;`. It collects distinct `tableName`s of `declaredSeed` items and throws a plain `Error` naming them and the remedy. Both checks share a small `declaredAppItems(db)` helper. `seed` removed from the ignored-item message's keyword list. JSDoc on `applyAppSchema` states the constraint.
- `schema-guide-examples.spec.ts`: dropped the `apply schema App with seed` step from `checkSchemaBody`.
- `docs/schema-guide.md`: intro says `seed` is refused; skeleton's seed line removed; Seeds section retitled "Seeds (Local Quereus Databases Only)" and converted to a `sql script` block declaring a local memory schema then `apply schema main with seed`; explanation now states the refusal and reason (links to Ordering Events); chat schema's seed replaced with a comment; intro feature list and Practical Guidance bullet updated; old anchor `#seeds-deterministic-bootstrapping` no longer referenced anywhere.
- `docs/testing.md`: removed "then applied `with seed`".
- `.release-notes.pending.md`: new section "App schemas: `seed` items are now an error".

## Tests

- `plugin.spec.ts` → `applyAppSchema` › "refuses a seed item, before applying any of the schema": pins the refusal message naming the table, and that no `App` tables exist afterwards.
- The schema-guide spec now implicitly enforces that no `sql schema` guide block contains a seed, and runs the new Seeds `sql script` block.

## Validation

- `yarn workspace @serfab/quereus-plugin-sereus build` — ok (dist rebuilt for cadre-core consumers).
- `yarn workspace @serfab/quereus-plugin-sereus test` — 12 files, 156 passed, 1 todo.
- `yarn lint` — exit 0.
- cadre-core tests not run (no signature change; no cadre-core fixture carries a seed per the plan's grep).

## Known gaps / for the reviewer

- Edge cases from the plan (both ignored and seed items present → ignored error first; `seed … values (cols) values (…)` form; seed for an undeclared table; `attachAppSchema` leaves `sAppConfig` unset on failure) are by inspection only, not tested.
