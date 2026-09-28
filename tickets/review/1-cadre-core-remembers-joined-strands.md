description: A node now remembers the shared workspaces (strands) it joined from another person's party, secret key included, and offers them again on every start, so apps no longer keep their own list. Review the new record, how it feeds the strand watcher, and the React Native app's re-attach of closed strands.
architecture: docs/strands.md#closed-strand-member-key-handling
files: packages/cadre-core/src/joined-strand-store.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/types.ts, packages/cadre-core/src/index.ts, packages/cadre-core/src/key-store.ts, packages/cadre-core/test/joined-strand-store.spec.ts, packages/reference-app-rn/src/use-cadre.ts, packages/reference-app-rn/src/chat-strand.ts, packages/reference-app-rn/test/react/use-cadre.spec.ts, docs/strands.md, docs/api.md, docs/architecture.md, .release-notes.pending.md
----

## What landed

gotchoices/sereus#18: a strand joined from another party has no row in the joiner's control database, so nothing re-offered it after a restart and every app kept its own `{Id, MemberPrivateKey, Type}` list. cadre-core now records those joins itself and re-offers them through the existing `strand:discovered` path.

- **`joined-strand-store.ts`** (new, cross-platform):
  - `JoinedStrandRecord { Id, Type, MemberPrivateKey, joinedAt }` and `joinedStrandRow(record)` → a `StrandRow` with `FounderOwnerKey: null`.
  - `JoinedStrandStore { partyId; list(); record(); forget() }`.
  - `MemoryJoinedStrandStore(partyId)`: warns once via `console.warn` at its first `record`.
  - `KeyStoreJoinedStrandStore(keyStore, partyId)`: one slot per join at `cadre/joined-strand/<base64url partyId>/<strandId>`, holding the record's UTF-8 JSON. It loads once on the first `list()`, then answers from memory and writes through; every KeyStore access is serialized. A slot that is not a valid record for its own id is dropped with a log and its siblings kept. A load error (for example `KeyStoreAccessError`) is rethrown and retried on the next call. `record` asserts the id is a valid scope key.
  - `JoinedStrandRows`: the watcher's per-session view. `withControlRows(control)` returns the control rows plus the joined rows; a control row wins an id collision, and the stale record is forgotten. `forget(id)` removes a join for good. `forgetAfterThisSession(id)` removes it from the store but keeps offering it until the session ends. When `list()` fails, it reuses the last list the store returned.
- **`CadreNode`**:
  - `initializeJoinedStrandStore()` runs in `start()` beside the bootstrap-peer store. It uses `config.joinedStrands.store`, else a `KeyStoreJoinedStrandStore` over `config.keyStore`, else memory. An injected store scoped to another party fails `start()`. The store survives `stop()`→`start()`; the `JoinedStrandRows` view is rebuilt on each start.
  - `createStrandQueryable` returns the union of control rows and joined rows.
  - `formStrand` records the join last, after `adoptFormationMembershipInvite`, and throws a "token is spent, fix the store, redeem a fresh invitation" error if recording fails.
  - `addStrand` calls `rememberForeignStrand` before launching, unless the row is one this node itself offered as `strand:discovered`. That call does a `queryStrand(id)`: a control row means the strand is the party's own and nothing is recorded; otherwise it records, skipping the write when an identical record already exists and keeping the first `joinedAt`. It is best-effort: a failure logs `console.warn` and the attach carries on.
  - New public `forgetJoinedStrand(id)` forgets the join, then calls `stopStrand`. It requires a running node.
  - `onSelfRevoked` now also calls `forgetRevokedJoin`, which uses `forgetAfterThisSession`.
- **`CadreNodeConfig.joinedStrands?: { store?: JoinedStrandStore }`**. The index exports `MemoryJoinedStrandStore`, `KeyStoreJoinedStrandStore`, `JoinedStrandStore` and `JoinedStrandRecord`. The docs for the `KeyStore` interface and for the `strand:discovered` and `strand:revoked` events are updated.
- **RN `claimDiscovered`** now claims a closed row only when it carries `MemberPrivateKey`, and still claims open rows. The claim goes through `joinChatStrand(node, strand)`, which passes the offered row through unchanged.
- **Docs**:
  - `strands.md` has a new subsection, "What a joiner's node remembers". It also fixes a stale claim that the initiator records the read secret into its own control database.
  - `api.md` documents `forgetJoinedStrand` and the remembered join under `formStrand`.
  - `architecture.md` covers the watcher bullet and the KeyStore section.
  - `.release-notes.pending.md` has one bullet.

## Deviations from the ticket (please scrutinize)

- **Party scoping.** The ticket said there was no need to scope by `partyId` because the KeyStore is per node. It is not per party on React Native: `cadre-phone.ts` keeps one module-level `SecureStoreKeyStore` for the whole device, and the user can switch party in Settings. Without scoping, a join made for party A would be offered, and on RN auto-attached, under party B. So slots carry a base64url party segment, stores carry `partyId`, and `start()` fails when an injected store belongs to another party, the same as the other node-local stores.
- **`JoinedStrandRows` holds per-session state.** A plain union has two problems, because the watcher reads a joined row that is missing from a poll as a removal and detaches the strand:
  - Forgetting on self-revocation would tear the strand down mid-session, which contradicts the `strand:revoked` promise that nothing is torn down.
  - A single failed `list()` would detach every running joined strand.

  So revocation forgets the record from the store but keeps offering the strand until the session ends, and a failed list reuses the last good one.
- **Record order in `formStrand`.** The join is recorded after `adoptFormationMembershipInvite`, not before. The ticket's design section and its edge-case section disagreed on this. With "after", a failed record leaves the party key and the staged invitation in place for the re-formation the error asks for.
- **Best-effort record in `addStrand`.** A failure logs and the attach continues, rather than throwing. Failing an attach on a KeyStore write would be worse than losing the re-offer, and a re-attach after restart goes through `addStrand`. `formStrand` still fails loudly. The record is also skipped for rows the node offered itself: those came from the control table or are already remembered. The skip also narrows the unpublish race described under Known gaps.
- **RN re-attach uses `joinChatStrand`, not `joinClosedChatStrand`.** `joinClosedChatStrand` rebuilds the row with `FounderOwnerKey: null`. For this party's own orphaned closed strand (published, but the app died before founding it), that would join instead of found. It also writes the `member` role, which the first attach already wrote.
- **Load-once cache in the KeyStore store.** Without it, the 5-second poll would read the enclave, log each junk slot, and prompt through any gated backend on every pass.

## Tests

- `packages/cadre-core/test/joined-strand-store.spec.ts` (new):
  - "reads its joins back through a fresh store, dropping a junk slot and keeping its siblings": round trip over `InMemoryKeyStore`, a non-JSON slot and a mismatched-id slot are dropped, an unrelated `cadre/identity` slot is ignored, and `forget` persists.
  - "never lists another party's joins from a KeyStore the parties share": party isolation, including a party id whose base64url encoding is a prefix of another's. That case pins the segment's closing `/`.
  - "offers each join beside the control rows, and forgets one a control row now names": the union, the control row winning, and the stale record being forgotten.
  - "keeps offering a join forgotten on self-revocation until the session ends": the `strand:revoked` contract arm.
  - Node level, "re-offers a formed join after a restart over the same keyStore, until forgetJoinedStrand": the formation dial is stubbed; a real `CadreNode` records the join; a second `CadreNode` over the same `InMemoryKeyStore` and storage lists it in `getDiscoveredStrands()` as `{Type:'c', MemberPrivateKey, FounderOwnerKey:null}`; `forgetJoinedStrand` removes it from the backlog and the KeyStore. This also covers the default store being built from `keyStore`. It runs in about 260 ms.
- `packages/reference-app-rn/test/react/use-cadre.spec.ts`: the existing test "leaves a CLOSED strand unclaimed" is replaced by "joins a CLOSED strand only when its row carries the read secret", which covers both the keyed and the keyless row.
- Not tested, checked by reading the code:
  - A `formStrand` whose record fails throws the spent-token error. The existing membership spec's `startSelfOwnerNode` picks a random party id, so an injected store cannot match it without reworking the helper.
  - A failed `list()` falls back to the last list the store returned.
  - `KeyStoreAccessError` from a load is rethrown.

## Validation run

- `yarn workspace @serfab/cadre-core test`: 141 files, 2287 passed, 1 skipped.
- `yarn lint` and `yarn typecheck` (repository-wide): clean.
- `yarn workspace @serfab/integration-tests exec vitest run strand-formation-cross-party-seed blind-relay-phone-to-phone-e2e`: 4/4 passed. Each joining node printed the memory-store warning once, 4 lines in all. Both scenarios use `privateKey` with no `keyStore`.
- `reference-app-rn`: `use-cadre.spec.ts` 23/23; typecheck clean.

## Known gaps and things to look at

- **Restart replication is not fixed by this ticket alone.** `crossPartyStrandAddrs` is still in memory only, so a re-attached join starts with an empty cross-party seed until `strand-peer-book-local` and `strand-peer-book-swap` land. `scenario-relay-only-restart-reconverges` is the end-to-end proof. That ticket's `joinedStrands.store` must be built as `new KeyStoreJoinedStrandStore(keyStore, partyId)`: the constructor takes the party id.
- **Web reference app.** It still keeps `formedStrands` in memory and has no `strand:discovered` handler. Left unchanged, as the ticket said.
- **cadre-cli and cadre-host** pass `privateKey` with no `keyStore`, so they get the memory store. Neither calls `formStrand` or `addStrand` today, so they were not wired. The CLI `start` would inject a `KeyStoreJoinedStrandStore(new FileKeyStore(<nodeStateDir>/…), partyId)` if it ever does.
- **Tripwires left as `NOTE:` comments:**
  - Direct re-admission after revocation (`addMemberByManager`) leaves the record forgotten (`CadreNode.forgetRevokedJoin`).
  - An app that claims a row the party just unpublished, from a copy it kept after the watcher withdrew it, gets it recorded as a join (`CadreNode.rememberForeignStrand`).
  - A failed load retries on every poll, which over a gated KeyStore would mean a prompt every 5 seconds (`KeyStoreJoinedStrandStore.loaded`).
- **FileKeyStore filename length (not measured).** The slot id is percent-encoded into a file name: about 115 characters for a UUID party and strand id. A very long party id plus a 128-character strand id full of dots (each `.` becomes `%2E`) could exceed a 255-byte name limit, and `formStrand` would then throw.
- **Duplicate addStrand race on RN (existing behavior, not new).** When RN `joinViaInvite` runs, the watcher can offer the just-recorded join before `joinClosedChatStrandFromFormation`'s `addStrand` registers the sApp config. That produces two concurrent `addStrand` calls for one strand. The launch path already tolerates this (`startStrand` returns the tracked instance), and the race already existed for own-party strands.
- The memory store's `console.warn` shows up in every integration run whose nodes join cross-party without a `keyStore`, once per node. The noise is deliberate: it is what makes the #18 setup visible in logs.
