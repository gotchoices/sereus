----
description: sAppId strand filter deferral permanently starts strands that should be excluded — a strand admitted under an unknown-sAppId deferral is never re-evaluated.
files: packages/cadre-core/src/strand-watcher.ts
----
`StrandWatcher` is responsible for honoring a node's configured `StrandFilter`, including the `sAppId` mode, which is meant to restrict a node to running only the strands whose owning sApp matches `filter.sAppId`. The current implementation lets non-matching strands leak onto a node that is explicitly configured with `sAppId` filtering, because a filter decision deferred while the sAppId is unknown is never revisited.

## How it diverges

When `passesFilter` runs in `sAppId` mode and the strand's sAppId is not yet known, the watcher logs "deferring filter decision" and returns `true` (packages/cadre-core/src/strand-watcher.ts:82-94). The sAppId is supplied out-of-band by the hosting application via `SAppIdLookup.getSAppId`, so it is legitimately unavailable when a strand first appears. On the next `poll()`, `onStrandAdded` runs: the strand is added to `knownStrands` and an instance is started (strand-watcher.ts:112-122).

The problem is that `poll()` only evaluates `passesFilter` for strands that are NOT already in `knownStrands` — the added-strand loop is gated on `!this.knownStrands.has(strand.Id)` (strand-watcher.ts:112-122). Once a strand has been admitted under the deferral and recorded in `knownStrands`, it is never re-checked against the filter again. If its sAppId later resolves to a value that does not match `filter.sAppId`, the strand nonetheless stays running, in violation of the configured filter. The net effect is that a node configured with `sAppId` filtering accumulates and keeps running strands belonging to other sApps — the exact strands the filter was meant to exclude.

## Expected behavior

A strand admitted under a deferred filter decision must be treated as provisional, not final. Once its sAppId resolves, the watcher must re-evaluate it against the configured filter, and if it does not match, stop the strand (invoking the `onStrandRemoved` callback) and remove it from `knownStrands`. The deferral must only ever be a temporary bridge until the sAppId is known; it must never become a permanent admission. Strands whose sAppId resolves to a matching value should continue running unaffected, and strands whose sAppId is still unknown should remain deferred and continue to be re-evaluated on subsequent polls until a decision can be made.

Key file: packages/cadre-core/src/strand-watcher.ts (`passesFilter`, `poll`).
