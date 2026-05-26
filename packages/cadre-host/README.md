# @serfab/cadre-host

Self-hosted cadre node manager for basement-PC deployments. Runs one always-on host machine, manages cadre nodes for a small trust circle (family, friends, hobby group), exposes a localhost web UI, and handles NAT/DDNS so members behind residential connections can still be reached.

The sibling of [`@serfab/cadre-provider`](../cadre-provider/README.md): the provider is a multi-tenant hosting service with API keys, billing, and Docker; cadre-host is a single-household manager with trust-circle auth, native child processes, and an installer.

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

From inside `~/cadre`, `npx cadre-host <command>` runs the local binary (`invite`, `trust`, `nat`, `uninstall`, …) without any path prefix — `npx` resolves it from `node_modules/.bin/`. **Caveat:** outside `~/cadre`, `npx cadre-host` won't find the local install and will silently download a fresh copy from the npm registry. To avoid that, either always `cd ~/cadre` first or symlink the binary onto your PATH:

```bash
ln -s ~/cadre/node_modules/.bin/cadre-host ~/.local/bin/cadre-host
# now `cadre-host invite …` works from anywhere
```

If you'd rather skip `npx` and the symlink, the explicit path `./node_modules/.bin/cadre-host <command>` always works from `~/cadre` too.

The wizard (run either way):

1. Prompts for the data directory, UI port, libp2p port, and UPnP toggle (defaults shown in `[...]`).
2. Generates a fresh Ed25519 node identity (`<dataDir>/identity.key`, mode 600 on POSIX).
3. Writes `<dataDir>/host.config.json` and seeds `<dataDir>/nat.json` with the chosen libp2p port.
4. Registers a per-user service: `systemctl --user` unit (Linux), `LaunchAgent` (macOS), or NSSM service (Windows; requires `nssm.exe` on PATH — see `service/README.md`).
5. Opens `http://127.0.0.1:<uiPort>/` in your browser.
6. Issues a 24-hour enrollment invite and prints it as both a QR code and a paste-friendly token.

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

## After install — getting your first user running

`cadre-host install` leaves you with a running management service, a local UI, and **no cadre nodes yet**. In v1, cadre-host does not pre-spawn nodes; each one materializes when a person you trust enrolls a device against an invite you issue. This walkthrough goes from "install just finished" to "first member is enrolled."

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

### 3. Issue your first invite

Decide whose cadre you want to host first — yourself (from your phone), a family member, or a friend. You'll deliver the invite to that device out-of-band (in person, Signal, etc.).

```bash
cadre-host invite "<label>"
```

`<label>` is a human-readable name **you** choose to identify this device or person in your member list. It's purely for your own bookkeeping — the system doesn't use it for anything. Quote it if it has spaces. Examples:

```bash
cadre-host invite "Mom's phone"
cadre-host invite mylaptop
cadre-host invite "Friend — tablet"
```

The command prints two things — a terminal-rendered QR code and an encoded invite string — both representing the same single-use token. The recipient can use either form. By default the token expires in 24 hours; override with `--ttl 7d` (or `30m`, `1h`, etc.).

Hand the QR or token to the device's owner in person if possible. **Anyone who gets the token can claim the cadre identity it grants**, so treat it like a one-time password.

Terminology aside: cadre-host's **trust circle** is just the cryptographically-authenticated list of identities allowed to have a cadre node on this host. An invite adds one new identity to that list.

### 4. The invitee redeems the invite

On the invitee's device, they install a cadre-aware app — the React Native reference app at [`@serfab/reference-app-rn`](../reference-app-rn), or any sApp built on `@serfab/cadre-core` — and scan or paste the invite. The app dials your cadre-host over libp2p (NAT/DDNS permitting; see step 6) and redeems the token. At that moment:

- A child cadre node spawns inside your cadre-host process for this member's identity.
- The member appears in `cadre-host trust list` and on the Trust Circle and Nodes pages of the UI.
- The invitee's device can now use that cadre to participate in strands (shared SQL databases) and connect to other members.

Until someone redeems an invite, the Nodes page in the UI stays empty — that's expected.

### 5. Manage members

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

### 6. Reachability — can people actually reach you?

After install (and any time your network changes):

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

## CLI reference

All commands except `install`, `uninstall`, `start`, and `ui` talk to the running cadre-host management API over loopback. They print a connection error if the service isn't running.

### `cadre-host status`

Print whether the service is registered and currently active.

```
$ cadre-host status
Service installed: yes
Service running:   yes
```

### `cadre-host ui [--no-browser]`

Print the local-UI URL (e.g. `http://127.0.0.1:8765`) and open it in the default browser. Reads `uiPort` from `host.config.json`; doesn't require the service to be running (if not, the browser will fail to connect — that's feedback enough). Pass `--no-browser` to just print the URL.

### `cadre-host invite <label> [--ttl <duration>]`

Generate a single-use invite token to add a member to your trust circle. `<label>` is whatever human-readable name helps you track the invitee — quote it if it has spaces. `--ttl` defaults to `24h`; accepts `s`/`m`/`h`/`d` suffixes (e.g. `7d`, `30m`). Prints a QR code and the encoded invite string.

### `cadre-host trust list`

Print all current trust-circle members (with peerIds) and pending invites (with tokens and expiry).

### `cadre-host trust revoke <token-or-peerId> [--kind invite|member|auto]`

Revoke a pending invite (by token) or evict an existing member (by peerId). `--kind` defaults to `auto`, which decides based on whether the argument looks like a peerId.

### `cadre-host nat status [--json]`

Print current NAT state — port-mapping mode, external IP, CGNAT detection, direct-reachability result, DDNS configuration. With `--json`, dumps the raw response from the management API.

### `cadre-host nat test [--json]`

Re-run the reachability probe right now and print the updated NAT state. Useful after changing port-forwarding rules on your router.

### `cadre-host nat settings [--external-port N] [--internal-port N] [--no-upnp]`

Adjust NAT settings. Pass only the flag(s) you want to change.

### `cadre-host nat ddns set <provider> --hostname <h> [--token <t>]`

Configure cadre-host to push DNS updates itself. Currently the only `<provider>` is `duckdns`. If `--token` is omitted, the command prompts for it (with echo suppressed) when stdin is a TTY. The token is stored in the OS keychain when available, otherwise unencrypted at `<dataDir>/nat-secrets.json` (a startup warning surfaces this).

### `cadre-host nat ddns external --hostname <h>`

Tell cadre-host that some other tool (your router firmware, a separate `ddclient`, etc.) is updating DNS, and to record the hostname for publishing to peers without trying to update it itself.

### `cadre-host start [--data-dir <path>] [--no-tui]`

Run cadre-host in the foreground. Normally invoked by the systemd unit, not directly. `--data-dir` overrides the install-time data directory (also honors `$CADRE_HOST_DATA_DIR`).

### `cadre-host install [...flags]`

Run the first-run wizard. See [**Install**](#install) at the top of this README.

### `cadre-host uninstall [--remove-data] [--yes]`

Stop and deregister the service. Preserves the data dir by default; pass `--remove-data --yes` to wipe identity, trust circle, NAT state, and update state too.

```bash
cadre-host uninstall                       # stop + deregister, keep data
cadre-host uninstall --remove-data --yes   # also delete the data dir
```

## What `cadre-host start` does today

`start` loads `host.config.json` + the identity, brings up the trust-circle / NAT / update services, and binds the Fastify management server on `127.0.0.1:<uiPort>` (loopback only). Routes:

- `/auth/*` (trust circle), `/nat/*` (NAT/DDNS), `/update/*` (update flow) — these match the CLI's contract.
- `/api/status`, `/api/nodes`, `/api/nodes/:id/{logs,stop,start,restart}`, `/api/settings`, `/api/events` (Server-Sent Events) — the local-UI surface consumed by the Svelte SPA.
- `/` — the SPA bundle (or a placeholder HTML when running from source before the SPA is built — see `6.5.2-cadre-host-local-ui-spa`).

If the configured `uiPort` is in use the server tries `uiPort+1..uiPort+9`; on total failure it exits with a message listing every port attempted. An origin guard rejects requests whose `Host` or `Origin` is not `127.0.0.1[:port]` / `localhost[:port]` (defeats DNS-rebind from a malicious page). There is no login — the security model is "same machine as the cadre-host user" (see threat model below).

## Updates

cadre-host checks `https://releases.serfab.io/cadre-host/latest.json` once per `start` and every 24 hours thereafter. **Notify-by-default**: an available update is recorded in `<dataDir>/update-state.json` and surfaced by the local UI; the user clicks "apply" to install it. Auto-apply is opt-in via the local-UI settings page (writes `updates.autoApply: true` into `host.config.json`).

The manifest URL is overridable two ways:
- `CADRE_HOST_UPDATE_MANIFEST_URL` env var (wins over config).
- `updates.manifestUrl` in `host.config.json` (settable from the local UI).

Manifests are signed with Ed25519; cadre-host refuses to apply any release whose signature doesn't match the embedded release key. For CI / dev signing, set `CADRE_HOST_UPDATE_DEV_KEY` to a base64-encoded raw 32-byte public key.

**Threat model.** Any local process running as the cadre-host user can fully control cadre-host (read identity, mutate trust circle, install arbitrary global packages). Signature verification protects against a compromised release CDN — it is **not** a defense against local-machine compromise. Treat the host like any other long-running service: limit who can run shells as that user, keep the OS patched, and rely on the trust-circle membership model for inter-cadre auth.

Apply flow: re-fetch + re-verify the manifest, record `applyInProgress`, run `npm install -g @serfab/cadre-host@<version>` (5-minute timeout), and restart the OS service unit so the new binary takes effect. On install failure, the previous version is reinstalled and the error is surfaced via `update-state.json` — the still-running binary continues to serve. The service-host restart is best-effort; if it fails, the binary swap already succeeded and the user can restart manually.

## Local UI

`cadre-host start` serves a Svelte 5 SPA at `http://127.0.0.1:<uiPort>/`. **Local-only by design:** the server binds to loopback (`127.0.0.1`) only and rejects requests whose `Host` or `Origin` header is not a loopback hostname, so the UI is unreachable from your LAN even though it has no login. To use it from another machine, SSH-port-forward as shown in [*After install*, step 2](#2-open-the-local-ui).

Five pages cover the day-to-day operations:

- **Home / Status** — green/yellow/red dot, service version + uptime, trust-circle size, connectivity at a glance, "update available" banner.
- **Trust Circle** — list members, invite a friend (modal generates a paste-friendly token + QR), revoke pending invites or remove members.
- **Connectivity** — port-forwarding status, "Test reachability", DDNS provider configuration, manual port-forward instructions when UPnP isn't working.
- **Nodes** — per-managed-node detail, recent stats, log tail (last 200 lines, "Refresh" pulls again), start/stop/restart. `cadre-host` v1 doesn't auto-spawn nodes, so this list is usually empty until a trust-circle member completes enrollment.
- **Settings** — update preferences (autoApply toggle, manifest URL override), install metadata (install ID, data dir, ports), uninstall pointer.

The SPA opens an `EventSource` against `/api/events` and re-fetches the relevant slice when a node state changes, the trust circle changes, connectivity changes, or an update is announced. No login — the page is bound to loopback only, with an Origin/Host guard for DNS-rebind defence. See the threat-model note in the *Updates* section above and in [docs/cadre-host.md](../../docs/cadre-host.md) for the full security posture.

### Building the SPA

`yarn workspace @serfab/cadre-host build` compiles both the server (TypeScript) and the SPA (`vite build` against `ui/`). The bundle lands in `dist/ui/` and is served by the same Fastify instance that handles `/api/*` and friends. When `dist/ui/` is missing (e.g. running from source without building), the server still answers all API routes and shows a placeholder at `/` explaining how to build.

For UI-only iteration: `yarn workspace @serfab/cadre-host dev:ui` starts Vite on `:5173` and proxies `/api`, `/auth`, `/nat`, `/update` to `127.0.0.1:8765` (override with `CADRE_HOST_PORT`).

## More

- [docs/cadre-host.md](../../docs/cadre-host.md) — persona, package boundary, deployment model, security posture.
- [docs/architecture.md](../../docs/architecture.md) — overall cadre architecture.
