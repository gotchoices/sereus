---
description: Cleaned up two leftover rough edges from sharing one saving mechanism between the node's on-device record files — deleted a chunk of code that only forwarded calls with no logic of its own, and moved one storage class out of a file whose stated purpose no longer covered it. Also added missing concurrency tests.
files: packages/cadre-core/src/trusted-owner-store-file.ts, packages/cadre-core/src/bootstrap-peer-store-file.ts, packages/cadre-core/src/fs-atomic.ts, packages/cadre-core/src/file-durable-slot.ts, packages/cadre-core/src/node-local-snapshot.ts, packages/cadre-core/test/node-local-snapshot.spec.ts, docs/architecture.md
difficulty: easy
---

# Node-local store: file-wrapper and slot-placement cleanups

## What landed

**Pass-through wrappers gone.** `FileTrustedOwnerStore` / `FileBootstrapPeerStore` were classes
whose whole body forwarded to `PersistentTrustedOwnerStore` / `PersistentBootstrapPeerStore`. Each
is now a `const` object with one `open(dir, partyId)` method returning the store *interface*
(`Promise<TrustedOwnerStore>` / `Promise<BootstrapPeerStore>`). Call shape unchanged, so
`cadre-cli/src/commands/start.ts` and the ~30 spec call sites needed no edit.

**`FileDurableSlot` moved** out of `fs-atomic.ts` into its own
`packages/cadre-core/src/file-durable-slot.ts`. `fs-atomic.ts` keeps `writeFileAtomically`,
`encodeFileSafeComponent`, `isNotFound` and the mode constants (still used by `key-store-file.ts`).
Neither module is an exported subpath, so the `node:fs` edge still cannot reach the package's
cross-platform default entry.

**Concurrency coverage** added to `test/node-local-snapshot.spec.ts` (a `GatedSlot` whose `save()`
blocks until the test releases — or fails — it), covering `NodeLocalSnapshot.put`'s write-chain
ordering directly over the cross-platform fake slot rather than only incidentally through the Node
file backend.

## Review findings

**Ran (all at review HEAD, on this machine):**
- `packages/cadre-core` full suite: **1369 passed, 1 skipped, 5 failed** — the 5 failures are the
  `control-revocation-reissue.spec.ts` (4) + `control-revocation-replay.spec.ts` (1) entries already
  listed in `tickets/.pre-existing-known.md` under blocked ticket
  `10-revocation-reissue-same-pk-update-unique-collision`. Untouched by this diff; not re-reported,
  not skipped.
- The three directly affected specs (`node-local-snapshot`, `trusted-owner-store`,
  `bootstrap-peer-store`): 61/61 green — **so the implement ticket's "could not run vitest" caveat is
  now resolved; the new tests do pass, not merely type-check.** The sibling-repo build-freshness
  guard that blocked the implementer no longer trips.
- `tsc --noEmit -p packages/cadre-core/tsconfig.typecheck.json` (src + test) — clean.
- `yarn workspace @serfab/cadre-core build` then `yarn workspace @serfab/cadre-cli typecheck` —
  clean, so the narrowed public return types (interface instead of the concrete wrapper class) do
  not break the one production consumer.
- `yarn eslint` on every changed/added file — clean.
- `yarn dep-check` (knip + declared-range gate) — exit 0; the new module is imported, so it raises
  nothing.

**Correctness / API shape:** no findings. Repo-wide grep confirms every `FileTrustedOwnerStore` /
`FileBootstrapPeerStore` reference is a `.open(...)` call — no type positions, no `instanceof`, no
subclassing — so dropping the class is not observable. Returning the interface rather than the
concrete class is the stricter direction and `cadre-cli` still compiles.

**Docs — fixed inline (minor):**
- `docs/architecture.md` still described the two names as "those classes over a `FileDurableSlot`",
  which stopped being true, and never named the new file. Reworded to "thin `open(dir, partyId)`
  entry points that construct those classes over a `FileDurableSlot` (`file-durable-slot.ts`)".
- Both `*-store-file.ts` module comments said "Construct via {@link open}" — nothing is constructed
  there any more. Now "Open via {@link open}, which loads the existing file and returns the
  cross-platform store over it".
- Checked and left alone (still accurate): `trusted-owner-store.ts` / `bootstrap-peer-store.ts`
  header + class comments ("`FileTrustedOwnerStore` is this class over a file slot" is now literally
  what `open` returns), `types.ts` injection comments, `cadre-host/src/orchestrator/node-identity.ts`.

**Tests — one gap fixed inline (minor):** the implementer covered the happy ordering path
(overlapping `put`s serialise, last snapshot complete, reopen sees all) but not the failure path
*through* a queued chain — `NodeLocalSnapshot.put` deliberately swallows a persist failure on
`writeChain` so the next queued put still runs, and nothing exercised that with a save actually in
flight. Added `'a save that fails mid-chain rejects only its own caller — the queued put still lands
the full set'` (new `GatedSlot.failNext(error)`); the pre-existing failed-persist test only covered
the sequential case.

**Major findings:** none — no new tickets filed.

**Tripwires:** none newly noticed. The one conditional concern in this area (writes are serialised
in-process only, so two processes sharing one slot for one party would each snapshot-write their own
view) was already documented as a `NOTE:` on `NodeLocalSnapshot` before this ticket and still reads
correctly.

**Handoff accuracy nit (no code impact):** the implement handoff said it *added*
`test/node-local-snapshot.spec.ts`; that file already existed and was extended.
