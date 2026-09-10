----
description: Give sApps a home for per-user state that follows a party across its own machines but stays invisible to the rest of the strand — read position, drafts, preferences. Deferred past the initial release; interim workaround is documented separately.
files: schemas/control.qsql, packages/cadre-core/src/control-database.ts, packages/cadre-core/src/node-local-snapshot.ts, docs/cadre-consistency.md, docs/strand-contracts.md
difficulty: medium
tradeoffs: opening the control database to app data grows the one database whose start-up cost is budgeted; a separate party-private database avoids that at the cost of a second replication path
likelihood: likely
----

# Party-private, app-namespaced state

Raised as **gotchoices/sereus#6** by an outside consumer, as a feature gap rather than a defect.

## Decision taken (owner, 2026-09-09)

> "I think this is a good request, but probably can come after the initial release. In the meantime,
> maybe just work around it by storing the data in the common database with a user key."

So: **not a release blocker.** The interim answer is the strand database with a per-party key — which
means consumers must understand that the state is *readable by every strand member*, and choose
accordingly. Documenting that honestly is the release-relevant half and is tracked separately as
`document-party-private-state-interim`.

## The need

State private to one party, replicated across that party's own machines, invisible to other strand
members. Small values, low write rate, no cross-party visibility. Not chat-specific — any app with a
per-user cursor, preference, or draft has this shape.

## Why nothing fits today

| candidate | why it fails |
| --- | --- |
| an sApp table in the strand database | replicates to **everyone**; no per-member visibility scoping, so read position becomes public |
| the control database | right properties (party-private, party-wide replication) but a fixed, closed schema (`schemas/control.qsql`) with no app-extension table or per-app key/value space |
| node-local storage (`node-local-snapshot.ts`) | never replicated, so state does not follow the user between devices — the entire requirement |

## Options (unchanged from the blocked write-up)

- **An app-extension table in the control database**, namespaced by sApp id. Exact fit; costs
  unbounded growth in the database whose start-up cost is pinned by storage-op budgets.
- **A generic per-`sAppId` key/value space** with a deliberately narrow API — small values, capped
  size, no queries — so the blast radius is bounded by the interface rather than by convention.
- **A separate party-private database** alongside the control one. Most work, cleanest separation.

Recommended default: **the capped key/value space.**

## Reversibility

Whatever ships becomes a persistence contract holding user data, so migrating away later means
migrating their data. Settle the shape before anything ships.

## TODO

- [ ] Pick between the capped key/value space and a separate party-private database.
- [ ] Specify the cap (value size, per-sApp total) and what happens when it is hit.
- [ ] Decide whether the space is queryable at all, or strictly get/put by key.
- [ ] Define the replication policy relative to `CONTROL_REPLICATION_BREADTH` and the start-up budget.
- [ ] Migration story for consumers who took the interim strand-database workaround.
