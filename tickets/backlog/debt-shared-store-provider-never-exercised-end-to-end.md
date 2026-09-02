----
description: Our documentation tells app builders they may hand the system a single data store for everything, but nothing we run actually does that — so the code path they would take has never been executed once, only reasoned about.
files: packages/quereus-plugin-sereus/src/cached-storage.ts, packages/cadre-core/src/types.ts (RawStorageProvider), packages/cadre-core/src/cadre-node.ts (resolveControlStorage), packages/cadre-core/src/strand-instance-manager.ts (resolveStrandStorage, disposeStrandStorage), packages/integration-tests/src/harness/block-store-probe.ts, docs/architecture.md
difficulty: medium
severity: wrong-result
likelihood: unusual
tradeoffs: No shipped provider takes this form — the CLI, both phone apps, the web app and the test harness all hand out a store per scope — so a maintainer may reasonably call the reasoning in the cache-claim review sufficient and spend the test budget on a path someone actually walks.
----

# The one-store-for-every-scope provider form has never been run

## What is documented, and what is exercised

`CadreNodeConfig.storage.provider` accepts either a factory keyed on the scope or a **single
`IRawStorage` instance** shared by the control database and every workspace. `docs/architecture.md`
documents the second form as supported.

Every provider this repository ships takes the first form — the CLI's file provider, both phone
apps, the web app, and the integration harness's `captureRawStorage` all hand out a distinct store
per scope. The one place that does share a single instance shares an in-memory store, which the
cache layer deliberately never wraps. So the shared form is supported on paper and unexecuted in
practice.

## Why it is worth an actual run now

`debt-storage-cache-wrap-unrefcounted` (complete, 2026-09-01) rewrote the cache wrap and release
into a counted pair *specifically* so this form is safe: without the count, the first scope to stop
retired a cache the other scopes were still reading through, and the next scope to start built a
second, competing cache over the same backend. Its review verified the counts at the helper, at
`composeStrand`, and by walking the cadre-core call sites — and said plainly that the end-to-end
proof was not run:

> Building that node, starting control plus two strands, stopping one, and confirming the control
> database still reads its own writes remains the end-to-end proof nobody has run.

The failure this guards against is a **stale read**, not a crash: a cache that keeps a remembered
"this block does not exist" answer after another cache has written the block. That is the kind of
defect reasoning is worst at catching and a live run is best at.

## What a proof looks like

One integration scenario, one `CadreNode`, one `IRawStorage` instance handed back for every scope:

- start the control database and two strands over that single instance;
- write through each scope and read it back through the others;
- stop one strand, then confirm the control database and the surviving strand still read their own
  writes — and still see writes made *after* the stop;
- start a third strand and confirm it shares the same cache rather than building a second one
  (the shared pool's `stats()` store count is the observable);
- stop everything and confirm the pool's registration for that backing store is gone.

A persistent backend is required — an in-memory store is returned unwrapped and would make the whole
scenario vacuous. `packages/integration-tests/src/harness/block-store-probe.ts` is the natural home
for a shared-instance variant of `captureRawStorage`; today it deliberately refuses that shape
(`forStrand` throws when the control and strand scopes collapse to one object), because for a
*replication* assertion a shared store is a bug. A shared-store provider harness has to be its own
thing, clearly named, so the two never get confused.

## Related

`tickets/complete/1-debt-storage-cache-wrap-unrefcounted.md` carries the counting invariant and the
call-site walk this would confirm. If that ticket ages out of `complete/`, the invariant is in the
module doc of `packages/quereus-plugin-sereus/src/cached-storage.ts`.
