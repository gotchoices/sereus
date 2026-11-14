description: Record in each shared workspace the highest version of the app's tables any member has applied, and refuse to open the workspace for an app older than that, with an error telling the app to update, so an older app can no longer remove a column a newer one added.
prereq: app-schema-version-declared-and-signed
architecture: docs/strands.md#until-then-every-member-on-the-same-schema-version
files: schemas/strand.qsql, packages/quereus-plugin-sereus/src/strand-schema.ts (`STRAND_SCHEMA`), packages/quereus-plugin-sereus/src/app-schema.ts (`applyAppSchema`, `checkAppSchema`, `applyAppSchemaOrDefer`, `retryDeferredAppSchema`, `deferralOf`, `AppSchemaRefusedError`), packages/quereus-plugin-sereus/src/compose-strand.ts (step 7), packages/quereus-plugin-sereus/src/types.ts (`StrandConnectionOptions`), packages/quereus-plugin-sereus/src/index.ts, packages/cadre-core/src/strand-database.ts (`connectToStrand` call ~183, `attachAppSchema` ~362), packages/cadre-core/src/strand-instance-manager.ts (`attachSApp` ~2278, `checkAppSchema` call ~2285, `revertRefusedAttach`), packages/cadre-core/src/cadre-node.ts (`suppressIfAppSchemaRefused`), packages/cadre-core/src/index.ts (re-exports), packages/quereus-plugin-sereus/test/e2e/local-transactor.e2e.spec.ts (pattern for the reproduction), docs/strands.md, docs/schema-guide.md, .release-notes.pending.md
----

# The strand's recorded app schema version gates opening it (gotchoices/sereus#59)

Second of three tickets. `app-schema-version-declared-and-signed` gives every `SAppConfig` a signed `schemaVersion`. This ticket records the highest one in the strand and refuses a lower one at connect and at a claim on a replica. `app-schema-version-stops-a-running-member` handles a member that is already open when a higher version is recorded; until it lands, a deferred retry that finds the strand ahead settles `failed` and the database stays open on what it hydrated.

## Where the version is recorded: a row in a new `Strand` table

```sql
-- The highest App schema version (SAppConfig.schemaVersion) any member has applied to this strand.
-- Written by the plugin's gated apply (app-schema.ts) before the App schema it records; never lowered.
table AppSchemaVersion (
    Version integer not null check (Version >= 1),
    primary key (/* empty - singleton */),
    constraint Rises check on update (new.Version > old.Version),
    constraint NoDelete check on delete (false),
) with tags ("optimystic.offline" = 'network', "optimystic.network_watch" = true);
```

In `schemas/strand.qsql` and the `STRAND_SCHEMA` mirror. Why a row in `Strand`, and not the alternatives:

- **Not a catalog tag (the control database's model).** A running member's catalog is its own hydrated copy, and Optimystic offers no way to re-read a stored catalog record short of a fresh `Database` (Optimystic README, the limitation beginning "A machine that hydrated before another machine changed a table's record"). A row is read live: "every live read first pulls what the other machines have committed" (same README). The next ticket's running-member check needs that, and the connect gate gets a fresh value from it too.
- **Not an `App` table Sereus injects.** It would share a namespace with the app's own tables and need a reserved name; `Strand` is Sereus's already, is declared by every machine (replicas included), and every one of its tables is network-acknowledged.
- **`network_watch`** lets a node with strand reactivity hear another machine's record within milliseconds (the next ticket uses it). On a node without reactivity the tag costs one debug log line.
- **The founder's empty-collection step covers it.** `FOUNDED_SCHEMAS` includes `Strand`, so a new strand gets the table's collection at founding, and joiners receive it by backfill.

### Not the same commit as the schema change: recorded first

The ticket that planned this asked that the version be recorded in the same commit as the schema change. That is not available: `apply schema` commits the catalog in its own batch at `endSchemaBatch`, which "is a write-coalescing buffer, not a transaction" (Optimystic `docs/transactions.md` → "APPLY SCHEMA coalesces catalog writes"), so no row can ride with it. The two orders differ in what a reader can see between them:

- record after apply: the new schema under the old number, so a lower member connecting in between passes the gate and its diff drops what was just added. That is the bug.
- **record before apply (chosen):** the new number over the old schema, so lower members are refused a moment early. If the apply then never lands (refused against the rows, `AppSchemaRefusedError`), the strand stays at the new number with the old schema: lower members are locked out until the app ships a version that applies, which members at the new number also need. Lockout, never loss.

## The gated apply

`applyAppSchema(db, app)` and `applyAppSchemaOrDefer(db, app, waits, released)` take `app: { schema: string; schemaVersion: number }` instead of `schema`, and both run the same gate before the apply. `checkAppSchema(app)` also validates the number (safe integer ≥ 1, else `AppSchemaRefusedError`) so a claim is refused before touching the replica.

```
read    select Version from Strand.AppSchemaVersion          (live read)
absent  → record: insert (Version) values (:declared)  → apply
equal   → apply (today's behaviour: the full diff)
lower   → throw AppSchemaOutdatedError; nothing applied, nothing written
higher  → record: update set Version = :declared        → apply
```

- **Record** is one atomic batch, `db.exec(…, undefined, { transaction: true })`, as the deferred retry already does for its apply, so it never joins a transaction the app holds open (wait the same way `applyOutsideOpenTransaction` does when `TransactionActiveError`).
- **A record refused by a constraint** (two members recording at once: the singleton key on concurrent inserts, `Rises` on a concurrent update that landed a higher number first) re-runs the gate from the read; at most 3 rounds, then throw the last error. On the re-read the member is equal or lower, and the gate decides as above.
- **A record or read that cannot reach the cohort** defers like today's apply (`{ wait: 'cohort' }`). The read's failure carries Optimystic's `BlockUnavailableError` on its cause chain, which `classifyCommitFailure` may not call `cohort-unreachable`; extend `deferralOf` to recognise it for the read. While deferred the app gets the database on its hydrated catalog, as today.
- **A record needed while the offline queue lists transactions** (`offline.entries()` non-empty, the journaled-not-restored ones included) defers as `{ wait: 'queue', transactionIds }` without trying: a `'network'` write would wait behind the queue holding Quereus's execution lock for up to `networkCommitTimeoutMs` (docs/strands.md → "Membership writes are refused while transactions are queued" says why cadre-core's own writers refuse the same way). The equal case needs no record and keeps today's queue behaviour.
- **Every deferred retry re-runs the whole gate** (`retryDeferredAppSchema` calls the gated apply, not `apply schema` alone), so a retry that finds another member recorded a higher number in the meantime stops with `AppSchemaOutdatedError` and settles `{ state: 'failed', error }`; it does not count as retryable.

### The typed refusal

```ts
/** The strand has recorded a higher App schema version than this app declares. Not retryable: the app must update. */
export class AppSchemaOutdatedError extends AppSchemaRefusedError {
	readonly appSchemaVersion: number;    // what this app declares
	readonly strandSchemaVersion: number; // what the strand records
}
```

Message names both numbers and says to update the app. A subclass of `AppSchemaRefusedError`, so `appSchemaRefusalOf` finds it, cadre-core's `suppressIfAppSchemaRefused` stops the watcher relaunching, and `revertRefusedAttach` leaves a claimed replica a replica, with no change to either. Export it from `@serfab/quereus-plugin-sereus` and re-export from `@serfab/cadre-core` beside `AppSchemaRefusedError`.

## Threading the number

- `StrandConnectionOptions`: `schema` and `schemaVersion` come as a pair, enforced by the type (`{ schema: string; schemaVersion: number } | { schema?: undefined; schemaVersion?: undefined }` intersected with the rest), so no runtime check is needed. Plugin test call sites that pass `schema` add `schemaVersion: 1`.
- `StrandDatabase` passes `sAppConfig.schemaVersion` to `connectToStrand`, and `attachAppSchema` passes it to `applyAppSchema`.
- `attachSApp`'s `checkAppSchema` call passes the pair.

## Edge cases & interactions

- **A strand with no recorded version** (every strand founded before this release): the first gated connect inserts the row, creating the table's collection. Two members doing that at once before either reads the other's write can fork the collection, the known upstream case in docs/strands.md (the bullet on tables a later schema adds, `backlog/feat-strand-tables-added-by-a-later-schema-get-their-collection`). On such a strand, reads of the table fail while the other members are unreachable, so the gate defers, and the first-sync probe (which reads every `Strand` table) withholds the database on a joining or store-less machine. Release-note both. By inspection.
- **Members on Sereus 1.23.0 or earlier** apply a `Strand` declaration without this table, and `apply schema` drops a table the declaration lacks, so such a member removes the record (and `Header.sAppSchemaVersion`). Every member of a strand must run this release or later; release-note it plainly. The control database has the same constraint across releases.
- **Equal version, different schema text** (a developer iterating): full diff, as today.
- **The same machine downgraded**: its app's number is lower than what it recorded; refused like any lower version.
- **Founder ordering**: compose's step 7 records the row before the founder bootstrap's `createEmptyCollections`. Check that it skips a table whose collection this machine already holds; if it would commit an empty collection over the one the record just created, add `AppSchemaVersion` to its `except` list (`bootstrapFounderMembership` in cadre-core). Verify by reading `empty-collections.ts`; settle by inspection.
- **A joiner's record** reads first, and the read pulls the founder's collection, so the write appends rather than forking (the first-sync rule, "a joiner writes to a table only after it has read it"). By inspection.
- **Offline mode, equal or lower**: the gate read is served from this machine's view while the others are unreachable, so a member that has not seen the higher number opens. That member is the running-member case (next ticket). By inspection.
- **Storage replica** (no `schema`): no gate, no record. It applies the `Strand` declaration, table included, and keeps replicating.
- **Claim on a live or hibernating replica** (`attachSApp`) at a lower version: `AppSchemaOutdatedError` from `attachAppSchema`; `revertRefusedAttach` already restores the replica. One existing attach-refusal spec, if one already asserts the replica survives an `AppSchemaRefusedError`, covers it by subclass; no new test.
- **`Rises` and replay**: if Optimystic resolves a conflicting update by re-executing it against the newer row, `Rises` refuses it and the gate re-reads. Confirm the refusal surfaces as a constraint error the gate recognises (Quereus `CONSTRAINT`), not a retryable fault.

## Test that pays

The reproduction, at the lowest layer that shows it: `local-transactor.e2e.spec.ts` style, one storage opened by successive connections (each a "member").

1. Open with `table T (Id integer primary key, A text)`, `schemaVersion: 1`; insert `(1, 'a')`; close.
2. Open with `T` plus `B text null`, `schemaVersion: 2`; `update App.T set B = 'b'`; close.
3. Open with the version-1 schema and `schemaVersion: 1`: rejects with `AppSchemaOutdatedError`, `appSchemaVersion === 1`, `strandSchemaVersion === 2`, and `appSchemaRefusalOf(err)` is that error.
4. Open with the version-2 schema: `select A, B from App.T` returns `('a', 'b')`.

Step 4 proves nothing ran in step 3. No other new test: the equal path runs in every existing reopen spec, and the deferral re-check is verified by inspection.

## Docs

- docs/strands.md → "Until then": replace the bullets' future tense with how it works: the table, the gate table above in prose, record-before-apply and why (one sentence on the catalog batch), the refusal type, and the three limits (pre-existing strands, earlier Sereus releases, the deferred database on its hydrated catalog). Point the "not yet built" note at `app-schema-version-stops-a-running-member` for the running member.
- docs/strands.md → "An app schema upgrade waits for the queue or the cohort": one sentence that a version record defers the same way and every retry re-checks the number.
- docs/schema-guide.md intro: the app passes `schemaVersion` beside the schema body and raises it with every change.
- `.release-notes.pending.md`: the gate, the new error, and the two compatibility limits. The entry `app-schema-version-declared-and-signed` added ends "Nothing refuses an older schema version yet; that comes next": rewrite or drop that sentence.
- Already written ahead of this ticket, by `app-schema-version-declared-and-signed`: the `SAppConfig.schemaVersion` doc comment (cadre-core `types.ts`), the `CHAT_SCHEMA_VERSION` comments in the three reference apps' `chat-strand.ts`, and one sentence in each reference app's README all say "a strand refuses an app whose number is below the highest it has seen". Check they match what this ticket builds.

## TODO

- Add `Strand.AppSchemaVersion` to strand.qsql and `STRAND_SCHEMA`.
- Gate in app-schema.ts: read, decide, record, apply; constraint re-run; queue and cohort deferral; retries re-gate; `AppSchemaOutdatedError`; `checkAppSchema` validates the number.
- Thread `{ schema, schemaVersion }` through `StrandConnectionOptions`, compose-strand step 7, `StrandDatabase`, `attachSApp`; exports.
- Settle the founder `createEmptyCollections` question.
- The reproduction spec.
- Docs and release notes.
- `yarn lint`, typecheck, quereus-plugin-sereus and cadre-core suites.
