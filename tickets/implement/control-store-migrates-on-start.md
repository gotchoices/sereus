description: When a machine starts on a release whose control schema is newer than the one its party's shared control database was written under, it upgrades that database in place and keeps every row. Machines still on the older release keep working until they restart, and then ask to be updated instead of asking for the party to be recreated.
prereq: optimystic-catalog-only-alter-table, control-schema-versions-stay-migratable
architecture: docs/architecture.md#control-schema-changes-and-incompatible-stores
files: packages/cadre-core/src/control-schema-version.ts (`refuseIncompatibleControlStore`, `ControlStoreIncompatibleError`, the module NOTE), packages/cadre-core/src/control-database.ts (`loadSchema` ~1262-1281, its comment naming this ticket), packages/cadre-core/src/control-schema.ts (`CONTROL_SCHEMA_BASELINE_VERSION`), packages/cadre-core/test/control-store-incompatible.spec.ts, packages/cadre-core/test/fixtures/control-schema/, packages/integration-tests/src/scenarios/control-db-two-node-convergence.integration.ts (pattern for the new scenario), packages/cadre-core/src/types.ts (`controlNetwork.schemaPath` ~717), package.json files that pin `@optimystic/*` ranges, docs/architecture.md (~55-72), .release-notes.pending.md
difficulty: hard
----

# The control store migrates when a machine starts on a newer release

GitHub #46. The maintainer chose versioned migrations (2026-10-15), because phones receive an app update one at a time. The prereqs supply both halves of what this needs:

- `control-schema-versions-stay-migratable` keeps a fixture per version and guarantees that consecutive versions differ only by `additive` or `catalog-only` statements.
- `complete/optimystic-catalog-only-alter-table` makes Optimystic apply the `catalog-only` statements and save tag changes. It shipped in Optimystic 1.16.0, and `adopt-optimystic-1-17-0` raised the floors to `@optimystic/*` ^1.17.0 and `@quereus/quereus` ^4.20.3, so the "Optimystic version" step below is done. That ticket's resolution lists three facts of the shipped form to design around: a failed apply cannot undo a `drop column`, a host must never apply a declaration older than the stored one, and a machine that hydrated before another's upgrade can still write its older table description back.

## Design

**A migration is the apply.** Between consecutive versions every change is one the optimystic module applies to the catalog alone. So the `diff schema` from a store at version K to this build's declaration is exactly the result of running each version's changes from K+1 up to the build's, in order. `ControlDatabase.loadSchema` keeps its shape: declare, check, then apply through `applyControlSchema` with the existing retry policy. The check now lets `catalog-only` statements through, so the apply migrates the store. No per-version migration code is added, because there is nothing a start-time step could do that the diff cannot:

- A start-time step cannot write signed rows, since it holds no owner key.
- Every change that would need a step (rename, type change, NOT NULL column, a moved row) is refused at edit time by the prereq's spec.

Record that as a tripwire bullet in the docs section. If a future version needs rows rewritten, the plan is a new table plus a re-seat pass that owner machines run after start through the ordinary signed writers, the way `revouchOwnerKey` re-adds a row. That plan is not built here.

**The version moves with the store.** With tag changes saved upstream, the `alter table OwnerKey set tags (…)` the apply emits now persists. After a successful start the store records this build's version. Replace the `NOTE:` at the top of `control-schema-version.ts`, which says the tag is the version a store was created under, with the new fact. A store created under the baseline and additively upgraded before the upstream fix still reads the baseline. That is harmless, because the diff is computed from the catalog, not from the number.

**The check's three refusals.** Add `readonly reason: 'newer-release' | 'before-migrations' | 'not-migratable'` to `ControlStoreIncompatibleError` and write a message for each:

- **`newer-release`**: the store's version is above the build's. The message tells the user to update this app or node, and does not advise a recreate. A newer machine of the party has already migrated the store, and recreating would throw away its rows.
- **`before-migrations`**: the store's version is below `CONTROL_SCHEMA_BASELINE_VERSION`. These are stores written by 1.16.0 and earlier (prereq's "Baseline"). Refuse it even when its diff is additive. The message gives the recreate advice as today.
- **`not-migratable`**: any pending statement is `unmigratable`. With the edit-time guard in place this is reachable only from a development store or a hand-made one. The message gives the recreate advice.

Check them in that order, so a store that is both older than the baseline and not migratable reports `before-migrations`. `CadreNode.start()` already rethrows the error unchanged, and the kits surface it as `status.error`, so an app can branch on `reason`. No kit change is needed.

**Every machine migrates for itself.** No machine is designated to migrate. The catalog tree is replicated, so the first machine of the party to start on the new release changes the catalog that the others hydrate. A second machine starting on the same release finds the store already migrated, so its diff is empty, or, if it raced the first, the arms are idempotent (upstream proposal point 4).

**Machines still on the older release.**

- **While running**, an older machine keeps its own in-memory catalog and keeps working. Rows are stored keyed by column name, so its rows read on the new release with null in any new column, and it ignores columns it does not know.
- **When it updates a row**, the update rewrites the row with only the columns it knows, so the values in the new columns are lost. Today the only control-row update is `CadrePeer`'s self-publish and re-vouch. The row is written again when that machine starts on the new release. Record this as a docs bullet: it has no single code site in this repo, because the behaviour is in Optimystic's `RowCodec.encodeRow`.
- **When it restarts**, it hydrates the migrated catalog and is refused. A build carrying this ticket reports `newer-release`. A version-3 build already shipped with the prereq's check refuses because its diff is not additive. Its message calls the store "created by a newer release" because it reads the saved tag, and its advice is to recreate. Name that wording in the release notes, so users of the older release are told to update, not recreate.

**Signed rows.** No signed digest has changed since the baseline, so this ticket changes no verifier. The rule (old digest forms stay verifiable, writers sign the newest form) and its edit-time guard are the prereq's. The docs section states the rule once.

**Optimystic version.** Raise the `@optimystic/*` dependency floors to the release that carries the upstream changes, and run `scripts/check-dep-ranges.mjs`. Local development already sees the change through the root `resolutions` link. Sibling repositories are read-only: if the stale-build guard reports `../optimystic` stale, stop and record that this ticket is blocked on the sibling's build.

## Docs

Rename and rewrite `docs/architecture.md` → "Control schema changes and incompatible stores" as "Control schema versions and migrations". Keep the anchor `#control-schema-changes-and-incompatible-stores` resolving, or update every link to it (grep `docs/` and `tickets/`). The section should state:

- what a warm start migrates, and that the apply is the migration;
- the change kinds and the fixtures (from the prereq);
- the version tag now moving with the store;
- the three refusal reasons and what an app should tell the user for each;
- mixed versions in one party (the three bullets above);
- the signed-digest rule;
- the row-rewrite tripwire;
- "Recreating a control store", kept, now scoped to `before-migrations` and `not-migratable`.

Remove the "Until versioned migrations land" wording, and the prereq's sentence saying a version bump still needs a recreate. Update `loadSchema`'s comment in `control-database.ts` that names this ticket.

Add a line to `.release-notes.pending.md`:

- Control stores written by the release carrying `CONTROL_SCHEMA_VERSION` 3 or later migrate on start.
- A machine on an older release that is refused after another machine migrated should be updated, not recreated.

## Tests

Use the `lifetime` harness in `control-store-incompatible.spec.ts`: one storage across starts, with the store's schema chosen by `schemaPath`. Rename the spec `control-store-migration.spec.ts`. Build the store's schema from `test/fixtures/control-schema/v<baseline>.qsql`, and build "the next release" as a variant of that fixture at version baseline+1. Its changes: one new nullable column on `CadrePeer`, one CHECK body changed (for example a wider `OwnerKey.LabelLength` bound), one new table. The store variant also carries one extra nullable column, which the next release drops. Variants must not change anything the TypeScript writers read or write, because both "releases" run the same cadre-core code.

- **A store from the previous version migrates and keeps its rows.** Start under the baseline fixture and write an owner key with a label (`ensureOwnerKey`) and a `CadrePeer` row. Restart under the next release: it starts, `queryOwnerKeyRows` returns the key with its label and stamp, and the peer row reads back. Restart once more under the next release: `diff schema CadreControl` is empty, and the `OwnerKey` tag reads baseline+1, which shows the tag was saved and not just held in memory. This is the contract the ticket exists for, so keep it to one `it`.
- **The three refusals.** One `it` per `reason`, re-aiming the existing three cases:
  - `newer-release`: the existing newer-store case; also assert the message does not contain the recreate advice.
  - `before-migrations`: the existing pre-version case, which today *starts*. It now expects a refusal for a version-0 store even though its diff is additive.
  - `not-migratable`: the existing `drop table` case, at the baseline version.

  Each still asserts nothing was applied. That is checked the way the spec checks it today, by the store schema still starting afterwards.
- **Integration scenario, two machines on different releases.** Add `packages/integration-tests/src/scenarios/control-schema-migration-mixed-releases.integration.ts`, modelled on `control-db-two-node-convergence.integration.ts`, with `controlNetwork.schemaPath` choosing each machine's "release":
  1. A and B form a party under the baseline fixture and each writes a row.
  2. A restarts under the next release and starts without error, while B keeps running.
  3. B writes a row and A reads it; A writes a row in the new column and B reads that row, without the column.
  4. B restarts under the baseline fixture and is refused with `reason: 'newer-release'`.
  5. B restarts under the next release, starts, and reads every row from before.

  Steps 4 and 5 are what the ticket promises the phone that updates second.

No test for the concurrent-migration race: the idempotency is upstream's contract, and their tests own it. Check it here by reading the code.

## Edge cases & interactions

- **The apply fails partway through a migration** (an unanswered cohort member on one statement). The undo journal unwinds the whole apply and the retry re-runs the full diff (`applyControlSchema`'s comment). That argument now covers the new arms only if each is reversible through the plugin's hooks (upstream proposal point 3). Verify by reading the code in the adopted Optimystic release, and extend `applyControlSchema`'s comment to name the alter arms.
- **Two machines on the new release start together.** Both run the same `alter` statements and the catalog record converges. Rely on the upstream contract; check it by reading the code.
- **A migrating machine that is alone in a party with other members.** The apply is a distributed write under `SCHEMA_INIT_RETRY_POLICY`, exactly as a cold start's `create table` is today. Nothing new; check by reading the code.
- **An older machine updating a row.** The new columns' values are lost, as described above. Recorded in the docs. Not tested.
- **A store created under the baseline and upgraded before the upstream fix.** Its tag is stale, at the baseline. The diff is still correct, and the next start saves the right tag. Covered by the first test's second restart.
- **A newer machine's rows that use a new field, read by an older machine's verifier.** Once a future version changes a digest, those rows fail to verify on the older machine, which refuses to trust them. Out of scope until a digest changes. The prereq's `CHANGED_DIGESTS` guard is where that change gets weighed.
- **`before-migrations` takes precedence over `not-migratable`.** A 1.16 store has both properties. Its message must give the recreate advice and point to the baseline explanation. Checked by the order of the three checks.
- **The start-time storage-operation budget.** A warm start with nothing to migrate must not issue more storage operations. `control-start-storage-op-budget.spec.ts` must pass unchanged.

## TODO

- Raise the `@optimystic/*` floors to the release with the upstream changes; run `check-dep-ranges`.
- Widen `refuseIncompatibleControlStore` to accept `catalog-only`; add the baseline refusal; add `reason` and the three messages to `ControlStoreIncompatibleError`.
- Replace the created-under `NOTE:` in `control-schema-version.ts`; update `loadSchema`'s and `applyControlSchema`'s comments.
- Rename and re-aim `control-store-incompatible.spec.ts` → `control-store-migration.spec.ts` (four cases above).
- Add the mixed-releases integration scenario.
- Rewrite the `docs/architecture.md` section; fix links to its anchor; add the release-notes line.
- `yarn lint`, `yarn workspace @serfab/cadre-core typecheck`, `yarn workspace @serfab/cadre-core test`, and the new scenario under `yarn workspace @serfab/integration-tests` (run only that file if the whole suite exceeds the idle window).
