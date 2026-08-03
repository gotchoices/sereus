description: On the NativeScript phone app, the piece that opens a per-conversation database file has no automated tests, and if one of those opens ever fails the app keeps replaying that same failure for the rest of the session instead of trying again.
files: packages/reference-app-ns/src/ns-storage.ts, packages/reference-app-ns/test/cadre-phone.spec.ts, packages/reference-app-ns/vitest.config.ts
difficulty: easy
---

# `ns-storage.ts` has no coverage, and a failed database open is cached forever

## Background

`packages/reference-app-ns/src/ns-storage.ts` is the NativeScript app's storage
provider for strands (the app's term for a shared conversation/dataset). Cadre's
node configuration asks for a **synchronous** factory that returns a storage
object per strand, but the NativeScript SQLite open is **asynchronous**. The
module bridges that: `makeLazyNsStorage(strandId)` hands back a proxy object
immediately, and every method on it waits for a cached open promise before
delegating to the real SQLite-backed storage.

It is the only module in `src/` with no unit coverage at all. The Vitest harness
that landed under `debt-ns-unit-test-harness` mocks it out wholesale
(`vi.mock('../src/ns-storage', …)` in `test/cadre-phone.spec.ts`) because
importing it for real drags in the native SQLite plugin, which does not exist
under Node.

## What is worth covering

Most of the file is mechanical one-line delegation and does not need tests of its
own. Two behaviours are not mechanical:

- **One open per database name.** `openStorage` caches the open promise in a
  module-level map keyed by database name, so a strand whose provider is invoked
  more than once over the node's life shares a single SQLite connection rather
  than reopening the file. Nothing currently proves that.

- **A failed open is cached permanently.** The map stores the promise, not the
  resolved value. If the open rejects — corrupt file, no disk space, plugin not
  yet initialised — the rejected promise stays in the map, and *every* later
  operation on that strand replays the original error. Nothing ever retries; only
  restarting the app clears it. Observed by reading the code, not by running it.

  Whether that is the wanted policy is an open question and part of this ticket:
  "fail fast and stay failed" is defensible for a corrupt database file, but a
  transient failure (plugin not ready during startup) then bricks that strand for
  the whole session with no user-visible way out. Decide it deliberately, then
  pin the decision with a test — do not just test whatever it does today.

The two async-generator methods (`listRevisions`, `listPendingTransactions`) also
differ in shape from the rest — they `await` the open, then `yield*` — and are
worth one test between them.

## Constraint on how to test it

The module statically imports `@optimystic/db-p2p-storage-ns`, which is a native
NativeScript plugin. Any unit test has to mock that import the way
`test/cadre-phone.spec.ts` already mocks it — a fake `openOptimysticNSDb` plus a
fake `SqliteRawStorage` that records the calls delegated to it. The existing
suite's hoisted-doubles pattern is the model to follow.
