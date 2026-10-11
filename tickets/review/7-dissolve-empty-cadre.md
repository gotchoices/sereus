description: Once an app has joined the user's main cadre and moved its strands there, the phone kit can now delete the one-node cadre the app founded and left, after checking against that cadre's own storage that nothing is left in it; review the new call, its crash-resume marker and its docs.
prereq: move-strand-between-cadres
architecture: docs/architecture.md#dissolving-the-party-it-left
files: packages/cadre-rn/src/phone-node/dissolve.ts (new), packages/cadre-rn/src/phone-node/node.ts, packages/cadre-rn/src/phone-node/index.ts, packages/cadre-core/src/strand-move.ts, packages/cadre-core/src/index.ts, packages/cadre-core/test/strand-move.spec.ts, packages/cadre-rn/test/phone-node/node.spec.ts, test-harness/fake-rn-leveldb.ts, packages/reference-app-rn/src/cadre-phone.ts, packages/cadre-rn/README.md, docs/architecture.md, docs/reference-app-rn.md
----

# Review: dissolve the cadre an app left

Party B is the one-node cadre the app founded; party A is the cadre it joined, whose saved start names B as `formerPartyId`. `PhoneNode.dissolveFormerParty({ discard? })` checks against B's own storage that A holds everything B holds and that no other machine is in B, then deletes B's local storage and drops `formerPartyId`. It writes nothing to either control database.

## What was built

**cadre-core (`strand-move.ts`, exported from the index):**

- `readStrandHoldings(node)`: the running party's strand ids (`Strand` ∪ `JoinedStrand` ∪ unpublished joined-strand records) and every `queryPendingJoins()` id.
- `unheldBundleContent(bundle, holdings, nowMs)`: pure. Strands of the bundle held under no kind, and pending joins with no outcome and `nowMs < ExpiresAt` (the pending-join runner stops at `now >= ExpiresAt`) whose id the holdings lack. Formation invitations are not compared.
- `requireControlDatabase` now takes the whole action phrase; the export/adopt messages are unchanged text.

**cadre-rn phone node:**

- `dissolve.ts` (new): `StrandMovePendingError` (`pending`), `FormerPartyNotEmptyError` (`partyId`, `otherMachines`, `strandIds`, `pendingJoinIds`), `DissolveFormerPartyOptions`; `readFormerParty` (bundle + `listMembers()` peer ids other than the node's own, deduplicated); `formerPartyRefusal` (unheld minus `discard`, plus other machines); the marker (`{ v: 1, partyId }` JSON under `names.dissolveMarkerKey`); the removal steps over a narrow `PartyStorage` view of the runtime, in the ticket's order (marker, destroy control DB, three node-local keys, anchor slot, joined-strand records via `KeyStoreJoinedStrandStore`, move record, saved-start rewrite with a throwing write, delete marker). The `NOTE:` that strand databases stay, discarded ones included, is on `finishRemoving`.
- `node.ts`: `dissolveFormerParty` runs `inTurn` and clears `this.starting` first (so a `start` called during it runs after it). The transition is `dissolve()`: finish a marked removal → refuse with a plain `Error` unless running with `formerPartyId` → refuse with `StrandMovePendingError` if `moves.load(B)` finds a record → `readStrandHoldings(A)` → in a `try`: `shutDown()`, read B alone, refuse or `removeParty` → on any error start A again with unchanged options (failure logged, status `failed`) and rethrow → otherwise `buildAndStart(A without formerPartyId)`, whose failure is the call's error.
- `readAlone(options, read, purpose)` replaces `exportStopped`: status `starting`, config built and resolved as before, `strandFilter: { mode: 'none' }` applied after `platform.configure`, nothing subscribed or saved, `shutDown()` in `finally`. Used by the join's stopped-party export and by the dissolve's read of B.
- `bringUp` (every start and every join's start) runs `finishRemovalAtStart` first and drops `formerPartyId` from the *resolved* options when the marker names it, finished or not (so a `formerPartyId` copied from the saved start by `resolveOptions` is dropped too). A failure there is logged; the start goes on and the marker stays.
- `LevelDBNative.destroy` (required) and `PhoneNodeNames.dissolveMarkerKey` (default `'dissolving-party'`, pinned in the names spec). `database()` passes only `openFn`/`WriteBatch` to `openOptimysticRNDb`.
- `test-harness/fake-rn-leveldb.ts`: `lockingFakeRNLevelDB().destroy(name)` throws for an open name, else drops its data.
- Reference app passes `destroy: (name) => LevelDB.destroyDB(name)`; no UI (that is `reference-apps-join-existing-cadre`).

**Docs:** architecture.md gains `##### Dissolving the party it left` after "Moving the app's strands", and "What stays in B" plus the join intro point at it. The kit README gains a members-table row, `#### Dissolving the left cadre` (example, errors, what is removed, the marker, `leveldb.destroy`), the platform snippet's `destroy`, and the `formerPartyId` bullet. reference-app-rn.md gains a `### Dissolve marker (app-private LevelDB)` section beside Start options.

## Tests added

- `packages/cadre-core/test/strand-move.spec.ts` → `unheldBundleContent` "lacks a strand held under no kind and a join still open, not a finished or expired one": hand-built bundle with a held and an unheld strand; held-open, unheld-open, unheld-finished (`failed` outcome) and unheld-expired (`ExpiresAt === now`) joins. Only the unheld strand and the unheld open join come back. Pins the branching rules, including the `<` boundary.
- `packages/cadre-rn/test/phone-node/node.spec.ts` → "dissolving the party it left":
  - success path: found a strand in B, export, stop; start A (founded) with `formerPartyId: B`, adopt; dissolve. Asserts A running `enrolled`, saved options without `formerPartyId`, B's anchor slot present before and absent after, B's control database empty in the fake; after stop + start from the saved options, A's control DB has the strand.
  - refusal branch: B holds a strand A never adopted. Asserts `FormerPartyNotEmptyError` with `strandIds: [id]`, empty `pendingJoinIds` and `otherMachines`; A running with `formerPartyId` still set; B's control DB still holds data. Then `discard: [id]` dissolves and B's control DB is empty.
- The names-pinning case now includes `dissolveMarkerKey`.

Validation run: `yarn lint` clean; `typecheck` clean for cadre-core, cadre-rn, reference-app-rn; cadre-rn suite 161/161; reference-app-rn suite 151/151; cadre-core `strand-move.spec.ts` 4/4. The full cadre-core suite was not run (only `strand-move.ts` changed there, plus one exported-name block). cadre-core and cadre-rn `dist` were rebuilt.

## Judgment calls the ticket left open (check these)

- **`strandFilter: none` now applies to the join's stopped-party export too**, since `readAlone` is the extracted helper. The export reads only control rows, node-local stores and the in-memory carried addresses, none of which a strand launch produces, so launching strands there was wasted work. A behaviour change for `joinCadre` from a stopped app; the existing "records the strands of a stopped party" case still passes.
- **A removal that fails after the marker is written** (the ticket's step 7 only specified a failed *start*): A is started again with unchanged options, and `bringUp` retries the finish and drops `formerPartyId` because the marker names B, then the removal's error is rethrown. A marker write that fails leaves nothing deleted and A restarts with `formerPartyId` intact.
- **Finishing a marked removal at the top of `dissolveFormerParty` throws** (the call reports why), where the same finish at a start only logs. Consequence: once a start has dropped `formerPartyId` after a failed finish, a later dissolve call that finishes the removal then fails with "Nothing to dissolve". The UI would hide the action by then, since `options.formerPartyId` is gone.
- **An unparseable marker is deleted with a warning**, as an unparseable move record is: nothing can finish it.

## Known gaps

- Untested, checked only by reading the code: marker resume at start and in the call, the other-machines refusal (needs a second machine in B), `StrandMovePendingError`, an unparseable marker, removal or restart failures, and the status sequence the app sees (`running → stopped → starting → stopped → starting → running`; `phone.node` is null throughout).
- `KeyStoreJoinedStrandStore.list()` skips a slot that does not parse, so `forget` never reaches it: a corrupt unpublished joined-strand record of B stays in the secure store after the dissolve. A few bytes; not tracked.
- `destroy` is a required `LevelDBNative` field, a breaking change for any embedder constructing the platform (no backwards-compat policy yet).
- If a `destroy` finds B's control database still open in this runtime (only reachable when the app started B itself by typed id, that node died without `stop`, and a marker names B), it throws "DB is open", which is logged at start and kept for the next start.
- `node.ts` is 972 lines (`wc -l`); the size `NOTE:` near the join now names the dissolve transition too.
