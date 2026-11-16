description: An app that edited a shared workspace while offline can, on reconnecting, send edits made with an older version of the app's tables before it learns a newer version was applied, and those edits erase values the newer version added. Hold such queued edits until the app has confirmed it is still on the current version.
architecture: docs/strands/app-schema.md#every-member-on-the-same-schema-version
files: packages/quereus-plugin-sereus/src/compose-strand.ts (`cohortReachability` registration), packages/quereus-plugin-sereus/src/app-schema.ts (the version check from `app-schema-version-stops-a-running-member`), packages/cadre-core/src/strand-party-machines.ts (the existing reachability gate), docs/strands/writes.md (Offline mode)
tradeoffs: The window is only an offline member reconnecting after a schema upgrade elsewhere, the stop-gap it guards is temporary until lenses let versions coexist, and closing it means a gate that must tell the version table's own blocks apart from app tables' so the check itself can still reach the network.
----

# Hold the offline queue until the app schema version is confirmed current

Under the stop-gap in docs/strands/app-schema.md → "Every member on the same schema version", a running member stops once it reads a higher recorded `App` schema version (`app-schema-version-stops-a-running-member`). A member that was offline at the lower version queued transactions that do not know the newer columns. On reconnect the queue drains as soon as its reachability gate opens, possibly before the version check sees the higher number. Rows are stored keyed by column name, so a queued insert lands with the newer columns null, but a queued update rewrites the row without them and erases their values.

## Expected behaviour

After every return from being unable to reach the cohort, the offline queue sends nothing until a version read that reached the other machines (not one served from this machine's own view) has found this app's number current. If it finds the strand ahead, the queue stays held and the member stops as the running-member ticket describes; the queued transactions stay in the journal, and what happens to them once the app updates (sent, or discarded with the app told) is part of this design.

## Shapes to weigh

- Wrap the `cohortReachability` gate the composition registers (Optimystic `ICohortReachability.reachable(blockIds)`) so it answers false for app-table blocks until the check passes. The version read's own blocks must still pass, and the offline live-read path asks the same gate.
- A hold the Optimystic queue exposes directly, if upstream adds one (sibling repo; would be a report, not an edit here).
