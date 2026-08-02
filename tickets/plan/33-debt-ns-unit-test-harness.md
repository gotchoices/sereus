description: The NativeScript phone app has no unit tests at all, so small pieces of its own glue code — like the bit that saves records into the phone's database — are only ever checked by hand on a device.
files: packages/reference-app-ns/package.json, packages/reference-app-ns/src/node-local-slots.ts, packages/reference-app-ns/src/ns-storage.ts, packages/reference-app-rn/test/node-local-slots.test.ts
difficulty: medium
---

# `reference-app-ns` has no unit-test runner

## Situation

`packages/reference-app-ns` ships only three checks: `typecheck`,
`test:bundle` (webpack-compiles the whole import graph), and `test:e2e`
(needs a real device or emulator, so no agent and no CI job runs it). There is no
unit-test runner, so every piece of app-level glue in `src/` is unverified except
by the type checker.

The gap became concrete with the durable node-local records: `src/node-local-slots.ts`
holds the key format (`trusted-owners.<partyId>` / `bootstrap-peers.<partyId>`)
and a small `DurableSlot` adapter over `SqliteKVStore`, and `cadre-phone.ts`
composes them with a shared SQLite handle whose lifetime spans start/stop. The
cross-platform machinery underneath is covered in `@serfab/cadre-core`, and the
sibling React Native app has direct tests for its own slots
(`packages/reference-app-rn/test/node-local-slots.test.ts`), but nothing checks
the NativeScript composition — including the empty-key-prefix choice, which is
what keeps the stored keys equal to those literal strings.

## Expected outcome

- The package has a unit-test runner that works under plain Node (no device, no
  NativeScript runtime), in line with how the rest of the monorepo tests.
- Round-trip coverage for the node-local slots: written text comes back
  unchanged; an absent key reads as "nothing stored"; a database read fault
  surfaces as an error rather than as "nothing stored" (that distinction is what
  stops a later write from destroying an intact record); and the stored key is
  exactly the documented literal string.
- Coverage for the shared-handle lifecycle in `cadre-phone.ts` if it can be
  reached without the native plugin — at minimum, that stopping the node releases
  the database handle even when the node's own shutdown throws.

## Notes

- The `KvStoreApi` shape in `src/node-local-slots.ts` exists precisely so a test
  can pass an in-memory fake with no SQLite dependency.
- `@optimystic/db-p2p-storage-ns` itself tests against `node:sqlite` /
  `better-sqlite3` instead of the NativeScript plugin; the same trick would let a
  test exercise the real `SqliteKVStore` here.
- Whatever runner is chosen should be added to the repo's normal test invocation
  so it is not a script only a human remembers to run.
