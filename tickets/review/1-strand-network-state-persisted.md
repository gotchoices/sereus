description: Each machine now saves, per workspace, the ring library's routing table with every peer's signed address, and loads it again after a restart. The "two relay-only machines restart" test now passes using only that saved table, with Sereus's own address book left in memory, which is what allows the address book to be removed next.
prereq:
architecture: docs/architecture.md#strand-address-resolution
files: packages/cadre-core/src/strand-network-state.ts, packages/cadre-core/src/strand-network-state-file.ts, packages/cadre-core/src/strand-instance-manager.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/types.ts, packages/cadre-core/src/index.ts, packages/cadre-core/src/node-local-snapshot.ts, packages/cadre-core/package.json, packages/cadre-core/test/strand-network-state.spec.ts, packages/cadre-cli/src/commands/start.ts, packages/cadre-host/src/orchestrator/node-identity.ts, packages/reference-app-rn/src/cadre-phone.ts, packages/reference-app-rn/src/node-local-slots.ts, packages/reference-app-rn/src/phone-node-config.ts, packages/reference-app-web/src/lib/cadre-web.ts, packages/reference-app-web/src/lib/node-local-slots.ts, packages/reference-app-ns/src/cadre-phone.ts, packages/reference-app-ns/src/node-local-slots.ts, packages/integration-tests/src/harness/node-fixtures.ts, packages/integration-tests/src/harness/strand-restart-party.ts, packages/integration-tests/src/harness/fixtures/strand-restart-party.mjs, packages/integration-tests/src/scenarios/strand-relay-only-restart-reconverges.integration.ts, packages/*/package.json, yarn.lock, docs/architecture.md, docs/strands.md, docs/testing.md, .release-notes.pending.md, tickets/.pre-existing-error.md
difficulty: hard
----
# Strand network state persisted — review handoff

## The gate result

**The gotchoices/sereus#18 restart scenario converges without the strand peer book.** All three arms of `strand-relay-only-restart-reconverges` passed with the book at its in-memory default in every arm. `remove-strand-peer-book` may proceed; its `prereq:` line was not changed.

| Arm | Runs | Result | Timings from the rebuild | Book era (`tickets/complete/4-scenario-relay-only-restart-reconverges.md`) |
|---|---|---|---|---|
| Default (in-process, durable network state) | 4 | all passed | strand nodes reconnected at 0.87–0.96 s; B read A's post-restart row at 1.38–1.53 s; A read B's about 0.07 s later; test 4.7–4.9 s | reconnect 1.25–1.39 s; B read at 1.41–2.46 s |
| `RESTART_NEGATIVE_CONTROL=1` (network state in memory too) | 1 | passed: phase 2 did not converge in 180 s, strand nodes never connected, B's strand `active` | — | same outcome |
| `RESTART_TWO_PROCESS=1` (child processes, `FileStrandNetworkStateStore`) | 4 | converged in all 4 (see "The book assertion" below for the one red run) | respawned at 3.3–3.6 s; both strands active at 3.9–4.2 s; phase 2 both ways by 4.3–4.6 s; test 14.9 s in the final run | respawned 3.1 s; active 4.4 s; phase 2 by 4.8 s; about 12 s |

Logs: `tickets/.logs/strand-network-state-persisted.all-arms.log` (final code, all three arms in one run), `…default-arm.log`, `…two-process-arm.log` (the red run).

**The pre-restart gate** (each side's saved state holds the other side's strand peer with an address record) passed in 0–1 ms after the control read in every run.

## Which save carries the record

The ticket asked whether the gate passes only because of an unrelated later connection. It does not, but the save at `connection:open` is not the one that carries the record either. Traced once by wrapping the store's `save` (instrumentation removed):

- The save at `connection:open` held the other peer **without** an address record, on both sides.
- The next save, 59 ms later on B and about 200 ms later on A, held the record. That save coincided with the peer first appearing in `servingPeers`, so it is db-p2p's "serving verdict changed" save. The verdict is read from the peer's identify protocol list, and identify is also what delivers the record, so the two arrive together. That ordering is observed, not guaranteed by any contract.
- After a restart the verdict is restored from the saved state, so it does not change and that save does not fire again. In the two-process arm the saved record was still refreshed after the restart (new sequence number), then the live peerStore record moved on about 2 s later and the saved copy did not follow. The address was the same single `/p2p-circuit` address in both.

So the saved record can lag the live one. Parked as a `NOTE:` at `strandNetworkStatePersistence` (the upstream fix is db-p2p saving when FRET's table changes). No blocked ticket was filed, because nothing failed.

## A behaviour change the ticket did not name: restarting alone

db-p2p's saved state also restores which peers it saw serving the strand, and counts them in the cohort until FRET finds them unreachable. Measured by temporarily restarting only B in the in-process arm (A left stopped), writing every 1.5 s:

- **With saved network state:** B's writes at about 0 s and 2.8 s after launch failed with `Failed to get super-majority: 1/2 approvals (needed 2)`; the write at about 5.5 s and all 13 later ones succeeded. Reads worked throughout.
- **With in-memory network state:** every write succeeded at once (the node has forgotten the other party).

So a machine that restarts while every other member is offline now fails its first writes for 4–6 s on loopback. This is the same window `strand-removal-cuts-network` already documents for a running node whose cohort still lists an unreachable member. **The window on a slow relayed link was not measured.** Recorded in `docs/architecture.md` ("Restarting alone"), the release note, and a `NOTE:` at the `persistence` option in `buildStrandRuntime`. The reviewer should weigh whether this needs a ticket; the levers are an app-side retry or upstream, not Sereus's store.

## What was built

- **`strand-network-state.ts`** (cross-platform): `StrandNetworkStateStore`, `MemoryStrandNetworkStateStore`, `PersistentStrandNetworkStateStore` (over `NodeLocalSnapshot`, `drop-entry` policy, entry check is "plain object with a numeric `version`"), and `strandNetworkStatePersistence(store, strandId)`, the adapter to db-p2p's `NodeOptions.persistence`.
- **`strand-network-state-file.ts`** (Node-only): `FileStrandNetworkStateStore.open(dir, partyId)` over `FileDurableSlot(dir, 'strand-network', partyId)`; subpath export `@serfab/cadre-core/strand-network-state-file`.
- **Config and wiring:** `CadreNodeConfig.strandNetworkState.store`; `initializeStrandNetworkStateStore()` at `start()` (memory default, party mismatch throws, kept across `stop()`→`start()`); `getStrandNetworkStateStore()`; `StartStrandConfig.networkState`; `buildStrandRuntime` passes `persistence`. Forgetting is in `forgetStrandPeers`, which now forgets both the book and the network state, so the three book forget sites (`unpublishStrand`, `forgetJoinedStrand`, self-revocation) are covered by one edit.
- **Embedders:** cadre-cli `start` (file store in `nodeStateDir`), React Native and NativeScript (`strand-network.<party>`), web (`strand-network`), integration harness `controlNodeConfig({ strandNetworkStateStore })`.
- **Dependency floor:** every `@optimystic/*` range is `^1.8.1`; `yarn check:dep-ranges` passes.

## Deviations from the ticket's sketch

- **`forgetGeneration(strandId)` is a fourth method on `StrandNetworkStateStore`.** It is the save-after-forget guard: `forget` advances a per-strand counter, and the adapter drops a save once the counter differs from the value it captured. A custom store must implement it. The adapter is built per runtime, so a relaunch or a hibernation resume starts saving again.
- **`NodeLocalSnapshot.get(key)` was added** so `load` does not copy the whole map.
- **The web key is `strand-network`, not `strand-network.<party>`**, matching the web app's other unscoped keys.
- **Timings are recorded here**, not written into the archived `tickets/complete/4-…` ticket.

## The book assertion changed

The first two-process run converged (both phase-2 reads passed) and then failed the post-restart book check: the other side's signed book entry listed no addresses. Cause: a rebuilt strand node now dials from its saved table before its own relay reservation lands, so the first entry it swaps truthfully lists none; the book swap re-signs about 1 s later (`OWN_ENTRY_RESIGN_DEBOUNCE_MS`). Both arms now wait for an entry signed after the restart **with** at least one address. This assertion goes away with the book in the next ticket.

## Tests added

- `packages/cadre-core/test/strand-network-state.spec.ts`
  - "keeps each strand across a reopen, drops a forgotten one, and drops a non-object entry on load": the persistent round trip the ticket specified.
  - "drops a save that arrives after the strand was forgotten, until a new adapter is built": the guard. The ticket allowed this only if the guard has real branching; it has one branch plus the re-arm. Cut it if that does not meet the bar.
- Existing tests extended, not added: the slot-key pin and distinctness tests in the RN, NS and web `node-local-slots.spec.ts`; NS `cadre-phone.spec.ts` ("reads exactly the five node-local keys"); the RN config fixtures gained the new required store.

## Validation run

- `yarn lint`, `yarn typecheck`, `yarn knip`, `yarn check:dep-ranges`: pass.
- `yarn workspace @serfab/cadre-core test`: 148 files, 2381 passed, 1 skipped.
- `cadre-cli` 254 passed; `reference-app-rn` 302 passed; `reference-app-web` 67 passed; `reference-app-ns` 131 passed.
- Integration, beyond the three arms: every `strand-*` scenario, `blind-relay`, `push-wake`, `happy-path`, `websocket-chat`, `multi-party` (22 files and 78 tests passed; 1 opt-in file skipped), and `cadre-host-*` plus the non-control scenarios and `test/` specs (25 files passed, 2 opt-in files skipped, 2 failed, below).

## Not run, and why

- **The 13 `control-*` integration files** (`control-bring-up…`, `control-cohort-auto…/cold…/edge…/three…`, `control-concurrent…`, `control-cross…`, `control-db…`, `control-delete…`, `control-divergent…`, `control-offline…`, `control-stream…`, `control-write…`). The stale-build guard refused that run: `../optimystic`'s `db-core` and `db-p2p` `dist` went stale during the session, which means the sibling is being edited. Per `tickets/rules/sibling-repos.md` nothing was built there and no further integration runs were made. Everything listed under "Validation run" finished before that. Control nodes take no `persistence`, so this change should not reach those files, but that is by inspection.
- Device and browser end-to-end flows for the reference apps.
- `cadre-host`, `cadre-rn` and `quereus-plugin-sereus` unit suites (a comment and range bumps only; they typecheck).

## Pre-existing failures reported

`harness-party-control-cohort` ("…caps at two from a drone") and `control-cohort-harness-helpers` ("names the party and the observed size when the wait times out") fail 2 of 2 runs: a drone machine now reaches a three-member control cohort. Neither scenario launches a strand, so this change cannot reach them. Written to `tickets/.pre-existing-error.md` with an unverified lead (FRET 1.0.0's address hints letting a drone find its sibling).

## Known gaps to check

- **Self-revocation stops saving.** It forgets the state but stops nothing, so the still-running strand saves nothing more until its runtime is rebuilt. `NOTE:` at the adapter. The other side still holds this node's record, which was enough to re-mesh in every run, but a party re-admitted without a relaunch and then restarted relies on that.
- **A save during import.** db-p2p reads the saved state and then awaits FRET's import; a `connection:open` in between would save a table without the imported entries. Not observed and not tested; it would matter only if the process died inside that window.
- **Write amplification** (every save rewrites all strands' tables): `NOTE:` at `PersistentStrandNetworkStateStore.save`.
- **Party mismatch and hibernation resume** are by inspection only, as the ticket allowed.
- **Docs describe both records**, because the book still exists until `remove-strand-peer-book` lands. `reference-app-web/src/lib/node-local-slots.ts`'s header still says "all three records"; it was already out of date and was left.
