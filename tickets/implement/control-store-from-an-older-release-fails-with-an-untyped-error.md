description: When a release changes the control schema, a node restarting on a control store written by a different release fails with a raw database error whose text changes from release to release, and an older build silently deletes tables a newer build added. Record a schema version in the store, check it and the pending schema changes before applying anything, and throw one typed error that embedders can recognise, with a documented recreate procedure (GitHub #46).
architecture: docs/architecture.md
files: packages/cadre-core/src/control-database.ts (`initialize` ~977-1075, `loadSchema` ~1077-1167 and its NOTE ~1128-1132), packages/cadre-core/src/control-schema.ts, schemas/control.qsql (`table OwnerKey` ~43), packages/cadre-core/src/control-write-retry.ts (comment on `RETRIABLE_SCHEMA_INIT_MATCHERS` ~410-427), packages/cadre-core/src/storage-scope.ts (`controlStorageScope`), packages/cadre-core/src/index.ts, packages/cadre-core/test/control-schema-drift.spec.ts, docs/architecture.md (paragraph after the party-binding paragraph, "Editing the text of an existing control-table constraint…")
repro: verified
----

# A control store from another release fails with an untyped error

Reported by kjeib (gotchoices/sereus#46). The control database is the replicated Quereus database holding a party's owner keys, machines, invitations and strands; its schema is `schemas/control.qsql`, embedded as `CONTROL_SCHEMA`. On every start, `ControlDatabase.initialize` loads the tables already in local storage into Quereus's catalog (the optimystic plugin's `hydrate`), then `loadSchema` runs `declare schema CadreControl { … } apply schema CadreControl`. `apply schema` compares the declared schema with the catalog and runs whatever DDL makes them equal.

## Reproduction (run at 7ccfcebf, throwaway spec, deleted)

Two `ControlDatabase` lifetimes over one `MemoryRawStorage`, built the way `control-schema-apply-unwind.spec.ts` builds one (hand-built libp2p node, no listen address). The first lifetime used `schemaPath` pointing at a variant of `CONTROL_SCHEMA`; the second used a different schema. Results of the second `initialize()`:

| Store written with | Restarted with | Result |
|---|---|---|
| `CadrePeer.AuthorizedUpdate` text edited | `CONTROL_SCHEMA` | `QuereusError: Failed to execute DDL: ALTER TABLE CadreControl.CadrePeer DROP CONSTRAINT AuthorizedUpdate` / `Module for table 'CadrePeer' does not support ALTER TABLE DROP CONSTRAINT` |
| an extra `DeviceToken.Legacy` column | `CONTROL_SCHEMA` | `… DROP COLUMN Legacy` refused, plus Quereus's "The schema could not be restored: the failing step … cannot be undone" — the step is irreversible, so the apply is left partially migrated |
| `CONTROL_SCHEMA` | schema with an added `DeviceToken` column | `… ADD COLUMN Legacy text null` refused |
| an extra unreferenced table `Legacy` | `CONTROL_SCHEMA` | **succeeds**: `diff schema` showed `DROP TABLE IF EXISTS CadreControl.legacy`, and the apply ran it |
| identical | identical | succeeds, no DDL |

So: every change to an existing control table fails the warm start with text that names the specific DDL step, the error class is the generic `QuereusError`, and the last-but-one row is a downgrade hazard nobody has reported yet: a build whose schema lacks a table that a newer build added drops that table from the store on start. Whether the drop also removes the table's replicated blocks for the other machines was not checked; at minimum it removes the table from that machine's catalog and storage.

`CadreNode.start()` rethrows the error unchanged (`cadre-node.ts` catch ~1423), and `PhoneNode` (`cadre-rn/src/phone-node/node.ts` ~715) passes it through `toError`, which keeps an `Error` as is, into `status.error`. So a typed error thrown from `loadSchema` reaches both embedder surfaces with no change there.

## Also verified, by probe, as inputs to the design

- A table-level tag (`table X (…) with tags ("sereus.version" = 2)`) is stored by the optimystic plugin and is present on `db.schemaManager.getTable('CadreControl', 'X').tags` right after `hydrate`, before any apply.
- After `declare schema CadreControl { … }` (without `apply`), `db.eval('diff schema CadreControl')` returns the exact DDL the apply would run, one row per statement (`{ ddl }`), and runs nothing.
- A tag-only change diffs to `ALTER TABLE … SET TAGS (…)` and the optimystic module applies it on a warm store.
- Quereus does not export its structured `SchemaDiff` from the package root; it does export `Parser` (AST types from `@quereus/quereus/parser`), so the diff's DDL rows can be classified by parsing them rather than by matching text.

## Design

### Schema version, stored as a table tag

Add `CONTROL_SCHEMA_VERSION` (an integer, starting at 1) and carry it in the schema text as a table-level tag on `OwnerKey`, the first table: `) with tags ("sereus.controlSchemaVersion" = 1)` in both `schemas/control.qsql` and `control-schema.ts` (the drift spec keeps them identical). A store written before this ticket has no tag; read that as version 0.

Why a tag on an existing table, not a version row or a new marker table:

- A tag lives in the table's stored schema, which is replicated with the table, so every machine that hydrates the store sees it, and no row write is needed. A version **row** would need an authorization constraint (any member could otherwise set it to a value that stops every machine from starting), and that design belongs to `plan/control-schema-versioned-migrations`.
- A new table would add storage operations to every cold start, which `control-start-storage-op-budget.spec.ts` pins.
- It can be read before the apply (verified above), and a version bump applies on a warm store as `SET TAGS` (verified above).

**Bump rule:** every edit to the declared control schema bumps `CONTROL_SCHEMA_VERSION`, additive or not. One rule with no judgment in it; the migrations ticket needs an ordered version for every change anyway. Add one assertion to `control-schema-drift.spec.ts` pinning the pair (version, `explain schema CadreControl` hash). Quereus computes that hash from the canonical schema with tags stripped, so comment edits do not move it and the tag does not feed its own hash. Editing the schema without bumping then fails that spec. Say so in the comment above the constant.

### Check before applying

In `loadSchema`, between the hydrate and the apply, and only on a **warm store** (the hydrated catalog lists at least one `CadreControl` table; a cold store skips all of this and applies as today):

1. Read the store's version from the hydrated `OwnerKey` table's tags (0 when the tag or the table is absent).
2. Run the `declare schema` statement alone, then `diff schema CadreControl`, and collect the DDL rows.
3. Refuse, with no apply attempted, when **either** the store's version is greater than the build's (a downgrade: the diff would drop the newer build's tables, or lower the version tag), **or** any diff statement is not additive. Additive means: `create table`, `create index`, or `alter table … set tags`. Classify each row by parsing it with Quereus's `Parser` and checking the statement node's type (and, for `alter table`, its action), not by matching text.
4. Otherwise run `apply schema CadreControl` under the existing `lockedWithRetry(…, SCHEMA_INIT_RETRY_POLICY, 'schema-init')`. The declaration is already stored by step 2, so the retried body is just the apply.

This makes the outcome independent of which DDL statement would have failed first. It also means a dropped control table is now refused rather than silently applied, which is correct: dropping a table that holds rows destroys them.

A pure additive change (a new table, a new index) still warm-starts, as it does today, and moves the version tag up in the same apply.

**Splitting the declaration from the apply.** `CONTROL_SCHEMA` and the `schemaPath` file both end in `apply schema CadreControl;`. Recommended: export the declaration text from `control-schema.ts` and build `CONTROL_SCHEMA` from it plus the apply line (the drift spec still compares the whole string to the `.qsql` file). For `schemaPath`, parse the file with `Parser` and refuse a file that contains anything other than one `declare schema CadreControl` statement followed by one `apply schema CadreControl`; execute the declaration's source text. If slicing the source text by AST location turns out to be awkward, the alternative is to narrow `schemaPath` to a declaration-only file and update its two users (`control-revocation-reap.spec.ts`, and `CadreNodeConfig.controlNetwork.schemaPath`'s doc in `types.ts`). Either is acceptable; don't strip the apply line with a regex.

**The build's version** is `CONTROL_SCHEMA_VERSION` for the embedded schema. With a `schemaPath` override, read it from the declared `OwnerKey` table's tags (`db.declaredSchemaManager.getDeclaredSchema('CadreControl')`), so a test can declare an older or newer version through a file. If the declared tags are not reachable that way, use the constant and have the tests that need another version build their fixtures from the embedded text.

### The typed error

```ts
/** A warm control store this build cannot apply its control schema to without destroying data. */
export class ControlStoreIncompatibleError extends Error {
	/** `controlStorageScope(partyId)`: the storage the embedder deletes to recreate (docs/architecture.md). */
	readonly storageScope: string;
	constructor(
		readonly partyId: string,
		/** The version the store was written with; 0 = before versions were recorded. */
		readonly storeVersion: number,
		/** The version this build declares. */
		readonly buildVersion: number,
		/** The DDL the apply would have run, from `diff schema`; for diagnostics, not for parsing. */
		readonly pendingDdl: readonly string[]
	) { … this.name = 'ControlStoreIncompatibleError'; }
}
```

The message is stable and names the direction (`storeVersion > buildVersion`: written by a newer release; otherwise by an older one) and the scope, not the DDL. Define it in a new small module beside the check (for example `control-schema-version.ts`, holding the error, the version read and the additive classifier), keep `loadSchema` as the caller, and export the error and `CONTROL_SCHEMA_VERSION` from `index.ts`.

It carries no `cause`: the check refuses before Quereus runs anything, so there is no Quereus error to attach. That is a deliberate change from the original ticket's wording ("the Quereus error as `cause`"), because applying first and classifying the failure afterwards would still run the partial, irreversible migration shown in the reproduction table. A failure of the apply itself — a cold store, or a warm store whose diff was additive — keeps its raw error; those are not incompatibilities. `control-schema-apply-unwind.spec.ts`'s raw-text pin is a cold store and stays. `control-write-retry.spec.ts`'s message is synthetic and stays. There are no other raw-text pins to retire.

### Comments that become wrong

- `loadSchema`'s NOTE (~1128) says a store with different constraint text fails "here on every start". Replace it with a pointer to the check: incompatible stores are refused before the apply, and the apply is where migrations go (`plan/control-schema-versioned-migrations`).
- The comment on `RETRIABLE_SCHEMA_INIT_MATCHERS` says irreversible steps are things "none of which a `CadreControl` diff generates today". The reproduction shows the diff does generate `DROP COLUMN` and `DROP TABLE` against a store from another release. After this ticket the check refuses those before the apply runs, so the statement becomes true by construction; say that, and name the check.

### Recreate, defined (docs/architecture.md)

Decision: **cadre-core documents the procedure and offers no `recreateControlStore` API.** cadre-core cannot delete storage: `RawStorageProvider` (`types.ts` ~127) only hands out stores. Deleting is the embedder's (cadre-rn's `storage.destroyDatabase(storagePrefix + controlStorageScope(partyId))` as in `phone-node/dissolve.ts` `finishRemoving`; the web app's `deleteStore(controlStorageScope(partyId))` in `web-dissolve.ts`). Versioned migrations are decided and planned, so a recreate API would be a stopgap API. The typed error's `storageScope` is what the embedder needs to find the store.

Replace the paragraph that begins "Editing the text of an existing control-table constraint…" with one that says, in this order:

- Any change to an existing control table — constraint text, an added or removed column, a removed table — cannot be applied to a warm store: the optimystic module refuses `alter table … drop constraint`, `add column` and `drop column`, and a removed table would be dropped with its rows. Adding a table or an index applies.
- The schema version: where it lives (the `OwnerKey` table tag), the bump rule, and that a warm start compares it and the pending DDL before applying and throws `ControlStoreIncompatibleError` instead, for a store from an older release and from a newer one.
- Until `plan/control-schema-versioned-migrations` lands, the policy is recreate. Recreating means: stop the node and delete the control store (`controlStorageScope(partyId)`) on **every** machine of the party, then start the founding machine, which runs owner genesis again with the same owner key, and re-admit the other machines with new invitations. Every machine, because the control tables' collection ids are fixed by table name, so a recreated store and a surviving old one would hold different blocks under the same ids; this reasoning is from the code, not a run — the implementer should either check it with two machines or keep the instruction as stated and say it is precautionary.
- What is lost: every row of the control tables — `OwnerKey`, `CadrePeer`, `CadreInvite`/`CadreInviteUsage`, `FormationInvite`/`FormationUsage`, `ValidationKey`, `Strand`, `StrandPartyKey`, `JoinedStrand`, `JoinRequest` and its outcomes, `DeviceToken`, `Revocation` — including the closed-strand read secrets (`Strand.MemberPrivateKey`, `JoinedStrand.MemberPrivateKey`) and the `StrandPartyKey` private keys, which are stored nowhere else. A `JoinedStrand` secret is also held by the founding party and every member, so that strand can be re-joined; the party's own closed strands cannot be read again. What survives: strand stores (their scope is the strand id), the machine's identity key, the owner key (held by the kit's key store since the owner-key series, not derived from the identity), and the node-local trusted-owner anchor.

Keep it to the section that owns the control tables; follow AGENTS.md (no history narrative, one claim per item).

## Timing

The owner-key series (`complete/1.03-owner-key-label-and-founder-machine` and siblings) has already landed on master and changed control constraint text, so the next release breaks warm starts of stores from the previous one whether or not this ticket lands. With this ticket those embedders get `ControlStoreIncompatibleError` (store version 0) instead of a raw DDL error; the release notes still need to tell them to recreate, until migrations land. `plan/2-owner-grant-separate-from-machine-invitation` also edits the control schema and must bump the version.

## Tests

One spec, at the `ControlDatabase` layer over `MemoryRawStorage` (the reproduction harness above; fixtures derived from `CONTROL_SCHEMA` by replacing one literal, written to a temp file for `schemaPath`). Three cases, each a branch of the check:

- A store written with an edited constraint and a lower version: `initialize()` rejects with `ControlStoreIncompatibleError` carrying `storeVersion < buildVersion`, and a third lifetime with the original schema still starts (proves nothing was applied).
- A store written with a higher version and an extra table: rejects with `storeVersion > buildVersion`, and the extra table is still in the catalog of a later lifetime started with that newer schema (proves the downgrade did not drop it).
- A store with no version tag whose schema lacks one table the build declares: starts, the table exists, and the `OwnerKey` tag now reads the build's version (additive path, pre-version store).

Plus the drift-spec assertion pinning (version, `explain schema` hash). No `CadreNode`-level test: `start()` already rethrows unchanged.

## TODO

- Add `CONTROL_SCHEMA_VERSION` and the `OwnerKey` version tag to `control-schema.ts` and `schemas/control.qsql`; split out the declaration text; add the drift-spec version/hash assertion.
- New module with `ControlStoreIncompatibleError`, the stored-version read and the additive-DDL classifier (via `Parser`); export the error and the constant from `index.ts`.
- Rework `loadSchema`: warm-store detection, declare, `diff schema`, refuse or apply; `schemaPath` handling as described.
- Update the `loadSchema` NOTE and the `RETRIABLE_SCHEMA_INIT_MATCHERS` comment.
- Write the three-case spec; run `yarn workspace @serfab/cadre-core test` and `yarn lint`; confirm `control-start-storage-op-budget.spec.ts` still passes (the check reads only the local catalog; if a warm-start count moves, find out why before re-pinning).
- Rewrite the architecture paragraph (version, check, typed error, recreate procedure, what is lost and what survives).
- Add a line to `plan/control-schema-versioned-migrations`'s "Where the version lives" if the implementation departs from the tag-on-`OwnerKey` choice.
