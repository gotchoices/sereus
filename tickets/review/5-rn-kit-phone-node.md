description: The shared React Native kit now builds and runs a phone's cadre node, so phone apps start their node the prescribed way, with the reference app's start/stop rules and two fixes from sereus-chat, instead of each keeping its own drifting copy.
prereq: rn-kit-key-store
architecture: docs/reference-app-rn.md#phone-rn-app-configuration
files: packages/cadre-rn/src/phone-node/, packages/cadre-rn/test/phone-node/, packages/cadre-rn/test/global-setup.ts, packages/cadre-rn/package.json, packages/cadre-rn/README.md, packages/reference-app-rn/src/cadre-phone.ts, packages/reference-app-rn/src/noise-crypto-config.ts, packages/reference-app-rn/app/settings.tsx, packages/reference-app-rn/test/solo-founding.spec.ts, test-harness/fake-rn-leveldb.ts, knip.ts, yarn.lock, docs/reference-app-rn.md, docs/architecture.md
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
