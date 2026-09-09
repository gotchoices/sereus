----
description: An app needs somewhere to keep per-user state that follows the user across their own devices but stays invisible to everyone else in the shared workspace — how far they have read, a draft, a preference. There is no such place today. Decide whether to provide one.
files: schemas/control.qsql, packages/cadre-core/src/control-database.ts, packages/cadre-core/src/node-local-snapshot.ts, docs/cadre-consistency.md, docs/strand-contracts.md
----

# Decision (a): is there a home for party-private, app-namespaced state?

**Category (a) — a decision only a human should make.** Raised as **gotchoices/sereus#6** by an
outside consumer, explicitly as a feature gap rather than a defect, and ending with a direct
question: *"Is anything like this planned? If not, is the control DB the right place to ask for it,
or is there a better one we have missed?"*

## The need

State that is **private to one party, replicated across that party's own machines, and invisible to
other members of the strand**. Their case is read position: read a conversation on the laptop and the
phone should already know, but no counterparty has any business seeing it. Small values, low write
rate, no cross-party visibility ever.

They note it is unlikely to be unique to chat — any app with a per-user cursor, preference, or draft
has exactly this shape.

## Why nothing fits today, in their words and confirmed against our source

| candidate | why it fails |
| --- | --- |
| an sApp table in the strand database | replicates to **everyone** in the strand; there is no per-member visibility scoping, every member holds the whole strand database, so read position becomes public |
| the control database | has precisely the right properties — party-private, replicated to the whole party — but its schema is fixed and closed (`schemas/control.qsql`: `OwnerKey`, `ValidationKey`, `Strand`, `CadrePeer`, `DeviceToken`, `FormationInvite`, `FormationUsage`, `Revocation`). No app-extension table, no per-app key/value space. The one design that adds an app-ish table to it — `KnownDocument` in `docs/strand-contracts.md` — is unimplemented |
| node-local storage (`node-local-snapshot.ts`) | explicitly never replicated, so state would not follow the user between devices, which is the entire requirement |

## What happens if we do nothing

Consumers put it in the strand database and it leaks, or they put it in node-local storage and it
does not follow the user, or they build a side channel of their own. The first is a privacy defect
we will have led them into.

## Options

- **An app-extension table in the control database**, namespaced by sApp id. Fits the stated
  properties exactly. Costs: the control DB is party-critical infrastructure with a deliberately
  closed schema, replicated at `CONTROL_REPLICATION_BREADTH` to every machine of the party, and
  opening it to app data invites unbounded growth in the one database whose start-up cost we pin with
  storage-op budgets (`docs/testing.md`).
- **A generic per-`sAppId` key/value space** with the same backing but an explicitly narrow API —
  small values, capped size, no queries — so the blast radius of the previous option is bounded by
  the interface rather than by convention.
- **A separate party-private database** alongside the control one, so app state never shares a
  schema, a replication policy, or a start-up cost with membership data. Most work; cleanest
  separation.
- **Decline, and say so.** Tell consumers this is out of scope and per-user state belongs in their
  own infrastructure. Honest, and cheap — but it pushes every app toward a side channel, which is the
  outcome the reporter is trying to avoid.

Recommended default: the capped key/value space. It answers the need without opening the control
schema to arbitrary app tables, and the cap is what keeps the start-up budget defensible.

## Reversibility

Whatever ships becomes a persistence contract consumers store user data in, so migrating away later
means migrating their data. Worth settling the shape before anything ships, which is why this is a
decision rather than a backlog item.
