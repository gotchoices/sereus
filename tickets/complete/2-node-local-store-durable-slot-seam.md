---
description: The two small on-device record files a node keeps for itself were saved by two near-identical copies of the same code; they now share one saving mechanism, and each platform plugs its own storage into it. Node's file storage is the first plug-in and behaves exactly as before.
files: packages/cadre-core/src/node-local-snapshot.ts, packages/cadre-core/src/trusted-owner-store.ts, packages/cadre-core/src/bootstrap-peer-store.ts, packages/cadre-core/src/trusted-owner-store-file.ts, packages/cadre-core/src/bootstrap-peer-store-file.ts, packages/cadre-core/src/fs-atomic.ts, packages/cadre-core/src/index.ts, packages/cadre-core/src/types.ts, packages/cadre-core/test/node-local-snapshot.spec.ts, docs/architecture.md
difficulty: medium
---

# One shared snapshot store, one injectable durable slot

## What landed

`packages/cadre-core/src/node-local-snapshot.ts` (new, cross-platform, no `node:`
imports) owns everything the node's two node-local records share:

- `DurableSlot` — the seam. `load(): Promise<string | undefined>` / `save(text)`. Its
  doc states the load-bearing rule: an implementation MUST throw, not return
  `undefined`, when the slot exists but cannot be read.
- `NodeLocalSnapshotSpec<E>` — what a given record persists: `label`, `payloadKey`
  (`owners` / `peers`), `unusableEntry` (`'discard-all'` | `'drop-entry'`),
  `acceptEntry(key, entry)`.
- `NodeLocalSnapshot<E>` — the loaded record: `has`, `keySnapshot()`,
  `entrySnapshot()`, `put()`, and `static open(slot, partyId, spec)` carrying the load
  policy verbatim from the old `FileTrustedOwnerStore.open` (absent / unparsable /
  unknown shape / foreign `partyId` ⇒ empty; unreadable ⇒ throw). `put()` holds the
  serialised write chain: in-memory update synchronous, returned promise tracks
  durability, a failed persist is logged, does not wedge the chain, and still rejects
  to the caller.

Over it: `PersistentTrustedOwnerStore` and `PersistentBootstrapPeerStore`, both
`static open(slot, partyId)`, both exported from `./index.js` with the `DurableSlot`
type. Each holds only its payload type + `acceptEntry` + bad-entry policy.
`FileDurableSlot` (`fs-atomic.ts`) is the Node backend —
`<dir>/<name>.<encoded partyId>.json`, atomic 0600 writes, ENOENT ⇒ `undefined`, any
other read failure ⇒ throw. `FileTrustedOwnerStore` / `FileBootstrapPeerStore` are a
slot name plus delegation: same exported names, same `open(dir, partyId)`, same
subpaths, same file names. `cadre-cli` is untouched.

## Review findings

### Verified against the pre-refactor code

Read the whole implement diff, then diffed the new load/validate/persist paths against
the deleted `FileTrustedOwnerStore` / `FileBootstrapPeerStore` line by line. Behaviour
is preserved, including the subtle bits: the trusted-owner anchor's whole-record
discard on one bad entry (the old code reached it by returning `undefined` from
`parsePersisted`; the new code reaches it by policy — same outcome), the idempotent
`trust()` early return that skips the write chain and preserves original provenance,
the "in-memory update is synchronous, promise is durability only" contract, and the
chain surviving a failed persist. Two incidental improvements: the anchor now *copies*
each accepted entry (the old code aliased the parsed JSON tree), and `KNOWN_SOURCES` is
typed `Set<TrustSource>` rather than `Set<string>`.

### Fixed in this pass (minor)

- **Operator-facing load error lost the file path.** `cadre-cli start` prints
  `error.message` alone (`packages/cadre-cli/src/commands/start.ts:381`). Pre-refactor
  that message carried the path; after the split the path lived only on the nested
  `cause`, so an operator hitting a permissions problem saw "failed to read the
  trusted-owner anchor for party X" with nothing to act on. `loadEntries` now folds the
  slot's own message into the top-level message and still sets `cause`. This is
  platform-agnostic on purpose — the slot is what knows whether the detail is a path or
  a database name. Pinned by a new test.
- **An array payload slipped the envelope check.** `envelopePayload` accepted anything
  `typeof 'object'`, so `{ version: 1, partyId, peers: [...] }` passed and every
  numeric index was handed to `acceptEntry`. The end state was correct (all entries
  rejected ⇒ empty record) but reached by accident and noisily. Now an explicit
  `isRecord` guard excludes arrays. Pinned by a new test. Pre-existing hole — both old
  validators had it.
- **Unused generic.** `envelopePayload<E>` took the whole `NodeLocalSnapshotSpec<E>`
  to read one string field; now takes `payloadKey: string`.
- **Dead ticket pointer in a public doc comment.** `types.ts` still pointed
  `bootstrapPeers` readers at `tickets/plan/2-durable-node-local-stores-on-mobile-web.md`,
  which no longer exists (split into the `web-` / `rn-` / `ns-` tickets). The implementer
  fixed the identical pointer in `docs/architecture.md` and missed this one. Replaced,
  and the comment now names the two `Persistent*Store.open(slot, partyId)` entry points
  a platform integrator actually needs — that config block is where they will look.
- **Interface docs said "both backends".** `TrustedOwnerStore.all()`,
  `BootstrapPeerStore.all()`, and `TrustedOwnerStore.trust()` ("a file-backed persist")
  were written when there were two implementations and one was a file. Corrected.

### Resolved concerns the handoff asked about (no change needed)

- **New `@libp2p/peer-id` edge in the cross-platform entry graph** — a non-event, now
  confirmed rather than assumed: `seed-bootstrap.ts`, `enrollment.ts`,
  `strand-solicitation.ts` and `strand-addr-protocol.ts` already import it and are all
  exported from `src/index.ts`. `bootstrap-peer-store.ts` adds no new package to the
  RN/browser graph.
- **The delegation wrappers.** Keeping them. They are verbose but not unsafe: both
  `implements` their store interface, so a missing or mistyped forwarded member fails
  the build. Filed the tightening as a debt ticket rather than churning the CLI and two
  spec files inside a review pass.
- **`acceptEntry` receives the raw parsed JSON.** Both implementations copy what they
  return, so nothing aliases the parsed tree. Enforced by the field's doc comment, not
  the type — acceptable; the alternative is a deep-freeze on every load.
- **Docs.** Read every doc that names these stores. `docs/architecture.md` (both
  bullets, and the stale ticket pointer) is correct and current. `docs/cadre-host.md`
  (lines 97, 158) still accurate — file names and the state-directory contract did not
  change. `docs/STATUS.md` describes the anchor's role, never its implementation split;
  nothing to update.

### Not fixed — filed as `backlog/debt-node-local-store-file-wrapper-cleanups`

Three deferred hygiene items, no defect among them: the ~50 lines of pure forwarding in
the two `*-store-file.ts` wrappers; `FileDurableSlot` sitting in `fs-atomic.ts`, whose
module comment describes helpers rather than a storage backend; and the write-chain
ordering guarantee being covered only through the Node file backend (the cross-platform
spec never issues overlapping `put()` calls). Deferred because this review pass hit its
token budget, not because any of them is contentious.

### Noticed, parked, not filed

- **`docs/reference-app-rn.md:455`** tells the reader that invite-pinned owner keys are
  "persisted into the anchor, so later seeds from the same owner need no invite" — true
  within an app session, false across a relaunch, because React Native still injects no
  slot. Pre-existing (predates this ticket, which changed no RN behaviour) and it is
  exactly what `rn-durable-node-local-stores` closes; left alone to avoid colliding with
  that ticket's own edit to the same paragraph.
- **`all()` / `entrySnapshot()` hand out shared entry objects.** The Map/Set copy is
  shallow, so a caller mutating `entry.addrs` on a returned snapshot would corrupt the
  store's in-memory state and have it persisted. Identical in the pre-refactor code, and
  no caller does it. Documented on the interface already; not worth a deep copy per call.

### Tripwires (in code, from the implement pass — re-read and still accurate)

- `NodeLocalSnapshot` class doc — writes are serialised in-process only, so two
  processes or two browser tabs sharing one slot for one party each snapshot-write their
  own view and the loser's entries are dropped. Needs a lock or merge-on-write only if a
  single slot ever backs two concurrent nodes of one party.
- `BootstrapPeerStore.record` doc — entries are never evicted, so the record grows
  across the node's whole lifetime; add eviction by `recordedAt` if a node ever applies
  seeds naming many distinct owners.

## Validation

`yarn typecheck` (`packages/cadre-core`) and `yarn lint` (repo root): clean.
`yarn vitest run test/node-local-snapshot.spec.ts test/trusted-owner-store.spec.ts
test/bootstrap-peer-store.spec.ts`: **3 files, 60 passed** — the two pre-existing file
suites unchanged and passing (cross-backend contract, persistence across `open()`
cycles, absent dir, corrupt file, unknown shape, two parties one directory, foreign
`partyId`, unreadable ⇒ throw, provenance write-once, junk-entry dropping, 8 concurrent
writes, no `.tmp` debris), plus the cross-platform suite and the two cases added here.

**The full 71-file `cadre-core` suite was not re-run.** The repo's stale-build guard
(`test-harness/build-freshness.ts`) blocks the runner whenever the linked `../quereus`
workspace's `dist` is older than its `src`, and that workspace is being edited
concurrently: a `yarn workspace @quereus/quereus build` cleared the guard long enough
for the targeted run above to pass, and it had tripped again minutes later. This is an
external-workspace race, not a test failure and not caused by this diff, so no
`.pre-existing-error.md` was written — a triage agent cannot fix "someone is editing
quereus right now." The diff's blast radius is the four store modules plus two
comment-only edits (`types.ts`, interface docs), all covered by the three suites run.

Integration tests were not run: no wire format, no protocol, no control-DB change, and
the `cadre-cli` call sites are byte-identical.

## Still open (by design, not a gap in this ticket)

React Native, NativeScript and the browser inject no slot, so both records still die
with the app process. That is the entire content of the `web-` / `rn-` /
`ns-durable-node-local-stores` tickets in `tickets/implement/`, which this ticket
unblocks and which consume `PersistentTrustedOwnerStore.open(slot, partyId)` /
`PersistentBootstrapPeerStore.open(slot, partyId)` exactly as they sketch.
