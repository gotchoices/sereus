# @serfab/cadre-host

Self-hosted cadre node manager for basement-PC deployments. Runs one always-on machine whose job is to **donate cadre nodes to other people's cadres**: a friend or family member keeps their own device as the authority for their cadre, and your box contributes always-on capacity by running an extra node that joins *theirs*. It exposes a localhost web UI to manage that. It holds no owner key and never runs a cadre of its own.

The sibling of [`@serfab/cadre-provider`](../cadre-provider/README.md): the provider donates nodes to paying tenants with API keys, billing, and Docker; cadre-host donates them for free to a handful of people you trust, as native child processes, with a one-shot installer.

Who may ask for a node is gated by **grant tokens** you hand out. The NAT/DDNS layer (`/nat/*`) maps the ports of every node this machine runs.

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

From inside `~/cadre`, `npx cadre-host <command>` runs the local binary (`grant`, `nat`, `uninstall`, …) without any path prefix — `npx` resolves it from `node_modules/.bin/`. **Caveat:** outside `~/cadre`, `npx cadre-host` won't find the local install and will silently download a fresh copy from the npm registry. To avoid that, either always `cd ~/cadre` first or symlink the binary onto your PATH:

```bash
ln -s ~/cadre/node_modules/.bin/cadre-host ~/.local/bin/cadre-host
# now `cadre-host grant issue …` works from anywhere
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

## After install — donating your first node

`cadre-host install` leaves you with a running management service, a local UI, and **no cadre nodes yet**. cadre-host never pre-spawns nodes; each one materializes when someone you trust asks for one. This walkthrough goes from "install just finished" to "first donated node is running."

This host's whole job is to lend always-on capacity to *other people's* cadres: your friend's phone stays the authority for their cadre, and your box runs an extra node that joins **theirs**. Your host never holds their owner key and never becomes the authority for their data. See [docs/cadre-host.md § Node donation](../../docs/cadre-host.md#node-donation) for the full lifecycle.

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

### 3. Issue your first grant token

Decide whose cadre you want to help keep online — a family member, a friend, or your own phone. That person already has (or is about to create) **their own** cadre; you are donating capacity to it, not enrolling them into anything of yours.

Before anyone can ask, you issue them a **grant token**: a bearer credential meaning "this person may ask my host to donate nodes."

```bash
cadre-host grant issue "<label>"
```

`<label>` is a human-readable name **you** choose to identify this grantee in your grant list. It's purely for your own bookkeeping — the system doesn't use it for anything. Quote it if it has spaces. Examples:

```bash
cadre-host grant issue "Mom's cadre"
cadre-host grant issue alice
cadre-host grant issue "Friend — hobby group"
```

The command prints two things — a terminal-rendered QR code and the encoded token — both representing the same secret. The recipient can use either form. `--max-nodes N` caps how many donated nodes that grantee may keep running here at once (default 1); `--ttl 30d` gives the grant an expiry (`s`/`m`/`h`/`d` suffixes) — omit it and the grant never expires; `--no-qr` prints only the token.

Hand the QR or token to the grantee in person if possible. **Anyone who gets the token can claim what it grants — the right to make your machine run nodes for them** — so treat it like a password. One difference from a cadre invitation: a grant is **not** one-time. It stays spendable, up to `--max-nodes` at a time, until it expires or you revoke it.

### 4. The grantee requests a node

The grantee's cadre authority — typically their phone — presents the grant token as `Authorization: Bearer <grant-token>` and drives the donation lifecycle against your host:

1. `POST /grants` with their party id, owner public key(s) and, optionally, bootstrap addresses → your host spawns a child cadre node that pins **their** owner key and joins **their** cadre. Each bootstrap address given must be a full multiaddr naming both where to reach the peer and who it is (`/dns4/…/tcp/443/wss/p2p/12D3KooW…`); anything the donated node could not dial is refused as `400 invalid_request` naming the bad entry, before anything is spawned. A phone sends none: nothing can dial a phone, so it dials the node instead.
2. `GET /grants/:id/peer` → the new node's peerId and multiaddrs, including the WebSocket (`/ws`) address a phone dials.
3. Their device signs a seed for that peer and `PUT /grants/:id/seed` hands it back; the node accepts it precisely because their owner key was pinned at spawn.
4. `DELETE /grants/:id` when they're done — the node is stopped and removed.

At that moment:

- cadre-host spawns a child cadre-node process for this grantee's cadre (the manager itself never joins a cadre).
- The node appears on the Nodes page of the UI, and the grant it was spent against shows up in `cadre-host grant list`.
- The node stays up: if it crashes or dies in a reboot, cadre-host respawns it from the donation's recorded spawn inputs.

Until someone requests a node, the Nodes page in the UI stays empty — that's expected.

**What is not built yet (v1):** `/grants` mounts on the same loopback-only management server as everything else, so today a grantee can only reach it from *this machine* or through an SSH tunnel like the one in step 2. Letting a friend's phone reach it across the internet is not done, and no app drives the four calls above for you yet — it is raw HTTP today. Issuing grants and running donated nodes work now; the last hop from a remote phone does not.

### 5. Manage grants

The dashboard's **Grants** page (`cadre-host ui`, then *Grants*) does everything below from the browser: issue a grant (with the same QR code and copyable token), see how many nodes each grant is using and which ones, show an active grant's token again to re-share it, and revoke a grant with or without its nodes. From the command line:

```bash
$ cadre-host grant list
Grants:
  Zx8kq1...   Mom's cadre           live=1 max=2
  Ld93af...   Friend — hobby group  live=0 max=1  (expires 2026-09-01T12:00:00Z)
```

Revoke a grant:

```bash
$ cadre-host grant revoke <token>
revoked grant: Zx8kq1...
terminated 2 donated node(s)
```

Revoking denies every future request on that token — including the grantee's own `DELETE /grants/:id`, which is refused (403) once the grant is revoked — and shuts down every node already donated under it: each is stopped and its working directory (its identity key and node-local data) deleted. Pass `--keep-nodes` to revoke without touching the nodes already running; they then stay up until you end them yourself.

To shut down one donated node — under a revoked grant or a live one — use its id, which is the id the UI's Nodes page shows (`grn_…`):

```bash
cadre-host grant terminate <donation-id>
```

A donated node's page in the UI offers **Terminate** (the same call) rather than Stop: the respawn supervisor treats a live donation as "expected to be running" and would bring a merely stopped node straight back. Revoking a grant again is safe and ends whatever is still running under it.

## Reachability — can people actually reach your nodes?

Every node this machine runs needs two ports reachable from outside your home network: its libp2p TCP port and its WebSocket port (the one a phone dials). cadre-host asks your router to map both over UPnP as each node starts, and reports per node whether that worked. After installing (and any time your network changes):

```bash
cadre-host nat status     # UPnP and router state, external IP, and per node: mapped / forwarded by hand / unreachable, with what to do
cadre-host nat test       # re-run the probes right now
```

If a node reads `unreachable`, the status says which of its ports to forward on your router and to which address on this machine, then the command that records the external ports you chose:

```bash
cadre-host nat forward grn_abc123 --tcp 10003 --ws 10004   # the ports your router forwards to that node
cadre-host nat forward grn_abc123 --clear                  # forget them
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

The `cadre-host push` group needs **no running service** — the commands write straight to the data dir's secret store and `host.config.json`. Private keys land in the OS keychain when one is available, otherwise a plain-JSON fallback at `<dataDir>/nat-secrets.json` (mode `0600` on POSIX; **on Windows the permission bits don't apply, so any account on the machine can read it** — install keytar's native dependency to avoid that); the non-secret bits (APNs bundle id / sandbox toggle, cooldown, debounce) land in `host.config.json`. Credentials are re-resolved on every node spawn, so a node picks them up the next time it is spawned. Today only a storage node started without pinned owner keys carries them, which a donated node never is.

### `cadre-host status`

Print whether the service is registered and currently active.

```
$ cadre-host status
Service installed: yes
Service running:   yes
```

### `cadre-host ui [--no-browser]`

Print the local-UI URL (e.g. `http://127.0.0.1:8765`) and open it in the default browser. Reads `uiPort` from `host.config.json`; doesn't require the service to be running (if not, the browser will fail to connect — that's feedback enough). Pass `--no-browser` to just print the URL.

### `cadre-host grant issue <label> [--max-nodes N] [--ttl <duration>] [--no-qr]`

Issue a grant token — the credential that lets one person ask this host to donate cadre nodes into *their* cadre. `<label>` is whatever human-readable name helps you track the grantee — quote it if it has spaces. `--max-nodes` caps how many donated nodes that grantee may keep running here at once (default 1); `--ttl` gives the grant an expiry (`s`/`m`/`h`/`d` suffixes, e.g. `30d`) — omit it and the grant never expires. Prints a QR code and the encoded token; `--no-qr` prints the token only.

### `cadre-host grant list`

Print every issued grant token with its label, live donated nodes (`live=`), node cap (`max=`), expiry, and revoked state.

### `cadre-host grant revoke <token> [--keep-nodes]`

Revoke a grant token. Every future request presenting it is denied, the grantee's own `DELETE /grants/:id` included, and every node already donated under it is shut down (stopped, working directory deleted). Prints how many were terminated. `--keep-nodes` revokes only and leaves those nodes running. See [*Manage grants*](#5-manage-grants).

### `cadre-host grant terminate <donation-id>`

Shut down one donated node — stop it and delete its working directory — whatever state its grant is in. `<donation-id>` is the `grn_…` id the Nodes page shows.

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

`--no-service` writes the data dir (`host.config.json`, `nat.json`) and stops there: no OS service is registered and no browser opens. Run the host by hand with `cadre-host start --data-dir <path>`. This is the setup for a test session, for example the phone walkthrough in [`docs/reference-app-rn.md`](../../docs/reference-app-rn.md) ("Borrowing a Node From a cadre-host"). Don't run `start` on top of a service install: the service already binds `uiPort`, and a second host on the same data dir moves to the next free port.

### `cadre-host uninstall [--remove-data] [--yes]`

Stop and deregister the service. Preserves the data dir by default; pass `--remove-data --yes` to wipe node identities, issued grants, donated-node records, NAT state, and update state too.

```bash
cadre-host uninstall                       # stop + deregister, keep data
cadre-host uninstall --remove-data --yes   # also delete the data dir
```

## What `cadre-host start` does today

`start` loads `host.config.json`, brings up the orchestrator, the NAT layer, the donation grant layer, and the update service, and binds the Fastify management server on `127.0.0.1:<uiPort>` (loopback only). Routes:

- `/grants-admin` (issue/list/revoke grants, where revoke also shuts down the grant's donated nodes unless `?keepNodes=true`, and `DELETE /grants-admin/donations/:id` to shut down one donated node — no bearer; same-machine admin) and `/grants` (the bearer-gated surface a grantee drives to request, seed, and release a donated node) — the always-on donor surface.
- `/update/*` (update flow) — matches the CLI's contract.
- `/nat/*` (NAT/DDNS) — every hosted node's ports are mapped, and `PUT /nat/nodes/:nodeId/forward` records the ports you forwarded by hand (what `cadre-host nat forward` calls).
- `/api/status`, `/api/nodes`, `/api/nodes/:id`, `/api/nodes/:id/logs`, `/api/settings`, `/api/events` (Server-Sent Events) — the local-UI surface consumed by the Svelte SPA. `/api/nodes` is read-only: end a donated node through `/grants-admin`.
- `/` — the SPA bundle (or a placeholder HTML when running from source before the SPA is built — see `6.5.2-cadre-host-local-ui-spa`).

If the configured `uiPort` is in use the server tries `uiPort+1..uiPort+9`; on total failure it exits with a message listing every port attempted. An origin guard rejects requests whose `Host` or `Origin` is not `127.0.0.1[:port]` / `localhost[:port]` (defeats DNS-rebind from a malicious page). There is no login — the security model is "same machine as the cadre-host user" (see threat model below).

## Updates

cadre-host checks `https://releases.serfab.io/cadre-host/latest.json` once per `start` and every 24 hours thereafter. **Notify-by-default**: an available update is recorded in `<dataDir>/update-state.json` and surfaced by the local UI; the user clicks "apply" to install it. Auto-apply is opt-in via the local-UI settings page (writes `updates.autoApply: true` into `host.config.json`).

The manifest URL is overridable two ways:
- `CADRE_HOST_UPDATE_MANIFEST_URL` env var (wins over config).
- `updates.manifestUrl` in `host.config.json` (settable from the local UI).

Manifests are signed with Ed25519; cadre-host refuses to apply any release whose signature doesn't match the embedded release key. For CI / dev signing, set `CADRE_HOST_UPDATE_DEV_KEY` to a base64-encoded raw 32-byte public key.

**Threat model.** Any local process running as the cadre-host user can fully control cadre-host (read node identities, issue or revoke grants, install arbitrary global packages). Signature verification protects against a compromised release CDN — it is **not** a defense against local-machine compromise. Treat the host like any other long-running service: limit who can run shells as that user, keep the OS patched, and rely on grant tokens for inter-cadre auth.

Apply flow: re-fetch + re-verify the manifest, record `applyInProgress`, run `npm install -g @serfab/cadre-host@<version>` (5-minute timeout), and restart the OS service unit so the new binary takes effect. On install failure, the previous version is reinstalled and the error is surfaced via `update-state.json` — the still-running binary continues to serve. The service-host restart is best-effort; if it fails, the binary swap already succeeded and the user can restart manually.

## Local UI

`cadre-host start` serves a Svelte 5 SPA at `http://127.0.0.1:<uiPort>/`. **Local-only by design:** the server binds to loopback (`127.0.0.1`) only and rejects requests whose `Host` or `Origin` header is not a loopback hostname, so the UI is unreachable from your LAN even though it has no login. To use it from another machine, SSH-port-forward as shown in [*After install*, step 2](#2-open-the-local-ui).

Five pages cover the day-to-day operations:

- **Home / Status** — green/yellow/red dot, service version + uptime, "update available" banner, a connectivity tile ("N of M nodes reachable from outside", or plainly that none can be, linking to Connectivity) and a Donation tile linking to Grants.
- **Nodes** — per-managed-node detail, recent stats, log tail (last 200 lines, "Refresh" pulls again). A donated node has **Terminate**, the same as `cadre-host grant terminate <id>`. `cadre-host` v1 doesn't auto-spawn nodes, so this list is empty until a grantee requests a donated node.
- **Grants** — issue grant tokens (QR + copy), see each grant's node usage and the donated nodes under it (linked to their node pages), show an active grant's token again, revoke a grant with or without its nodes. Same `/grants-admin` surface as `cadre-host grant`.
- **Settings** — update preferences (autoApply toggle, manifest URL override), install metadata (install ID, data dir, UI port), uninstall pointer.
- **Connectivity** — UPnP and router status, "Test reachability", a carrier-grade NAT notice when detected, UPnP toggle and DDNS provider configuration; then one entry per hosted node with its reachability, its TCP and WebSocket ports (internal → external, and whether UPnP or a hand forward provides the route), its public addresses (copyable), what to forward when it cannot be reached, and an "I forwarded these ports" form. A node's page shows the same entry for that node.
The SPA opens an `EventSource` against `/api/events` and re-fetches the relevant slice when a node state changes, the grants change, connectivity changes, or an update is announced. No login — the page is bound to loopback only, with an Origin/Host guard for DNS-rebind defence. See the threat-model note in the *Updates* section above and in [docs/cadre-host.md](../../docs/cadre-host.md) for the full security posture.

### Building the SPA

`yarn workspace @serfab/cadre-host build` compiles both the server (TypeScript) and the SPA (`vite build` against `ui/`). The bundle lands in `dist/ui/` and is served by the same Fastify instance that handles `/api/*` and friends. When `dist/ui/` is missing (e.g. running from source without building), the server still answers all API routes and shows a placeholder at `/` explaining how to build.

For UI-only iteration: `yarn workspace @serfab/cadre-host dev:ui` starts Vite on `:5173` and proxies `/api`, `/nat`, `/update`, `/grants-admin` to `127.0.0.1:8765` (override with `CADRE_HOST_PORT`).

## More

- [docs/cadre-host.md](../../docs/cadre-host.md) — persona, package boundary, deployment model, security posture.
- [docs/architecture.md](../../docs/architecture.md) — overall cadre architecture.
