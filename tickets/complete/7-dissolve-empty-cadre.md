description: Once an app has joined the user's main cadre and moved its strands there, the phone kit can delete the one-node cadre the app founded and left, after checking against that cadre's own storage that nothing is left in it.
prereq: move-strand-between-cadres
architecture: docs/architecture.md#dissolving-the-party-it-left
files: packages/cadre-rn/src/phone-node/dissolve.ts, packages/cadre-rn/src/phone-node/node.ts, packages/cadre-rn/src/phone-node/index.ts, packages/cadre-core/src/strand-move.ts, packages/cadre-core/src/index.ts, packages/cadre-core/test/strand-move.spec.ts, packages/cadre-rn/test/phone-node/node.spec.ts, test-harness/fake-rn-leveldb.ts, packages/reference-app-rn/src/cadre-phone.ts, packages/cadre-rn/README.md, docs/architecture.md, docs/reference-app-rn.md
----

# Dissolve the cadre an app left

Party B is the one-node cadre the app founded; party A is the cadre it joined, whose saved start names B as `formerPartyId`. `PhoneNode.dissolveFormerParty({ discard? })` checks against B's own storage that A holds everything B holds and that no other machine is in B, then deletes B's local storage and drops `formerPartyId`. It writes nothing to either control database.

## What was built

- **cadre-core** (`strand-move.ts`): `readStrandHoldings(node)` (every strand id of either kind and every pending-join id the running party holds) and the pure `unheldBundleContent(bundle, holdings, nowMs)` (strands held under no kind, and open pending joins not held). Formation invitations are not compared.
- **cadre-rn** (`phone-node/dissolve.ts`): `StrandMovePendingError`, `FormerPartyNotEmptyError` (`otherMachines`, `strandIds`, `pendingJoinIds`), the refusal check, the dissolve marker (`{ v: 1, partyId }` under `names.dissolveMarkerKey`, default `dissolving-party`) and the removal steps (control database through the new required `LevelDBNative.destroy`, three node-local keys, anchor slot, unpublished joined-strand records, move record, saved-start rewrite, marker).
- **cadre-rn** (`phone-node/node.ts`): the `dissolve` transition (in turn with start/stop/join: read A's holdings, stop A, read B from a node started for it alone, refuse or remove, start A again); `readAlone` replaces the join's `exportStopped` and launches no strands; every `bringUp` finishes a marked removal first and drops `formerPartyId` when the marker names it.
- Reference app passes `destroy: (name) => LevelDB.destroyDB(name)`; no UI yet (`reference-apps-join-existing-cadre`).
- Docs: architecture.md `##### Dissolving the party it left`; kit README `#### Dissolving the left cadre`; reference-app-rn.md `### Dissolve marker (app-private LevelDB)`.

Implemented in `ticket(implement): dissolve-empty-cadre`.

## Review findings

**Checked:** the full implement diff (`ticket(implement): dissolve-empty-cadre`) before the handoff; every per-party storage item `buildConfig` opens against what `finishRemoving` deletes (control scope via `controlStorageScope`, anchor slot, the three `<record>.<partyId>` node-local keys, joined-strand key-store records, move record) — complete, the identity key is per-app (`DEFAULT_IDENTITY_KEY_ID`) so nothing per-party is missed; rn-leveldb's `LevelDB.destroyDB(name, force?)` is static, synchronous and throws "DB is open" for an open name, matching the `destroy` contract and the fake; LevelDB's `DestroyDB` on a missing directory returns OK, so a resumed removal is idempotent; the order of `shutDown` / `closeDatabases` against `destroy` (B's control database is closed and out of `this.databases` before the destroy); `listMembers()` is `queryCadrePeers()` (revoked peers already filtered) and the reading node's peer id is the per-app identity, so the self-filter is right; queueing against `start`/`stop`/`restart`/`joinCadre` (`this.starting = null` mirrors `joinCadre`); the success, refusal and failure-after-marker paths and the status each leaves; the `strandFilter: none` change for the join's stopped-party export (`exportStrand` reads the persisted network-state store and in-memory carried addresses, neither of which a strand launch populates from a stopped start); docs in architecture.md, kit README, reference-app-rn.md and strands.md (the last needs no change).

**Fixed inline (minor):**
- A start whose `formerPartyId` names its own party (only a hand-built `PhoneNodeOptions` can do this; the field is app-settable) would pass the check trivially and have the dissolve destroy the running party's control database. `runningWithFormerParty` (`packages/cadre-rn/src/phone-node/node.ts`) now refuses it before anything stops; the interface doc and README's refusal bullet say so.
- Added one test, "finishes a removal that failed partway at the start that follows, which drops formerPartyId" (`packages/cadre-rn/test/phone-node/node.spec.ts`): a secure-store delete of B's anchor fails once after the marker is written; asserts the call rejects with that error, A is running without `formerPartyId`, the anchor is gone and the saved start no longer names B. Pins the crash-resume contract the handoff listed as untested (failure after the marker → restart of A → `bringUp` finishes the removal and drops the field).

**Major:** none. No finding needed a ticket.

**Tripwires / conditional:** none new. The implementer's existing `NOTE:` on `finishRemoving` (strand databases stay) and the updated file-size `NOTE:` near the join cover the conditional concerns. A marker naming the party a start is *for* (only reachable if a user hand-starts B after a failed dissolve) finishes the removal and starts B empty; the check had already passed, so no moved data is lost — judged too contrived for a comment.

**Accepted as the implementer left them (judgment calls reviewed):** finishing a marked removal at the top of the call throws while the same finish at a start only logs — right, the caller asked for the action; an unparseable marker is deleted with a warning, as an unparseable move record is; a removal failing after the marker restarts A with unchanged options and lets `bringUp` drop the field.

**Known gaps carried from the handoff, still true:** the other-machines refusal, `StrandMovePendingError` and an unparseable marker are checked by reading only (the first needs a second machine in B; the latter two are a single branch each over code already exercised); a corrupt unpublished joined-strand record of B is skipped by `KeyStoreJoinedStrandStore.list()` and stays in the secure store (a few bytes); `LevelDBNative.destroy` is a required field, a breaking change for embedders (no backwards-compat policy yet); the transient `stopped`/`starting` statuses the app sees during a dissolve are documented in the README.

**Tests reviewed:** the cadre-core `unheldBundleContent` case pins the open/finished/expired branching including the `<` boundary — kept. The two phone-node cases (success, refusal + discard) each cover a distinct specified behaviour — kept. Nothing cut.

**Validation:** `yarn lint` clean; `@serfab/cadre-rn` typecheck clean, build rebuilt, suite 162/162; `@serfab/reference-app-rn` typecheck clean; cadre-core `strand-move.spec.ts` 4/4 (cadre-core source unchanged in this pass).
