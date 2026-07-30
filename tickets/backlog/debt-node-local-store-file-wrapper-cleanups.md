---
description: Two small tidy-ups left over from sharing one saving mechanism between the node's on-device record files — a chunk of pure pass-through code that no longer earns its keep, and one storage backend class sitting in a file whose stated purpose no longer covers it.
files: packages/cadre-core/src/trusted-owner-store-file.ts, packages/cadre-core/src/bootstrap-peer-store-file.ts, packages/cadre-core/src/fs-atomic.ts, packages/cadre-core/test/node-local-snapshot.spec.ts
difficulty: easy
---

# Node-local store: file-wrapper and slot-placement cleanups

Follow-on hygiene from `node-local-store-durable-slot-seam`, which moved the shared
persistence machinery for the node's two node-local records (the trusted-owner anchor
and the cold-start bootstrap-peer store) into `node-local-snapshot.ts` behind an
injectable `DurableSlot`. Nothing here is a defect — the code is correct, tested, and
shipping. These are three structure/coverage items a reviewer flagged and deferred.

## Pure pass-through wrappers

`FileTrustedOwnerStore` (`trusted-owner-store-file.ts`) and `FileBootstrapPeerStore`
(`bootstrap-peer-store-file.ts`) are now nothing but a slot name plus four/three
members that forward verbatim to `PersistentTrustedOwnerStore` /
`PersistentBootstrapPeerStore`. Roughly 50 lines across the two files carry no logic.

They are safe as written — each `implements` its store interface, so a missing or
mistyped forwarded member is a compile error, not a silent drift — so this is a
readability item, not a correctness one.

The constraint that produced them: `class FileTrustedOwnerStore extends
PersistentTrustedOwnerStore` does not compile, because a derived
`static open(dir, partyId)` is not assignable to the base's
`static open(slot, partyId)`.

Two ways out, both preserving the exact public call shape
`FileTrustedOwnerStore.open(dir, partyId)` that `cadre-cli`
(`packages/cadre-cli/src/commands/start.ts:146,156`) and ~30 test call sites use:

- export a `const` object with a single `open` method returning the store
  *interface* type (`Promise<TrustedOwnerStore>`), deleting every forwarding member;
- or rename to a plain factory function (`openFileTrustedOwnerStore(dir, partyId)`),
  which is more idiomatic but churns the CLI and both spec files.

Either is fine. Confirm first that nothing uses `FileTrustedOwnerStore` /
`FileBootstrapPeerStore` as a *type* or with `instanceof` (a repo-wide grep at review
time found only `.open(...)` call sites, but re-check).

## `FileDurableSlot` lives in the wrong module

`FileDurableSlot` — the Node file backend for a durable slot — sits in
`packages/cadre-core/src/fs-atomic.ts`, whose module comment describes itself as
"Node-only filesystem helpers shared by the file-backed stores". It is not a helper;
it is a storage backend, and the two stores named in that comment no longer use the
helpers directly at all (they go through the slot). Move it to its own
`file-durable-slot.ts` and correct `fs-atomic.ts`'s module comment, leaving
`fs-atomic.ts` as what it claims to be: `writeFileAtomically`,
`encodeFileSafeComponent`, `isNotFound`, and the mode constants — which `key-store-file.ts`
still uses directly.

The new module must stay out of the package's cross-platform default entry
(`src/index.ts`), like its two importers, so the `node:fs` edge never reaches an RN or
browser bundler.

## Missing concurrency coverage on the shared path

`NodeLocalSnapshot.put` serialises persists through a promise chain so overlapping
writes stay ordered and the last landed snapshot is complete. That guarantee is
exercised only through the Node file backend today (the 8-concurrent-writes cases in
`test/trusted-owner-store.spec.ts` and `test/bootstrap-peer-store.spec.ts`). The
cross-platform suite (`test/node-local-snapshot.spec.ts`) drives both persistent
classes against an in-memory fake slot but never issues overlapping `put()` calls.

Add a case there: give the fake slot a controllable delay, fire several
`trust()` / `record()` calls without awaiting in between, then assert the saves
happened in order and that reopening the slot yields the full set. That puts the
ordering guarantee under test on the backend every future platform slot will be
validated against, rather than on the one backend that happens to exist.
