---
description: The two small on-device record files a node keeps for itself were saved by two near-identical copies of the same code; they now share one saving mechanism, and each platform plugs its own storage into it. Node's file storage is the first plug-in and behaves exactly as before.
files: packages/cadre-core/src/node-local-snapshot.ts, packages/cadre-core/src/trusted-owner-store.ts, packages/cadre-core/src/bootstrap-peer-store.ts, packages/cadre-core/src/trusted-owner-store-file.ts, packages/cadre-core/src/bootstrap-peer-store-file.ts, packages/cadre-core/src/fs-atomic.ts, packages/cadre-core/src/index.ts, packages/cadre-core/test/node-local-snapshot.spec.ts, packages/cadre-core/test/trusted-owner-store.spec.ts, packages/cadre-core/test/bootstrap-peer-store.spec.ts, docs/architecture.md
difficulty: medium
---

# Review: one shared snapshot store, one injectable durable slot

## What landed

`packages/cadre-core/src/node-local-snapshot.ts` (new, cross-platform, no `node:`
imports) now owns everything the two node-local records share:

- `DurableSlot` — the seam. `load(): Promise<string | undefined>` / `save(text)`. Its
  doc states the load-bearing rule: an implementation MUST throw, not return
  `undefined`, when the slot exists but cannot be read.
- `NodeLocalSnapshotSpec<E>` — what a given record persists: `label` (used in load
  errors + logs), `payloadKey` (`owners` / `peers`), `unusableEntry`
  (`'discard-all'` | `'drop-entry'`), `acceptEntry(key, entry)`.
- `NodeLocalSnapshot<E>` — the loaded record: `has`, `keySnapshot()`,
  `entrySnapshot()`, `put()`. `static open(slot, partyId, spec)` carries the load
  policy verbatim from the old `FileTrustedOwnerStore.open` doc (absent / unparsable /
  unknown shape / foreign `partyId` ⇒ empty; unreadable ⇒ throw, with the reasoning
  intact). `put()` holds the serialised write chain: in-memory update is synchronous,
  the returned promise tracks durability, a failed persist is logged, does not wedge the
  chain, and still rejects to the caller. The two-concurrent-writers NOTE moved here
  from `FileBootstrapPeerStore` — it is now a property of every backend.

Over it:

- `PersistentTrustedOwnerStore` (in `trusted-owner-store.ts`) and
  `PersistentBootstrapPeerStore` (in `bootstrap-peer-store.ts`), both
  `static open(slot, partyId)`, both exported from `./index.js` along with the
  `DurableSlot` type. Each module holds only its payload type + `acceptEntry` +
  bad-entry policy, and points at `NodeLocalSnapshot` for the policy prose.
  `trust()` keeps its idempotent early return, including the NOTE about not awaiting an
  in-flight first persist.
- `FileDurableSlot` in `fs-atomic.ts` — `<dir>/<name>.<encoded partyId>.json`,
  `writeFileAtomically`, ENOENT ⇒ `undefined`, any other read failure ⇒ throw.
- `FileTrustedOwnerStore` / `FileBootstrapPeerStore` reduced to a slot name + a thin
  delegation to the persistent class. Same exported names, same
  `open(dir, partyId)` signature, same subpaths, same file names, same 0600/atomic
  writes. `packages/cadre-cli/src/commands/start.ts` is untouched and typechecks.

`docs/architecture.md` — the two bullets that describe these stores now describe the
seam, and the stale `tickets/plan/2-durable-node-local-stores-on-mobile-web.md` pointer
was replaced with the three per-platform slot ticket slugs.

## Validation performed

From `packages/cadre-core`: `yarn build`, `yarn typecheck`, `yarn test` — **71 files,
1085 passed, 1 skipped** (the skip is pre-existing). From `packages/cadre-cli`:
`yarn typecheck`. Repo root: `yarn lint`. All clean.

The two existing suites (`test/trusted-owner-store.spec.ts`,
`test/bootstrap-peer-store.spec.ts` — note: the file-backend cases live in these files,
not in the `*-store-file.spec.ts` paths the source ticket named) pass **unchanged**, and
they are the real behaviour contract: cross-backend contract suite, persistence across
`open()` cycles, absent dir, corrupt file, unknown shape, two parties one directory,
foreign `partyId`, present-but-unreadable ⇒ throw with the same error text, provenance
write-once, junk-entry dropping, 8 concurrent writes all landing, no `.tmp` debris.

New `test/node-local-snapshot.spec.ts` drives both persistent classes against an
in-memory `FakeSlot` (`text` / `loadError` / `saveError` / `saves` counter):

- unwritten slot ⇒ empty, no throw; round-trip through one slot survives a reopen
- unparsable text ⇒ empty; unknown envelope version ⇒ empty; foreign `partyId` ⇒ empty
- anchor: one bad `source` discards the whole record; peers: bad peer id / empty
  `addrs` / non-string addr / non-object entry each dropped, the good sibling retained
- `load()` rejects ⇒ `open()` rejects with the labelled message **and `slot.saves === 0`**
  (no empty store, no subsequent write)
- `trust()` / `record()` visible synchronously before the returned promise settles
- `save()` rejects ⇒ caller's promise rejects, entry still visible, slot still unwritten,
  and the next successful write re-lands the **full** set
- re-trusting a known key performs exactly one save (skips the chain)

## Where to push hardest

- **The delegation wrappers.** `FileTrustedOwnerStore` is no longer a subclass of
  anything — it holds a `PersistentTrustedOwnerStore` and forwards four members. Chosen
  over `extends` because a derived `static open(dir, partyId)` conflicts with the base's
  `static open(slot, partyId)` on TypeScript's static-side assignability check. Cost:
  `instanceof PersistentTrustedOwnerStore` is false for a file store (nothing in the
  repo tests that), and each forwarding member is a place a future signature change can
  be forgotten. Worth a second opinion on whether the wrapper earns its keep versus
  exporting a plain factory.
- **Load-error message shape changed.** Previously one error:
  `FileTrustedOwnerStore: failed to read the trusted-owner anchor for party X at <path>`.
  Now two nested: `failed to read the trusted-owner anchor for party X` with
  `cause` = `FileDurableSlot: <path> is present but unreadable` with `cause` = the fs
  error. Both existing regex assertions still match, and the path is still recoverable,
  but a log site that prints only `error.message` now loses the path. Worth checking
  whether any operator-facing path prints without the cause chain.
- **Envelope payload typed as `object`, so an array slips the envelope check.**
  `{ version: 1, partyId, peers: [...] }` passes `envelopePayload` (arrays are objects)
  and falls to `acceptEntry` per numeric key — which rejects everything, so the anchor
  ends empty and the peer store drops every entry. Correct outcome, reached by accident
  rather than by an explicit check. Pre-existing (both old validators had the same
  hole); untested either way.
- **`spec.acceptEntry` receives the raw parsed JSON value.** Both implementations copy
  what they return (`{...}` / `[...addrs]`), so nothing aliases the parsed tree. That is
  a convention enforced only by the doc comment on the field, not by the type.
- **No test that the persisted envelope is byte-identical to the pre-refactor one.** The
  provenance test (`body.version` / `body.partyId` / `body.owners[KEY].source`) plus the
  junk-entry test (which hand-writes a `peers` envelope and expects it to load) pin the
  shape between them, and the `\t` indentation is preserved in
  `NodeLocalSnapshot.persistSnapshot`, but nothing asserts the exact bytes. Since the
  key order now comes from `Map` insertion order rather than the old
  `Object.fromEntries(this.owners)` (same thing, but via a different code path), a
  reviewer may want a golden-file check.
- **Concurrency is only covered through the file backend.** The 8-concurrent-writes test
  lives in the file specs; the cross-platform spec never exercises overlapping `put()`
  calls against a slow slot, so the chain's ordering guarantee is verified on one
  backend only.
- **`@libp2p/peer-id` is now imported by `bootstrap-peer-store.ts`**, which is in the
  default (RN/browser) entry graph. It has no `node:` edge and the entry already pulls
  libp2p elsewhere, so this should be a non-event — but it is a new edge in the
  cross-platform graph and worth a sanity check against the RN/web bundlers.

## Tripwires parked in code

- `NodeLocalSnapshot` class doc — two processes / two browser tabs sharing one slot for
  one party each snapshot-write their own view, so the loser's entries are dropped;
  needs a lock or merge-on-write only if a single slot ever backs two concurrent nodes
  of one party. (Moved from `FileBootstrapPeerStore`, where it was Node-specific.)
- `BootstrapPeerStore.record` doc (unchanged, still accurate) — entries are never
  evicted, so the record grows across the node's whole lifetime; add eviction by
  `recordedAt` if a node ever applies seeds naming many distinct owners.

## Not done / out of scope

- No per-platform slot: React Native, NativeScript and the browser still inject nothing
  and both records still die with the app process. That is the whole content of the
  `web-` / `rn-` / `ns-durable-node-local-stores` tickets, which are unblocked by this
  and consume `PersistentTrustedOwnerStore.open(slot, partyId)` /
  `PersistentBootstrapPeerStore.open(slot, partyId)` exactly as they sketch.
- Integration tests were not run (out of this ticket's blast radius — no wire format,
  no protocol, no control-DB change; `cadre-cli` call sites are byte-identical).
