description: When an app joins another person's shared workspace, the library forgets that join on restart and the app has to keep its own list, including the workspace's secret key. Make the library remember joined workspaces itself and bring them back on start, the same way it brings back the workspaces its own party created.
architecture: docs/strands.md#closed-strand-member-key-handling
files: packages/cadre-core/src/joined-strand-store.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/types.ts, packages/cadre-core/src/index.ts, packages/cadre-core/src/key-store.ts, packages/cadre-core/src/strand-watcher.ts, packages/reference-app-rn/src/use-cadre.ts, packages/reference-app-rn/src/chat-strand.ts, docs/strands.md, docs/api.md, docs/architecture.md
difficulty: medium
----

## Why

gotchoices/sereus#18 asked, correctly, where a cross-party joiner is supposed to keep the strand it joined. Today: nowhere in cadre-core. `formStrand` returns `{ strandId, memberPrivateKey, … }`, the app calls `addStrand` with a hand-built `StrandRow`, and `addStrand` records nothing that survives the process. A party's own strands come back after a restart through the control database (`StrandWatcher` polls the `Strand` table and `CadreNode.handleStrandAdded` emits `strand:discovered`); a strand joined from another party has no row in this party's control database, so nothing re-offers it. Every app has had to keep a "remembered joins" list holding `{Id, MemberPrivateKey, Type}`, undocumented. Maintainer decision (2026-09-27), item 3: cadre-core remembers joined strands, key included, in the node's own storage, and re-attaches them on start through the same `strand:discovered` path. Treat the stored key as a secret, the same way the identity key is.

## Design

### The record

```ts
/** One strand this node joined from ANOTHER party — nothing in this party's control DB names it. */
export interface JoinedStrandRecord {
	/** The strand id (a valid scope key, see storage-scope.ts). */
	Id: string;
	Type: 'o' | 'c';
	/** The closed strand's shared read secret the formation delivered; null for an open strand. */
	MemberPrivateKey: string | null;
	/** Wall-clock ms this node first recorded the join. Diagnostics only. */
	joinedAt: number;
}
```

A record converts to the `StrandRow` shape `addStrand` and `strand:discovered` already use, with `FounderOwnerKey: null` (a joiner never founds; `launchStrand`'s founder derivation reads null as "not mine", which is exactly today's hand-built row).

### The store, and where the secret goes

```ts
export interface JoinedStrandStore {
	list(): Promise<JoinedStrandRecord[]>;
	record(record: JoinedStrandRecord): Promise<void>;   // replace by Id
	forget(strandId: string): Promise<void>;             // no-op when absent
}
```

Two implementations in a new cross-platform module `packages/cadre-core/src/joined-strand-store.ts`:

- `MemoryJoinedStrandStore` — the fallback; joins die with the process (logged once, at the first `record`, so the #18 shape is visible in a log rather than silent).
- `KeyStoreJoinedStrandStore(keyStore: KeyStore)` — one slot per strand, key id `cadre/joined-strand/<strandId>`, payload the UTF-8 JSON of the record. `list()` = `keyStore.list()` filtered by the prefix, each `get` parsed; a slot that fails to parse or fails `isValidStrandScopeKey` is dropped with a log and its siblings kept (the bootstrap-peer store's `drop-entry` posture; nothing here can be repaired by refusing to start). A `KeyStoreAccessError` on `get` (a biometric prompt refused) is rethrown, not treated as empty, exactly as `loadOrCreateIdentityKey` treats it.

Why the `KeyStore` and not a new `DurableSlot` store like `bootstrapPeers`: the record holds the closed strand's read secret, and the KeyStore is the one seam every platform already routes secrets through (RN `SecureStoreKeyStore` in the platform enclave, CLI and host `FileKeyStore` in the state directory, tests `InMemoryKeyStore`). A record is about 200 bytes, well under SecureStore's ~2048-byte value limit noted in `reference-app-rn/src/node-local-slots.ts`. `FileKeyStore` percent-encodes key ids, so the `/` in the id is fine (the identity slot is already `cadre/identity`). Document at `KeyStore` in `key-store.ts` that the store now carries small JSON records under the `cadre/joined-strand/` prefix as well as raw key bytes, and that `list()` therefore returns those ids.

Selection in `CadreNode`: `config.joinedStrands?.store` when injected; else `new KeyStoreJoinedStrandStore(config.keyStore)` when `keyStore` is configured; else memory. Like the other node-local stores, the instance is kept across `stop()`→`start()` of the same node and is NOT cleared by `cleanup()`. No `partyId` scoping: the KeyStore is already per node, and one node serves one party.

Add `joinedStrands?: { store?: JoinedStrandStore }` to `CadreNodeConfig` beside `bootstrapPeers`/`enrolledMachines`, with the doc comment stating the default derivation from `keyStore`. Export the interface, both classes, and the record type from `index.ts`.

### When a join is recorded

- **`CadreNode.formStrand`**, on success, after `recordCrossPartyStrandAddrs` and before `adoptFormationMembershipInvite`: record `{ Id: result.strandId, Type: result.memberPrivateKey ? 'c' : 'o', MemberPrivateKey: result.memberPrivateKey ?? null, joinedAt: now }`. A `record` failure throws out of `formStrand` with a message like the party-key persistence failure already there: the token is spent, fix the store, redeem a fresh invitation. Recording here rather than only at `addStrand` means an app killed between `formStrand` and `addStrand` still gets the strand offered on its next start.
- **`CadreNode.addStrand`**, when the row is foreign: no `Strand` row with that id in this party's control database (`controlDatabase.queryStrands()`, the same read the watcher issues every 5 s). Record `{ Id, Type, MemberPrivateKey, joinedAt: existing?.joinedAt ?? now }` so an app that obtained the row some other way (a test fixture, the #18 harness's own list) is covered, and a re-attach after restart is harmless. A row that IS in the control table is never recorded; the control database already remembers it.

### When a join is forgotten

- A new public `CadreNode.forgetJoinedStrand(strandId)`: `forget` on the store, then `stopStrand(strandId)` if running. This is the app's "leave this workspace" action for a strand it cannot `unpublishStrand` (not its party's row). Document it in `docs/api.md`.
- On self-revocation for that strand (the `onSelfRevoked` callback wired in `launchStrand`, which emits `strand:revoked`): forget the record. A removed party's machines must not re-attach the strand on every launch. `strand:rejoin-blocked` does NOT forget (a fresh invitation is the path back and the record's key is still the right one to attach with).
- `stopStrand` does NOT forget: it is "stop on this node, rediscover on restart" for own-party strands, and the joined-strand path mirrors it.

### How a remembered join comes back

Feed the watcher rather than adding a second offer path. `StrandWatcher` takes a `StrandQueryable`; `CadreNode` builds it today over `controlDatabase.queryStrands()`. Change the queryable to return the union of the control rows and the joined-strand records converted to rows, control row winning on an id collision (a strand that is both remembered and in the control table is the own-party case; the record is then stale and should be forgotten on that poll). Everything the watcher already does then applies to remembered joins with no new code: offered once as `strand:discovered` (or auto-launched when the app registered its sApp config beforehand), the retry ladder on a failed launch, suppression after `stopStrand`, and `onStrandRemoved` → `detachStrand` when a record is forgotten. Keep the union function small and pure (`unionStrandRows(control, joined)`), in `strand-watcher.ts` or the new module.

### Interplay with the addresses

None in this ticket. `crossPartyStrandAddrs` stays in-memory; a remembered join re-attached after a restart still has an empty seed until `strand-peer-book-local` lands. The scenario ticket at the end of this chain is where restart replication is proven. Say so in the `docs/strands.md` paragraph so a reader does not expect this ticket alone to fix #18.

## Edge cases & interactions

- **Formation succeeded, `record` failed.** Throws out of `formStrand` (see above); the pending membership invitation and party key are already persisted by then, so a re-formation reuses the party key. Test: one unit test on `formStrand` with a store whose `record` rejects, asserting the error names the spent token, if `cadre-node-formation-membership.spec.ts` already has a fixture where it is a few-line addition; otherwise inspection suffices.
- **The same strand formed twice** (re-formation after losing addresses): `record` replaces by Id; the responder's stored key never changes for one strand, so the keys are equal in practice. Inspection.
- **Open host strand, no `memberPrivateKey`.** Type `'o'`, key null. The RN handler auto-joins open strands already. Inspection.
- **Record present, control row appears later** (the strand's founding party enrolled this machine into its cadre, so it is now own-party): the union prefers the control row; forget the record on that poll. Inspection plus a case in the union's unit test.
- **A remembered strand whose id no longer passes `isValidStrandScopeKey`** (a store written by a future version, or edited). Dropped at `list()` with a log; never reaches `handleStrandAdded`'s throw-and-suppress arm.
- **KeyStore configured but read-gated and the user declines the prompt at start.** `list()` throws `KeyStoreAccessError`; the watcher's poll catches and logs, and retries next poll. The node still starts; own-party strands are unaffected. Verify by reading the watcher's `poll` catch; no test.
- **`stop()`→`start()` on the same `CadreNode`**: store instance retained; records survive. Inspection (same as `bootstrapPeerStore`).
- **The RN reference app.** `use-cadre.ts` `claimDiscovered` ignores closed rows on purpose ("a closed strand must go through consent"). A remembered join IS the product of that consent and carries its key, so the handler must now claim a discovered closed row whose `MemberPrivateKey` is non-null (attach via the existing closed-strand attach helper in `chat-strand.ts`, not `formStrand`). Own-party closed rows discovered from the control table also carry the key, so this also fixes the RN app never re-attaching the closed strand it hosts after a restart; check that `joinClosedChatStrandFromFormation`'s role write is not repeated on a re-attach. The web app has no `strand:discovered` handler and keeps `formedStrands` in memory only; leave it, but note it in the handoff.
- **The #18 harness and other embedders that pass `privateKey` and no `keyStore`.** They get the memory store and one log line. Document that such an embedder injects `joinedStrands: { store: new KeyStoreJoinedStrandStore(new FileKeyStore(dir)) }` or its own implementation.

## Tests

- `joined-strand-store.spec.ts`: the `KeyStoreJoinedStrandStore` round trip over `InMemoryKeyStore` with one junk slot in the store (dropped, siblings kept). One test, because the drop-entry rule is a branch that a type cannot enforce.
- The union: one test that a remembered row is offered, a control row wins a collision, and the record is forgotten on collision.
- The watcher-driven re-offer at the node level: extend an existing spec only if a fixture already stands up a `CadreNode` with a control DB; otherwise the integration scenario in `scenario-relay-only-restart-reconverges` is the proof, and say so in the handoff.

## Docs

- `docs/strands.md` → "Closed-Strand Member Key Handling": a new paragraph "What a joiner's node remembers" stating the contract: cadre-core records every strand joined from another party (id, type, read secret) in the node's KeyStore under `cadre/joined-strand/<id>`, re-offers it on start as `strand:discovered`, and forgets it on `forgetJoinedStrand` or self-revocation; apps no longer keep their own list. Note the restart-addresses limit until the address book lands.
- `docs/api.md`: `forgetJoinedStrand`, and a sentence under `formStrand` that the join is remembered.
- `docs/architecture.md` → "Node Key Material & the KeyStore Seam": the KeyStore now also holds joined-strand records, and why (secret-grade, every platform already routes secrets there).
- `.release-notes.pending.md`: one bullet.

## TODO

- Module `joined-strand-store.ts` with the record type, interface, memory and KeyStore-backed stores; exports; `CadreNodeConfig.joinedStrands`.
- `CadreNode`: store selection at start; record at `formStrand` and foreign `addStrand`; `forgetJoinedStrand`; forget on self-revocation; watcher queryable union.
- RN `claimDiscovered`: claim closed rows that carry a key.
- Tests as listed; `yarn workspace @serfab/cadre-core test`, `yarn lint`, `yarn typecheck`, and the `strand-formation-cross-party-seed` and `blind-relay-phone-to-phone-e2e` integration scenarios in the foreground.
- Docs and release-note bullet.
