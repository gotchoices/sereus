description: An app that restarts and reconnects to a party it already had strands in now gets those strands back, instead of showing nothing because the node announced them a fraction of a second before the app was listening.
files:
  - packages/cadre-core/src/cadre-node.ts (`discoveredStrands` field ~400; `getDiscoveredStrands()` ~897; `handleStrandAdded` ~3931; `cleanup` ~4070; `addStrand` ~4396; `stopStrand` doc ~5663; `detachStrand` ~5699)
  - packages/cadre-core/src/types.ts (`'strand:discovered'` doc ~1118-1142)
  - packages/cadre-core/test/discovered-strands-late-subscriber.spec.ts (new — the three regression arms)
  - packages/cadre-core/test/control-db-node-helpers.ts (`memoryStorageProvider` hoisted here, ~185)
  - packages/cadre-core/test/control-founding-consult-budget.spec.ts (now imports that helper instead of its own copy)
  - packages/reference-app-rn/src/use-cadre.ts (`claimDiscovered` + the in-flight guard ~196 + the drain ~229)
  - packages/reference-app-rn/test/react/use-cadre.spec.ts (`MockNode.getDiscoveredStrands` / payload-carrying `emit`; new `discovered-strand backlog` describe block)
  - docs/architecture.md (Cadre Node bullet 3 — the unclaimed-strand branch and the subscribe-then-drain contract)
difficulty: medium
----

# Keep unclaimed strand discoveries claimable — implementation handoff

## What was wrong, in one paragraph

`CadreNode` polls the control database's `Strand` table. A row it holds no sApp config for is announced as `strand:discovered` and then forgotten by the node — the watcher records the id in its `knownStrands` and never re-offers it. sApp configs are in-memory only and `stop()` clears them, so after a restart every stored strand takes that branch, and the announcement fires from the watcher's first poll *inside* `CadreNode.start()` — before any embedding app can attach a listener. Every discovery fired into an empty listener list. On a phone, reconnecting to a party you already had strands in showed `0 strand(s)`, permanently.

## What changed

**cadre-core.** The set of unclaimed strands is now node state, not a one-shot notification. A private `discoveredStrands: Map<string, StrandRow>` sits beside `sAppConfigs`; `getDiscoveredStrands()` returns a snapshot of it. It is maintained at the four sites the ticket named: recorded in `handleStrandAdded`'s no-config branch (immediately *before* the emit, so a handler that drains synchronously sees the strand it was just told about), deleted in `addStrand` when a config claims the strand, deleted in `detachStrand` (which covers both the vanished-control-row path and a deliberate `stopStrand`, so a drain can never undo a stop), and cleared in `cleanup`. The `strand:discovered` event itself is unchanged.

The `'strand:discovered'` doc in `types.ts` now states the contract that was previously only discoverable by hitting the bug: fired once per strand per session, can fire before your listener exists, subscribe-then-drain is the required order, and the join handler must be idempotent because a strand discovered between those two steps is offered twice. The `stopStrand` doc comment was corrected — it claimed a stopped strand resurfaces "on the next node restart (or watcher poll)"; the watcher-poll half was never true. `docs/architecture.md` (Cadre Node, bullet 3) gained the same contract in prose.

Nothing new is exported: `getDiscoveredStrands` is a method, and `StrandRow` already ships via `export * from './types.js'`. Confirmed, not assumed.

**reference-app-rn.** The `strand:discovered` effect in `use-cadre.ts` now factors the join into one `claimDiscovered` function used by both the event and a catch-up drain, subscribes first and drains `node.getDiscoveredStrands()` second, and guards with a `Set<string>` of ids currently being claimed (cleared in a `finally`). The existing `getStrands().has(id)` check is not sufficient alone — the strand manager tracks an instance only once `addStrand` resolves, and the handler is fire-and-forget, so two offers could both pass it. The `Type !== 'o'` gate is unchanged: closed strands still require the invite handshake and simply stay unclaimed.

**A shared test helper moved.** `memoryStorageProvider()` (one memoised `MemoryRawStorage` per storage scope) was a private function inside `control-founding-consult-budget.spec.ts`; it is now exported from `control-db-node-helpers.ts` next to `fileStorageProvider`, and that spec imports it. Its budgets are untouched and it passes.

## How to validate

**Commands run, all green.**

```
yarn lint
yarn typecheck                                 # repo-wide, 2m21s; includes the test-file/vitest coverage guards
yarn workspace @serfab/cadre-core test         # 130 files, 2128 passed | 1 skipped
yarn workspace @serfab/reference-app-rn test   # 14 files, 213 passed
```

The one skip is `key-store.spec.ts:231`, a pre-existing `it.skipIf(process.platform === 'win32')`. Nothing was skipped, disabled, or loosened by this work.

**Each new arm was verified to fail without the fix**, by temporarily reverting the change and re-running — not by inspection:

- Removing `discoveredStrands.set(...)` from `handleStrandAdded` fails cadre-core arms 1 and 3 (`expected [] to deeply equal [ 'late-…' ]`). Arm 2 still passes, correctly — it guards the prereq's party-isolation property, not this change.
- Removing the drain loop and the `joining` guard from `use-cadre.ts` fails exactly the two new RN tests that target them.

**The cadre-core regression arms** live in `packages/cadre-core/test/discovered-strands-late-subscriber.spec.ts` and cost about 900 ms in total:

- *The restart.* A real node founds an open strand over a memoised storage provider and stops; a second node comes up on the same party and the same provider. The spec waits until the watcher's `knownStrands` holds the id — i.e. until the single `strand:discovered` has already fired with nothing listening — and only then subscribes and drains. It asserts no event reached the late listener, that the backlog holds exactly that strand, that `addStrand` on the backlog row brings it up `active`, and that the claimed strand then leaves the backlog. Do not hoist the subscription above `waitForOffered`; that is what makes the arm mean anything.
- *Party isolation.* One storage provider, two party ids, with the scopes it is asked for recorded. Party A founds a strand and stops; a node on party B over the same provider discovers nothing, runs nothing, and its watcher sees no rows — while the recording proves both parties really shared one provider at two different `controlStorageScope` keys, so the arm cannot pass vacuously on two providers that never met.
- *The bare reproduction.* A real `StrandWatcher` over a fake queryable driving the real `handleStrandAdded`, no libp2p and no database, 1 ms. Two further forced polls after subscribing show the watcher will not re-offer a known strand — which is precisely why the event alone cannot rescue a late subscriber.

**The RN arms** are in the `useCadreInternal — discovered-strand backlog` describe block: the drain joins an open strand that was in the backlog at mount; a closed strand in the backlog is left alone; a `strand:discovered` re-offering a strand whose join is still in flight produces one `joinChatStrand` call, not two; and an ordinary mid-session discovery still joins, proving the subscribe-before-drain order did not break the event path.

## Known gaps — please weigh these

**No device check was performed.** No phone was available in this session, so the ticket's device scenario (create a strand, send a message, force-stop, relaunch into the same party id, confirm the strand and its history return) is unverified against the fix, and the 2157 ms figure from the hand-forced re-attach has no post-fix counterpart. The in-process arm 1 exercises the same sequence against a real `CadreNode`, but it is not a device.

**The ticket's note that "the React Native app has no lifecycle tests at all" is out of date.** `packages/reference-app-rn/test/react/use-cadre.spec.ts` exists and mounts the real hook with `react-test-renderer`. Eight of its tests failed the moment the drain landed, because its `MockNode` had no `getDiscoveredStrands` — that is how the staleness surfaced. The mock was extended (a seedable `discovered` map, a snapshot-returning accessor, and an `emit` that carries the event payload) and the four tests above were added to it, so the drain and the in-flight guard *are* covered app-side after all. `backlog/debt-rn-cadre-phone-lifecycle-untested` may want re-reading in that light; it was not touched.

**The in-flight guard is per effect run, not per node.** A tripwire `NOTE:` is parked at the site in `use-cadre.ts`: the `Set` is correct only because this effect's deps are `[node, refreshStrands]` and `refreshStrands` is a stable `useCallback([])`, so a re-run implies a different node with its own backlog. If the effect ever gains a dep that changes under a live node, or the app mounts under React `StrictMode` (cleanup + re-run on the *same* node), a fresh set would let a second launch through and it should be hoisted to a `useRef`. `StrictMode` is not used in the app today — checked.

**`getDiscoveredStrands()` returns a copy; `getStrands()` returns the live map.** Deliberate and documented on the accessor (it matches `StrandWatcher.getKnownStrands()`), but it is an asymmetry in `CadreNode`'s read surface and worth an opinion.

**A closed strand stays in the backlog for the life of the session.** Nothing claims it and nothing evicts it short of its control row vanishing. That is intended — the map is bounded by the number of this party's strands this node does not run, which the prereq's party-scoped control storage keeps small — and the accessor's doc says so rather than adding a cap. Arm 2 is what notices if the party scoping ever regresses.

**`reference-app-web` and `reference-app-ns` were re-confirmed not to subscribe** to `strand:discovered` or call `getDiscoveredStrands()` — neither auto-joins discovered strands, so neither is affected by this change and neither was touched. (The `strand:discovered` hits under `reference-app-ns/platforms/.../bundle.js` are checked-in build artifacts containing cadre-core's own code, not app subscriptions.) Whether the NS chat app *should* gain the same drain is a separate question this ticket did not answer.

**`cadre-node.ts` grew** by one field, one accessor, four one-line deletes and their comments. It is already flagged oversized by `backlog/debt-cadre-node-single-file-size`; splitting it here was out of scope.

**Environment note, not a repo defect.** The first test run was refused by the stale-build guard: the sibling `../optimystic` workspace had `@optimystic/db-core` and `@optimystic/quereus-plugin-optimystic` dist older than their src. Both were rebuilt there before any test ran. No `tickets/.pre-existing-error.md` was written — no test failed; the guard simply did its job.

The full cadre-core run is at `tickets/.logs/discovered-strands-lost-to-late-subscriber.test.log`.
