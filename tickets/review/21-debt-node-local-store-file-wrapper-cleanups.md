description: Cleaned up two leftover rough edges from sharing one saving mechanism between the node's on-device record files — deleted a chunk of code that only forwarded calls with no logic of its own, and moved one storage class out of a file whose stated purpose no longer covered it. Also added a missing test.
files: packages/cadre-core/src/trusted-owner-store-file.ts, packages/cadre-core/src/bootstrap-peer-store-file.ts, packages/cadre-core/src/fs-atomic.ts, packages/cadre-core/src/file-durable-slot.ts, packages/cadre-core/src/node-local-snapshot.ts, packages/cadre-core/test/node-local-snapshot.spec.ts
difficulty: easy
---

# Node-local store: file-wrapper and slot-placement cleanups

All three items from the plan ticket done.

## Pure pass-through wrappers → const-object factories

`FileTrustedOwnerStore` and `FileBootstrapPeerStore` were classes whose entire body forwarded to
`PersistentTrustedOwnerStore` / `PersistentBootstrapPeerStore`. Took the plan's first option
(preserves the exact public call shape, least churn): each is now a `const` object with a single
`open(dir, partyId)` method that returns the store *interface* type directly
(`Promise<TrustedOwnerStore>` / `Promise<BootstrapPeerStore>`) instead of constructing a wrapper
instance:

```ts
export const FileTrustedOwnerStore = {
	async open(dir: string, partyId: string): Promise<TrustedOwnerStore> {
		return PersistentTrustedOwnerStore.open(new FileDurableSlot(dir, SLOT_NAME, partyId), partyId);
	}
};
```

Confirmed before the change (repo-wide grep) that nothing uses either name as a *type* or with
`instanceof` — every reference across `cadre-cli/src/commands/start.ts` and the ~30 call sites in
`test/trusted-owner-store.spec.ts` / `test/bootstrap-peer-store.spec.ts` is a `.open(...)` call,
so the call shape is unchanged and nothing else needed to move.

## `FileDurableSlot` moved out of `fs-atomic.ts`

New file `packages/cadre-core/src/file-durable-slot.ts` holds `FileDurableSlot` (the Node
`DurableSlot` backend). `fs-atomic.ts`'s module comment now describes only what's left in it:
`writeFileAtomically`, `encodeFileSafeComponent`, `isNotFound`, and the mode constants — still
used directly by `key-store-file.ts`. `node-local-snapshot.ts`'s module comment, which named the
old location, is updated to match. The new module is not re-exported from `index.ts` (same as
`fs-atomic.ts` before it), so the `node:fs` edge still can't reach the package's cross-platform
default entry.

## Concurrency coverage on the shared path

Added `packages/cadre-core/test/node-local-snapshot.spec.ts`: a `GatedSlot` (`DurableSlot` whose
`save()` blocks until the test releases it, FIFO) plus one new test —
`'overlapping trust() calls persist in order, one save at a time, and a reopen sees them all'`.
Fires three `trust()` calls without awaiting between them, confirms via a microtask-polling helper
(`untilSaveCount`) that each save only starts after the previous one's promise settled, then
confirms the last landed snapshot holds all three entries and a reopened store sees them all. This
exercises `NodeLocalSnapshot.put`'s write-chain ordering guarantee directly (over the cross-platform
fake slot), rather than only incidentally through the Node file backend's own 8-concurrent-writes
cases.

## Verification

- `yarn tsc --noEmit -p packages/cadre-core/tsconfig.typecheck.json` — clean (src + test).
- `yarn tsc -p packages/cadre-core/tsconfig.build.json` — clean build.
- `yarn tsc --noEmit -p packages/cadre-cli` — clean (consumer of the `*-store-file` subpaths,
  against the rebuilt `cadre-core` dist).
- `yarn eslint` on every changed/new file — clean.
- **Could not run `yarn vitest` for `cadre-core`** — its `global-setup.ts` build-freshness guard
  aborts the whole suite up front because the linked `../optimystic` sibling repo (`db-core`,
  `db-p2p`) has uncommitted, currently non-compiling changes (`Cannot find name 'highestStaleAt'`
  in `network-transactor.ts`) from an in-progress session there, unrelated to this diff. Logged in
  `tickets/.pre-existing-error.md` per the workflow rules rather than worked around. The new test's
  control flow (write-chain ordering via chained promise `.then()`s, verified against
  `NodeLocalSnapshot.put`'s actual implementation) was traced by hand instead; a reviewer should
  re-run `yarn vitest run test/node-local-snapshot.spec.ts` from `packages/cadre-core` once that
  sibling repo's build is fixed, to confirm the new test actually passes rather than only
  type-checking.
