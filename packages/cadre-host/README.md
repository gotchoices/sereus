# @serfab/cadre-host

Self-hosted cadre node manager for basement-PC deployments. Runs one always-on machine whose primary job is to **donate cadre nodes to other people's cadres**: a friend or family member keeps their own device as the authority for their cadre, and your box contributes always-on capacity by running an extra node that joins *theirs*. It exposes a localhost web UI to manage that, and can optionally also run a personal cadre of your own.

The sibling of [`@serfab/cadre-provider`](../cadre-provider/README.md): the provider donates nodes to paying tenants with API keys, billing, and Docker; cadre-host donates them for free to a handful of people you trust, as native child processes, with a one-shot installer.

cadre-host has **two independent roles**, and only the first is on by default:

- **Node donor (primary, always on).** Contribute nodes to cadres *other people* own. Who may ask is gated by **grant tokens** you hand out. Needs no cadre of your own.
- **Founder (opt-in — `ownCadre.enabled` in `host.config.json`, default `false`).** *Also* run your own personal cadre on this machine. This is what turns on the trust circle (`/auth/*`) and the NAT/DDNS layer (`/nat/*`); both are unmounted and 404 until you enable it.

[docs/cadre-host.md](../../docs/cadre-host.md) is the design source of truth for both roles.

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

From inside `~/cadre`, `npx cadre-host <command>` runs the local binary (`grant`, `invite`, `nat`, `uninstall`, …) without any path prefix — `npx` resolves it from `node_modules/.bin/`. **Caveat:** outside `~/cadre`, `npx cadre-host` won't find the local install and will silently download a fresh copy from the npm registry. To avoid that, either always `cd ~/cadre` first or symlink the binary onto your PATH:

```bash
ln -s ~/cadre/node_modules/.bin/cadre-host ~/.local/bin/cadre-host
# now `cadre-host grant issue …` works from anywhere
```

If you'd rather skip `npx` and the symlink, the explicit path `./node_modules/.bin/cadre-host <command>` always works from `~/cadre` too.

The wizard (run either way):

1. Prompts for the data directory, UI port, libp2p port, UPnP toggle, and whether to **also run your own personal cadre on this machine** — the opt-in founder role, default **no** (defaults shown in `[...]`).
2. Generates a fresh Ed25519 node identity (`<dataDir>/identity.key`, mode 600 on POSIX).
3. Writes `<dataDir>/host.config.json` and seeds `<dataDir>/nat.json` with the chosen libp2p port.
4. Registers a per-user service: `systemctl --user` unit (Linux), `LaunchAgent` (macOS), or NSSM service (Windows; requires `nssm.exe` on PATH — see `service/README.md`).
5. Opens `http://127.0.0.1:<uiPort>/` in your browser.
6. **Founder installs only, and only when interactive:** issues a 24-hour enrollment invite for your own cadre and prints it as both a QR code and a paste-friendly token. A donor-only install has no cadre of its own to enroll into, so this step is silently skipped — you hand out a grant token instead (see [*After install*](#after-install--donating-your-first-node)).

Run `cadre-host install --non-interactive --data-dir <path>` for unattended provisioning; add `--own-cadre` to enable the founder role without prompting.

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

It assumes the **default install — donor-only**, i.e. you answered *no* to the wizard's *"Also run your own personal cadre on this machine?"*. In that mode this host's whole job is to lend always-on capacity to *other people's* cadres: your friend's phone stays the authority for their cadre, and your box runs an extra node that joins **theirs**. Your host never holds their owner key and never becomes the authority for their data. See [docs/cadre-host.md § Node donation](../../docs/cadre-host.md#node-donation-the-primary-role) for the full lifecycle.

If you answered *yes*, everything below still applies — you additionally get the opt-in **founder** surfaces, covered in [the founder section](#the-founder-role--running-your-own-cadre-here-opt-in) after step 5.

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

Hand the QR or token to the grantee in person if possible. **Anyone who gets the token can claim what it grants — the right to make your machine run nodes for them** — so treat it like a password. One difference from a trust-circle invite: a grant is **not** one-time. It stays spendable, up to `--max-nodes` at a time, until it expires or you revoke it.

Terminology aside: your **trust circle** in the everyday sense is the handful of people you have handed a grant token to — the people allowed to have a node donated to them here. Don't confuse it with the *feature* named trust circle (`cadre-host trust`, the `/auth/*` routes, the UI's Trust Circle page): that one is membership in the host's **own** cadre and exists only in the founder role.

### 4. The grantee requests a node

The grantee's cadre authority — typically their phone — presents the grant token as `Authorization: Bearer <grant-token>` and drives the donation lifecycle against your host:

1. `POST /grants` with their party id, bootstrap addresses, and owner public key(s) → your host spawns a child cadre node that pins **their** owner key and joins **their** cadre.
2. `GET /grants/:id/peer` → the new node's peerId and multiaddrs.
3. Their device signs a seed for that peer and `PUT /grants/:id/seed` hands it back; the node accepts it precisely because their owner key was pinned at spawn.
4. `DELETE /grants/:id` when they're done — the node is stopped and removed.

At that moment:

- cadre-host spawns a child cadre-node process for this grantee's cadre (the manager itself never joins a cadre).
- The node appears on the Nodes page of the UI, and the grant it was spent against shows up in `cadre-host grant list`.
- The node stays up: if it crashes or dies in a reboot, cadre-host respawns it from the donation's recorded spawn inputs.

Until someone requests a node, the Nodes page in the UI stays empty — that's expected.

**What is not built yet (v1):** `/grants` mounts on the same loopback-only management server as everything else, so today a grantee can only reach it from *this machine* or through an SSH tunnel like the one in step 2. Letting a friend's phone reach it across the internet is deferred (`backlog/feat-cadre-host-wan-grant-reachability`), and no app drives the four calls above for you yet — it is raw HTTP today. Issuing grants and running donated nodes work now; the last hop from a remote phone does not.

### 5. Manage grants

```bash
$ cadre-host grant list
Grants:
  Zx8kq1...   Mom's cadre           max=2
  Ld93af...   Friend — hobby group  max=1  (expires 2026-09-01T12:00:00Z)
```

Revoke a grant:

```bash
cadre-host grant revoke <token>
```

Revoking denies every future request on that token — including the grantee's own `DELETE /grants/:id`, which is refused (403) once the grant is revoked.

**Nodes already donated under it keep running, and there is no supported way to tear them down from the host side yet.** Stopping one from the UI's Nodes page does not stick: the respawn supervisor treats a live donation as "expected to be running" and brings it straight back. So if you want a node *gone*, ask the grantee to release it with `DELETE /grants/:id` **before** you revoke the grant. Tracked as `backlog/bug-cadre-host-donated-node-teardown-unavailable`.

## The founder role — running your own cadre here (opt-in)

Everything above needs no cadre of your own. If you *also* want this machine to run your **own** personal cadre — your devices, your trust circle, your data — that is the **founder** role. It is opt-in: answer *yes* to the wizard's *"Also run your own personal cadre on this machine?"*, or install with `cadre-host install --own-cadre`. It is stored as `ownCadre.enabled` in `<dataDir>/host.config.json` (default **false**) and is install-time only — to change it later, edit that file and restart the service.

Until it is enabled, the founder-only surfaces are **not mounted** and return **404**:

| Surface | Commands | Local UI page |
| --- | --- | --- |
| `/auth/*` — trust circle | `cadre-host invite`, `cadre-host trust list`, `cadre-host trust revoke` | Trust Circle |
| `/nat/*` — NAT/DDNS | `cadre-host nat …` | Connectivity |
| `/api/strands` | — | Strands |

So if you followed the default install and `cadre-host invite` or `cadre-host nat status` reports a 404, nothing is broken — those belong to a role you didn't turn on. The UI still lists those three pages in its nav and they error when opened on a donor-only install; that's a known gap, not a misconfiguration.

The rest of this section applies **only** with the founder role enabled.

### Enrolling your own devices (founder role)

```bash
cadre-host invite "<label>"
```

Same bookkeeping-only `<label>` rule as a grant. The command prints a QR code and an encoded invite string — both representing the same single-use token. By default the token expires in 24 hours; override with `--ttl 7d` (or `30m`, `1h`, etc.).

Hand the QR or token to the device's owner in person if possible. **Anyone who gets the token can claim the cadre identity it grants**, so treat it like a one-time password.

On the invitee's device, they install a cadre-aware app — the React Native reference app at [`@serfab/reference-app-rn`](../reference-app-rn), or any sApp built on `@serfab/cadre-core` — and scan or paste the invite. The app dials your cadre-host over libp2p (NAT/DDNS permitting; see below) and redeems the token, which authorizes their peer in *your* cadre and lets them participate in its strands (shared SQL databases).

```bash
$ cadre-host trust list
Members:
  12D3KooWHcdEf...  kyle's laptop  [self]
  12D3KooW2aB...    Mom's phone

Pending invites:
  invite_a3f8...    Friend — tablet  (expires 2026-06-01T12:00:00Z)
```

A **peerId** is a libp2p identity string — for the common Ed25519 case it starts with `12D3Koo...` (you'll also see `16Uiu2HAm...` for secp256k1 or `Qm...` for legacy RSA). Each member has exactly one.

Remove a pending invite or evict an existing member:

```bash
cadre-host trust revoke <token-or-peerId>
```

cadre-host auto-detects whether the argument is a pending-invite token or a member peerId. Force interpretation with `--kind invite` or `--kind member` if it ever guesses wrong.

### Reachability — can people actually reach you? (founder role)

Reachability work targets your **own** cadre's owner node. After enabling the founder role (and any time your network changes):

```bash
cadre-host nat status     # current external IP, port-mapping state, reachability
cadre-host nat test       # re-run the reachability probe right now
```

If `Reachability` shows anything other than `direct`, peers will fall back to libp2p relays — slower but still functional. If UPnP didn't work on your router, the UI's **Connectivity** page has manual port-forwarding instructions.

When your residential IP changes (it will), members can't find you on the old IP. DDNS (a hostname that auto-updates to your current IP) fixes this:

```bash
# DuckDNS — cadre-host updates the record itself. Sign up at duckdns.org and grab a token first.
cadre-host nat ddns set duckdns --hostname mybox.duckdns.org --token <duckdns-token>

# Externally-managed — your router or another tool updates DNS; cadre-host just records the hostname.
cadre-host nat ddns external --hostname mybox.example.com
```

If you use the DuckDNS form, the token is stored in the OS keychain when `libsecret` is installed (`sudo apt install libsecret-1-0` on Debian/Ubuntu), and unencrypted in `<dataDir>/nat-secrets.json` otherwise. The service logs a warning at startup when it falls back to unencrypted storage.

Donated nodes do **not** depend on any of this — they dial outward into the grantee's cadre. Per-donated-node WAN reachability is separate, deferred work (`backlog/feat-cadre-host-wan-grant-reachability`).

## CLI reference

All commands except `install`, `uninstall`, `start`, `ui`, and the `push` group talk to the running cadre-host management API over loopback. They print a connection error if the service isn't running.

Commands marked **founder role only** additionally need `ownCadre.enabled`; on a donor-only install their routes are unmounted and the command reports a 404.

The `cadre-host push` group is the exception on both counts. It needs **no running service** — the commands write straight to the data dir's secret store and `host.config.json` — and it is **not** founder-role only, because donated nodes get push credentials too. Private keys land in the OS keychain when one is available, otherwise the `0600` fallback at `<dataDir>/nat-secrets.json`; the non-secret bits (APNs bundle id / sandbox toggle, cooldown, debounce) land in `host.config.json`. Credentials are re-resolved on every node spawn, so restart cadre-host to apply them immediately.

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

Print every issued grant token with its label, node cap, expiry, and revoked state.

### `cadre-host grant revoke <token>`

Revoke a grant token. Every future request presenting it is denied, the grantee's own `DELETE /grants/:id` included. **Nodes already donated under it keep running and cannot yet be torn down host-side** — see [*Manage grants*](#5-manage-grants).

### `cadre-host invite <label> [--ttl <duration>]`

**Founder role only.** Generate a single-use invite token to add a member to your trust circle. `<label>` is whatever human-readable name helps you track the invitee — quote it if it has spaces. `--ttl` defaults to `24h`; accepts `s`/`m`/`h`/`d` suffixes (e.g. `7d`, `30m`). Prints a QR code and the encoded invite string.

### `cadre-host trust list`

**Founder role only.** Print all current trust-circle members (with peerIds) and pending invites (with tokens and expiry).

### `cadre-host trust revoke <token-or-peerId> [--kind invite|member|auto]`

**Founder role only.** Revoke a pending invite (by token) or evict an existing member (by peerId). `--kind` defaults to `auto`, which decides based on whether the argument looks like a peerId.

### `cadre-host nat status [--json]`

**Founder role only** (as is every `cadre-host nat` subcommand — NAT/DDNS maps a port for the host's *own* owner node). Print current NAT state — port-mapping mode, external IP, CGNAT detection, direct-reachability result, DDNS configuration. With `--json`, dumps the raw response from the management API.

### `cadre-host nat test [--json]`

Re-run the reachability probe right now and print the updated NAT state. Useful after changing port-forwarding rules on your router.

### `cadre-host nat settings [--external-port N] [--internal-port N] [--no-upnp]`

Adjust NAT settings. Pass only the flag(s) you want to change.

### `cadre-host nat ddns set <provider> --hostname <h> [--token <t>]`

Configure cadre-host to push DNS updates itself. Currently the only `<provider>` is `duckdns`. If `--token` is omitted, the command prompts for it (with echo suppressed) when stdin is a TTY. The token is stored in the OS keychain when available, otherwise unencrypted at `<dataDir>/nat-secrets.json` (a startup warning surfaces this).

### `cadre-host nat ddns external --hostname <h>`

Tell cadre-host that some other tool (your router firmware, a separate `ddclient`, etc.) is updating DNS, and to record the hostname for publishing to peers without trying to update it itself.

### `cadre-host push fcm --project-id <id> --client-email <email> [--private-key-file <path>] [--private-key <pem>] [--data-dir <path>]`

Store Firebase Cloud Messaging (Android) service-account credentials so the owner/storage node can wake suspended mobile apps. The three values come from the Firebase service-account JSON (`project_id`, `client_email`, `private_key`). Supply the key either as a file (`--private-key-file`, preferred) or inline (`--private-key`); with neither, the command exits with an error. See [docs/cadre-host.md § Push credentials](../../docs/cadre-host.md#push-credentials-fcmapns) for how to mint the credentials and how they reach the spawned node.

### `cadre-host push apns --key-id <id> --team-id <id> --bundle-id <id> [--private-key-file <path>] [--private-key <pem>] [--production] [--data-dir <path>]`

Store Apple Push Notification service (iOS) auth-key credentials. `--key-id`/`--team-id` identify the `.p8` auth key downloaded from the Apple Developer portal; `--bundle-id` becomes the `apns-topic`. As with `push fcm`, pass the key via `--private-key-file` (preferred) or `--private-key`. Targets the **sandbox** APNs host by default — pass `--production` for an App Store build. A token minted for one host is rejected by the other, so this must match the build under test.

### `cadre-host push options [--cooldown-ms <ms>] [--debounce-ms <ms>] [--data-dir <path>]`

Set the non-secret push tuning knobs: `--cooldown-ms` is the minimum gap between wakes for one (peer, strand) pair (anti-spam), `--debounce-ms` the per-strand burst-coalescing window. Pass only the flag(s) you want to change.

### `cadre-host push clear <target> [--data-dir <path>]`

Remove stored push credentials. `<target>` is `fcm`, `apns`, or `all`. Clearing `apns` also drops the bundle id / sandbox toggle from `host.config.json`. With nothing configured, no `push` block is written into the spawned node's `cadre.json` and the node falls back to control-network push-wake only.

### `cadre-host push status [--data-dir <path>]`

Print which push platforms are configured, the APNs bundle id and sandbox/production mode, and the current cooldown/debounce values. Never prints key material.

### `cadre-host start [--data-dir <path>] [--no-tui]`

Run cadre-host in the foreground. Normally invoked by the systemd unit, not directly. `--data-dir` overrides the install-time data directory (also honors `$CADRE_HOST_DATA_DIR`).

### `cadre-host install [...flags]`

Run the first-run wizard. See [**Install**](#install) at the top of this README.

### `cadre-host uninstall [--remove-data] [--yes]`

Stop and deregister the service. Preserves the data dir by default; pass `--remove-data --yes` to wipe identity, issued grants, donated-node records, trust circle, NAT state, and update state too.

```bash
cadre-host uninstall                       # stop + deregister, keep data
cadre-host uninstall --remove-data --yes   # also delete the data dir
```

## What `cadre-host start` does today

`start` loads `host.config.json` + the identity, brings up the orchestrator, the donation grant layer, and the update service, and binds the Fastify management server on `127.0.0.1:<uiPort>` (loopback only). Only when `ownCadre.enabled` does it also spawn the host's own owner node and bring up the trust-circle and NAT services. Routes:

- `/grants-admin` (issue/list/revoke grants — no bearer; same-machine admin) and `/grants` (the bearer-gated surface a grantee drives to request, seed, and release a donated node) — the always-on donor surface.
- `/update/*` (update flow) — matches the CLI's contract.
- `/auth/*` (trust circle), `/nat/*` (NAT/DDNS), `/api/strands` — **founder role only**; left unmounted and 404 on a donor-only install.
- `/api/status`, `/api/nodes`, `/api/nodes/:id/{logs,stop,start,restart}`, `/api/settings`, `/api/events` (Server-Sent Events) — the local-UI surface consumed by the Svelte SPA.
- `/` — the SPA bundle (or a placeholder HTML when running from source before the SPA is built — see `6.5.2-cadre-host-local-ui-spa`).

If the configured `uiPort` is in use the server tries `uiPort+1..uiPort+9`; on total failure it exits with a message listing every port attempted. An origin guard rejects requests whose `Host` or `Origin` is not `127.0.0.1[:port]` / `localhost[:port]` (defeats DNS-rebind from a malicious page). There is no login — the security model is "same machine as the cadre-host user" (see threat model below).

## Updates

cadre-host checks `https://releases.serfab.io/cadre-host/latest.json` once per `start` and every 24 hours thereafter. **Notify-by-default**: an available update is recorded in `<dataDir>/update-state.json` and surfaced by the local UI; the user clicks "apply" to install it. Auto-apply is opt-in via the local-UI settings page (writes `updates.autoApply: true` into `host.config.json`).

The manifest URL is overridable two ways:
- `CADRE_HOST_UPDATE_MANIFEST_URL` env var (wins over config).
- `updates.manifestUrl` in `host.config.json` (settable from the local UI).

Manifests are signed with Ed25519; cadre-host refuses to apply any release whose signature doesn't match the embedded release key. For CI / dev signing, set `CADRE_HOST_UPDATE_DEV_KEY` to a base64-encoded raw 32-byte public key.

**Threat model.** Any local process running as the cadre-host user can fully control cadre-host (read identity, issue or revoke grants, mutate the trust circle, install arbitrary global packages). Signature verification protects against a compromised release CDN — it is **not** a defense against local-machine compromise. Treat the host like any other long-running service: limit who can run shells as that user, keep the OS patched, and rely on grant tokens — plus, in the founder role, trust-circle membership — for inter-cadre auth.

Apply flow: re-fetch + re-verify the manifest, record `applyInProgress`, run `npm install -g @serfab/cadre-host@<version>` (5-minute timeout), and restart the OS service unit so the new binary takes effect. On install failure, the previous version is reinstalled and the error is surfaced via `update-state.json` — the still-running binary continues to serve. The service-host restart is best-effort; if it fails, the binary swap already succeeded and the user can restart manually.

## Local UI

`cadre-host start` serves a Svelte 5 SPA at `http://127.0.0.1:<uiPort>/`. **Local-only by design:** the server binds to loopback (`127.0.0.1`) only and rejects requests whose `Host` or `Origin` header is not a loopback hostname, so the UI is unreachable from your LAN even though it has no login. To use it from another machine, SSH-port-forward as shown in [*After install*, step 2](#2-open-the-local-ui).

Six pages cover the day-to-day operations. Three of them belong to the opt-in founder role and are marked as such:

- **Home / Status** — green/yellow/red dot, service version + uptime, "update available" banner. Its trust-circle-size and connectivity tiles are fed by founder-only routes.
- **Nodes** — per-managed-node detail, recent stats, log tail (last 200 lines, "Refresh" pulls again), start/stop/restart. `cadre-host` v1 doesn't auto-spawn nodes, so this list is empty until a grantee requests a donated node (or, in the founder role, until your own owner node starts).
- **Settings** — update preferences (autoApply toggle, manifest URL override), install metadata (install ID, data dir, ports), uninstall pointer.
- **Trust Circle** *(founder role only)* — list members, invite a friend (modal generates a paste-friendly token + QR), revoke pending invites or remove members.
- **Connectivity** *(founder role only)* — port-forwarding status, "Test reachability", DDNS provider configuration, manual port-forward instructions when UPnP isn't working.
- **Strands** *(founder role only)* — the shared SQL databases your own cadre belongs to.

The SPA does not yet hide the founder-only pages on a donor-only install: they stay in the nav and error when opened, and Home's connectivity tile never resolves. There is no donor-side view of grants or donated nodes beyond the Nodes page. Tracked as `backlog/feat-cadre-host-donor-aware-ui`.

The SPA opens an `EventSource` against `/api/events` and re-fetches the relevant slice when a node state changes, the trust circle changes, connectivity changes, or an update is announced. No login — the page is bound to loopback only, with an Origin/Host guard for DNS-rebind defence. See the threat-model note in the *Updates* section above and in [docs/cadre-host.md](../../docs/cadre-host.md) for the full security posture.

### Building the SPA

`yarn workspace @serfab/cadre-host build` compiles both the server (TypeScript) and the SPA (`vite build` against `ui/`). The bundle lands in `dist/ui/` and is served by the same Fastify instance that handles `/api/*` and friends. When `dist/ui/` is missing (e.g. running from source without building), the server still answers all API routes and shows a placeholder at `/` explaining how to build.

For UI-only iteration: `yarn workspace @serfab/cadre-host dev:ui` starts Vite on `:5173` and proxies `/api`, `/auth`, `/nat`, `/update` to `127.0.0.1:8765` (override with `CADRE_HOST_PORT`).

## More

- [docs/cadre-host.md](../../docs/cadre-host.md) — persona, package boundary, deployment model, security posture.
- [docs/architecture.md](../../docs/architecture.md) — overall cadre architecture.
