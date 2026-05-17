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
- `HostProcessOrchestrator` runs cadre nodes as native child processes.

## What `cadre-host start` does today

`start` loads `host.config.json` + the identity, kicks off a background update check, arms a 24-hour update-check timer, and waits for SIGTERM. The full HTTP management server (Fastify with `/auth/*`, `/nat/*`, `/update/*`, `/api/*` routes) lands in `cadre-host-local-ui` (`6.5.1`); until then the wizard's enrollment-invite step degrades silently (the URL is printed, the QR is not). The `UpdateService` is exposed via `createUpdateHandlers()` for the local-UI ticket to wire up.

## Updates

cadre-host checks `https://releases.serfab.io/cadre-host/latest.json` once per `start` and every 24 hours thereafter. **Notify-by-default**: an available update is recorded in `<dataDir>/update-state.json` and surfaced by the local UI; the user clicks "apply" to install it. Auto-apply is opt-in via the local-UI settings page (writes `updates.autoApply: true` into `host.config.json`).

The manifest URL is overridable two ways:
- `CADRE_HOST_UPDATE_MANIFEST_URL` env var (wins over config).
- `updates.manifestUrl` in `host.config.json` (settable from the local UI).

Manifests are signed with Ed25519; cadre-host refuses to apply any release whose signature doesn't match the embedded release key. For CI / dev signing, set `CADRE_HOST_UPDATE_DEV_KEY` to a base64-encoded raw 32-byte public key.

**Threat model.** Any local process running as the cadre-host user can fully control cadre-host (read identity, mutate trust circle, install arbitrary global packages). Signature verification protects against a compromised release CDN — it is **not** a defense against local-machine compromise. Treat the host like any other long-running service: limit who can run shells as that user, keep the OS patched, and rely on the trust-circle membership model for inter-cadre auth.

Apply flow: re-fetch + re-verify the manifest, record `applyInProgress`, run `npm install -g @serfab/cadre-host@<version>` (5-minute timeout), and restart the OS service unit so the new binary takes effect. On install failure, the previous version is reinstalled and the error is surfaced via `update-state.json` — the still-running binary continues to serve. The service-host restart is best-effort; if it fails, the binary swap already succeeded and the user can restart manually.

## More

- [docs/cadre-host.md](../../docs/cadre-host.md) — persona, package boundary, deployment model, security posture.
- [docs/architecture.md](../../docs/architecture.md) — overall cadre architecture.
