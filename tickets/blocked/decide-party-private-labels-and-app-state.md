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

## Decision needed

- **A. A party-private app database with an app-declared schema** (recommended, given the direction above). It serves #24 and #6 together. Its plan must settle three things:
  - which machines host it;
  - its start-up cost;
  - how the app declares its private schema next to the strand schema.
- **B. Add only an invitation label now** (option 1, not editable), and leave #6 for later.
- **C. Leave both for later.** Chat keeps device-local storage keyed by token, as it already plans to in the meantime.
