# @serfab/cadre-host

Self-hosted cadre node manager for basement-PC deployments. Runs one always-on host machine, manages cadre nodes for a small trust circle (family, friends, hobby group), exposes a localhost web UI, and handles NAT/DDNS so members behind residential connections can still be reached.

The sibling of [`@serfab/cadre-provider`](../cadre-provider/README.md): the provider is a multi-tenant hosting service with API keys, billing, and Docker; cadre-host is a single-household manager with trust-circle auth, native child processes, and an installer.

## Install

```bash
npm install -g @serfab/cadre-host
cadre-host install
```

The wizard:

1. Prompts for the data directory, UI port, libp2p port, and UPnP toggle (defaults shown in `[...]`).
2. Generates a fresh Ed25519 node identity (`<dataDir>/identity.key`, mode 600 on POSIX).
3. Writes `<dataDir>/host.config.json` and seeds `<dataDir>/nat.json` with the chosen libp2p port.
4. Registers a system service: `systemctl --user` unit (Linux), `LaunchAgent` (macOS), or NSSM service (Windows; requires `nssm.exe` on PATH — see `service/README.md`).
5. Opens `http://127.0.0.1:<uiPort>/` in your browser.
6. Issues a 24-hour enrollment invite and prints it as both a QR code and a paste-friendly token.

Run `cadre-host install --non-interactive --data-dir <path>` for unattended provisioning.

### Per-user vs system install

v1 supports per-user installs only. `cadre-host install --system` is accepted by the CLI but errors out; running cadre-host as a dedicated system user requires data-dir ownership work that's tracked separately.

### Service-host details

The rendered unit files live at:

| Platform | Path |
| -------- | ---- |
| Linux    | `~/.config/systemd/user/cadre-host.service` |
| macOS    | `~/Library/LaunchAgents/com.serfab.cadre-host.plist` |
| Windows  | NSSM-managed service `CadreHost` (registry-stored config) |

See [`service/README.md`](./service/README.md) for templates, manual-smoke instructions, and the cross-platform CI gap.

## Uninstall

```bash
cadre-host uninstall              # stop + deregister, keep data
cadre-host uninstall --remove-data --yes
```

## CLI subcommands once running

- `cadre-host invite <label>` issues a trust-circle invite via the running management API. See [docs/cadre-host.md](../../docs/cadre-host.md#trust-circle).
- `cadre-host trust list` and `cadre-host trust revoke <token-or-peerId>` round out trust-circle management.
- `cadre-host nat status`, `cadre-host nat test`, `cadre-host nat ddns set duckdns --hostname <h> --token <t>`, `cadre-host nat ddns external --hostname <h>`, `cadre-host nat settings [--external-port N] [--no-upnp]` manage NAT / DDNS. See [docs/cadre-host.md](../../docs/cadre-host.md#nat-and-ddns).
- `cadre-host ui` prints the local-UI URL and opens it in the default browser. Reads the configured port from `host.config.json`; doesn't require the cadre-host service to be running (if it isn't, the browser will fail to connect — that's obvious feedback).
- `HostProcessOrchestrator` runs cadre nodes as native child processes.

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

`cadre-host start` serves a Svelte 5 SPA at `http://127.0.0.1:<uiPort>/`. Five pages cover the day-to-day operations:

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
