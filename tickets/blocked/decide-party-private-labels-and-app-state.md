description: Decide whether to build #6's party-private app state now, because #24 (a private label on an invitation, such as "for Bob") is a second case for it and a control-schema change is cheapest before apps have users.
files: schemas/control.qsql (FormationInvite ~620, Strand ~130, JoinedStrand ~370), tickets/backlog/feat-party-private-app-state.md
----
# Party-private labels (#24) and app state (#6): now or later?

## The request (gotchoices/sereus#24)

Sereus Chat wants an optional free-text note on each of its own invitations, such as "for Bob".
- The note follows the user to their other machines, and Bob never sees it.
- Through `FormationUsage`, it also shows who redeemed which invitation.

They suggest either:
1. **`Label text null` on `FormationInvite`**, included in the signed digest, plus a label on `Strand` and `JoinedStrand` as a private strand title.
2. **The #6 facility**, if it can key app records to a token and a strand id.

They are asking now because a control-schema change means recreating every party, and chat has no users yet.

## Assessment

- **The control database is the right home for both.** It replicates only to the party's own machines, so other members can neither read a value nor see that it changed. That also meets kjeib's stricter requirement on #6, that a write to read position must not be observable.
- **Option 1 fits poorly.**
  - `FormationInvite`, `Strand` and `JoinedStrand` are immutable signed rows (`Immutable` / `NoUpdate`). A label could not be edited without deleting and re-signing its row, so renaming a strand would mean re-signing its `Strand` row.
  - It also adds columns to sereus that sereus never reads.
- **Option 2 is the "capped per-sApp key/value space" that #6 recommends**, with keys the app chooses (a token, a strand id). It serves #24 and #6 together, and sereus never interprets the data.
- **The cost noted in #6 still applies.** Stored values grow the control database, whose start-up cost is budgeted.
  - Labels are tiny and rarely written.
  - Read position is small but written often, so the cap and a limit on write rate must be settled.

## Maintainer direction (2026-09-30)

> "I try to avoid key/value stores, unless the semantics are truly opaque to the layer in question."

That rules out #6's key/value recommendation.

The relational alternative is **a party-private app database**:
- **What it is:** a Quereus database per sApp, holding tables the app declares in a schema of its own (for example `table InviteNote (Token text primary key, Label text not null)`).
- **Where it lives:** it replicates across the party's own machines the way the control database does, and never to strand members.
- **What sereus does with it:** sereus hosts and replicates it but never reads its tables, so it stays opaque to sereus without being shapeless to the app.
- **What it costs:** a second database per party per sApp, opened next to the control database. This is #6's "separate party-private database" option, and it is the most work.

## Maintainer question (2026-10-01): embed the app's database in the control database?

> "Is there a way for us to embed the app specific database into the control database somehow, so that it's opaque (like a blob) in the control database, but a relational database for the app?"

Yes, by embedding at the storage and network layer rather than inside a column.

**How it would work**
- **One namespace per app.** The control database is a Quereus database whose tables are optimystic collections on the party's control network: the default vtab is `optimystic`, with `networkName` set to the control network (`control-database.ts` ~553). Quereus already supports more than one declared schema (`declare schema CadreControl { … }`). The app's tables would go in their own declared schema, one per sApp, as more collections on the same control network.
- **Opaque to sereus.** Sereus never declares, reads or checks the app's tables, and `CadreControl` has no knowledge of them. Its signed tables and constraints are unchanged.
- **Relational for the app.** The app applies its own private schema with `apply schema` and queries it like its strand database.
- **Shared replication.** The app's tables replicate exactly where the control tables do, to the party's own machines and nowhere else.
- **No second database.** There is no second network, cohort or set of protocols, and no new place to persist.

**Why not a literal blob column.** Serialising the app's database into one value would turn every write into a rewrite of the whole value. Two machines writing at once would conflict on the entire database instead of merging row by row, which the per-table collections do today.

**Questions for planning**
- **Isolation.** The app's SQL handle must not reach `CadreControl` tables, but a filter on SQL text would need a parser. A second Quereus `Database` would have only the app's schema declared, and its default vtab would point at the same control network and storage. That needs verifying: can two plugin instances share one control network and collection factory?
- **Start-up cost.** `pluginResult.hydrate` currently loads every persisted optimystic table schema at control start. App tables must be left out, or loaded only when the app opens its schema, so that the budgeted start-up cost does not grow with app data.
- **Who may write.** Control rows are owner-signed. App rows would carry no signature, so any machine admitted to the party's control network could write them, including enrolled non-owner machines and machines lent under a grant. That is the same trust boundary as reading the control database today, but it should be stated.
- **Schema lifecycle.** Apply the schema on app upgrade; on uninstall, either drop the schema or keep its data.

## Decision needed

- **A′. The app's schema embedded in the control database** (recommended): tables in a per-app namespace on the control network, as described above. This is A without the second database.
- **A. A separate party-private app database with an app-declared schema.** It serves #24 and #6 together. Its plan must settle three things:
  - which machines host it;
  - its start-up cost;
  - how the app declares its private schema next to the strand schema.
- **B. Add only an invitation label now** (option 1, not editable), and leave #6 for later.
- **C. Leave both for later.** Chat keeps device-local storage keyed by token, as it already plans to in the meantime.
