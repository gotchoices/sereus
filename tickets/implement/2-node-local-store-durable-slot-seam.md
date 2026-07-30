---
description: Two small on-device record files are saved to disk by two nearly identical pieces of code, and three more copies are about to be written for phones and browsers. Replace them with one shared saving mechanism that each platform plugs its own storage into.
files: packages/cadre-core/src/trusted-owner-store.ts, packages/cadre-core/src/trusted-owner-store-file.ts, packages/cadre-core/src/bootstrap-peer-store.ts, packages/cadre-core/src/bootstrap-peer-store-file.ts, packages/cadre-core/src/fs-atomic.ts, packages/cadre-core/src/index.ts, packages/cadre-core/test/trusted-owner-store-file.spec.ts, packages/cadre-core/test/bootstrap-peer-store-file.spec.ts
difficulty: medium
---

# One shared snapshot store, one injectable durable slot

A cadre node keeps two small records that are **node-local**: never replicated, never
sourced from shared group state.

- the **trusted-owner anchor** (`trusted-owner-store.ts`) — which owner keys this machine
  established out of band. Everything that judges "is this row from a real member of my
  party" rests on it.
- the **bootstrap-peer store** (`bootstrap-peer-store.ts`) — the addresses to keep dialing
  so a newly-invited machine that could not reach the group on its first try gets in.

Each has an ephemeral in-memory default plus a Node-only file backend
(`*-store-file.ts`). Those two file backends are the same file with different payloads:
same on-disk envelope (`version` / `partyId` / a record of entries), same envelope
validator, same file-name and temp-name builders, same load-failure policy, same
serialised write chain, same full-snapshot atomic write. They diverge in exactly two
intentional places — the payload type, and whether one bad entry discards the whole file
(the anchor rejects the file; the peer store drops the entry and keeps the rest).

React Native, NativeScript, and the browser inject neither backend, so on those targets
both records die with the app process. Three more platform backends are queued behind
this ticket. Writing them against the current shape means five copies of the same
machinery.

## The seam

Split "what is persisted" from "where bytes are kept". Where-bytes-are-kept becomes a
minimal, cross-platform, app-injected interface; everything else becomes one shared
class in the cross-platform entry.

```ts
/**
 * A single durable text slot, supplied by the embedding app. The only
 * platform-specific part of a persistent node-local store.
 */
export interface DurableSlot {
	/**
	 * The slot's persisted text, or `undefined` when it was never written.
	 * MUST throw (not return undefined) when the slot exists but cannot be read —
	 * that distinction is the whole load-failure policy below.
	 */
	load(): Promise<string | undefined>;
	/**
	 * Durably replace the slot's text. Callers snapshot-write the whole record, so
	 * an implementation never needs to merge.
	 */
	save(text: string): Promise<void>;
}
```

Shared machinery (new module, cross-platform, no `node:` imports — call it
`node-local-snapshot.ts`):

- the on-disk envelope `{ version: 1; partyId: string; <payload key>: Record<string, E> }`
  and its validator,
- `load` policy, verbatim from today's `FileTrustedOwnerStore.open` (its doc comment is
  the spec — carry the reasoning across, don't paraphrase it away):
  - slot absent ⇒ **empty** store (cold start),
  - unparsable JSON ⇒ **empty**,
  - unknown envelope shape ⇒ **empty**,
  - `partyId` mismatch ⇒ **empty** (a store reused for another party must not leak),
  - slot present but unreadable (`load()` threw) ⇒ **throw**. Loading empty here would
    hide a real misconfiguration *and* let the next write snapshot-destroy a still-intact
    record.
- per-entry validation + the one-bad-entry policy, supplied by the caller (anchor:
  reject the whole file; peers: drop the entry, keep the rest),
- the serialised write chain: in-memory state updates **synchronously**, the returned
  promise tracks durability only, a failed persist is logged and does not wedge the chain
  but still rejects to the caller.

Then:

- `PersistentTrustedOwnerStore` and `PersistentBootstrapPeerStore` — cross-platform,
  exported from `./index.js`, constructed from a `DurableSlot` + `partyId`.
- `FileTrustedOwnerStore` / `FileBootstrapPeerStore` keep their names, subpaths
  (`@serfab/cadre-core/trusted-owner-store-file`, `.../bootstrap-peer-store-file`), and
  observable behaviour, but become a `FileDurableSlot` (the `node:fs` part —
  `<dir>/<name>.<encoded partyId>.json`, `writeFileAtomically`, `isNotFound` ⇒ absent)
  handed to the shared class. `cadre-cli`'s `start.ts` call sites must not change.

No `node:` import may enter `index.js` — the whole point of the existing subpath split.

## Edge cases & interactions

- **Slot absent vs unreadable.** A `DurableSlot` that returns `undefined` for a *failed*
  read silently converts a recoverable error into a wipe on the next write. Document it
  on the interface and test both branches.
- **Wrong-party file.** A slot holding another party's envelope loads empty and the next
  write replaces it. Existing behaviour; keep the test.
- **One junk entry.** Anchor: whole file rejected ⇒ empty. Peer store: that entry dropped,
  siblings retained. Both policies must survive the refactor with their existing tests.
- **Persist failure.** In-memory state stays updated, the caller's promise rejects, the
  chain keeps running, and the *next* successful write re-lands the complete snapshot.
- **Idempotent re-trust.** `TrustedOwnerStore.trust` on an already-known key resolves
  immediately without joining the write chain (existing documented behaviour, including
  its NOTE about not awaiting an in-flight first persist). Preserve it exactly.
- **Concurrent writers.** Two processes on one directory/party still clobber each other
  (documented on `FileBootstrapPeerStore`). Carry the NOTE onto the shared class — it is
  now a property of every backend, not just the file one.
- **Synchronous-read contract.** `has`/`all` (anchor) and `all` (peers) stay synchronous
  and snapshot-copied. `CadreNode.recordSeedBootstrapPeers` is synchronous and depends on
  this.
- **partyId mismatch at `start()`.** `CadreNode` fails closed when an injected store's
  `partyId` differs from `controlNetwork.partyId`. Unchanged; keep the test.

## TODO

- Add `DurableSlot` and the shared snapshot machinery in a new cross-platform
  `packages/cadre-core/src/node-local-snapshot.ts`; export `DurableSlot` from `index.ts`.
- Add `PersistentTrustedOwnerStore` (in `trusted-owner-store.ts`) and
  `PersistentBootstrapPeerStore` (in `bootstrap-peer-store.ts`) over it; export both from
  `index.ts`. Move the load-policy prose onto the shared class; leave a pointer from each
  store module.
- Reduce `trusted-owner-store-file.ts` / `bootstrap-peer-store-file.ts` to a
  `FileDurableSlot` (shared, in `fs-atomic.ts`) plus the payload/validation config. Keep
  the exported class names, `open(dir, partyId)` signatures, file names, and 0600/atomic
  write behaviour.
- Verify `packages/cadre-cli/src/commands/start.ts` still compiles untouched.
- Tests — the existing `*-store-file.spec.ts` suites must pass unchanged (they are the
  behaviour contract). Add cross-platform specs against an in-memory `DurableSlot` fake:
  - absent slot ⇒ empty store, no throw;
  - corrupt JSON ⇒ empty store;
  - foreign `partyId` ⇒ empty store;
  - `load()` rejects ⇒ construction rejects (no empty store, no subsequent write);
  - `save()` rejects ⇒ caller's promise rejects, entry still visible via `has`/`all`, next
    write re-lands the full set;
  - anchor: one malformed entry ⇒ whole store empty; peers: one malformed entry dropped,
    the rest retained;
  - `trust()`/`record()` visible synchronously before the returned promise settles.
- Delete nothing from `docs/` — update `docs/architecture.md` only if it names the file
  backends by module path.

Supersedes backlog ticket `debt-file-store-snapshot-duplication` (deleted; its
"worth doing before the mobile/browser backends land" call is why this ticket sequences
first).
