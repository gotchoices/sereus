description: Make Sereus reject an app's database schema if it contains "seed" rows (pre-filled rows such as a list of roles), since those rows are never inserted into a shared database, and rewrite the schema guide so it no longer recommends them.
architecture: docs/schema-guide.md#seeds-deterministic-bootstrapping
files: packages/quereus-plugin-sereus/src/compose-strand.ts, packages/quereus-plugin-sereus/test/plugin.spec.ts, packages/quereus-plugin-sereus/test/schema-guide-examples.spec.ts, docs/schema-guide.md, docs/testing.md, .release-notes.pending.md, ../quereus/packages/quereus/src/parser/ast.ts (read only)
difficulty: easy
----

# Refuse `seed` items in an sApp schema

## Decision (maintainer, 2026-09-30)

An sApp schema's `seed` items are not applied to a strand, and `applyAppSchema` refuses a schema that contains any. Rows an app needs at birth are written by the app itself, as ordinary inserts, when it founds the strand.

**Why refuse rather than apply.** `applyAppSchema` runs on every node of a strand each time that node connects, and again when an app claims a live strand (cadre-core's `StrandDatabase.attachAppSchema`). Applying `with seed` would put a network write on every node's bring-up, and two nodes inserting the same primary key at the same time across the network is the concurrent-duplicate case the guide describes under "Ordering Events": one commit wins and the other writer gets a `UNIQUE constraint failed` error, which inside the apply would fail that node's connect. Applying only at founding needs knowledge the plugin does not have (whether this connect is the founding one), and a seed added in a later schema version would never reach an existing strand. Silently ignoring seeds (today's behaviour) leaves an author with an empty table they discover at runtime. Refusing is in line with how `applyAppSchema` already refuses items the Quereus parser skips.

## Current state

- `applyAppSchema` (`packages/quereus-plugin-sereus/src/compose-strand.ts`, ~line 383) runs `declare schema App { <schema> }`, then `assertNoIgnoredItems(db)`, then `apply schema App;` — without `with seed`, so seed items parse and are dropped.
- `assertNoIgnoredItems` reads `db.declaredSchemaManager.getDeclaredSchema('App')?.items` and counts items of type `declareIgnored`. Its error message lists the valid item keywords, including `seed`.
- Quereus parses a seed item as `{ type: 'declaredSeed', tableName: string, columns?, seedData? }` (`../quereus/packages/quereus/src/parser/ast.ts`, `DeclaredSeed`). Both seed forms (`seed t ((…))` and `seed t values (cols) values (…)`) produce this type.
- Callers: `composeStrand` step 7 (same file) and `StrandDatabase.attachAppSchema` (`packages/cadre-core/src/strand-database.ts` ~line 235). No schema in the repo outside `docs/schema-guide.md` contains a seed item (`grep -rnE "^\s*seed\s+\w+\s*(\(|values)"` over `packages schemas docs test-harness scripts`, excluding `dist`, finds only the guide's four).
- `packages/quereus-plugin-sereus/test/schema-guide-examples.spec.ts` applies every `sql schema` guide block through `applyAppSchema`, then runs `apply schema App with seed` (in `checkSchemaBody`) to prove the seed literals fit. Once seeds are refused, any `sql schema` block with a seed fails the spec, so the guide must change in the same commit.

## Design

### Plugin

Add a second check beside `assertNoIgnoredItems`, run after it and before `apply schema App;` so a refused schema applies nothing:

```ts
function assertNoSeedItems(db: Database): void
```

It collects the distinct `tableName`s of items whose `type === 'declaredSeed'` and, if any, throws an `Error` whose message names those tables and says why, e.g.:

`sApp schema has seed item(s) for table(s) roles, users; Sereus does not apply seed rows to a strand — write the rows an app needs at birth from the app when it founds the strand`

Wording is the implementer's; it must name the tables and state the remedy. (Plain `Error`, matching `assertNoIgnoredItems`; no new error class.) Reading `declaredSchemaManager` twice is fine; if the two checks read nicer sharing one `items` lookup, do that.

Also:
- Remove `seed` from the list of valid item keywords in `assertNoIgnoredItems`'s message.
- Extend `applyAppSchema`'s JSDoc with one sentence: refuses `seed` items, because the apply runs on every node at every connect and concurrent same-key seed inserts would collide; birth rows are the founding app's job. State it as a constraint, not a history.

### Test

One test, in the existing `describe('applyAppSchema')` block of `packages/quereus-plugin-sereus/test/plugin.spec.ts`, mirroring the ignored-item test: a schema with a table and a `seed` item for it rejects with a message matching the table name and `seed`, and `db.schemaManager.getSchema('App')?.getAllTables() ?? []` is empty afterwards (nothing applied). This pins the maintainer's contract on the one branch; no other new tests.

### Schema-guide spec

In `schema-guide-examples.spec.ts` `checkSchemaBody`, delete the `await db.exec('apply schema App with seed');` line and its two-line comment — no `sql schema` block can hold a seed any more. Leave the `sql script` handling as is (it will run the local-Quereus seed example below).

### `docs/schema-guide.md`

- Opening "What the examples are" paragraph (line ~5): drop `seed` from the list of item keywords an sApp schema body holds, and say a `seed` item is refused too (short clause; details in the Seeds section).
- Declarative workflow example (the `sql script` with `declare schema main using (default_vtab_module = 'memory')` and `apply schema main with seed`): keep — it is raw Quereus. After it, the existing "That is raw Quereus…" sentence can add that `seed`/`with seed` has no Sereus equivalent (see Seeds).
- "Minimal Strand Schema Skeleton": remove the `seed users (...)` line and its comment.
- "Seeds (Deterministic Bootstrapping)": retitle to make the scope plain, e.g. `### Seeds (Local Quereus Databases Only)`. Convert its `sql schema` block to a `sql script` block that declares a local memory schema (`declare schema main using (default_vtab_module = 'memory') { table roles (...); seed roles (...); }`), then `apply schema main with seed;`. Keep the paragraph about the positional `values (<columns>)` form. Replace the "open decision" paragraph with: Sereus refuses an sApp schema containing `seed` items (`applyAppSchema`), with the one-sentence reason (applied on every node at every connect; concurrent same-key inserts collide); an app that needs rows at birth inserts them itself from the node that founds the strand. Remove the reference to `tickets/blocked/decide-sapp-schema-seed-rows.md` (that ticket no longer exists).
- "Putting It All Together": remove `seed roles (('admin'), ('member'));`, replace it with a one-line SQL comment saying the app inserts the `'admin'` and `'member'` role rows when it founds the strand, and drop "and seeds" from the intro sentence's feature list.
- Practical Guidance bullet on seeds (line ~708): rewrite as one claim plus reason — birth rows (a role list) are inserted by the app when it founds the strand; Sereus refuses `seed` items. Update its link to the retitled section's anchor.
- Grep the guide for any other `seed` mention and the old anchor `#seeds-deterministic-bootstrapping` after editing.

### `docs/testing.md`

Line ~430 ("Schema guide examples execute"): remove ", then applied `with seed`" from the `sql schema` description.

### Release note

Add a section to `.release-notes.pending.md` modelled on the v1.8.0 "App schemas: unrecognised items are now an error" section (see `git show d3791ca5^:.release-notes.pending.md`): **App schemas: `seed` items are now an error.** An sApp schema containing a `seed` item now fails to connect (and `attachAppSchema` throws) naming the tables. Seed items never inserted rows into a strand — they were silently ignored — so no stored data changes; remove them and insert the rows from the app when it founds the strand.

## Edge cases & interactions

- **Refusal must precede any DDL.** The seed check runs before `apply schema App;`, so a refused schema creates no table. Verified by the test's empty-tables assertion.
- **Both an ignored item and a seed item present.** The ignored-item check runs first and throws; the author fixes that, then sees the seed error. Acceptable; by inspection.
- **`seed … values (cols) values (…)` form.** Same `declaredSeed` type, so refused by the same check; by inspection of the AST type.
- **Seed for an undeclared table.** Refused on item type alone (no table lookup), so the message still names it; by inspection.
- **`attachAppSchema` on a live replica.** The throw happens inside `applyAppSchema` before `this.config.sAppConfig` is set, so "a failed apply records nothing" still holds. The `App` declaration stays in `declaredSchemaManager` unapplied, exactly as on the existing ignored-item refusal; the next attach re-declares over it. By inspection.
- **`composeStrand` failure path.** The throw lands in step 7's existing `try`, which shuts the collection factory, stops a created node and releases the storage-cache claim. No new cleanup; by inspection.
- **Upgrade of an existing app whose schema had seeds.** Previously connected (seeds ignored); now its connect fails until the author removes them. No stored data depends on the seeds (they were never inserted). This is the breaking change the release note covers.
- **Guide examples.** After the edit, no `sql schema` block may contain `seed`; the schema-guide spec enforces it (the block would fail to apply). The new `sql script` Seeds block must pass as a script. Verified by running the spec.
- **cadre-core.** No cadre-core schema or test fixture carries a seed item (grep above), so no cadre-core change; it consumes the plugin's `applyAppSchema` unchanged in signature.

## TODO

- Add `assertNoSeedItems` in `compose-strand.ts`, call it after `assertNoIgnoredItems` in `applyAppSchema`; drop `seed` from the ignored-items message; extend the JSDoc.
- Add the one refusal test to `plugin.spec.ts`'s `applyAppSchema` describe.
- Remove the `with seed` apply and its comment from `schema-guide-examples.spec.ts` `checkSchemaBody`.
- Edit `docs/schema-guide.md` as listed (intro paragraph, skeleton, Seeds section as a `sql script`, chat schema, Practical Guidance bullet, anchors).
- Edit `docs/testing.md` line ~430.
- Add the release-note section to `.release-notes.pending.md`.
- Run `yarn workspace @serfab/quereus-plugin-sereus test` (the `unit` project includes both specs) and `yarn lint`; build the plugin package (`yarn workspace @serfab/quereus-plugin-sereus build`) so cadre-core consumers see the new `dist`. Do not build anything under `../quereus` or `../optimystic`.
