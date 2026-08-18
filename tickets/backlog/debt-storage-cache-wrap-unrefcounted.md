---
description: When several parts of the app are told to use one shared data store, they all quietly end up sharing a single memory cache that none of them owns — so the first part to shut down throws that cache away while the others are still using it, and the next part to start builds a second, competing cache over the same data.
files: packages/quereus-plugin-sereus/src/cached-storage.ts, packages/quereus-plugin-sereus/src/compose-strand.ts, packages/quereus-plugin-sereus/src/types.ts, packages/quereus-plugin-sereus/test/cached-storage.spec.ts, packages/cadre-core/src/types.ts, docs/architecture.md
difficulty: medium
severity: wrong-result
likelihood: unusual
tradeoffs: No shipped wiring hits it today — every provider in this repo either hands out a distinct store per scope or hands out an in-memory store, which is never cached at all — so a maintainer could reasonably wait until a real embedder configures a shared persistent store, and just tighten the documented contract instead.
---

# The cache wrapper has no owner count, so one scope's shutdown speaks for all of them

## Background in plain terms

Every store the app is given gets wrapped in a small read cache before anything uses
it. There is one helper that does the wrapping (`wrapStorageWithCache`) and, as of the
`strand-storage-owned-per-instance` change, one that releases it
(`disposeStorageCache`). Both live in
`packages/quereus-plugin-sereus/src/cached-storage.ts`.

The wrapping helper **memoizes by the store object it was handed**. That is deliberate:
several parts of the system reach for the same store, and wrapping it twice would put
two caches over one backend, which the architecture explicitly forbids (`docs/architecture.md`,
"one live cache per backend").

The releasing helper, by contrast, is unconditional. It has no idea how many callers
are still holding the wrapper it is being asked to retire.

## The defect

`CadreNodeConfig.storage.provider` accepts either a factory keyed on the scope, or a
single `IRawStorage` instance shared by every scope — the control database and every
workspace. `docs/architecture.md` documents the second form as supported.

Take the shared form with any persistent backend:

1. The control database starts. The instance is wrapped → wrapper **W**. Memo records it.
2. Workspace A starts. Same instance → memo hit → **W**.
3. Workspace B starts. Same instance → memo hit → **W**.
4. Workspace A stops. `disposeStorageCache(W)` runs: **W**'s cache is emptied, its
   registration in the process-wide cache pool is retired, and the memo entry is dropped.
   The control database and workspace B are still live and still reading and writing
   through **W**.
5. Workspace C starts. Memo is now empty → a **second** wrapper **W2** is built over
   the same underlying store.

After step 5 there are two live caches over one backend. Writes go straight through
(the cache is write-through, so nothing is lost), but each cache holds its own read
state — including remembered "this block does not exist" answers — so a block C writes
through **W2** can be reported as still-absent to the control database reading through
**W**. That is a stale read, not just a slow one.

Step 4 alone is already wrong even if step 5 never happens: the control database's warm
cache is dumped by an unrelated workspace shutting down, and its pool registration is
gone while it keeps admitting entries — so the pool's own occupancy report stops
counting them.

Confirmed by running the five steps directly against `cached-storage.ts` (all
assertions held: one wrapper handed to all three scopes; a different, live wrapper
handed to the fourth after the third scope's dispose).

**Why nothing breaks today.** Every provider this repo ships hands out a distinct store
per scope (the CLI's file provider, the phone app's LevelDB provider, the web app's and
the integration harness's per-scope caches), and the one place that does share a single
instance across scopes shares an *in-memory* store, which the helper deliberately never
wraps. So the bad path exists and is documented as supported, but nothing in-tree walks
it.

## Second arm, same site

The SQL package's own connector wraps a store per `connectStrand` call
(`compose-strand.ts`, around the `wrapStorageWithCache` call) and its `shutdown()`
never releases it. That is exactly the leak `strand-storage-owned-per-instance` closed
on the cadre-core side — one abandoned pool registration per connect, in a process
meant to run for weeks — and it is still open here.

It cannot simply be closed by calling `disposeStorageCache` in `shutdown()`: if the
caller handed in a store some other scope also holds, that dispose retires the other
scope's cache. **The two arms therefore share one root cause and one fix site.** With
ownership counted, `shutdown()` releasing its own claim becomes correct and safe, and
this arm closes for free.

## What "fixed" should mean

The wrap and the release should be a matched pair with a count between them, so that:

- Wrapping an instance a second time is still the same wrapper, but records that a
  second holder exists.
- Releasing decrements. The underlying wrapper is emptied and unregistered **only when
  the last holder releases it**, and the memo entry is dropped at the same moment — not
  before, so a still-held wrapper is never replaced by a competing one.
- Releasing something the helper handed back unwrapped (an in-memory store) stays a
  no-op, as it is now, so no call site needs to test the type.
- Releasing more times than wrapped must not go negative or retire a live successor;
  the existing "already-disposed wrapper handed back late" test in
  `cached-storage.spec.ts` covers that shape and should keep passing.

No caller changes should be required — `CadreNode`, `StrandInstanceManager`, and
`compose-strand` all already call the pair correctly for their own scope.

## What to cover in tests

`packages/quereus-plugin-sereus/test/cached-storage.spec.ts` is the home for these; it
already owns the helper's contract.

- Several scopes wrapping one instance, then one of them releasing: the wrapper stays
  live and stays registered, and a later wrap of that instance returns the *same*
  wrapper rather than a second one.
- The last holder releasing: registration is retired and a later wrap yields a fresh,
  live wrapper.
- Release called more times than wrap, in both orders, leaves no live wrapper retired
  and no retired wrapper resurrected.
- Once the count exists, `compose-strand`'s `shutdown()` releasing its claim: repeated
  connect/shutdown cycles leave the pool's store count flat.

## Related

`docs/architecture.md`'s storage section and the `RawStorageProvider` doc comment in
`packages/cadre-core/src/types.ts` both now steer embedders to the per-scope factory
form and point here. Those steers should be relaxed back to neutral once this lands.
