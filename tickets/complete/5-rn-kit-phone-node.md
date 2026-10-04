description: The shared React Native kit now builds and runs a phone's cadre node, so phone apps start their node the prescribed way, with the reference app's start/stop rules and two fixes from sereus-chat, instead of each keeping its own drifting copy.
prereq: rn-kit-key-store
architecture: docs/reference-app-rn.md#phone-rn-app-configuration
files: packages/cadre-rn/src/phone-node/, packages/cadre-rn/test/phone-node/, packages/reference-app-rn/src/use-cadre.ts, packages/cadre-rn/test/global-setup.ts, packages/cadre-rn/package.json, packages/cadre-rn/README.md, packages/reference-app-rn/src/cadre-phone.ts, packages/reference-app-rn/src/noise-crypto-config.ts, packages/reference-app-rn/app/settings.tsx, packages/reference-app-rn/test/solo-founding.spec.ts, test-harness/fake-rn-leveldb.ts, knip.ts, yarn.lock, docs/reference-app-rn.md, docs/architecture.md
----
# Phone node (`@serfab/cadre-rn/phone-node`)

Second of the kit's bring-up tickets, after `rn-kit-key-store`. Three apps build a phone node outside
the reference app: sereus-chat, health and taleus. The two that copied chat's bring-up miss parts of
the host contract that the reference app gets right:
- no AppState handling;
- a start promise never cleared after success;
- `stop` not waiting for an in-flight start;
- un-awaited async calls inside fail-soft `try` blocks.

Since v1.10 the node installs its formation responder at start, and since v1.11 STUN comes from the
relays. That left the reference app's bring-up free of app-specific pieces apart from its names and
transports, which are now parameters.

The API was reviewed before implementation by the sereus-chat agent, which runs this bring-up on a
Galaxy S7 and an API 37 emulator. Its additions are in, marked "from chat" below.

## What landed

- **`createPhoneNode(platform)`** (`src/phone-node/node.ts`). It returns a `PhoneNode`:
  - `start`: single-flight, cleared in `finally`. It opens the four node-local stores party-scoped,
    builds and starts the node, runs owner genesis, and saves the start with `autoStart: true`. A
    failed start closes everything it opened and reports `status: failed`.
  - `stop`: waits for a start in flight, saves `autoStart: false`, and closes **every** database it
    opened (from chat).
  - `restart`: rebuilds without clearing `autoStart`.
  - `loadSavedStart`, plus `writtenBy` from `platform.dataVersion` (from chat, as data-format
    detection).
  - `on`: subscriptions re-applied to every rebuilt node (from chat).
  - `status` and `onStatus`, and `ownerPublicKey`.
  - Storage: one handle per database name, reused when the node died without a `stop`. A second
    phone node over the same storage prefix throws while the first is starting or running (from chat).
- **`PhoneNodePlatform`.** The app passes in the secure store, `rn-leveldb`'s constructors,
  transports (default WebSockets + circuit relay), Noise crypto, and storage names (defaults are the
  reference app's). It also takes:
  - `allowPrivateDial` (default `true`, from chat);
  - `ownerGenesisTimeoutMs` (default 60 s, from chat);
  - `dataVersion`;
  - `configure` for anything else.

  The subpath imports nothing native.
- **`buildPhoneNodeConfig` and `runOwnerGenesis`** (`src/phone-node/config.ts`) moved from the
  reference app's `phone-node-config.ts`, with two changes:
  - The demo's `requireSignedSchemas: false` left the kit; the reference app sets it through `configure`.
  - Owner genesis is bounded and returns `enrolled`, `failed` or `timed-out`, reported in `status`.
    A NOTE says the bound belongs in cadre-core.
- **The saved-start record** (`src/phone-node/options.ts`) moved from the reference app's
  `start-options.ts`. It is the same record (version 1, key `start-options`) plus `writtenBy`, so
  devices keep their saved start.
- **`attachStrandWhenWritable` and `retryAfterRestart`** (`src/phone-node/strands.ts`), from chat.
  The retry matches Optimystic's message text (`Failed to get super-majority`), since Optimystic
  throws a plain `Error`. A NOTE says to match on a typed error when one exists.
- **The reference app**:
  - `src/cadre-phone.ts` is now one `createPhoneNode` call plus the module's earlier functions over
    it, so `use-cadre.ts`, push wake and their mocked spec are unchanged.
  - `phone-node-config.ts` and `start-options.ts` are deleted. The app passes its storage names
    explicitly from `node-local-names.ts`, where a Node test pins them; `STORAGE_PREFIX` joined them.
  - The kit pins its own default names (`DEFAULT_PHONE_NODE_NAMES`, now including `savedStartKey`)
    for apps that rely on them.
  - `getPhoneNode()` now returns the node only once it is running (before, also while starting).
    Its callers already treat null as "start it", and `startPhoneNode` joins the start in flight.
- **Tests:**
  - The two moved specs are in `cadre-rn/test/phone-node/`.
  - New: `node.spec.ts` (16 cases, real `CadreNode`s under Node) and `strands.spec.ts`.
  - The rn-leveldb fake moved to `test-harness/` and gained `lockingFakeRNLevelDB`, which refuses to
    open a name already open, as the native module does. So a leaked handle fails the specs.
  - The kit's stale-build guard now lists cadre-core and db-p2p-storage-rn.
- **`debt-rn-cadre-phone-lifecycle-untested` is removed**, because `node.spec.ts` covers its rules:
  - a refused secure-store read fails the start;
  - re-entering start after the node died opens no second handle;
  - stop closes the databases even when the node's stop throws;
  - overlapping starts build one node;
  - stop waits for an in-flight start;
  - only a successful start saves, and stop saves `autoStart: false`.

  Its rule that the identity must be resolved before the relay-credential fetch went away with that
  fetch in v1.11.
- **Docs:** the kit README has a "Phone node" section. `docs/reference-app-rn.md`,
  `docs/architecture.md` (which still described the removed ICE-manifest fetch) and two tickets point
  at the kit.

## Verification

Checked on master at v1.11.0, rebased on `rn-kit-key-store`, with optimystic v1.9.0 and quereus
v4.20.0 linked:
- `cadre-rn`: `typecheck` clean, 141 tests pass (11 files).
- `reference-app-rn`: `typecheck` clean, 181 tests pass. The 12 moved to the kit are no longer counted here.
- Repo-wide:
  - `yarn lint` exit 0;
  - `check:dep-ranges`, both typecheck-coverage checks and the stale-build-guard wiring check pass;
  - knip reports nothing new.

**Not run:** an Expo device build of the reference app.

## Decisions

- **Owner genesis stays on.** `requestJoin` needs an enrolled owner, and no known app must avoid
  self-enrolling.
- **WebRTC is not in the default transports,** so an app without `react-native-webrtc` works.
- **A second live phone node over the same storage names throws.** A stopped or failed one is
  replaced, which a development reload needs.
- **Data compatibility is reported, not judged.** The app names its `dataVersion` and compares
  `writtenBy`. A storage-format version exported by cadre-core would let the kit judge; that would be
  a cadre-core ticket.

## Follow-ups

- `feat-rn-kit-lifecycle`: the background runner, next.
- `feat-rn-kit-native-digest` and `feat-rn-kit-loop-lag-monitor`: from the same review.
- sereus-chat and health can move onto `createPhoneNode`; that is their maintainers' change.

## Review findings

Reviewed the implement work as it landed (`feat(cadre-rn): share the phone-node bring-up`, merged in PR #30; the runner's `ticket(implement): rn-kit-phone-node` commit does not exist because the work came in through that PR), read against the current tree, which also carries the lifecycle runner from PR #31.

**Fixed in this pass:**

- **A start during a stop or restart built on closed databases (defect, fixed).** `start()` only checked for a start in flight, never a stop. Called while `stop()` was saving `autoStart: false`, it was handed the node about to be stopped. Called during the teardown, it built a new node on the open-handle map, whose handles the teardown's `finally` then closed, and the teardown then set the status to `stopped` over the new start. `restart()` had the same window. The pre-kit `cadre-phone.ts` carried a NOTE saying to make start wait for an in-flight stop once a new unattended caller appeared. That condition has now tripped: the kit's `phoneNodeLifecycle` cold start calls `start` on a foreground return, and other apps will call it too. Fix in `packages/cadre-rn/src/phone-node/node.ts`: start, stop and restart now run one at a time, in call order, on a queue of promises (`inTurn`). A start called after a stop runs after it rather than joining the start that stop ends. `restart` is one queued step that later `start` calls join.
- **`loadSavedStart` during a stop read the value being replaced (defect, fixed).** The lifecycle cold start reads the saved start when it finds no node, and mid-stop it finds no node. `loadSavedStart` now waits for a pending stop, so it reads `autoStart: false`.
- **`PhoneNode.node` returned the node being stopped during teardown.** It read the status, which stays `running` until teardown ends. It now reads `null` from the moment teardown begins, which is what `use-cadre.ts`'s stop comment already assumed.
- Two tests added to `test/phone-node/node.spec.ts`, one for each defect. Both failed before the fix and pass after it.
- Updated the docs and comments that described the race: the `PhoneNode` interface docs, the kit README's member table, `docs/reference-app-rn.md` → "Overlapping starts", the `stopPhoneNode` NOTE in `cadre-phone.ts`, and the stop comment in `use-cadre.ts`.

**Tripwires recorded:**

- `stop()` after a failed start leaves an earlier `autoStart: true` saved. The reference app offers Disconnect only while connected, so nothing reaches this today. Parked as a NOTE in `stopAndClearAutoStart` (`node.ts`).
- A push wake that read `autoStart: true` before a Disconnect began can still start the node after it. The read and the start are separate calls, so closing this would need the kit's start to re-check `autoStart` itself. Parked in the existing NOTE on `stopPhoneNode` (`cadre-phone.ts`), reworded.

**Checked, nothing to change:**

- Resource cleanup: a failed start closes what it opened, stop closes every handle even when the node's own stop throws, and the locking rn-leveldb fake pins this.
- Error handling: the saved-start write and status listeners are best-effort and logged, and the start's own error wins over a cleanup error.
- Owner-genesis bound: the timer is cleared, and a genesis that runs past the bound still logs its later failure. The NOTE that the bound belongs in cadre-core is correct.
- Type safety: no `any`. The one cast in `parseRecord` follows an object check.
- The rest of the diff:
  - `options.ts` and `config.ts` were moved unchanged apart from the documented `requireSignedSchemas` and `writtenBy` changes.
  - `strands.ts` matches Optimystic's message text and carries a NOTE about it.
  - The stale-build-guard list gained cadre-core and db-p2p-storage-rn.
  - The `docs/architecture.md` edits are accurate.
- Tests: the moved specs and the new `strands.spec.ts` cover branching logic. The kit's default-names test pins a persistence contract (renaming a default orphans installed phones' data), so it was kept although it reads like a constant test. No tests were cut.
- File size: `node.ts` is 472 lines (`wc -l`). It is one class with sectioned private methods and has no split candidate.
- Small duplication in `test-harness/fake-rn-leveldb.ts`: the locking opener repeats the plain opener's lookup by name, about 6 lines. Not worth a shared helper.

**Validation:** `yarn workspace @serfab/cadre-rn typecheck` is clean. `yarn workspace @serfab/cadre-rn test` passes 141 tests in 13 files, a count that includes PR #31's lifecycle specs. `yarn workspace @serfab/cadre-rn build` was run, then `yarn workspace @serfab/reference-app-rn typecheck` (clean) and `test`, which passes 168 tests; the drop from the handoff's 181 is the specs PR #31 moved into the kit. `yarn lint` exits 0. Still not run: an Expo device build.
