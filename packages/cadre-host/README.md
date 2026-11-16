# @serfab/cadre-host

`cadre-host` runs always-on Sereus nodes on a machine you own, for cadres that live on people's phones: your own, and a friend's or family member's if you show them a code. It installs as a per-user service with a web UI on localhost, starts each node as a child process, and makes the nodes reachable through your router.

The phone stays the authority for its cadre. cadre-host holds no owner key and never runs a cadre of its own. [cadre-host design](https://github.com/gotchoices/sereus/blob/master/docs/hosting/cadre-host.md) explains how it works; this README covers installing, running and configuring it.

## Prerequisites

- **Node.js 20.19 or later**, with npm.
- **A machine that stays on**, running Linux with systemd user services, macOS, or Windows with [NSSM](https://nssm.cc/download) (`nssm.exe` on `PATH`).
- **A phone with a Sereus app** whose cadre the node will join. The app scans the code cadre-host shows.
- **Optional: an OS keychain.** cadre-host stores DDNS tokens and push keys through `keytar`. On Debian or Ubuntu that needs `libsecret-1-0` and a running secret service. Without a keychain it stores them in a file ([Files it writes](#files-it-writes)).

## Install

Install globally:

```bash
npm install -g @serfab/cadre-host
cadre-host install
```

Or keep everything in one folder:

```bash
mkdir -p ~/cadre && cd ~/cadre
npm install @serfab/cadre-host
npx cadre-host install --data-dir ~/cadre/data
```

With a folder install, run commands as `npx cadre-host <command>` from inside `~/cadre`. Outside that folder `npx` does not find the local copy and downloads a new one from the registry, so either `cd ~/cadre` first or link the binary onto your `PATH`:

```bash
ln -s ~/cadre/node_modules/.bin/cadre-host ~/.local/bin/cadre-host
```

A folder install also uses a data directory that is not the default. The commands that read files directly (`ui`, `start`, `push`, `uninstall`) then need `--data-dir ~/cadre/data`; `ui`, `start` and `push` also accept `CADRE_HOST_DATA_DIR`.

`cadre-host install` does the following:

1. Asks for the data directory and the UI port, skipping any you gave as a flag. On a machine behind a router it asks whether to use UPnP. On a machine that holds a public IP address it says the nodes are reached directly and does not ask.
2. Creates the data directory, private to your account, and writes `host.config.json` and `nat.json` into it.
3. Registers and starts a per-user service: a `systemctl --user` unit on Linux, a LaunchAgent on macOS, the NSSM service `CadreHost` on Windows.
4. Prints how to open the UI. On a desktop it also opens the browser. Over SSH or on a machine with no display it prints the `ssh -L` command to run from your own computer.

`cadre-host install --non-interactive --data-dir <path>` installs without prompts. `--no-service` writes the data directory and registers no service; run the host yourself with `cadre-host start --data-dir <path>`.

### Permissions

On Linux and macOS no step needs root, and the installer writes only inside your home directory. The data directory must be a folder used only by cadre-host: on Linux and macOS the installer sets it to mode 0700.

On Linux, a `systemctl --user` service stops when your last session ends unless lingering is enabled. The installer tries `loginctl enable-linger` and continues if that fails. To enable it yourself, before or after installing:

```bash
sudo loginctl enable-linger "$USER"
```

On Windows, creating a service requires an Administrator PowerShell. [`service/README.md`](./service/README.md) describes the service on each platform.

## Join your first cadre

After `install` the service is running and hosts no nodes. A node starts when you join a cadre.

### 1. Check that the service is running

```bash
cadre-host status
```

It prints `Service installed: yes` and `Service running: yes`. If it is not running, read the log:

| Platform | Service state | Log |
|---|---|---|
| Linux | `systemctl --user status cadre-host` | `journalctl --user -u cadre-host -f` |
| macOS | `launchctl print gui/$(id -u)/com.serfab.cadre-host` | `<dataDir>/logs/out.log`, `err.log` |
| Windows | `nssm.exe status CadreHost` | `<dataDir>\logs\out.log`, `err.log` |

`cadre-host node list` confirms that the management API answers. With no nodes it prints ``Hosted nodes: none. Run `cadre-host join` to start one.``

### 2. Open the local UI

The UI is at `http://127.0.0.1:8765/` (or the port you chose) on the host machine. `cadre-host ui` prints the URL and opens it.

The UI listens on loopback only and has no login, so from another computer you reach it through an SSH forward. Use the same port number on both ends, because the server refuses requests addressed to any other port:

```bash
ssh -L 8765:127.0.0.1:8765 user@my-host
# then open http://127.0.0.1:8765 on your own computer
```

### 3. Join with a QR code

Open **Join** in the UI and click **Join a cadre**, or run:

```bash
cadre-host join
```

Either one starts a node and shows a QR code with the same content as text. Scan the code with the Sereus app on the phone that owns the cadre, or paste the text into the app. The command waits and then prints:

```
✓ Claimed by owner 1a2b3c4d into cadre <partyId>
```

Check the result:

```bash
cadre-host node list
```

The node's line reads `joined`, names the cadre and the owner's key fingerprint, and ends with `connected` once the node holds a connection to the cadre.

- **Whose cadre.** The node joins the cadre of whoever scans the code. To host a node for a friend, join again and let the friend scan the new code.
- **Keep the code private.** Anyone who scans it claims the node. If the wrong person did, `cadre-host node reset <id>` replaces the node with a fresh one and a new code.
- **Reachability warning.** If the page or the command warns that the node cannot be reached from outside your network, a phone on your home network can still claim it. See [Reachability](#reachability) before relying on it away from home.

### 4. Or join with an invitation

When the cadre already has a member this machine can reach, such as another always-on node, the owner's app can copy a cadre invitation instead. Paste it under **Or paste a cadre invitation** on the Join page, or run:

```bash
cadre-host join --invitation "<the invitation text>"
```

The command prints `✓ Joined cadre <partyId> at member <peerId>` when a member admits the node.

This cannot add a cadre's first always-on node: its only members are phones, which nothing can dial, so the join fails with no member reachable. Use the QR code for that node. If the join failed because the member was offline, run `cadre-host node retry <id>` once it is back. If the cadre refused the invitation (expired, used up, or made for another device), remove the node and join with a new invitation.

### 5. Manage the nodes

```bash
cadre-host node list          # id, status, cadre, owner fingerprint, connected
cadre-host node remove <id>   # stop the node and delete its data on this machine
cadre-host node reset <id>    # remove it and start a fresh one with a new code
```

`<id>` is the `hn_…` id that the list and the UI show. Removing a node deletes its identity key and its copy of the cadre's data from this machine. The cadre keeps its entry for the node until the owner removes it in their app. There is no stop command: cadre-host restarts a node that crashes or dies in a reboot, with the same identity and ports, so a code already shown stays valid.

## Reachability

A phone away from home reaches a node through two ports: the node's TCP port and its WebSocket port. cadre-host works out where the machine sits and acts accordingly.

- **Behind a router.** cadre-host asks the router to map both ports over UPnP when a node starts. If that does not work, forward them yourself.
- **On a public IP address** (a VPS). Nothing needs mapping; the status shows the nodes as `direct`. Allow the two ports through the machine's firewall and your hosting provider's. The status prints a `ufw` command for them.

Check the result after installing and whenever your network changes:

```bash
cadre-host nat status   # network mode, router, external IP, and a verdict per node
cadre-host nat test     # run the probes again now
```

Each node reads `mapped` (UPnP), `manual` (forwarded by you), `direct` (public IP) or `unreachable`. An `unreachable` node says why and what to do. The **Connectivity** page shows the same.

Three cases need a setting made by hand:

- **A cloud machine with a private interface address** whose provider forwards a public IP to it (AWS, GCP): `cadre-host nat settings --network public`.
- **A machine behind a router that also has a public address** on a second network card or a tunnel: `cadre-host nat settings --network lan`.
- **Carrier-grade NAT.** If your ISP shares one public address among customers, neither UPnP nor a port forward works, and the status says so. cadre-host cannot make such a node reachable from outside your network.

### Forward ports by hand

1. Run `cadre-host nat status`. Under the unreachable node, **To fix** lists the ports to forward and the address of this machine to forward them to.
2. In your router's settings, forward each of those ports (TCP) to that address, on the same internal port number. Choose any external port; the same number is simplest.
3. Tell cadre-host the external ports you chose:

   ```bash
   cadre-host nat forward hn_abc123 --tcp 10003 --ws 10004
   ```
4. The node restarts to announce its new address, and `nat status` shows it as `manual`.

`cadre-host nat forward <id> --clear` forgets a forward. cadre-host does not test the forward: it trusts the ports you give it. A node keeps its ports when it restarts, so the router rule stays valid until you remove the node. [Manual port forwarding](https://github.com/gotchoices/sereus/blob/master/docs/hosting/cadre-host.md#manual-port-forwarding) has the details.

### Set up dynamic DNS

A home connection's IP address changes. Without a hostname, a device that holds only the old address cannot find the node, and every node restarts to announce the new one. A dynamic DNS name avoids both. To have cadre-host keep a DuckDNS name current:

1. Sign in at <https://www.duckdns.org/>, register a subdomain and copy your token.
2. Configure it. Omit `--token` to be prompted for it without echo.

   ```bash
   cadre-host nat ddns set duckdns --hostname mybox.duckdns.org --token <token>
   ```
3. Run `cadre-host nat status`. The `DDNS` lines show the hostname and the result of the last update. cadre-host updates the record when the IP changes, checking every 5 minutes.

If your router or another tool already updates a DNS name, tell cadre-host to use the name without updating it:

```bash
cadre-host nat ddns external --hostname mybox.example.com
```

### Choose the addresses in the claim code

A phone tries each address in the code in turn, so the code carries only addresses a phone can use: the public address (the DDNS name when set, otherwise the public IP) and one LAN address for phones at home. To change that, use **Settings → Claim code addresses** in the UI or set `claimAddresses` in `host.config.json`:

| Value | Effect |
|---|---|
| `{ "lan": "auto" }` | Default. This machine's address on the router's network; none on a public IP. |
| `{ "lan": "192.168.1.20" }` | Use this LAN address. |
| `{ "lan": "none" }` | No LAN address; phones use the public address only. |
| `{ "addrs": ["/dns4/node.example.org/tcp/443/wss"] }` | Use exactly these addresses, for example behind a reverse proxy. |

The next code shown uses the change. Exact `addrs` apply to every node on this host and each code appends that node's own peer id, so leave `/p2p/…` off and either run one node or give each node its own address.

## Push credentials

An always-on node can wake a suspended phone app through Firebase Cloud Messaging (Android) or APNs (iOS) ([Push wake](https://github.com/gotchoices/sereus/blob/master/docs/strands/hibernation.md#push-wake)). This needs the push credentials of the app's publisher, so it applies when you publish the app your hosted nodes serve. Every node on the host receives the same credentials.

Storing the credentials does not by itself send any wake. A node sends one only when the program running it reports strand activity, and the nodes cadre-host starts never do (ticket `passive-strand-activity-fanout-detector`). The steps here put the credentials in place.

1. **FCM.** In the [Firebase console](https://console.firebase.google.com), open the app's project, then **Project settings → Service accounts → Generate new private key**. The downloaded JSON contains `project_id`, `client_email` and `private_key`. Save the private key to a file.
2. **APNs.** In the [Apple Developer portal](https://developer.apple.com/account), under **Certificates, Identifiers & Profiles → Keys**, create a key with Apple Push Notifications service enabled and download the `.p8` file. Note the key id, your team id and the app's bundle id.
3. **Store them.**

   ```bash
   cadre-host push fcm  --project-id <id> --client-email <email> --private-key-file ./fcm-key.pem
   cadre-host push apns --key-id <id> --team-id <id> --bundle-id <id> --private-key-file ./AuthKey.p8
   cadre-host push status
   ```

`push apns` targets Apple's sandbox host, which development and TestFlight builds use. Add `--production` for an App Store build; a device token from one is rejected by the other. A node picks up new credentials the next time it is spawned. The `push` commands need no running service.

## CLI reference

`install`, `uninstall`, `status`, `start`, `ui` and the `push` group work on files and the OS service directly. The `join`, `node` and `nat` commands are clients of the running service's management API and accept two more options:

- `--port <port>`: the management API port. The default is `CADRE_HOST_PORT`, or 8765 when that is unset. These commands do not read `host.config.json`, so if you installed with another `--ui-port`, or the service reported that it bound a different port, pass `--port` or set `CADRE_HOST_PORT`.
- `--host <host>`: the management API host, default `127.0.0.1`. The API accepts only loopback names.

They exit with status 2 when the service cannot be reached and 1 when it refuses the request.

### `cadre-host install [--non-interactive] [--data-dir <path>] [--ui-port <port>] [--no-upnp] [--no-browser] [--no-service] [--node-path <path>]`

Set up the data directory and register the service ([Install](#install)). `--no-upnp` turns UPnP off from the start. `--no-browser` skips opening the UI. `--node-path` sets the Node.js binary the service runs; the default is the one running the installer. `--system` is accepted and fails: only per-user installs are supported.

### `cadre-host uninstall [--remove-data] [--yes] [--data-dir <path>]`

Stop and deregister the service. The data directory is kept unless you pass `--remove-data`, which deletes node identities, records and settings after a confirmation; `--yes` skips the confirmation and is required when stdin is not a terminal. `--data-dir` names the directory to delete when it is not the default.

### `cadre-host status`

Print whether the service is registered and whether it is running.

### `cadre-host start [--data-dir <path>] [--no-tui]`

Run cadre-host in the foreground. The service runs this command; after `install --no-service` you run it yourself. The data directory comes from `--data-dir`, then `CADRE_HOST_DATA_DIR`, then the platform default. `--no-tui` has no effect. Do not run `start` beside a running service on the same data directory.

### `cadre-host ui [--no-browser] [--data-dir <path>]`

Print the UI's URL and open it in the default browser. Over SSH or with no display it prints the `ssh -L` command instead. It reads `uiPort` from `host.config.json` and does not check that the service is running.

### `cadre-host join [--invitation <encoded>] [--no-qr] [--no-wait]`

Start a hosted node. Without `--invitation`, show the code the owner's phone scans, wait for the claim and print `✓ Claimed by owner <fingerprint> into cadre <partyId>`. The text of the code goes to stdout alone and everything else to stderr, so `--no-qr`, which omits the QR code, can be piped. With `--invitation`, redeem a cadre invitation and print `✓ Joined cadre <partyId> at member <peerId>`, or `✗ Could not join: <reason>` and exit 1. `--no-wait` exits once the code is shown or the node started. Ctrl-C while waiting leaves the node as it is.

### `cadre-host node list`

Print every hosted node: id, status (`spawning`, `unclaimed`, `joining`, `joined` or `error`), cadre, the first 8 characters of the owner key, whether a joined node is connected, and the error of a failed one.

### `cadre-host node remove <id>`

Stop a hosted node and delete its record, its process and its working directory.

### `cadre-host node reset <id> [--no-qr] [--no-wait]`

Remove a hosted node and start a fresh one waiting to be claimed, then show its code and wait as `join` does. Use it for a node the wrong person claimed or one that failed. A node that joined by invitation is also replaced by one waiting to be claimed.

### `cadre-host node retry <id> [--no-wait]`

Start an invitation node again with the same invitation and identity, after no member could be reached, and wait as `join --invitation` does. The service refuses it for any other node, including one whose invitation the cadre refused.

### `cadre-host nat status [--json]`

Print the network mode, UPnP and router state, the external IP, whether carrier-grade NAT was detected, the overall reachability and the DDNS state. Then, for each node: its verdict, its TCP and WebSocket ports as internal → external with the source of the route, its public addresses, and for an unreachable node the reason and the fix. `--json` prints the raw API response.

### `cadre-host nat test [--json]`

Run router discovery and the external IP probes again, then print the status.

### `cadre-host nat settings [--network <auto|lan|public>] [--upnp] [--no-upnp]`

Set the network mode or turn UPnP on or off. `auto` (the default) picks `public` when an interface holds a public IPv4 address. Turning UPnP off releases the router's mappings and keeps the ports you forwarded by hand.

### `cadre-host nat forward <nodeId> [--tcp <port>] [--ws <port>] [--clear-tcp] [--clear-ws] [--clear]`

Record the external ports your router forwards to one node's TCP and WebSocket ports, or forget them. Ports are whole numbers from 1 to 65535. The node restarts if its public addresses change, at most once in 10 minutes.

### `cadre-host nat ddns set <provider> --hostname <hostname> [--token <token>]`

Have cadre-host keep a dynamic DNS record current. The only `<provider>` is `duckdns`. Without `--token` the command prompts for it; when stdin is not a terminal the flag is required.

### `cadre-host nat ddns external --hostname <hostname>`

Use a hostname that something else keeps current. cadre-host puts it in the nodes' addresses and never updates it.

### `cadre-host push fcm --project-id <id> --client-email <email> [--private-key-file <path>] [--private-key <pem>] [--data-dir <path>]`

Store Firebase Cloud Messaging service-account credentials. Give the key as a file (preferred) or inline; one of the two is required.

### `cadre-host push apns --key-id <id> --team-id <id> --bundle-id <id> [--private-key-file <path>] [--private-key <pem>] [--production] [--data-dir <path>]`

Store an APNs auth key. `--bundle-id` is the app's bundle id. `--production` selects Apple's production host instead of the sandbox.

### `cadre-host push options [--cooldown-ms <ms>] [--debounce-ms <ms>] [--data-dir <path>]`

Set push timing. `--cooldown-ms` is the minimum time between two wakes of the same peer for the same strand. `--debounce-ms` is how long a strand's changes are collected into one wake.

### `cadre-host push clear <target> [--data-dir <path>]`

Remove stored push credentials. `<target>` is `fcm`, `apns` or `all`.

### `cadre-host push status [--data-dir <path>]`

Print which push platforms are configured, the APNs bundle id and host, and the timing options. It prints no key material.

## Configuration

| Environment variable | Read by | Meaning |
|---|---|---|
| `CADRE_HOST_PORT` | `join`, `node`, `nat` | Default for `--port` |
| `CADRE_HOST_DATA_DIR` | `start`, `ui`, `push` | Default for `--data-dir` |
| `CADRE_HOST_UPDATE_MANIFEST_URL` | `start` | Where to fetch the update manifest; overrides `updates.manifestUrl` |
| `CADRE_HOST_UPDATE_DEV_KEY` | `start` | Development only: a different key for verifying update manifests |

`host.config.json` holds these settings. The UI's Settings page edits `updates` and `claimAddresses`. To change `uiPort`, edit the file and restart the service.

| Key | Default | Meaning |
|---|---|---|
| `uiPort` | 8765 | Port of the UI and management API |
| `dataDir` | per platform | The data directory, fixed at install |
| `updates.autoApply` | `false` | Install updates without asking |
| `updates.manifestUrl` | unset | Another update manifest URL |
| `claimAddresses` | `{ "lan": "auto" }` | [Addresses in the claim code](#choose-the-addresses-in-the-claim-code) |

The file also holds `push`, the settings of `cadre-host push` that are not secret (APNs bundle id and host, timing), and a record of the install. Network mode, UPnP, forwarded ports and DDNS are kept in `nat.json` and set with `cadre-host nat` or the Connectivity page; the `upnpEnabled` value in `host.config.json` records the install-time answer and is not read afterwards.

## Updates

cadre-host checks for a new release when it starts and every 24 hours. It only notifies by default: the UI shows a banner, and **Apply** installs the release with `npm install -g` and restarts the service. If the install fails, the previous version is reinstalled and the error is shown. Turn on automatic updates on the Settings page.

Each release is announced by a manifest signed with a key built into cadre-host, and a manifest whose signature does not verify is never applied ([Updates](https://github.com/gotchoices/sereus/blob/master/docs/hosting/cadre-host.md#updates)).

## Local UI

The UI has five pages.

- **Home.** Service version, update notice, and how many nodes are joined, waiting and reachable.
- **Connectivity.** Network mode, UPnP, DDNS, a reachability test, and each node's ports and public addresses with a form for ports you forwarded.
- **Nodes.** Each node's status, cadre and owner fingerprint; a node's page adds its log, its code while it waits, and Reset, Retry and Remove.
- **Join.** The **Join a cadre** button, the invitation field, and the nodes still waiting.
- **Settings.** Updates, claim code addresses and install details.

## Files it writes

The default data directory is `~/.local/share/cadre-host` on Linux (or `$XDG_DATA_HOME/cadre-host`), `~/Library/Application Support/CadreHost` on macOS and `%LocalAppData%\CadreHost` on Windows.

| Path | Contents |
|---|---|
| `<dataDir>/host.config.json` | Install settings |
| `<dataDir>/nat.json` | Network mode, UPnP, forwarded ports, DDNS hostname |
| `<dataDir>/hosted-nodes.json` | One record per node, including claim secrets and invitations |
| `<dataDir>/update-state.json` | Last update check and its result |
| `<dataDir>/nat-secrets.json` | DDNS token and push keys, only when no OS keychain is available |
| `<dataDir>/orchestrator/state.json` | Running processes and their ports |
| `<dataDir>/orchestrator/<id>/` | One node: `identity.key`, `cadre.json`, `storage/`, `node.log`, and the node's own state files |
| `<dataDir>/logs/` | Service output on macOS and Windows |
| `~/.config/systemd/user/cadre-host.service` | Linux service unit |
| `~/Library/LaunchAgents/com.serfab.cadre-host.plist` | macOS LaunchAgent |

With a keychain, secrets are stored there under the service name `sereus-cadre-host`. Without one, cadre-host prints a warning and uses `nat-secrets.json` with mode 0600. Windows has no file modes, so that file is readable by other accounts that can reach the folder. When push credentials are configured, each node's `cadre.json` also contains them.

A node whose `identity.key` is lost cannot be restored; the owner removes it from the cadre and claims a new one.

## Limits

- **Per-user install only.** `cadre-host install --system` fails. There is no install under a dedicated system user.
- **No login.** Any account on the machine can call the management API. Do not run cadre-host on a machine with users you do not trust.
- **Carrier-grade NAT.** A node behind it cannot be reached from outside the home network, because hosted nodes do not use relays.
- **UPnP only.** NAT-PMP is not supported, and some older routers' UPnP is not found. Forward ports by hand in those cases.
- **Updates use `npm install -g`.** They update a global install whose npm prefix your account can write. A folder install is not updated by **Apply**: run `npm install @serfab/cadre-host@latest` in its folder and restart the service.
- **No storage limit.** A node stores all the shared data of its cadre's strands.
- **Hosted nodes send no push wake.** [Push credentials](#push-credentials) says why.
- **NSSM is not bundled.** On Windows you install it yourself.

## Development

`yarn workspace @serfab/cadre-host build` compiles the server and builds the UI into `dist/ui/`. Without the UI build the server still answers the API and serves a placeholder page. `yarn workspace @serfab/cadre-host dev:ui` runs the UI on port 5173 and proxies API calls to `127.0.0.1:8765` (or `CADRE_HOST_PORT`).

Every command needs a `###` heading under [CLI reference](#cli-reference) in this file; `src/bin/__tests__/cli-reference.test.ts` checks both directions.

## More

- [cadre-host design](https://github.com/gotchoices/sereus/blob/master/docs/hosting/cadre-host.md): deployment model, joining, respawn, NAT, updates.
- [cadre-host management API](https://github.com/gotchoices/sereus/blob/master/docs/hosting/cadre-host-api.md): routes, events and writable settings.
- [Adding and removing machines](https://github.com/gotchoices/sereus/blob/master/docs/cadre/membership.md): claims and cadre invitations.
- [Concepts](https://github.com/gotchoices/sereus/blob/master/docs/concepts.md): cadres, parties, strands.
