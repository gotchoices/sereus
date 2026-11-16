# @serfab/reference-app-ns

A NativeScript Core chat app (TypeScript and XML, no UI framework) that runs a cadre node on NativeScript's V8 runtime, on Android. It exists to show that cadre-core, db-p2p, Quereus and libp2p bundle and run there; the screens are deliberately plain.

The reusable part, for a developer embedding a node in their own NativeScript app, is documented in [Running a node in a NativeScript app](../../docs/platforms/nativescript.md). [The reference apps](../../docs/platforms/reference-apps.md) compares this app with the React Native and browser ones.

## What it demonstrates

- cadre-core's edge node (`createEdgeNode`) over SQLite: `src/ns-edge-platform.ts`.
- The globals NativeScript lacks, each shimmed in `src/polyfills/`, with an audit logged at every launch.
- A webpack configuration that bundles the stack without TCP and without Node's `crypto`: `webpack.config.js`, `browser-map.js`.
- A phone that founds a cadre on its own, creates an open chat strand on that phone and reads and writes it with SQL.
- A phone that connects to an always-on node, applies a seed, or joins another cadre with a machine invitation.

## Prerequisites

- The repository installed and built: `yarn install` then `yarn build` at the root. The root `package.json` links `@optimystic/*` and `@quereus/quereus` to the sibling checkouts `../optimystic` and `../quereus`, which must be present and built.
- The NativeScript CLI (`ns`), the Android SDK, and a running Android emulator or a connected device. The SQLite and WebSocket plugins are native, so nothing runs without one.
- For `test:e2e` only: `adb` and the [Maestro CLI](https://maestro.mobile.dev/getting-started/installing-maestro) on `PATH`.

## Run

```bash
yarn workspace @serfab/reference-app-ns android   # ns run android
```

1. Read the device log. The polyfill audit prints one line per global; none should be marked `✗`.
2. Open **Settings** from the Chat screen's action bar. Leave **Party ID** blank and tap **Connect**. The node starts alone, founds a party with a generated id, and the screen shows **Connected** and the node's **Peer ID**.
3. Tap **Create Chat Strand**. A dialog titled "Strand created" appears.
4. Go back to **Chat**, type a message and tap **Send**. The message appears in the list.
5. Close and reopen the app. It reconnects to the same party without a tap and shows the same Peer ID. The strand from step 3 is not reopened, because the app neither publishes it nor records its id ([How it differs from the React Native app](#how-it-differs-from-the-react-native-app)).

To connect to an always-on node instead, enter that node's party id and its WebSocket bootstrap address before **Connect**. Use a `/wss` address: the app's manifest does not permit cleartext traffic, so Android is expected to refuse a `/ws` one ([Troubleshooting](#troubleshooting)). [Two-node startup](../../docs/contributing/device-testing.md#two-node-startup) has the procedure for starting the node and building the address.

## Screens

The app is one navigation stack, not tabs: Chat is the first page and **Settings** is an action in its title bar.

- **Chat** shows a status line, the messages of one strand and a composer. It polls the strand every 2 seconds. A message that no other member holds yet is marked "Not yet delivered" ([Messages not yet delivered](../../docs/platforms/reference-apps.md#messages-not-yet-delivered)).
- **Settings → Node** takes a party id, bootstrap addresses and relay addresses (comma-separated) and has **Connect** and **Disconnect**. A blank party id is replaced by a generated one. The app saves the options of a successful start and restarts with them at the next launch; **Disconnect** turns that off.
- **Settings → Add Peer** dials a multiaddr from the control node.
- **Settings → Seed Bootstrap** applies a pasted control network seed. The node accepts a seed only from an owner it already trusts, so this works on a phone that founded the cadre or joined it by that owner's invitation ([Seed trust policies](../../docs/cadre/control-security.md#seed-trust-policies)).
- **Settings → Join a Cadre** redeems a pasted cadre invitation with `EdgeNode.joinCadre`. The phone moves to the invitation's party and keeps its identity; a failed join returns it to the party it left ([An app joins an existing cadre](../../docs/cadre/apps.md#an-app-joins-an-existing-cadre)).
- **Settings → Strands** lists the running strands and has **Create Chat Strand**.

The sections after Node are shown only while the node is connected.

## How it differs from the React Native app

- **The join field takes a machine invitation only.** A pasted owner grant is refused as unreadable. A phone whose own cadre holds something to move is refused the join (`StrandsNeedOwnerJoinError`) and has no other way in. (ticket `feat-reference-app-ns-owner-grant-join`)
- **A created strand is not published.** `createChatStrand` calls `CadreNode.addStrand` with `founder: true`, which starts the strand on this phone and writes no `Strand` row to the control database. The React Native app calls `foundStrand`, which publishes the row so the party's other machines open the strand.
- **A created strand is not reopened after a restart.** Nothing records its id: the node restarts the strands the control database lists, and this one is not listed. Its data stays in its SQLite file, and **Create Chat Strand** makes a new, empty strand.
- **Strands that other machines publish are not opened.** The app has no handler for `strand:discovered`.
- **Chat shows whichever strand the node lists first.** There is no strand picker and the choice is not stable when the node runs several.
- **The chat schema is unsigned.** `src/ns-edge-platform.ts` sets `requireSignedSchemas: false` so the demonstration schema loads. A production app signs its schema.
- **No offline mode, no owner-key, device-list or dissolve screens, and no first-launch question.** (ticket `feat-strand-offline-mode-nativescript` for offline mode)

The chat schema is `CHAT_SCHEMA` in `src/chat-strand.ts`; `test/chat-schema-drift.spec.ts` holds it equal to `schemas/chat-simple.qsql`. Raise `CHAT_SCHEMA_VERSION` with every change to it, because a strand refuses an app whose schema version is below the highest it has seen ([App schema versions across a strand's members](../../docs/strands/app-schema.md#app-schema-versions-across-a-strands-members)).

## Layout

```
app/
  app.ts               entry: polyfills, audit, Application.run
  app-root.xml         one Frame; Chat is the default page
  chat/                Chat page
  settings/            Settings page and its view model
src/
  polyfills/           runtime globals, Node module shims, the audit
  shims/               replacements for libp2p's user-agent module and libp2p-noise's crypto
  ns-edge-platform.ts  key store and storage over SQLite
  ns-db-path.ts        database path on Android
  cadre-phone.ts       the app's one edge node
  cadre-vm.ts          view model over the edge node: status, strands, join, seed
  chat-vm.ts           view model for Chat: poll, send, participant registration
  chat-strand.ts       chat schema and strand creation
  chat-operations.ts   SQL for participants and messages
  join-failure.ts      wording for each way a join can fail
  solo-smoke.ts        start alone, create a strand, write and read one message (no UI)
  test-ids.ts          automation ids used by the pages and the Maestro flows
webpack.config.js      resolver rules (see the platform document)
browser-map.js         packages whose `browser` file map is applied
```

## Scripts

Run each as `yarn workspace @serfab/reference-app-ns <script>`.

| Script | What it does | Needs a device |
|---|---|---|
| `android` | `ns run android`: build, install and run | yes |
| `ios` | `ns run ios`; the package declares no iOS runtime, see [Limits](../../docs/platforms/nativescript.md#limits-and-accepted-tradeoffs) | yes |
| `typecheck` | `tsc --noEmit` | no |
| `test` | the Vitest unit suite | no |
| `dev:test` | Vitest in watch mode | no |
| `test:bundle` | webpack compile of the whole import graph, no native build | no |
| `test:bundle:native` | `ns prepare android`: the same compile plus the Gradle build | Android SDK |
| `test:e2e` | Maestro flows against an installed app | yes |
| `clean` | removes `platforms/` and `hooks/` | no |

## Environment variables

Only `test:e2e` (`scripts/run-e2e.mjs`) reads any, and all are optional.

| Variable | Default | Meaning |
|---|---|---|
| `DRONE_WS_PORT` | `4002` | WebSocket port of the test drone |
| `DRONE_HTTP_PORT` | `4080` | port of the drone's HTTP sidecar |
| `MAESTRO_APP_ID` | `org.gotchoices.sereus.chat.ns` | application id Maestro launches; matches `nativescript.config.ts` |
| `MAESTRO_BIN` | `maestro` | Maestro executable |

## Tests

- **Unit** (`test`). Vitest under Node over `test/**/*.spec.ts`: the SQLite platform under the real edge node, with `node:sqlite` standing in for the plugin; the view models, with `@nativescript/core` aliased to `test/stubs/nativescript-core.ts`; and the polyfills whose failures would otherwise show only on a phone. The pages are not covered. The run starts with the [stale-build guard](../../docs/contributing/gates.md#stale-build-guard), because the specs execute compiled output of cadre-core and the linked sibling packages.
- **Bundle** (`test:bundle`). `scripts/bundle-check.js` runs the webpack compile for Android and fails on any error, any warning, or any bundled file that the browser rewrite should have replaced. It proves the import graph resolves and parses. It does not run the code.
- **Device** (`test:e2e`). See [maestro/README.md](maestro/README.md). Three of the four flows cannot pass against this app; its [Limits](maestro/README.md#limits) section says why.

## Diagnostics

- **Polyfill audit.** Logged at launch by `src/polyfills/audit.ts`: `✓` native, `∙` polyfilled, `✗` missing, followed by a warning that lists the missing globals.
- **`runSoloSmoke`** (`src/solo-smoke.ts`). Starts the node alone, creates a strand, inserts a message and reads it back, and returns the peer id and whether the message was read. Call it from a debugger or a temporary button; no screen uses it. Like any start, it replaces the saved start.
- **Dialogs.** A failed connect, seed, join or dial shows the error's text in a dialog; a failed join is reworded by `src/join-failure.ts`.

## Troubleshooting

- **A global is marked `✗` in the audit.** A NativeScript upgrade stopped providing it, or a shim's guard no longer matches. Fix the shim in `src/polyfills/` before looking at libp2p errors.
- **`Cannot read properties of undefined (reading 'env')` at load.** A module ran before `src/polyfills/process.ts`. The polyfill import must be the first line of `app/app.ts`.
- **Every outbound dial times out although the socket opens.** `WebSocket.prototype.bufferedAmount` is undefined; check the audit line for it.
- **A `/ws` address cannot be dialled on Android but a `/wss` one can.** Android is blocking cleartext traffic. `App_Resources/Android/src/main/AndroidManifest.xml` does not set `android:usesCleartextTraffic`, and the app targets an API level where the default is to refuse ([What the app must provide](../../docs/platforms/nativescript.md#what-the-app-must-provide)).
- **`test` stops before running any spec.** The stale-build guard found a `dist` older than its `src`. Rebuild the package it names.
- **`test:bundle` fails on a warning.** A dependency imports a name that the resolved version does not export. See [`exportsPresence: 'warn'`](../../docs/platforms/nativescript.md#exportspresence-warn).

## Links

- [Running a node in a NativeScript app](../../docs/platforms/nativescript.md)
- [The reference apps](../../docs/platforms/reference-apps.md)
- [Device testing](../../docs/contributing/device-testing.md)
- [The cadre node](../../docs/cadre/node.md)
