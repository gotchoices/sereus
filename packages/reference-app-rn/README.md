# Sereus P2P Chat: React Native reference app

A chat app for Android and iOS that runs a Sereus cadre node on the phone, built with Expo and [`@serfab/cadre-rn`](../cadre-rn/README.md). It is the sample to copy from when building a phone app on Sereus, and the app the device procedures in this repo are run against.

## What it demonstrates

- **A node on the phone.** One `transaction`-profile node, started by the kit's `createPhoneNode` in `src/cadre-phone.ts`, with LevelDB storage, keys in the platform secure store, WebSocket, circuit-relay and WebRTC transports, and native Noise encryption.
- **Chat over a strand.** Founding an open strand, attaching strands that other machines of the cadre founded, reading and writing the chat tables with SQL, and marking messages no other member holds yet.
- **A closed strand between two parties.** Making a formation invitation and joining by one.
- **Cadre management.** Joining an existing cadre, adding a device or app, listing and removing machines, owner keys and owner grants, claiming a cadre-host node by its code, and renting a node from a provider.
- **Background start.** Starting again unattended from the saved start, and waking on a push notification.

[The reference apps](../../docs/platforms/reference-apps.md) describes each screen, the call it makes and the reason for its design. [Running a node in a React Native app](../../docs/platforms/react-native.md) covers what any React Native app needs: polyfills, Metro configuration, transports, storage and native rebuilds.

## Prerequisites

- Node.js 20.19 or later, and Yarn 4 through Corepack (the repo pins `yarn@4.12.0`).
- For a local native build: the Android SDK, or Xcode on macOS. A cloud build with EAS needs neither.
- Three sibling checkouts beside `sereus`, each installed and built:

	```
	projects/
	├── sereus/       this repo
	├── optimystic/
	├── quereus/
	└── Fret/
	```

	The root `package.json` links the `@optimystic/*` and `@quereus/quereus` packages from `../optimystic` and `../quereus`, and Optimystic links `p2p-fret` from `../Fret`. `metro.config.js` names all three as linked roots, so Metro can follow those links. Without `../Fret` a local bundle fails with "Unable to resolve module p2p-fret".

- An EAS build does not use the sibling checkouts: `scripts/eas-build-pre-install.sh` removes the links before install, and the packages come from npm.

## Run

From the repo root:

```bash
yarn install
yarn build
```

Build and install a development client. It contains the native modules; JavaScript then loads from Metro, so most changes need no rebuild ([When a native rebuild is needed](../../docs/platforms/react-native.md#when-a-native-rebuild-is-needed)).

```bash
cd packages/reference-app-rn
yarn android                                                # local build; or: yarn ios
npx eas build --profile development --platform android      # or a cloud build with EAS
```

On Windows, a local Android build needs `JAVA_HOME`, for example `$env:JAVA_HOME = "C:\Program Files\Android\Android Studio\jbr"`.

Start Metro, and on Android forward its port to the device:

```bash
yarn start
adb reverse tcp:8081 tcp:8081
```

### First run

1. Open **Settings**. The app asks "Do you already use Sereus apps?"; tap **No, start fresh**.
2. Leave **Party ID** and **Bootstrap addr** empty and tap **Connect**. The Node card shows Status "Connected", a generated party id and the phone's peer id.
3. Tap **Create Chat Strand**. A "Strand created" result appears.
4. Switch to **Chat**, type a message and send it. It appears in the list marked "Not yet delivered", because no other member of the strand holds a copy yet.

The app saves what it connected with and reconnects by itself on the next launch, unless **Disconnect** was tapped.

### With a drone

`drone.cadre.yaml` in this package is a `@serfab/cadre-cli` configuration for an always-on node the phone can dial: party id `reference-chat-party`, the `storage` profile, `strandFilter: all`, and a WebSocket listener on port 4002. In [Device testing → Two-node startup](../../docs/contributing/device-testing.md#two-node-startup) the drone founds the cadre with `cadre start --owner` and the phone joins it with an owner grant under **Join my existing cadre**. Typing the drone's party id and address under **Connect** founds a separate cadre on the phone and does not make the drone a member. The [cadre-cli README](../cadre-cli/README.md) covers running a drone as a service.

To invite another party into a closed strand, the phone needs a relay: a React Native app cannot accept connections, so its only dialable address is one a relay forwards. Enter a relay's multiaddr under **Relay** before Connect, or build with `EXPO_PUBLIC_RELAY_ADDR`. Joining someone else's invitation needs no relay.

## Scripts

| Script | What it does |
|---|---|
| `yarn start` | Starts Metro for the development client (`expo start --dev-client`). |
| `yarn start:frozen` | The same with file watching off, so no write in the repo reaches the phone during a device run. |
| `yarn metro:observe` | Prints each Metro update that changes code on the phone. Options: `--port`, `--host`, `--platform`, `--bundle-url`. |
| `yarn android`, `yarn ios` | Builds the native app locally and runs it. |
| `yarn build:dev`, `yarn build:preview` | EAS cloud builds with the `development` and `preview` profiles of `eas.json`. |
| `yarn typecheck` | `tsc --noEmit`. |
| `yarn test` | The headless test projects (see [Tests](#tests)). |
| `yarn test:bundle` | Exports the Android bundle with Metro and discards it: a check that the whole import graph resolves. |
| `yarn test:e2e` | Runs the Maestro flows against a local drone fixture. |

[Device testing → Device test runs](../../docs/contributing/device-testing.md#device-test-runs) explains when to use `start:frozen` and how to read `metro:observe`.

## Environment variables

Expo inlines `EXPO_PUBLIC_` variables into the bundle when Metro builds it, so set them where `yarn start` or the build runs.

| Variable | Default | Effect |
|---|---|---|
| `EXPO_PUBLIC_RELAY_ADDR` | none | Relay multiaddrs, comma-separated, that the node reserves on. Prefills the **Relay** field; a saved start's list takes precedence. |
| `EXPO_PUBLIC_STUN_URLS` | derived from the relays | STUN server URLs for WebRTC, comma-separated. Unset, each relay's host is used. |
| `EXPO_PUBLIC_NOISE_CRYPTO` | `symmetric` | Connection encryption implementation: `symmetric`, `full` or `off`. Any other value stops the app at start with a message naming the three. |
| `EXPO_PUBLIC_PROVIDER_DESCRIPTOR_URL` | none | A hosting provider's descriptor URL. Unset, **Rent an always-on node** is not shown. |
| `EXPO_PUBLIC_PROVIDER_CLIENT_ID` | `sereus-chat` | The OAuth client id this app is registered under at that provider. |
| `APP_VARIANT` | none | `second` builds the second install (next section). Read by `app.config.ts`. |

`yarn test:e2e` reads `DRONE_WS_PORT` (4002), `DRONE_HTTP_PORT` (4080), `MAESTRO_APP_ID` (`org.gotchoices.sereus.chat`) and `MAESTRO_BIN` (`maestro`).

## A second install on one phone

**Settings → Join my existing cadre → Choose the app that holds your cadre** opens another Sereus app on the same phone, so trying it needs two. `APP_VARIANT=second` builds this app as a separate one: name "Sereus P2P Chat (second)", URL scheme `sereus-chat-second`, package and bundle id ending in `.second`, with its own identity and storage.

```bash
# Cloud build (eas.json profile development-second)
npx eas build --profile development-second --platform android   # or ios

# Or locally. Prebuild rewrites android/ for the variant, so run it again
# without APP_VARIANT before building the main app.
APP_VARIANT=second npx expo prebuild --clean --platform android
APP_VARIANT=second npx expo run:android
```

In PowerShell, set the variable with `$env:APP_VARIANT = "second"`.

The second install needs a dev server of its own, started with the same variable on another port:

```bash
APP_VARIANT=second yarn start --port 8082
adb reverse tcp:8082 tcp:8082
```

A development build takes its name, scheme and `extra` from the dev server, not from the build. Served by the main app's dev server, the second install would present the main app's scheme, and answers meant for it would go to the main app, which refuses them. Both installs share the dev client's `exp+sereus-p2p-chat` scheme, so open the second one from its own icon or with `sereus-chat-second://expo-development-client/?url=http%3A%2F%2Flocalhost%3A8082`.

## Tests

`yarn test` runs four Vitest projects under plain Node (`vitest.config.ts`); none loads React Native:

| Project | Covers |
|---|---|
| `node` | The modules that hold rules and wording without React or native imports, and solo strand founding over a fake of the LevelDB native module. |
| `react` | The `useCadre` and `useChat` hooks under `react-test-renderer`, with the node mocked. |
| `metro-babel` | Probes compiled with the app's own Metro Babel transformer, for defects that exist only in the bundle Hermes runs. |
| `polyfills` | The globals this app's installed dependencies read, checked against the kit's polyfills. |

The `node` project executes other packages' compiled output, so it fails at setup when cadre-core or a linked sibling's `dist` is older than its source ([Stale-build guard](../../docs/contributing/gates.md#stale-build-guard)). Run `yarn build` at the root first.

`yarn test:e2e` needs an Android emulator running with the development client installed, `adb` on the PATH, and the [Maestro CLI](https://maestro.mobile.dev/getting-started/installing-maestro). It writes the fixture's log to `maestro/.fixture.log`, a JUnit report to `maestro/.maestro-junit.xml` and the fixture's data to `test-fixture/test-data.json`; all three are ignored by git. [Device testing → Maestro flows](../../docs/contributing/device-testing.md#maestro-flows) describes the fixture, each flow and what a failed run means.

## Layout

| Path | Contents |
|---|---|
| `index.js` | The entry file: the kit's polyfill imports in their required order, then Expo Router, then the background wake task. |
| `app/` | Expo Router screens: `index.tsx` (Chat), `settings.tsx` (Settings), `_layout.tsx` (tabs), `+native-intent.tsx` (rewrites incoming links before routing). |
| `src/cadre-phone.ts` | The app's one phone node and the functions the rest of the app calls on it. |
| `src/use-cadre.ts`, `src/use-chat.ts` | The hooks behind the two screens. |
| `src/chat-strand.ts`, `src/chat-operations.ts` | The chat schema (`CHAT_SCHEMA`), strand founding and joining, and the SQL helpers. |
| `src/*-section.tsx` | One Settings section each. |
| `app.json`, `app.config.ts` | The Expo config; `app.config.ts` adds the kit's config plugin and the second install. |
| `metro.config.js` | `withCadreMetro` from `@serfab/cadre-rn/metro` plus the linked sibling roots. |
| `drone.cadre.yaml` | A cadre-cli configuration for a local drone. |
| `maestro/`, `test-fixture/`, `scripts/run-e2e.mjs` | The Maestro flows, the drone fixture they run against, and the orchestrator. |

A change to `CHAT_SCHEMA` must also be made in `schemas/chat-simple.qsql` and the other reference apps' copies, and must raise `CHAT_SCHEMA_VERSION`.

## What the app stores

- **Platform secure store** (`expo-secure-store`): the node's identity key, the owner key, the records of strands joined from other parties, the trusted-owner anchor, and provider sign-in tokens.
- **LevelDB, app-private:** one database per storage scope, named `sereus-<scope>` (the control database's scope includes the party id; each strand has its own), and `sereus-node-local` for the saved start and the other node-local records.

Clearing the app's data or uninstalling it removes the LevelDB databases. On iOS the Keychain survives a reinstall, so the identity key does too. [Where node state is kept](../../docs/platforms/react-native.md#where-node-state-is-kept) lists every record.

## Troubleshooting

- **Status stays "connecting", or a join keeps waiting for a machine to answer.** Check that the drone is running and that the phone can reach the drone's address on port 4002. Use the machine's LAN address, not `127.0.0.1`, from a separate device.
- **No messages from the other node.** Both nodes must be in the same party and run the same strand. The chat re-reads the strand every two seconds; look in the Metro console for strand errors.
- **"Unable to resolve module …" from Metro.** Run `yarn install` at the repo root, and check that the three sibling checkouts exist and are built.
- **"Property 'X' doesn't exist" or "X is not a function" at startup.** Hermes lacks a global that a dependency reads. `index.js` must import `@serfab/cadre-rn/polyfills` before any library code; then restart Metro with `yarn start --clear`. See [Polyfills](../../docs/platforms/react-native.md#polyfills).
- **"Cannot find native module …" or a missing Nitro module.** The development client was built before a native dependency was added. Rebuild it.
- **The app reloads during a test.** See [Device testing → Why it reloaded](../../docs/contributing/device-testing.md#why-it-reloaded).
- **"There was a problem loading the project" on first launch.** Metro had not built the bundle yet; see [First launch on a cold Metro](../../docs/contributing/device-testing.md#first-launch-on-a-cold-metro).

## Links

- [The reference apps](../../docs/platforms/reference-apps.md): the screens, the calls behind them, and how this app differs from the browser and NativeScript samples.
- [Running a node in a React Native app](../../docs/platforms/react-native.md) and the [`@serfab/cadre-rn` README](../cadre-rn/README.md).
- [Device testing](../../docs/contributing/device-testing.md): drone startup, Maestro, Metro during a run, cadre-host and provider setups.
- [Concepts](../../docs/concepts.md) and the [architecture overview](../../docs/architecture.md).
