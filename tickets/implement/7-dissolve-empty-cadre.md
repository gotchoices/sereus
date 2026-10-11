description: Once an app has joined the user's main cadre and moved its strands there, the one-node cadre it founded and left still sits on the phone's disk; give the phone kit a call that checks nothing is left in it and then deletes it, so the app runs only as a member of the main cadre.
prereq: move-strand-between-cadres
architecture: docs/architecture.md#an-app-joins-an-existing-cadre
files: packages/cadre-rn/src/phone-node/node.ts, packages/cadre-rn/src/phone-node/dissolve.ts (new), packages/cadre-rn/src/phone-node/index.ts, packages/cadre-rn/src/phone-node/strand-move.ts, packages/cadre-core/src/strand-move.ts, packages/cadre-core/src/index.ts, packages/cadre-core/test/strand-move.spec.ts, packages/cadre-rn/test/phone-node/node.spec.ts, test-harness/fake-rn-leveldb.ts, packages/reference-app-rn/src/cadre-phone.ts, packages/cadre-rn/README.md, docs/architecture.md, docs/reference-app-rn.md
difficulty: medium
----

# Dissolve the cadre an app left

Party B is the one-node cadre the app founded; party A is the cadre it joined (`PhoneNode.joinCadre`), whose saved start names B as `formerPartyId`. The move (`move-strand-between-cadres`) copied B's strands and pending joins into A and deleted nothing in B. This ticket adds `PhoneNode.dissolveFormerParty()`: verify against B's own storage that A holds everything B holds and that no other machine is in B, then delete B's local storage and drop `formerPartyId`.

Dissolving is local. It writes nothing to B's control database (it could not delete the last `OwnerKey` row anyway: `OwnerKey.MinOneOwner`) and nothing to A's.

## Design decisions

**The check reads B's storage, not a record of it.** The kit's move record (`cadre/strand-move/<B>`) is deleted once an adoption fails nothing, and an unparseable one is deleted with a warning, so its absence does not prove every strand reached A. The control database cannot be opened without a libp2p node (`ControlDatabase` takes the node's `coordinatedRepo`), and a node serves one party, so the dissolve stops A's node, starts one for B alone to read it (as `exportStopped` already does for a join from a stopped app), stops it, and starts A again. That is one restart of A, a few seconds to tens of seconds on a loaded phone (control bring-up note in `cadre-node.ts`), for a rare, user-initiated action.

Rejected: a snapshot of B's strand ids and machines kept by the join, checked later against A with no restart. It is a second durable record with the same loss mode the move record has, and B's storage is the only ground truth.

**What must be in A** (cadre-core, so any embedder can make the same check):

- Every strand id in B's export (`exportStrandBundle`: `Strand`, published `JoinedStrand`, and unpublished joined-strand records) is in A's `Strand`, `JoinedStrand`, or unpublished joined-strand list. A strand the move refused (A already participates in it under its own identity, or holds the other kind or different content) is present, so it passes. Its data stays reachable from A; what is lost is B's seat in it, which the join already reported (`JoinCadreResult.strandMove.report.refused`). Dissolving does not ask again: calling dissolve is the user's choice.
- Every pending join of B that is still open (`outcome === null` and `ExpiresAt` in the future, by the same comparison the pending-join runner uses) has a row with the same `Id` in A's `queryPendingJoins()`. A finished join is not required: a `joined` one's strand is covered by the strand check, and a `failed` one is history. An expired one can never be attempted.
- Formation invitations are not compared. B's node never runs again, so a row the move dropped (validation-gated, or bound to a strand A does not seat) was unredeemable from the moment of the join; dissolving changes nothing for it.

**Discarding is explicit.** Something A legitimately dropped after the move (the user left a moved strand in A, or dismissed a moved join, whose tombstone A then reaped) reads the same as something never moved. So the dissolve refuses and names what is missing, and the caller may pass those ids back in `discard` to dissolve anyway. Other machines in B cannot be discarded: they may hold B's data, and removing them is the user's choice made in B (`remove-a-device-or-app-from-a-cadre`).

**Strand storage stays.** A strand's storage scope is its strand id, not the party, so A's copy of a moved strand is the same database. Only B's party-scoped records are deleted. A discarded strand's database is left in place too (A may join the strand again and reuse it); leave a `NOTE:` tripwire at the deletion site saying so.

**Crash safety: a marker written first.** A one-per-app node-local record names the party being dissolved. It is written before the first deletion and deleted last, after the saved start no longer names B. Every start, and every dissolve call, first finishes a dissolve a marker names: the check already passed before the marker was written, so finishing only deletes. Each deletion step is idempotent (deleting what is absent succeeds).

## API (`@serfab/cadre-core`, `strand-move.ts`)

```typescript
/** What a party already holds of strands and joins, read from its running node. */
export interface StrandHoldings {
	strandIds: ReadonlySet<string>;
	pendingJoinIds: ReadonlySet<string>;
}

/** `Strand` ∪ `JoinedStrand` ∪ `listUnpublishedJoinedStrands()` ids, and every `queryPendingJoins()` id. */
export function readStrandHoldings(node: CadreNode): Promise<StrandHoldings>;

/** What of `bundle` the holdings lack, by the rules above. Pure. */
export function unheldBundleContent(bundle: StrandBundle, holdings: StrandHoldings, nowMs: number): {
	strandIds: string[];
	pendingJoinIds: string[];
};
```

## API (`@serfab/cadre-rn/phone-node`)

```typescript
interface LevelDBNative {
	openFn: RNLevelDBOpenFn;
	WriteBatch: RNLevelDBWriteBatchCtor;
	/** rn-leveldb's `LevelDB.destroyDB(name)`: deletes a closed database; throws when it is open. */
	destroy: (name: string) => void;
}

interface PhoneNodeNames {
	// ...existing
	/** Key, in `nodeLocalDb`, of the record naming a party whose dissolve has begun. Dot-free, one per app. Default `'dissolving-party'`. */
	dissolveMarkerKey: string;
}

interface DissolveFormerPartyOptions {
	/** Strand and pending-join ids of the former party to give up although the running party does not hold them; from a `FormerPartyNotEmptyError`. */
	discard?: readonly string[];
}

interface PhoneNode {
	// ...existing
	/**
	 * Delete the local storage of `formerPartyId`, the party this app founded and left, once
	 * the running party holds everything it holds and no other machine is in it. Runs in turn
	 * with start, stop, restart and join. Stops the running node, reads the former party from a
	 * node started for that alone, and starts the running party again.
	 */
	dissolveFormerParty(options?: DissolveFormerPartyOptions): Promise<void>;
}

/** The move into the running party has not finished: `finishStrandMove()` first. Nothing stopped. */
class StrandMovePendingError extends Error { readonly pending: PendingStrandMove }

/** The former party still holds what the running party lacks, or has other machines. Nothing deleted. */
class FormerPartyNotEmptyError extends Error {
	readonly partyId: string;
	/** Peer ids of `CadrePeer` rows other than this node's. Not discardable. */
	readonly otherMachines: string[];
	/** Not held by the running party and not in `discard`. */
	readonly strandIds: string[];
	readonly pendingJoinIds: string[];
}
```

## The transition (`PhoneNodeRuntime.dissolveFormerParty`, in turn)

1. Finish a dissolve a marker names (below), if any.
2. Refuse, nothing stopped, with a plain `Error` unless the node is running and `runningOptions.formerPartyId` is set. Call it B.
3. Refuse, nothing stopped, with `StrandMovePendingError` when the move record for B exists (`this.moves.load(B)`, reported through `pendingMove`). This covers a record naming a third party the app joined later: it is adopted only there.
4. Read A's holdings (`readStrandHoldings` on the running node), then `shutDown()`.
5. Start a node for B alone, as `exportStopped` does (status `starting`, nothing subscribed, nothing saved): `partyId: B`, no bootstrap or relay addresses, the running Noise mode, and `strandFilter: { mode: 'none' }` applied after `platform.configure`, so B's strands do not launch and sync while it is read. Read `exportStrandBundle(node)` and the peer ids of `queryCadrePeers()` other than the node's own. `shutDown()` in a `finally`.
6. Compute `unheldBundleContent(bundle, holdings, Date.now())`, minus `discard`. Anything left, or any other machine: start A again with its unchanged options and throw `FormerPartyNotEmptyError`.
7. Otherwise remove B (below), then start A with its options minus `formerPartyId`. A failure of that start is the call's error (the app's node is down); B is gone by then, which `loadSavedStart()` shows.

A failure in steps 5 or 6 starts A again and rethrows the dissolve's own error; a failure restarting A after a refusal is logged and leaves status `failed`, as `returnToLeftParty` does for a join.

Extract the shared "start a node for one party alone, run a read, shut it down" from `exportStopped` rather than copying it.

## Removing B (`dissolve.ts`, run with no database of B open)

In this order:

1. Write the marker `{ v: 1, partyId: B }` (JSON) under `names.dissolveMarkerKey`.
2. Destroy the control database `names.storagePrefix + controlStorageScope(B)` through `platform.leveldb.destroy`.
3. Delete B's node-local keys from `nodeLocalDb`: `bootstrapPeersKvKey(B)`, `enrolledMachinesKvKey(B)`, `strandNetworkKvKey(B)` (`LevelDBKVStore.delete`).
4. Delete B's anchor, `anchorSlotKey(B)`, from the secure store (`deleteItemAsync` with `platform.secureStoreOptions`).
5. Forget B's joined-strand records: `new KeyStoreJoinedStrandStore(this.keyStore, B)`, `list()`, `forget()` each. Uses cadre-core's slot naming rather than copying its prefix.
6. Remove B's move record (`this.moves.remove(B)`; absent by step 3 of the transition, removed in case a crash left one).
7. Rewrite the saved start without `formerPartyId`, keeping `autoStart` and `writtenBy`. Use a write that throws, not the best-effort `saveStart`, so a failure keeps the marker for the next start.
8. Delete the marker.

**Finishing at start.** `buildAndStart` (and step 1 of the transition) reads the marker before `resolveOptions`. When one is present it runs steps 2 to 8 for its party, and the start drops `formerPartyId` from its options when it names that party (an app starting from a copy of the saved start read before the rewrite). A failure finishing is logged and the start goes on; the marker stays for the next start. An app that starts the marked party itself by a typed id gets it removed first, then founded afresh: an explicit request for a new party under that id.

## Other changes

- `test-harness/fake-rn-leveldb.ts`: `lockingFakeRNLevelDB()` returns a `destroy(name)` that throws when the name is open (as rn-leveldb does) and otherwise drops its data. Every `leveldb` the phone-node specs build passes it.
- `packages/reference-app-rn/src/cadre-phone.ts`: `destroy: (name) => LevelDB.destroyDB(name)`. No UI here: Settings' flow is `reference-apps-join-existing-cadre`.
- Export the new names from `phone-node/index.ts` and the cadre-core index.

## Edge cases & interactions

- **Crash mid-dissolve.** Before the marker: nothing deleted, the call can be repeated. After it: the next start, or the next call, finishes the deletion without checking again. Verified by inspection of the step order; each step is idempotent.
- **Crash or kill while B's node is up for the read.** Nothing was deleted and the saved start still names A with `autoStart`, so the next launch starts A. Inspection.
- **Another app on the phone, or B's own always-on node, is in B.** Its row is in B's `CadrePeer`, so the dissolve refuses and names it. Inspection; the read filters only this node's peer id.
- **Writes made in B while alone that never replicated.** There was no other machine, so they live only in B's storage. The check reads that storage, so a strand or open join written there after the move's export is caught as missing.
- **The move is unfinished or partly failed.** The record exists, so `StrandMovePendingError` before anything stops. A move whose record was lost (unparseable) is caught by the storage check.
- **A refused strand.** Present in A, so it passes; B's seat in it is dropped silently (decision above).
- **A strand or join A dropped after the move.** Refused and named; passing its id in `discard` dissolves anyway. Covered by the refusal test.
- **B's storage already gone** (a second call with a stale `formerPartyId`, from options an app cached). B's node comes up over empty storage, holds nothing, and the removal deletes what that start created. Harmless; inspection.
- **`stop`, `start` or `joinCadre` called during a dissolve.** They queue behind it (`inTurn`); a `start` finds A running and returns it. A dissolve is bounded by two node starts and waits on no network, so a stop does not cancel it. Inspection.
- **Push wake into a killed process mid-dissolve.** It starts from the saved start, which names A until step 7 and A without B after; the marker finishes any half-removal. Inspection.
- **Party ids as storage keys.** Every name is built by the existing helpers (`controlStorageScope`, the `node-local` key functions, `anchorSlotKey`, `KeyStoreJoinedStrandStore`), never by string-building a party id here. Inspection.

## Tests

The default is no new test; these pay:

- `packages/cadre-rn/test/phone-node/node.spec.ts`, success path (the ticket's own test): start B, found a strand, `exportStrandBundle`, stop; start A founded with `formerPartyId: B`, `adoptStrandBundle`; `dissolveFormerParty()`. Expect: status `running` in A; `loadSavedStart()` has no `formerPartyId`; B's control database name is gone from the fake (opening it finds it empty) and `anchorSlotKey(B)` is absent from the secure store; after `stop()` and `start(saved.options)` the node runs in A with the strand. Founding A rather than joining it keeps a member of A out of the spec; the transition does not read `origin`.
- Same file, refusal branch: B holds a strand A does not. Expect `FormerPartyNotEmptyError` with that strand id and empty `otherMachines`, A running again, B's control database intact; then `dissolveFormerParty({ discard: [id] })` succeeds.
- `packages/cadre-core/test/strand-move.spec.ts`: one case on `unheldBundleContent` over hand-built bundle and holdings: a held strand, an unheld strand, an open unheld join, a finished unheld join, an expired unheld join; only the unheld strand and the open join are returned. Pins the branching rules above.

No test for the marker resume (inspection) or for the other-machines refusal (needs a second machine in B; the read is one filter).

## Docs

- `docs/architecture.md`: a `##### Dissolving the party it left` section after "Moving the app's strands": what is checked and why from B's storage, the discard, what is deleted and what stays (strand storage), the marker. Point "What stays in B" at it.
- `packages/cadre-rn/README.md`: under "Joining another cadre", a `#### Dissolving the left cadre` entry for `dissolveFormerParty`, its errors and the `leveldb.destroy` the platform now passes; update the `formerPartyId` bullet.
- `docs/reference-app-rn.md`: the dissolve marker beside the saved-start record in the node-local records list.

## TODO

- cadre-core: `readStrandHoldings`, `unheldBundleContent`, exported; the spec case.
- Fake LevelDB `destroy`; `LevelDBNative.destroy`; `PhoneNodeNames.dissolveMarkerKey` (update the pinned-names spec case).
- `dissolve.ts`: errors, marker read/write, the removal steps over a narrow view of the runtime's storage.
- `node.ts`: the transition, the shared alone-node helper extracted from `exportStopped`, marker finishing in `buildAndStart`; keep node.ts from growing much (its size `NOTE:` near the join).
- Reference app: pass `destroy`.
- The two phone-node spec cases.
- Docs as above.
- `yarn lint`, cadre-core and cadre-rn tests, type checks.
