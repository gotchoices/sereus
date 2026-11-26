description: The cross-package test harness builds storage for every simulated machine the old way, so none of it compiles after the storage change. Update the harness and the scenarios that reach into it, and re-check one scenario whose whole point was that a machine storing nothing was never even given a place to store it.
prereq: 2-optimystic-1-30-cadre-core-node-storage
architecture: docs/contributing/testing.md
files: packages/integration-tests/src/harness/block-store-probe.ts, packages/integration-tests/src/harness/node-fixtures.ts, packages/integration-tests/src/harness/topology.ts, packages/integration-tests/src/harness/slow-raw-storage.ts, packages/integration-tests/src/harness/test-party.ts, packages/integration-tests/src/harness/cadre-invite.ts, packages/integration-tests/src/harness/strand-restart-party.ts, packages/integration-tests/src/harness/fixtures/strand-restart-party.mjs, packages/integration-tests/src/scenarios/strand-client-node-holds-no-blocks.integration.ts, packages/integration-tests/src/scenarios/strand-offline-waits-for-party-machine.integration.ts, packages/integration-tests/test/block-store-probe.spec.ts, packages/integration-tests/test/control-node-config.spec.ts, tickets/.pre-existing-known.md
difficulty: hard
----

# The integration harness opens one node storage per scope

Fourth of five tickets adopting Optimystic 1.30.0. Read ticket 2 first for the config shape this follows (`storage: { open(scope): Promise<NodeStorage>; allotmentBytes?: number }`, no single-instance form, cadre-core closes nothing). This package has 3 typecheck errors at HEAD, before any of this chain lands — `slow-raw-storage.ts:32`, `:171` and `test-party.ts:43` — and many more once ticket 2 changes cadre-core's types. It runs in parallel with ticket 3; neither depends on the other.

## The harness seams

**`block-store-probe.ts` — `captureRawStorage`.** Its `provider` becomes `open(scope): Promise<NodeStorage>`, still memoized per scope and for the reason its own comment gives: a provider is re-entered for a scope whose runtime has stopped and must reach the same durable backend, and memoizing is how the capture behaves like a real persistent provider. The factory it takes becomes a `() => NodeStorage`, defaulting to `memoryNodeStorage()`.

`forStrand`, `control` and every coverage helper keep taking and returning the **block** store (`IRawStorage`): every assertion in this package is about blocks. Add nothing for `kv` or `pieces` until a scenario needs them. The two guards stay as they are — `control()` throwing rather than minting an empty store (an empty store passes every coverage assertion vacuously) and `forStrand` refusing a control scope key.

**`node-fixtures.ts` and `topology.ts`.** `storageProvider?: RawStorageProvider` becomes the `open` function's type in both; the default stays one memory node storage per scope, and `storageOpDelayMs` stays mutually exclusive with it. The `slowMemoryStorageProvider` branch becomes a `NodeStorage` whose `blocks` is the slow wrapper over a memory block store, and whose `kv` and `pieces` come from a `memoryNodeStorage()` — the delay exists to stretch control-database bring-up, which is block reads, so wrapping only `blocks` is what the option means. Say that in its comment, because wrapping all three would also stretch things the option was never about.

Add an `allotmentBytes` passthrough to both only if a scenario needs one. None does today: a memory node storage reports no free space, so with no allotment a node measures nothing and acts on nothing, and upstream's warning for that case is on the `node-wiring` debug channel, off unless `DEBUG=` is set. Leave the option out rather than adding one nothing sets.

**`slow-raw-storage.ts`.** Add `deleteBlock` to `SlowRawStorage`, delaying and delegating like every other method (this is one of the three HEAD errors). `slowMemoryStorageProvider` returns the `NodeStorage` described above.

**`test-party.ts`.** Its `createLibp2pNode({ storage: () => new MemoryRawStorage() })` becomes `storage: memoryNodeStorage()` — note it currently passes a *function* where the option takes a value, which is the second HEAD error.

**`cadre-invite.ts`.** Retype its `storageProvider?: RawStorageProvider` field.

**`strand-restart-party.ts` and `fixtures/strand-restart-party.mjs`.** The fixture is the child process: one `FileRawStorage` per scope under `storage/`, and with `offline: true` one `FileKVStore` per strand scope under `offline/`. Both become one `fileNodeStorage(join(stateDir, 'storage', scope))` per scope, memoized, with the offline journal taken from that storage's `kv`. The separate `offline/` directory goes.

The journal must move, not merely may: one rule in this repository is that nothing builds a second key-value store over a location a node storage already covers, and upstream declares the journal's key prefix in `NODE_KV_NAMESPACES` so that one store serves the node and the journal. A journal in its own directory would also keep its bytes outside the one location the node measures itself against. Update the module comment in `strand-restart-party.ts` that describes the two directories, and the fixture's header comment.

## The scenario whose assertion inverts

`strand-client-node-holds-no-blocks.integration.ts` asserts, at its step 3, that the client's provider was **never asked for the strand's scope** (`clientCapture.scopes()` does not contain the strand id, and `forStrand` throws). Under 1.30 a client uses two thirds of a node storage — the key-value store for its clock high-water mark, blob records and owed-blob ledger, and the pieces, which may hold the only copy of a blob its own host put — so ticket 2 resolves storage for every strand, client included.

Re-aim the assertion to the stronger statement the scenario is really about: the provider **is** asked for the strand's scope, and the client's **block store holds nothing** — no block ids, no coverage — while both serving machines hold the strand's blocks. That proves the client stores no blocks even though it was handed somewhere to put them, which is a better test of `servesBlocks: false` than the old one. Rewrite the scenario's header comment at its step 3 to match, and keep every other step as it stands.

`block-store-probe.ts`'s `forStrand` returns the block store, so the empty-store assertion is a `listBlockIds` or coverage check over it. Check whether `compareBlockCoverage` already has the shape for "target holds nothing" or whether a `readBlockIndex` of size 0 is the clearer assertion; prefer the existing helper.

## Edge cases and interactions

- **The three HEAD errors are independent of this chain.** They are the sibling upgrade reaching this package: a missing `deleteBlock` on `SlowRawStorage` and a function passed where `createLibp2pNode` wants a storage value. Fix them whatever else lands.
- **`control-node-config.spec.ts`'s `storeForScope`.** It exists to resolve either form of the old provider (a per-scope factory or one shared store). The shared form is gone in ticket 2, so the helper collapses to awaiting `open(scope)`. Delete the branch rather than keeping a resolver for one shape.
- **A scenario that restarts a node over the same capture.** The memo is what makes that work, and it now holds `NodeStorage`s rather than block stores. Walk every scenario that keeps a capture across a stop (`control-offline-read-after-restart`, `strand-reattach-first-sync-measure`, `strand-relay-only-restart-reconverges`, `strand-two-party-two-machine`, `strand-late-cadre-join`, `strand-membership-closed-strand-e2e`, `control-delete-while-alone-convergence`, `strand-unpublish-sibling-convergence`) and confirm each still holds the same backend across the boundary.
- **`control-delete-while-alone-convergence` pins one store to every scope.** Its helper takes a single `MemoryRawStorage` and hands it to every scope, which the removed single-instance form made possible. It must become one `NodeStorage` per scope from one capture; read its header comment, which explains why it wanted one store, and keep whatever that reason still needs — if it needed the control and strand scopes to be the same store, that shape is no longer supported and the comment has to say what replaced it.
- **The child-process fixture is an `.mjs` file outside the typecheck program.** Nothing will fail to compile if it is missed; it will fail at run time in the scenarios that spawn it (`strand-offline-queue-survives-restart`, and whatever else `strand-restart-party.ts` serves). Run those scenarios.
- **`strand-offline-waits-for-party-machine.integration.ts`** builds its own `FileKVStore` journals in a `offline/` directory beside the party's home. Same move: the scope's `NodeStorage.kv`.
- **Read-cache leases across a scenario.** cadre-core now holds an upstream `withReadCache` lease per scope and releases it when the scope stops. A scenario that stops a node and starts another over the same capture gets a cold cache on the second, where before it got whatever Sereus's own wrapper held. That changes timing, not results — but `strand-reattach-first-sync-measure` and the relay-restart scenarios measure timing. If one of them moves, report the figure rather than adjusting a budget silently.
- **Four `.pre-existing-known.md` entries are stale.** The four entries dated 2026-11-24 attribute `enrollment-e2e`, `cadre-invite-any-member`, `cadre-host-join-by-invitation` and a cadre-core typecheck failure to `../optimystic` being parked at 1.28.0, with the confirm protocol "run `node scripts/check-dep-ranges.mjs`; if it reports no drift the cause is gone". It reports no drift (checked while planning this ticket), the sibling is at 1.30.0, and `PeersIncompleteError` resolves again. Run those three scenarios; if they pass, move their entries to the file's resolved section with the date and what resolved them, and note in the handoff that `tickets/blocked/optimystic-sibling-checkout-behind-declared-range.md` is answered by fact so a human can retire it. Do not delete that blocked ticket yourself — it is a human's inbox item.

## Tests

No new tests. The harness is test infrastructure, and the one assertion change is a re-aiming of an existing scenario step, not a new case.

The full integration suite is the check, and it is long: run it in the foreground with no redirection so the runner's idle timer stays alive, and `| tee tickets/.logs/<slug>.integration.log` only if you need to grep it afterwards. If the whole suite will not fit in the window, run the files this ticket touches plus every file named under *Edge cases* above, and say in the handoff which files were not run.

## TODO

- `slow-raw-storage.ts`: `deleteBlock`; `slowMemoryStorageProvider` returns a `NodeStorage` with only `blocks` slowed, with the reason in its comment.
- `test-party.ts`: `memoryNodeStorage()` as a value.
- `block-store-probe.ts`: `captureRawStorage` opens a `NodeStorage` per scope, memoized; `forStrand`/`control`/the coverage helpers keep working on `blocks`; both guards unchanged.
- `node-fixtures.ts`, `topology.ts`, `cadre-invite.ts`: retype the provider field; keep the memory default and the `storageOpDelayMs` exclusivity.
- `strand-restart-party.ts` and `fixtures/strand-restart-party.mjs`: one `fileNodeStorage` per scope, journal from its `kv`, the `offline/` directory removed, both comments rewritten.
- `strand-offline-waits-for-party-machine.integration.ts`: journal from the scope's `kv`.
- `strand-client-node-holds-no-blocks.integration.ts`: invert step 3 to "the provider was asked, and the client's block store holds nothing"; rewrite the header comment's step 3.
- `control-delete-while-alone-convergence.integration.ts`: one `NodeStorage` per scope; rewrite the header comment's single-store rationale.
- `test/control-node-config.spec.ts`: drop `storeForScope`'s shared-instance branch. `test/block-store-probe.spec.ts`: retype against the new capture.
- Sweep the remaining scenario files that name a store or a provider for compile and for assumptions: `app-joins-cadre-by-invitation`, `cadre-host-join-by-invitation`, `cadre-invite-any-member`, `cadre-invite-row-unreplicated`, `control-members-restarted-together`, `control-offline-read-after-restart`, `control-schema-migration-mixed-releases`, `harness-topology`, `joiner-first-commit-over-slow-relay`, `machine-removal-rotates-party-key`, `party-key-rotation-across-parties`, `pending-join-survives-restart`, `strand-always-on-replica-hosts-cross-party-join`, `strand-always-on-replica-survives-phone-loss`, `strand-chat-participants-converge`, `strand-late-cadre-join`, `strand-membership-closed-strand-e2e`, `strand-moves-between-cadres`, `strand-reattach-first-sync-measure`, `strand-relay-only-restart-reconverges`, `strand-two-party-two-machine`, `strand-unpublish-sibling-convergence`.
- Run `yarn workspace @serfab/integration-tests typecheck` and the suite; verify the three stale `.pre-existing-known.md` scenarios and update that file's resolved section if they pass.
- `docs/contributing/testing.md`: update it only if it describes the harness's storage seam; check before editing.
