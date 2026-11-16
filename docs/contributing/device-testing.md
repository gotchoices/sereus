# Device testing

Procedures for running the reference apps on a phone or an emulator: starting a drone and connecting a phone to it, the Maestro flows, keeping Metro from reloading the app during a run, finding out why it reloaded, installing the app twice on one phone, adding a cadre-host node, renting from a local provider, and tracing a strand founding. It is for maintainers and agents who need a result from a real device.

Related: [The reference apps](../platforms/reference-apps.md) · [Running a node in a React Native app](../platforms/react-native.md) · [in a NativeScript app](../platforms/nativescript.md) · [Testing](testing.md) · [`packages/reference-app-rn/README.md`](../../packages/reference-app-rn/README.md)

Nothing here runs in CI. The headless suites (`yarn workspace @serfab/reference-app-rn test`, the integration tests) run library code as published; they cannot show a fault that exists only in Metro's Babel-compiled bundle, on Hermes, or across a real Wi-Fi network.

## Two-node startup

This starts a drone with `@serfab/cadre-cli` that founds a cadre, and joins one phone to that cadre as a machine and an owner. The phone dials the drone, so the drone must be reachable from the phone ([Which side dials](../cadre/membership.md#which-side-dials)).

The drone founds the cadre, and the phone joins with an owner grant, because a machine is a member only once an owner has admitted it ([The cold start problem](../cadre/membership.md#the-cold-start-problem)). The grant admits the phone and makes its key an owner, which founding a strand needs. The Maestro fixture sets up the same arrangement ([The shared setup](#the-shared-setup)).

**Before you start:** `yarn install` at the repo root, `yarn workspace @serfab/cadre-cli build`, and a development build of the app installed on the phone or emulator ([README](../../packages/reference-app-rn/README.md)).

**1. Start the drone** from a working directory outside the repo. The drone writes its identity key, its owner key, its node-local records and its block stores there.

```bash
mkdir drone && cd drone
cp <repo>/packages/reference-app-rn/drone.cadre.yaml .
node <repo>/packages/cadre-cli/dist/bin/cadre.js enroll create --name drone
CADRE_STARTUP_TOKEN=dev node <repo>/packages/cadre-cli/dist/bin/cadre.js start -c drone.cadre.yaml --identity-file drone.key --owner --admin-port 7070
```

`enroll create` is needed once: it writes the identity `drone.key`, without which the drone would have a new peer id at every start and `--owner` would be refused. `--owner` creates `owner.key` and founds the party with it. `--admin-port` opens the loopback channel the next step uses; `CADRE_STARTUP_TOKEN` is its password and may be any text. In PowerShell, set it with `$env:CADRE_STARTUP_TOKEN = "dev"` before each command.

`drone.cadre.yaml` sets party id `reference-chat-party`, the `storage` profile, `strandFilter: all`, a TCP listener on port 4001, a WebSocket listener on port 4002 and `enableRelay: true`. The phone can only dial WebSocket addresses, so port 4002 is the one it uses. The console prints:

```
✓ Connected to control network
  Party ID: reference-chat-party
  Peer ID:  12D3KooW...
✓ Admin channel on 127.0.0.1:7070
```

**2. Mint an owner grant** in a second terminal:

```bash
CADRE_STARTUP_TOKEN=dev node <repo>/packages/cadre-cli/dist/bin/cadre.js enroll owner-grant --admin-port 7070
```

The grant is the one line on stdout. It lasts 15 minutes and seats one key; `--ttl 1h` extends it. Stderr lists the member addresses the grant carries, which are the addresses the drone advertises. The phone must be able to reach one that ends in `/ws`:

| App runs on | Address that works | Setup |
|---|---|---|
| A phone on the same Wi-Fi | The machine's LAN address | The machine's firewall must allow the port ([The PC's firewall](#the-pcs-firewall)). |
| An Android emulator | `10.0.2.2`, the emulator's reserved address for the host | None. |
| A USB-attached Android device, or an emulator | `127.0.0.1` | `adb reverse tcp:4002 tcp:4002` first. The rule is lost when the device disconnects. |

If the list has no address that fits, add one to `network.appendAnnounceAddrs` in the config, such as `/ip4/10.0.2.2/tcp/4002/ws`, restart the drone and mint again. The same three choices apply to any other host port the app must reach, such as a relay run on the workstation or Metro's 8081. An Android release build dials a plain `/ws` address only with the kit's config plugin installed ([Transport and reachability](../platforms/react-native.md#transport-and-reachability)).

**3. Join from the phone.** Open the app and go to **Settings**. On a first launch the app asks "Do you already use Sereus apps?"; tap **Yes, join my cadre**. Under **Join my existing cadre**, paste the grant into the field and tap **Join**. When the app reports "This app is now part of your cadre, as an owner", tap **OK**. The Node card shows Status "Connected", party id `reference-chat-party` and the phone's peer id.

**4. Create a strand.** Tap **Create Chat Strand**. A "Strand created" result appears with the elapsed time. The drone starts every strand of its party as a storage replica and stores its blocks ([Strand filtering](../cadre/node.md#strand-filtering)).

**5. Chat.** Switch to **Chat**, type and send. The chat re-reads the strand every two seconds.

Variations:

- **Phone first.** A phone that already runs a cadre of its own adds an always-on node by claiming it, which needs no owner key on the server: [Adding a home machine's node](#adding-a-home-machines-node) for cadre-host, or `cadre init` and `cadre code` for cadre-cli ([cadre-cli README](../../packages/cadre-cli/README.md)).
- **A phone that already has a cadre** finds **Join my existing cadre** in Settings while connected. Joining with an owner grant moves the strands it founded into the drone's cadre ([Joining an existing cadre](../platforms/reference-apps.md#joining-an-existing-cadre)).
- **The app reconnects by itself.** It saves what it last started with and starts with it on the next launch, unless **Disconnect** was tapped.
- **NativeScript.** The app's join field takes a machine invitation (`cadre enroll invite`) and no owner grant. An invitation admits the app without an owner key. The app's **Create Chat Strand** also starts the strand on the phone alone and writes no `Strand` row ([Founding and joining chat strands](../platforms/reference-apps.md#founding-and-joining-chat-strands)), so the drone never opens a strand the NativeScript app creates (ticket `feat-reference-app-ns-owner-grant-join`).

Two ways in that do not work:

- **Typing the drone's party id and address under Connect does not join its cadre.** Connect starts the phone as the founder of the party it names, so the phone seats its own founding owner key. The drone then has no `CadrePeer` row, and it trusts no owner key it did not learn out of band ([The trusted-owner anchor](../cadre/control-security.md#the-trusted-owner-anchor)). Only an authorized member gets an answer to a strand-address request ([Strand-address resolution](../network/strand-addressing.md#strand-address-resolution)), so the phone's and the drone's strand nodes do not find each other and the drone stores no strand data. Two phones that both type one party id can each seat a founding owner key.
- **The Seed field is not a way in.** **Apply Seed** accepts a seed only when its signer's key is already in the phone's trusted-owner anchor ([Seed trust policies](../cadre/control-security.md#seed-trust-policies)), which is true for a cadre the phone founded or joined.

## Maestro flows

The Maestro flows drive the app's UI on an Android emulator against a drone fixture. Run them with:

```bash
yarn workspace @serfab/reference-app-rn test:e2e
```

Requirements: an Android emulator running with the development build installed, `adb` on the PATH, and the [Maestro CLI](https://maestro.mobile.dev/getting-started/installing-maestro) on the PATH (or `MAESTRO_BIN` set). `scripts/run-e2e.mjs` runs `adb reverse` only, so iOS is not wired up, though the flow files themselves name no platform.

### What the orchestrator does

`packages/reference-app-rn/scripts/run-e2e.mjs`:

1. Starts the fixture, `test-fixture/start.mjs`: a `CadreNode` with in-memory storage, the `storage` profile, `strandFilter: all`, a WebSocket listener on `127.0.0.1:4002`, and an HTTP sidecar on port 4080 that lets a test read and write the drone's strand databases.
2. Waits for `GET http://127.0.0.1:4080/health`.
3. Reads `test-fixture/test-data.json`, which the fixture writes: the id of a strand the fixture founded, an owner grant and a machine invitation, both valid for one hour and both naming the fixture's WebSocket listener as the member to dial.
4. Runs `adb reverse` for ports 4002 and 4080, so the emulator's `127.0.0.1` reaches the host.
5. Runs `maestro test` over `maestro/flows/`, passing `JOIN_CODE` (the owner grant), `STRAND_ID`, `SIDECAR_URL` and `MAESTRO_APP_ID`.
6. Stops the fixture and removes the `adb reverse` rules when Maestro exits.

`DRONE_WS_PORT`, `DRONE_HTTP_PORT`, `MAESTRO_APP_ID` and `MAESTRO_BIN` override the defaults. The fixture's log is written to `maestro/.fixture.log` and Maestro's JUnit report to `maestro/.maestro-junit.xml`.

### The shared setup

Flows 1 to 3 begin with `maestro/_setup.yaml`. It launches the app with cleared state and joins the fixture's cadre the way a new install of an existing user does, so the app never founds a cadre of its own:

1. Opens Settings and taps **Yes, join my cadre** on the first-launch question (`btn-first-launch-join`).
2. Types `JOIN_CODE` into the join field (`input-cadre-invitation`) and taps **Join** (`btn-join-cadre`).
3. Waits up to two minutes for the join to finish (`btn-join-flow-ok`) and checks the completion line.
4. Taps **Create Chat Strand** and checks the "Strand created" result. The phone can found a strand because the owner grant made its key an owner.
5. Runs `_helpers/discover-phone-strand.js`, which polls the sidecar's `/status` until the drone reports a strand other than its own, and exports that id as `WORKING_STRAND_ID`.
6. Switches to Chat and asserts that the strand label (`chat-strand-label`) shows `WORKING_STRAND_ID`.

The last check exists because the phone holds two strands by then, its own and the fixture's. If the chat showed the other one, flows 2 and 3 would have the phone and the drone writing to different strands and could pass without testing replication.

### The flows

| Flow | What it does |
|---|---|
| `flows/1-connect-and-send.yaml` | After setup, sends a message from the phone and checks that it appears in the list. |
| `flows/2-drone-to-phone.yaml` | After setup, inserts a message into the working strand through the sidecar and waits five seconds for it to appear on the phone, with the sender's name. |
| `flows/3-round-trip.yaml` | After setup, sends from the phone and asserts through the sidecar that the drone holds the message; inserts from the drone and waits for it on the phone; then checks both are visible and that the drone's timestamps are monotonic. |
| `flows/4-solo-create-strand.yaml` | No fixture and no setup file. Taps **No, start fresh** if the question shows, connects with empty Party ID and Bootstrap addr, taps **Create Chat Strand** and waits up to 60 seconds for "Strand created". |

Flow 4 runs alone on a device with:

```bash
maestro test -e MAESTRO_APP_ID=org.gotchoices.sereus.chat maestro/flows/4-solo-create-strand.yaml
```

The orchestrator still starts the fixture when it runs flow 4 with the rest of the directory; the flow ignores it.

### The NativeScript run

`yarn workspace @serfab/reference-app-ns test:e2e` runs `packages/reference-app-ns/scripts/run-e2e.mjs`. The NativeScript package has no flow files. Its orchestrator starts the React Native package's fixture, points Maestro at the React Native package's `maestro/flows/`, sets `MAESTRO_APP_ID` to `org.gotchoices.sereus.chat.ns`, passes the fixture's machine invitation as `JOIN_CODE` (the app's join field takes no owner grant), and writes its artifacts under its own `maestro/` directory. It needs a built NativeScript APK installed on the emulator.

NativeScript has no `testID`. The app sets `automationText` on its controls to the same strings as the React Native app's `src/test-ids.ts`, which become the Android content description and the iOS accessibility identifier.

Only flow 4 matches the NativeScript app. It uses the ids both apps have (`btn-connect`, `btn-disconnect`, `btn-create-strand`, `modal-title`, `btn-modal-ok`) and taps the first-launch answer only when it is present. Flows 1 to 3 fail in `_setup.yaml`, at its first wait, for `btn-first-launch-join`. The setup depends on several things the NativeScript app does not have:

- the first-launch question and the join-flow result (`btn-first-launch-join`, `btn-join-flow-ok`); the NativeScript join field shows only while connected, and reports the result in a modal;
- a `chat-strand-label` element, and a deterministic choice of which strand the chat shows;
- a "Chat" tab to tap; the NativeScript app is a single page stack with a Settings action and a Back button;
- a strand the drone can see; the NativeScript app's **Create Chat Strand** starts the strand on the phone and writes no `Strand` row, so `_helpers/discover-phone-strand.js` would never find it on the drone.

The mismatch is tracked as ticket `debt-ns-maestro-flow-parity-gaps`. Whether Maestro's `id:` selector resolves `automationText` on a NativeScript build has not been established on a device; Appium, which matches content descriptions directly, is the fallback.

### When a run fails

- **`adb reverse` warning.** No emulator is running, or `adb` chose another device. Check `adb devices`.
- **The join never finishes**, with the app waiting for a machine of the cadre to answer. The phone dials the member address in the owner grant, which is `127.0.0.1:4002`, and the dial did not reach the host. Check that `adb reverse --list` shows both ports.
- **`maestro: command not found`.** Install Maestro or set `MAESTRO_BIN`.

## Device test runs

A manual scenario on a development build is interrupted when the app reloads. This section covers what causes a reload, how to prevent it, and how to tell afterwards what happened.

When Metro sends a development build a changed module, Fast Refresh applies it in place only if every chain of imports above that module ends at a React component module. Otherwise the whole app reloads. The library and `dist` modules the node is built from always cause a reload, because `index.js` and `src/cadre-phone.ts` import them outside any component. A reload restarts the node.

### What a write does to the phone

Metro watches the whole sereus, optimystic, quereus and Fret checkouts. Under `yarn start`:

| Write during the run | Effect on the phone |
|---|---|
| A `.md` file anywhere (tickets, docs), or a commit | None. `.md` is not a watched extension and `.git` is ignored. |
| A watched extension (`.json`, `.db`, `.ts`, …) outside the app's module graph, such as a ticket log or an index database | An empty update: "Refreshing..." flashes, and LogBox and any red box are cleared. No reload. |
| A build that rewrites `dist` files with identical bytes | An empty update. |
| A content change to a module the app bundles: its own `src/`, a sereus workspace package it imports, or a linked `dist` file in a sibling checkout | The module is sent, and the app reloads unless Fast Refresh can apply it. |

So ticket, doc and commit writes never need to wait for a run. Edits to bundled source, and builds that change linked `dist` output, do. No Metro `blockList` is configured for `tickets/` or `docs/`, because it would remove only the empty updates; the note beside `linkedRoots` in `metro.config.js` says when to revisit that.

One reload does not come from a write. If the app's connection to Metro drops (Wi-Fi, a lost `adb reverse`, Metro restarted), the app reloads the next time it loads a lazily bundled module, such as Optimystic's `import('p2p-fret')`.

### Frozen dev server

```bash
yarn workspace @serfab/reference-app-rn start:frozen
```

This runs `expo start --dev-client` with `CI=1`, which turns Metro's file watching off. No write anywhere reaches the phone, so other work in the repo does not have to pause. It differs from `yarn start` in these ways:

- **Modules are served as first read.** A reload from the dev menu or a red box serves each module as Metro first read it, not as it is on disk. To put a rebuilt dependency on the phone, restart Metro.
- **No interactive terminal.** There is no QR code and no `r`, `m` or `j` key. Metro prints `Metro is running in CI mode, reloads are disabled.` and waits on `http://localhost:8081`. The dev client connects from its recent-servers list, or after `adb reverse tcp:8081 tcp:8081` through the link `sereus-chat://expo-development-client/?url=http%3A%2F%2Flocalhost%3A8081`.
- **The session is not registered with Expo's servers**, so a signed-in dev client does not list the project.
- **A port in use is an error**, not a prompt. Pass `--port <n>`.

### First launch on a cold Metro

On a cold cache (`yarn start --clear`, or the first start), building the Android bundle takes longer than the dev client waits for it, and the launch fails with "There was a problem loading the project". This applies to `yarn start` and `start:frozen` alike. Build the bundle before opening the app: start `metro:observe` first, which builds it when no client has loaded it yet, or fetch it once from the PC.

To fetch it by hand, use the URL the observer prints on its first line (`bundle <url>`), which comes from Expo's manifest. Do not shorten it to `index.bundle?platform=android&dev=true`: the query carries transform options such as `transform.engine=hermes`, and a bundle requested with different options is a different build.

### Why it reloaded

A development build logs a warning before any reload that starts in JavaScript. The logger is `polyfills/reload-reason.js` in `@serfab/cadre-rn`, loaded by `@serfab/cadre-rn/boot-check`. In logcat the line precedes the next `Running "main"`:

```
W ReactNativeJS: [reload] Bundle Splitting – Metro disconnected
W ReactNativeJS: '[reload] (no reason given) caller:', 'Error: reload caller\n    at logReload (...)\n    at reload (...)\n    at performFullRefresh (...)\n    at metroHotUpdateModule (...)\n ...'
```

Search with `grep '\[reload\]'`. The no-reason line passes its text and the stack as two arguments, so logcat prints both quoted on one line with the stack's newlines escaped; a search for `caller: Error` does not match.

| Line | Meaning |
|---|---|
| `(no reason given)`, with `performFullRefresh` in the caller stack | Metro sent a changed module that Fast Refresh could not apply. Metro's own reason is lost, because the reload goes through Expo's `window.location.reload()`, which passes none. The observer names the module. |
| `(no reason given)` with any other caller | Other JavaScript called `DevSettings.reload()`; the stack names it. |
| `Bundle Splitting – Metro disconnected` | The connection to Metro had closed, and the app then loaded a lazily bundled module. React Native also logs a `Disconnected from Metro` warning when the connection drops. |
| `Running "main"` with no `[reload]` line before it | The JavaScript was started natively: the dev menu's Reload, `r` in the Metro terminal, or the app process restarting. |

`Running "main" with {...}` is logged once per JavaScript start. Do not use `I ReactNativeJS: log level = info` as a restart marker: another process, with a different pid in logcat, logs it too, at intervals.

### Which file reached the phone

With Metro running under `yarn start`, run in a second terminal:

```bash
yarn workspace @serfab/reference-app-rn metro:observe [--port <n>] [--host <h>] [--platform <p>]
```

`scripts/metro-hmr-observe.mjs` attaches to Metro as a second client of the bundle the dev client loads, and prints each update that adds, modifies or deletes modules, with local timestamps in logcat's format:

```
09-16 21:43:24.439 update: 1 modified, 0 added, 0 deleted
    modified packages/reference-app-rn/src/connection-status.bundle
```

Paths are relative to the sereus root with the extension replaced by `.bundle`; a sibling checkout's module starts with `../optimystic/` and so on. Empty updates print nothing, and under `start:frozen` nothing is ever printed. When Metro stops, the script prints `Metro closed the HMR socket` and exits with code 1.

A block printed at the moment of a `[reload]` line names the file that caused the reload. The phone's clock and the PC's differ, so match the two logs by nearness, not by order.

### A second install on one phone

Joining by link between two apps ([Between apps on one phone](../cadre/apps.md#between-apps-on-one-phone)) needs two Sereus apps on one device. `APP_VARIANT=second` builds this app as a separate one, with its own name, URL scheme `sereus-chat-second`, package id, identity and storage. The build commands are in the [README](../../packages/reference-app-rn/README.md#a-second-install-on-one-phone).

The second install needs its own dev server, started with the same variable on another port. A development build takes its name, scheme and `extra` from the dev server's manifest, not from the build. Served by the main app's dev server, the second install would name the main app's scheme in its join request, and the answer would go to the main app, which refuses it.

## Adding a home machine's node

This checks the claim of a cadre-host node from the phone: a machine running cadre-host shows a code, the phone reads it under **Settings → Add an always-on node** and claims the node ([Claiming a node](../cadre/membership.md#claiming-a-node), [cadre-host design](../hosting/cadre-host.md#join-a-cadre)). The phone dials the node. What the app does at each step is described in [The reference apps](../platforms/reference-apps.md#adding-an-always-on-node).

### On the PC

A test session uses a cadre-host data directory of its own and a host running in the foreground, not an OS service. From the repo root:

```bash
yarn workspace @serfab/cadre-host build
node packages/cadre-host/dist/bin/host.js install --non-interactive --no-service --no-upnp --no-browser --data-dir <dir>
node packages/cadre-host/dist/bin/host.js start --data-dir <dir>
node packages/cadre-host/dist/bin/host.js join
```

- **`install --no-service`** writes the identity key and `host.config.json` into `<dir>` and registers no OS service. It is needed once per data directory.
- **`--no-upnp`** leaves the router alone, so the code carries the node's LAN addresses only. That is the same-Wi-Fi case this procedure covers.
- **`start`** runs the host until Ctrl+C and prints `cadre-host local UI: http://127.0.0.1:<port>`. Run `join` from a second terminal.
- **`join`** starts a node, prints its code as a QR code and as text, and waits for the claim. The **Join a cadre** button in the local UI does the same and shows a larger code, which is easier to scan.

The management port is `uiPort` in `<dir>/host.config.json`, 8765 unless `install` was given `--ui-port`. `start` binds it, or the next free port of the nine above it, and prints the one it bound. `join` talks to 8765, or `$CADRE_HOST_PORT`, unless given `--port`. Only the PC uses this port.

If cadre-host is already installed as a service, that service is the running host: skip `install` and `start` and run only `join`. Running `start` beside the service starts a second host on the same data directory.

### The PC's firewall

The phone must be on the same Wi-Fi as the PC, and the PC's firewall must allow incoming connections to the node. On Windows, firewall rules apply per network profile, and a home Wi-Fi can be classified Public. Windows prompts about `node.exe` only while no rule for it exists. The usual failure is therefore silent: the Wi-Fi is Public, an earlier prompt left Block rules for `node.exe` on Public, no new prompt appears, and the phone's dials time out.

**Check** (PowerShell). `Get-NetConnectionProfile` shows the network's `NetworkCategory`. This lists the rules for the `node.exe` on the PATH:

```powershell
Get-NetFirewallApplicationFilter -Program (Get-Command node).Source | Get-NetFirewallRule | Format-Table DisplayName, Direction, Action, Profile, Enabled
```

**Network or app?** `adb shell nc -w 3 <pc-lan-ip> <ws-port>` opens a plain TCP connection from the phone to the node. `<ws-port>` is the node's WebSocket port, listed as `ws` under Ports on the node's page in the local UI. A timeout means something between the phone and the node drops the connection, so a claim that cannot reach the node is not the app's fault.

**Fix** (administrator PowerShell), one of:

- Mark the network Private, with the alias from `Get-NetConnectionProfile`. This helps only if an Allow rule for `node.exe` covers the Private profile.

	```powershell
	Set-NetConnectionProfile -InterfaceAlias <alias> -NetworkCategory Private
	```

- Add an inbound Allow rule on the profile the network uses, for `node.exe` or for the port range the host gives its nodes (10000 to 20000 by default). This rule opens those ports to every program on every Public network, so remove it after the session with `Remove-NetFirewallRule -DisplayName "cadre-host nodes"`.

	```powershell
	New-NetFirewallRule -DisplayName "cadre-host nodes" -Direction Inbound -Protocol TCP -LocalPort 10000-20000 -Action Allow -Profile Public
	```

A Block rule overrides an Allow rule, so with either fix an existing Block rule for `node.exe` on the network's profile must be disabled:

```powershell
Get-NetFirewallApplicationFilter -Program (Get-Command node).Source | Get-NetFirewallRule | Where-Object Action -eq Block | Disable-NetFirewallRule
```

### The run

1. On the phone, connect alone: Settings → **Connect** with no bootstrap address. The device must be an owner of its cadre; a phone that founded its own is one.
2. Settings → **Add an always-on node** → **Scan code**, and point the camera at the code. Or paste the code's text into the field and tap **Use code**. The first scan asks for camera permission.
3. Read the approval prompt: the cadre's party id, the signing owner key's name and fingerprint, the node's peer id, and whether the node is reachable from anywhere or only on the home network. Tap **Add to this cadre**.
4. Wait. After 20 seconds the progress line adds that some addresses are not answering. The claim tries the code's addresses in turn, so a code none of whose addresses answer takes much longer to fail than one dial.

Expected result: the app reports the node added, with its peer id, and the host's page for the node reads "Claimed by owner `<fingerprint>` into cadre `<party>`" with the fingerprint and party id from the prompt. The node then restarts once under the cadre, which drops the connection the claim used; the phone reconnects on a later pass and the host then reports the node connected. "Added" means the node accepted the claim, not that a connection is open.

After a relaunch the app reconnects to the same cadre and dials the node again from the addresses it kept. Switching tabs does not stop a claim. **Disconnect** during a claim stops the node and the claim fails; if the node had not accepted, nothing changed on either side.

On Android the system camera can open the code in the app, because the app registers the `sereus-join` scheme. The intent filter is native configuration, so it takes effect only in a development client built with it.

### What a failure means

Each failure shows the underlying error under its message. When the same code can succeed again, the section keeps it and offers **Try again**.

| Cause | Error | Same code again? |
|---|---|---|
| No address answered: the phone is on another network, the firewall drops the dial, the machine is off, or the router does not forward the port | `PeerUnreachableError` | Yes |
| Another owner claimed the node first. Reset the node on the machine and scan the new code. | `already-claimed` | No |
| The secret does not match: the node was reset after the code was shown | `claim-proof-invalid` | No |
| Several wrong codes in a short time | `claim-rate-limited` | Yes, after a minute |
| The node could not write its claim to disk | `claim-not-persisted` | Yes |
| The node was reached and the exchange, or a step on the phone, failed. The node accepts a repeat claim from the same owner. | any other | Yes |
| This device is a member of its cadre and not an owner | none; nothing is sent | n/a |

Text that is not a node code, comes from a newer cadre-host, or is cut short is refused before the approval prompt.

## Renting a provider node in development

To try **Settings → Rent an always-on node**, run `@serfab/cadre-provider` on the dev machine with Docker available ([README](../../packages/cadre-provider/README.md)), configured as follows:

- **`docker.publicHost`** is the address at which the phone reaches the dev machine. The container's WebSocket address is built from it, and the phone's claim dials it.
- **`provider.publicUrl`** is the base of every URL in the descriptor. The provider accepts plain `http` only at a loopback host, so either put it behind `https`, or use `http://127.0.0.1:3000` and run `adb reverse tcp:3000 tcp:3000` so the phone's loopback reaches the PC. The `provider` block also needs an `id` and a `name`.
- **`auth`** uses OAuth with the built-in consent form, which is for development only, and registers the app's client with the redirect URIs of both installs:

```yaml
auth:
  mode: oauth
  allowInsecureNoAuth: true
  oauth:
    devConsentPage: true
    clients:
      - clientId: sereus-chat
        redirectUris: ["sereus-chat://provider-auth", "sereus-chat-second://provider-auth"]
        scopes: ["containers:*", "billing:read"]
```

Start the dev server with `EXPO_PUBLIC_PROVIDER_DESCRIPTOR_URL=<publicUrl>/api/v1/descriptor`; without it the section does not show. On the consent page, type any customer id and choose a plan. To see how the app shows a node stopped for non-payment, lapse the subscription on the provider's side and wait for the app's next poll.

## Tracing a strand founding

While a strand is being created, the pressed button in Settings shows elapsed seconds, both create buttons are disabled, and a "still running" hint appears after 30 seconds. Nothing gives up at that point. Founding is resumable, so reporting a failure at a deadline would leave a strand the user believes was never created.

Every build logs the Settings handler at both ends (`adb logcat -s ReactNativeJS`):

```
I ReactNativeJS: [settings] create strand 1a2b3c4d pressed
I ReactNativeJS: [settings] create strand 1a2b3c4d succeeded in 1400 ms
```

A failure is a `W` line, `failed after <n> ms:` followed by the error. No `pressed` line after a tap means the tap never reached the handler.

Development builds also log cadre-core's `sereus:cadre:timing` lines as `D ReactNativeJS`; `@serfab/cadre-rn`'s `polyfills/hermes.js` enables the namespace. Each awaited step of `CadreNode.foundStrand` and of the strand's launch logs a line when it starts and another when it ends, so a step with a start and no end is the one that hung:

```
D ReactNativeJS: sereus:cadre:timing [foundStrand:<id>] publishStrand: start +0ms
D ReactNativeJS: sereus:cadre:timing [foundStrand:<id>] publishStrand: 21ms +21ms
D ReactNativeJS: sereus:cadre:timing [startOrFoundStrand:<id>] strandManager.startStrand: start +0ms
D ReactNativeJS: 'sereus:cadre:timing [buildStrandRuntime:%s] createLibp2pNode: %dms +35ms', '<id>', 35
```

The trailing `+<n>ms` is the `debug` library's time since that namespace's previous line. The last line shows how some timing lines print on a device: they pass their values as `%s` and `%d` arguments, and React Native's console prints the placeholders unfilled with the values after them (ticket `bug-rn-debug-placeholders-printed-raw`).

**Create Closed Strand + Invite** reports success once the strand is published and the invitation made, because it founds with `foundStrand`'s background form. The strand keeps starting after the handler's `succeeded` line, so the start's timing lines can follow it, ending with `[foundStrand:<id>] addStrand: <n>ms`, while `[foundStrand:<id>] total` covers only the publish. A start that fails logs `W ReactNativeJS: [chat-strand] closed strand <id> did not start; no owner role was written:` with the error, and the node retries the start.
