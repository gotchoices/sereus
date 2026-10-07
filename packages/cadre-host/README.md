# @serfab/cadre-host

Self-hosted cadre node manager for basement-PC deployments. Runs one always-on machine whose job is to **run always-on nodes for cadres whose owners claim them from their phones**: you, a friend or a family member keeps their own device as the authority for their cadre, and your box runs a node that joins *theirs*. It exposes a localhost web UI to manage that. It holds no owner key and never runs a cadre of its own.

The sibling of [`@serfab/cadre-provider`](../cadre-provider/README.md): the provider hosts nodes for paying tenants with API keys, billing, and Docker; cadre-host hosts them for free for a handful of people you trust, as native child processes, with a one-shot installer.

`cadre-host join` starts a node and shows a QR code; the phone that owns the cadre scans it to claim the node. The NAT/DDNS layer (`/nat/*`) maps the ports of every node this machine runs.

[docs/cadre-host.md](../../docs/cadre-host.md) is the design source of truth.

## Install

cadre-host installs entirely within your user account. **No step requires root**, with one optional exception (`loginctl enable-linger`) called out under *Root requirements* below.

Pick whichever install style suits you:

### Global install (binary on PATH)

```bash
npm install -g @serfab/cadre-host    # sudo only if your npm prefix is system-owned (e.g. /usr/lib)
cadre-host install
```

### Local install (self-contained — recommended if you want everything under one folder)

```bash
mkdir -p ~/cadre && cd ~/cadre
npm install @serfab/cadre-host
npx cadre-host install --data-dir ~/cadre/data
```

From inside `~/cadre`, `npx cadre-host <command>` runs the local binary (`join`, `nat`, `uninstall`, …) without any path prefix — `npx` resolves it from `node_modules/.bin/`. **Caveat:** outside `~/cadre`, `npx cadre-host` won't find the local install and will silently download a fresh copy from the npm registry. To avoid that, either always `cd ~/cadre` first or symlink the binary onto your PATH:

```bash
ln -s ~/cadre/node_modules/.bin/cadre-host ~/.local/bin/cadre-host
# now `cadre-host join` works from anywhere
```

If you'd rather skip `npx` and the symlink, the explicit path `./node_modules/.bin/cadre-host <command>` always works from `~/cadre` too.

The wizard (run either way):

1. Prompts for the data directory, UI port, UPnP toggle and whether to configure DDNS now (defaults shown in `[...]`).
2. Writes `<dataDir>/host.config.json` and seeds `<dataDir>/nat.json` with the UPnP choice.
3. Registers a per-user service: `systemctl --user` unit (Linux), `LaunchAgent` (macOS), or NSSM service (Windows; requires `nssm.exe` on PATH — see `service/README.md`).
4. Opens `http://127.0.0.1:<uiPort>/` in your browser.

Run `cadre-host install --non-interactive --data-dir <path>` for unattended provisioning.

### Root requirements

The installer never writes outside your home directory. On Linux the unit goes to `$XDG_CONFIG_HOME/systemd/user/cadre-host.service` (default `~/.config/systemd/user/cadre-host.service`); the data dir defaults to `$XDG_DATA_HOME/cadre-host` (default `~/.local/share/cadre-host`) or wherever you point `--data-dir`. Registering a `systemctl --user` unit does **not** require root — any user can do it.

There is **one optional** root command:

```bash
sudo loginctl enable-linger <your-user>
```

`enable-linger` is what allows your `systemctl --user` services to start at boot and keep running after you log out. Without linger, cadre-host runs only while you have an active session (desktop login or SSH) and stops when that session ends. With linger, it runs whenever the machine is on.

The installer attempts `loginctl enable-linger` for you and logs a warning if it can't (you aren't root, `loginctl` is missing, running inside a container, …). **The install succeeds either way** — you can enable linger separately, before or after `cadre-host install`. Without linger you can still verify everything by logging in and running `systemctl --user start cadre-host` by hand.

### System-wide install (not yet supported)

`cadre-host install --system` is accepted by the CLI but currently errors out. A proper system-wide install — dedicated `cadre` user, unit at `/etc/systemd/system/`, install under `/opt/cadre/...` — needs additional work around data-dir ownership and capability dropping and is tracked separately.

### Service-host details

The rendered unit files live at:

| Platform | Path |
| -------- | ---- |
| Linux    | `~/.config/systemd/user/cadre-host.service` |
| macOS    | `~/Library/LaunchAgents/com.serfab.cadre-host.plist` |
| Windows  | NSSM-managed service `CadreHost` (registry-stored config) |

See [`service/README.md`](./service/README.md) for templates, manual-smoke instructions, and the cross-platform CI gap.

## After install — joining your first cadre

`cadre-host install` leaves you with a running management service, a local UI, and **no cadre nodes yet**. cadre-host never pre-spawns nodes; each one starts when you click **Join a cadre** in the local UI or run `cadre-host join`. This walkthrough goes from "install just finished" to "first hosted node is claimed."

This host's whole job is to run always-on nodes for *other people's* cadres: your friend's phone stays the authority for their cadre, and your box runs a node that joins **theirs**. Your host never holds their owner key and never becomes the authority for their data. See [docs/cadre-host.md § Hosted nodes: Join a cadre](../../docs/cadre-host.md#hosted-nodes-join-a-cadre) for the full lifecycle.

### 1. Verify the service is running

```bash
systemctl --user status cadre-host
```

Look for `Active: active (running)`. If it's not active, `journalctl --user -u cadre-host -f` shows the live log.

### 2. Open the local UI

The UI listens on `http://127.0.0.1:<uiPort>/` (default port 8765) on the host machine itself.

- **On the host:** open the URL in a browser, or run `cadre-host ui` to print + open it.
- **From a different machine on your LAN** (most basement PCs are headless): the UI is bound to loopback only and has no authentication — that's intentional, the trust boundary is "same machine, same user as cadre-host." Use SSH port-forwarding from the client side:

  ```bash
  # from your laptop:
  ssh -L 8765:127.0.0.1:8765 user@my-basement-pc
  # then open http://127.0.0.1:8765 in the laptop's browser
  ```

  The forward stays up as long as the SSH session does.

### 3. Join your cadre

Decide whose cadre this node is for — a family member, a friend, or your own phone. That person already has **their own** cadre on their phone; you are adding a node to it, not enrolling them into anything of yours.

In the local UI, open **Join** and click **Join a cadre**. The page starts the node and shows a QR code and the same text with a copy button. Scan the code with the Sereus app on the phone that owns the cadre, or paste the text into it. The line under the node changes to `Claimed by owner <fingerprint> into cadre <partyId>` once the phone has claimed it, then to `Connected to the cadre`, and the code gives way to a link to the node's page. **Cancel** removes a node nobody has claimed yet. Closing the tab loses nothing: the Join page lists every node still waiting to be claimed.

From a shell instead:

```bash
cadre-host join
```

The command starts the node and prints a QR code and the same text under it, then waits and prints `✓ Claimed by owner <fingerprint> into cadre <partyId>` once the phone has claimed the node; the node now appears on the Nodes page as claimed. `--no-qr` prints only the text (on stdout, alone, so it can be piped); `--no-wait` exits once the code is shown, and the node keeps waiting. Ctrl-C while waiting also leaves the node waiting.

If the page or the command warns that the node cannot be reached from outside your home network, a phone on your home network can still claim it; see [Reachability](#reachability--can-people-actually-reach-your-nodes) for the ports to forward.

To host a node for a friend, join again and let the friend scan the new code. **Anyone who scans the code claims the node**, so show it only to the person it is for; if the wrong person claimed it, **Reset** on the node's page (or `cadre-host node reset <id>`) removes that node and starts a fresh one with a new code.

**The second way: paste an invitation.** Once the cadre already has a member this machine can reach (an always-on node, here or elsewhere), the owner's app can copy a cadre invitation instead of scanning anything. Paste it under **Or paste a cadre invitation** on the Join page, or run:

```bash
cadre-host join --invitation "<the invitation text>"
```

The node starts in the cadre the invitation names and redeems it at one of the cadre's members; the line under it reads `Joining cadre <partyId>…`, then `Joined cadre <partyId> at member <peerId>`. This does not work for a cadre's **first** always-on node: its only members are phones, which nothing can dial, so the join fails with "No member … could be reached". Use the QR code for that one. When no member could be reached because the member is offline for a while, **Retry** on the node (or `cadre-host node retry <id>`) starts it again with the same invitation; an invitation the cadre refused (expired, used up, or made for another device) cannot be retried, so remove the node and join with a fresh one.

### 4. Manage hosted nodes

```bash
cadre-host node list              # id, status, cadre, owner fingerprint, connected
cadre-host node remove <id>       # stop the node and delete its data on this machine
cadre-host node reset <id>        # remove it and start a fresh one with a new code
cadre-host node retry <id>        # start an invitation node again once a member is reachable
```

`<id>` is the `hn_…` id the list and the UI's Nodes page show. Removing a node deletes its record, stops the child and deletes its working directory (its identity key and node-local data); the cadre keeps the node's row until its owner removes it there. A hosted node's page in the UI offers **Remove** and **Reset** (the same calls; **Retry** on a failed node is a reset) rather than Stop: the respawn supervisor treats a claimed, joining or waiting node as expected to be running and would bring a merely stopped node straight back. A node that crashes or dies in a reboot is respawned with the same identity, ports and code, so a QR code already shown stays valid and a claimed node stays in its cadre.

## Reachability — can people actually reach your nodes?

Every node this machine runs needs two ports reachable from outside your home network: its libp2p TCP port and its WebSocket port (the one a phone dials). cadre-host asks your router to map both over UPnP as each node starts, and reports per node whether that worked. After installing (and any time your network changes):

```bash
cadre-host nat status     # UPnP and router state, external IP, and per node: mapped / forwarded by hand / unreachable, with what to do
cadre-host nat test       # re-run the probes right now
```

If a node reads `unreachable`, the status says which of its ports to forward on your router and to which address on this machine, then the command that records the external ports you chose:

```bash
cadre-host nat forward hn_abc123 --tcp 10003 --ws 10004   # the ports your router forwards to that node
cadre-host nat forward hn_abc123 --clear                  # forget them
```

The UI's **Connectivity** page shows the same per node, with an "I forwarded these ports" form. A node whose public addresses change restarts to announce them to the cadre it belongs to, at most once every 10 minutes; a node that restarts or respawns keeps its ports, so the forward stays valid. If your ISP uses carrier-grade NAT, a port forward will not help and the status says so. See [docs/cadre-host.md § Manual port forwarding](../../docs/cadre-host.md#manual-port-forwarding).

When your residential IP changes (it will), members can't find you on the old IP. DDNS (a hostname that auto-updates to your current IP) fixes this:

```bash
# DuckDNS — cadre-host updates the record itself. Sign up at duckdns.org and grab a token first.
cadre-host nat ddns set duckdns --hostname mybox.duckdns.org --token <duckdns-token>

# Externally-managed — your router or another tool updates DNS; cadre-host just records the hostname.
cadre-host nat ddns external --hostname mybox.example.com
```

If you use the DuckDNS form, the token is stored in the OS keychain when `libsecret` is installed (`sudo apt install libsecret-1-0` on Debian/Ubuntu), and unencrypted in `<dataDir>/nat-secrets.json` otherwise. The service logs a warning at startup when it falls back to unencrypted storage.

## CLI reference

All commands except `install`, `uninstall`, `start`, `ui`, and the `push` group talk to the running cadre-host management API over loopback. They print a connection error if the service isn't running.

The `cadre-host push` group needs **no running service** — the commands write straight to the data dir's secret store and `host.config.json`. Private keys land in the OS keychain when one is available, otherwise a plain-JSON fallback at `<dataDir>/nat-secrets.json` (mode `0600` on POSIX; **on Windows the permission bits don't apply, so any account on the machine can read it** — install keytar's native dependency to avoid that); the non-secret bits (APNs bundle id / sandbox toggle, cooldown, debounce) land in `host.config.json`. Credentials are re-resolved on every node spawn, so a node picks them up the next time it is spawned. Every storage-profile node carries them when they are configured, hosted nodes included.

### `cadre-host status`

Print whether the service is registered and currently active.

```
$ cadre-host status
Service installed: yes
Service running:   yes
```

### `cadre-host ui [--no-browser]`

Print the local-UI URL (e.g. `http://127.0.0.1:8765`) and open it in the default browser. Reads `uiPort` from `host.config.json`; doesn't require the service to be running (if not, the browser will fail to connect — that's feedback enough). Pass `--no-browser` to just print the URL.

### `cadre-host join [--no-qr] [--no-wait]`

Start a hosted node waiting to be claimed and show the code the owner's phone scans to add it to their cadre: a QR code and the same text, then (unless `--no-wait`) wait until the phone claims it and print `✓ Claimed by owner <fingerprint> into cadre <partyId>`. `--no-qr` prints the text only, on stdout alone. See [*Join your cadre*](#3-join-your-cadre).

### `cadre-host join --invitation <encoded> [--no-wait]`

Start a hosted node that redeems a cadre invitation the owner's app copied, instead of showing a code: `Joining cadre <partyId> through the invitation…`, then (unless `--no-wait`) wait and print `✓ Joined cadre <partyId> at member <peerId>`, or `✗ Could not join: <message>` and exit 1. When no member could be reached, it says what to do: for the cadre's first always-on node, use `cadre-host join` without `--invitation` and scan the QR code instead; otherwise `cadre-host node retry <id>` once a member is online. An invitation that does not decode is refused before any node starts. See [*Join your cadre*](#3-join-your-cadre).

### `cadre-host node list`

Print every hosted node: id, status (`spawning`, `unclaimed`, `joining`, `joined` or `error`), cadre, owner fingerprint (the first 8 characters of the owner key) and whether a joined node is connected.

### `cadre-host node remove <id>`

Stop one hosted node and delete its data on this machine — its record, the child and its working directory. Its cadre keeps the node's row until the owner removes it there. `<id>` is the `hn_…` id the list shows.

### `cadre-host node reset <id> [--no-qr] [--no-wait]`

Remove a hosted node and start a fresh one with a new code, then show the code and wait as `join` does. For a node someone else claimed first, or one that failed. An invitation node is replaced by one waiting to be claimed too.

### `cadre-host node retry <id> [--no-wait]`

Start an invitation node again after no member of its cadre could be reached, with the same invitation and the same identity, then wait as `join --invitation` does. Refused (409) for any other node, including one whose invitation the cadre refused.

### `cadre-host nat status [--json]`

Print current NAT state — whether UPnP is on and a router was found (and this machine's address on its network), external IP, CGNAT detection, the host-level reachability result and the DDNS configuration — then one block per hosted node: its id and verdict (`mapped`, `manual` or `unreachable`), the TCP and WebSocket ports as internal → external with where the route came from (UPnP or forwarded by hand), and its public addresses. An `unreachable` node adds why, and the forward to make: which ports to forward to which address on this machine, and the `cadre-host nat forward` command to run afterwards. With `--json`, dumps the raw response from the management API.

### `cadre-host nat test [--json]`

Re-run the reachability probe right now and print the updated NAT state. Useful after changing port-forwarding rules on your router.

### `cadre-host nat forward <nodeId> [--tcp <port>] [--ws <port>] [--clear-tcp] [--clear-ws] [--clear]`

Record the external ports your router forwards to one node, by the node id `nat status` shows: `--tcp` for its TCP port, `--ws` for its WebSocket port, `--clear-tcp`/`--clear-ws`/`--clear` to forget them. Ports are whole numbers 1–65535. Prints the node's block from the updated status. If the node's public addresses changed, it restarts to announce them; a node already restarted for an address change in the last 10 minutes waits until those 10 minutes are up. An id the host does not run is refused with a pointer to `nat status`.

### `cadre-host nat settings [--upnp|--no-upnp]`

Turn UPnP port mapping on or off. Turning it off releases every mapping the router granted and keeps the ports you forwarded by hand.

### `cadre-host nat ddns set <provider> --hostname <h> [--token <t>]`

Configure cadre-host to push DNS updates itself. Currently the only `<provider>` is `duckdns`. If `--token` is omitted, the command prompts for it (with echo suppressed) when stdin is a TTY. The token is stored in the OS keychain when available, otherwise unencrypted at `<dataDir>/nat-secrets.json` (a startup warning surfaces this).

### `cadre-host nat ddns external --hostname <h>`

Tell cadre-host that some other tool (your router firmware, a separate `ddclient`, etc.) is updating DNS, and to record the hostname for publishing to peers without trying to update it itself.

### `cadre-host push fcm --project-id <id> --client-email <email> [--private-key-file <path>] [--private-key <pem>] [--data-dir <path>]`

Store Firebase Cloud Messaging (Android) service-account credentials so a storage node can wake suspended mobile apps. The three values come from the Firebase service-account JSON (`project_id`, `client_email`, `private_key`). Supply the key either as a file (`--private-key-file`, preferred) or inline (`--private-key`); with neither, the command exits with an error. See [docs/cadre-host.md § Push credentials](../../docs/cadre-host.md#push-credentials-fcmapns) for how to mint the credentials and how they reach the spawned node.

### `cadre-host push apns --key-id <id> --team-id <id> --bundle-id <id> [--private-key-file <path>] [--private-key <pem>] [--production] [--data-dir <path>]`

Store Apple Push Notification service (iOS) auth-key credentials. `--key-id`/`--team-id` identify the `.p8` auth key downloaded from the Apple Developer portal; `--bundle-id` becomes the `apns-topic`. As with `push fcm`, pass the key via `--private-key-file` (preferred) or `--private-key`. Targets the **sandbox** APNs host by default — pass `--production` for an App Store build. A token minted for one host is rejected by the other, so this must match the build under test.

### `cadre-host push options [--cooldown-ms <ms>] [--debounce-ms <ms>] [--data-dir <path>]`

Set the non-secret push tuning knobs: `--cooldown-ms` is the minimum gap between wakes for one (peer, strand) pair (anti-spam), `--debounce-ms` the per-strand burst-coalescing window. Pass only the flag(s) you want to change.

### `cadre-host push clear <target> [--data-dir <path>]`

Remove stored push credentials. `<target>` is `fcm`, `apns`, or `all`. Clearing `apns` also drops the bundle id / sandbox toggle from `host.config.json`. With nothing configured, no `push` block is written into the spawned node's `cadre.json` and the node falls back to control-network push-wake only.

### `cadre-host push status [--data-dir <path>]`

Print which push platforms are configured, the APNs bundle id and sandbox/production mode, and the current cooldown/debounce values. Never prints key material.

### `cadre-host start [--data-dir <path>] [--no-tui]`

Run cadre-host in the foreground. Normally invoked by the service unit, not directly; after `install --no-service` it is how the host runs. `--data-dir` overrides the install-time data directory (also honors `$CADRE_HOST_DATA_DIR`).

### `cadre-host install [--no-service] [...flags]`

Run the first-run wizard. See [**Install**](#install) at the top of this README.

`--no-service` writes the data dir (`host.config.json`, `nat.json`) and stops there: no OS service is registered and no browser opens. Run the host by hand with `cadre-host start --data-dir <path>`. This is the setup for a test session, for example a phone walkthrough against a host run from a checkout ([`docs/reference-app-rn.md`](../../docs/reference-app-rn.md)). Don't run `start` on top of a service install: the service already binds `uiPort`, and a second host on the same data dir moves to the next free port.

### `cadre-host uninstall [--remove-data] [--yes]`

Stop and deregister the service. Preserves the data dir by default; pass `--remove-data --yes` to wipe node identities, hosted-node records, NAT state, and update state too.

```bash
cadre-host uninstall                       # stop + deregister, keep data
cadre-host uninstall --remove-data --yes   # also delete the data dir
```

## What `cadre-host start` does today

`start` loads `host.config.json`, brings up the orchestrator, the NAT layer, the hosted-node service with its watcher and supervisor, and the update service, and binds the Fastify management server on `127.0.0.1:<uiPort>` (loopback only). Routes:

- `/api/hosted-nodes` (list, start a node waiting to be claimed or one that redeems an invitation, its claim details, remove, reset, retry — no bearer; same-machine admin) — the surface `cadre-host join` and `cadre-host node` drive.
- `/update/*` (update flow) — matches the CLI's contract.
- `/nat/*` (NAT/DDNS) — every hosted node's ports are mapped, and `PUT /nat/nodes/:nodeId/forward` records the ports you forwarded by hand (what `cadre-host nat forward` calls).
- `/api/status`, `/api/nodes`, `/api/nodes/:id`, `/api/nodes/:id/logs`, `/api/settings`, `/api/events` (Server-Sent Events) — the local-UI surface consumed by the Svelte SPA. `/api/nodes` is read-only: end a hosted node through `DELETE /api/hosted-nodes/:id`.
- `/` — the SPA bundle (or a placeholder HTML when running from source before the SPA is built — see `6.5.2-cadre-host-local-ui-spa`).

If the configured `uiPort` is in use the server tries `uiPort+1..uiPort+9`; on total failure it exits with a message listing every port attempted. An origin guard rejects requests whose `Host` or `Origin` is not `127.0.0.1[:port]` / `localhost[:port]` (defeats DNS-rebind from a malicious page). There is no login — the security model is "same machine as the cadre-host user" (see threat model below).

## Updates

cadre-host checks `https://releases.serfab.io/cadre-host/latest.json` once per `start` and every 24 hours thereafter. **Notify-by-default**: an available update is recorded in `<dataDir>/update-state.json` and surfaced by the local UI; the user clicks "apply" to install it. Auto-apply is opt-in via the local-UI settings page (writes `updates.autoApply: true` into `host.config.json`).

The manifest URL is overridable two ways:
- `CADRE_HOST_UPDATE_MANIFEST_URL` env var (wins over config).
- `updates.manifestUrl` in `host.config.json` (settable from the local UI).

Manifests are signed with Ed25519; cadre-host refuses to apply any release whose signature doesn't match the embedded release key. For CI / dev signing, set `CADRE_HOST_UPDATE_DEV_KEY` to a base64-encoded raw 32-byte public key.

**Threat model.** Any local process running as the cadre-host user can fully control cadre-host (read node identities, start or remove hosted nodes, install arbitrary global packages). Signature verification protects against a compromised release CDN — it is **not** a defense against local-machine compromise. Treat the host like any other long-running service: limit who can run shells as that user, keep the OS patched, and show a join code only to the person it is for.

Apply flow: re-fetch + re-verify the manifest, record `applyInProgress`, run `npm install -g @serfab/cadre-host@<version>` (5-minute timeout), and restart the OS service unit so the new binary takes effect. On install failure, the previous version is reinstalled and the error is surfaced via `update-state.json` — the still-running binary continues to serve. The service-host restart is best-effort; if it fails, the binary swap already succeeded and the user can restart manually.

## Local UI

`cadre-host start` serves a Svelte 5 SPA at `http://127.0.0.1:<uiPort>/`. **Local-only by design:** the server binds to loopback (`127.0.0.1`) only and rejects requests whose `Host` or `Origin` header is not a loopback hostname, so the UI is unreachable from your LAN even though it has no login. To use it from another machine, SSH-port-forward as shown in [*After install*, step 2](#2-open-the-local-ui).

Five pages cover the day-to-day operations:

- **Home / Status** — green/yellow/red dot, service version + uptime, "update available" banner, a connectivity tile ("N of M nodes reachable from outside", or plainly that none can be, linking to Connectivity), a hosted-nodes tile ("N joined, M waiting", plus failed ones when there are any, linking to Join), and the running-node count.
- **Connectivity** — UPnP and router status, "Test reachability", a carrier-grade NAT notice when detected, UPnP toggle and DDNS provider configuration; then one entry per hosted node, labelled with the cadre it joined, "waiting to be claimed" or "joining cadre <partyId>", with its reachability, its TCP and WebSocket ports (internal → external, and whether UPnP or a hand forward provides the route), its public addresses (copyable), what to forward when it cannot be reached, and an "I forwarded these ports" form. A node's page shows the same entry for that node.
- **Nodes** — one row per hosted node with its status, cadre, owner fingerprint and whether it is connected. A node's page adds recent stats, the log tail (last 200 lines, "Refresh" pulls again) and a **Cadre** card: the code and **Cancel** while it waits to be claimed, **Cancel** while it redeems an invitation, **Reset** and **Remove** once joined (**Remove** alone for an invitation node), **Retry** and **Remove** when it failed (for an invitation node, **Retry** only when no member could be reached). cadre-host doesn't auto-spawn nodes, so this list is empty until you join a cadre.
- **Join** — the **Join a cadre** button and the **Or paste a cadre invitation** field, then each node waiting to be claimed with its QR code, its text, its reachability and a live line that follows the claim, and each node redeeming an invitation with its live line, or its error, the first-node hint and **Retry** when no member could be reached (see [*After install*, step 3](#3-join-your-cadre)).
- **Settings** — update preferences (autoApply toggle, manifest URL override), install metadata (install ID, data dir, UI port), uninstall pointer.

The SPA opens an `EventSource` against `/api/events` and re-fetches the relevant slice when a node state changes, a hosted node is added, claimed, joins, fails or is removed, connectivity changes, or an update is announced. No login — the page is bound to loopback only, with an Origin/Host guard for DNS-rebind defence. See the threat-model note in the *Updates* section above and in [docs/cadre-host.md](../../docs/cadre-host.md) for the full security posture.

### Building the SPA

`yarn workspace @serfab/cadre-host build` compiles both the server (TypeScript) and the SPA (`vite build` against `ui/`). The bundle lands in `dist/ui/` and is served by the same Fastify instance that handles `/api/*` and friends. When `dist/ui/` is missing (e.g. running from source without building), the server still answers all API routes and shows a placeholder at `/` explaining how to build.

For UI-only iteration: `yarn workspace @serfab/cadre-host dev:ui` starts Vite on `:5173` and proxies `/api`, `/nat`, `/update` to `127.0.0.1:8765` (override with `CADRE_HOST_PORT`).

## More

- [docs/cadre-host.md](../../docs/cadre-host.md) — persona, package boundary, deployment model, security posture.
- [docs/architecture.md](../../docs/architecture.md) — overall cadre architecture.
