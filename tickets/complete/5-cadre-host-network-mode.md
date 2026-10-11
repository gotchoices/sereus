description: cadre-host tells a machine behind a router (lan) from one holding a public IP (public, e.g. a VPS), routes node ports directly in public mode with no UPnP, and the installer stops re-asking flagged values and prints an ssh -L command when headless. Reviewed; small fixes applied.
architecture: docs/cadre-host.md#nat-and-ddns
files: packages/cadre-host/src/nat/network-mode.ts, packages/cadre-host/src/nat/nat-service.ts, packages/cadre-host/src/nat/nat-store.ts, packages/cadre-host/src/nat/reachability.ts, packages/cadre-host/src/nat/types.ts, packages/cadre-host/src/bin/host.ts, packages/cadre-host/src/bin/nat-output.ts, packages/cadre-host/src/bin/ui-access.ts, packages/cadre-host/src/installer/index.ts, packages/cadre-host/src/installer/wizard.ts, packages/cadre-host/ui/src/routes/Connectivity.svelte, packages/cadre-host/ui/src/components/NodeReachabilityCard.svelte, packages/cadre-host/src/__tests__/ui-access.test.ts, docs/cadre-host.md, packages/cadre-host/README.md
----
# cadre-host LAN vs public-IP network mode (PR #41, kjeib)

External PR, merged locally as `Merge PR #41: cadre-host LAN vs public-IP network mode, and an install that gets you to the GUI` (branch commit `feat(cadre-host): LAN vs public-IP network mode, and an install that gets to the GUI`).

## What landed

- **`nat.json` `network`: `auto` (default) | `lan` | `public`**, set from Connectivity → Network or `cadre-host nat settings --network` (validated in `NatStore`; a file without the field reads as `auto`). `auto` is public when any non-loopback interface holds a public IPv4 (`publicInterfaceAddress`), re-read at start, on the 5-minute probe pass and on `nat test`.
- **Public mode**: every node port gets a `direct` route at its own number; no UPnP discovery or mapping (`usesUpnp()`); CGNAT ruled out; public addresses use the interface IP (or the DDNS hostname); verdict `direct` with a firewall reminder (`sudo ufw allow …`) as its reason; a manual forward still wins. Switching mode re-routes every node, and leaving `lan` releases UPnP mappings.
- **Installer**: the wizard skips questions answered by flags, skips UPnP on a public IP, drops the unused DDNS prompt; `install` reports the mode; `install` and `cadre-host ui` print `ssh -L <port>:127.0.0.1:<port> user@host` when headless (an SSH session, or Linux with no display), and `ui` then exits without opening a browser.

## Review findings

Read the merge diff first (25 files), then the full `NatService` pass logic, `reachability.ts`, `nat-output.ts`, the installer path, `claim-details.ts` and cadre-core's `selectNodeClaimAddresses` / `primaryLanAddress`.

**Fixed in this pass (minor):**

- **`redetect` reconciled every 5 minutes in the steady state.** The new condition `modeChanged || (usesUpnp() && gateway.found)` ran a full reconcile on every probe pass whenever a router was known, not only when a router first answered (the original intent, and what the docs say). Redundant with the 1-minute reconcile timer, so harmless but wrong. Now reconciles only on a mode change or a gateway that appeared in this pass. The interface re-read and mode-change logging, duplicated between `redetect` and `testReachability`, moved into `refreshNetworkMode()` (`nat-service.ts`). The `redetect` doc comment described the old behaviour; rewritten.
- **`install` opened a browser while headless.** The installer's browser step only checked `isTTY`, so over SSH on macOS it opened a browser on the remote machine's screen (and tried `xdg-open` on a headless Linux), right before printing the `ssh -L` lines. `host.ts` now passes `openBrowser: … && !isHeadless()`.
- **`install`'s "Network:" line ignored a recorded setting.** It used `publicInterfaceAddress()` alone; a re-install keeps `nat.json` (the seed merges), so an explicit `lan`/`public` was misreported. It now uses `effectiveNetworkMode(store.network, interfaceIp)`.
- **The `ssh -L` line named `hostname()`.** A VPS's hostname rarely resolves from the admin's computer, and a non-22 SSH port was dropped. `currentLogin` now takes the server address and port from `SSH_CONNECTION` (the address the admin's client actually reached) and adds `-p` when the port is not 22; falls back to the hostname off SSH. One test added for that parse (`ui-access.test.ts`).
- **Stale comment**: `evaluateHostReachability` said "every running node is mapped/manual"; now includes `direct`.
- **Docs** (`docs/cadre-host.md`): the verdict table and host roll-up gained `direct`; the firewall reminder is stated to name only the TCP/WebSocket ports; "Public addresses per node" says which IP public mode uses; "Compared" lists a network-mode change as a cause of an address restart; "UPnP gateway" says discovery runs only in LAN mode; "Reachability from outside" mentions public mode; the network-mode section covers the cloud one-to-one NAT case (AWS/GCP: private interface, set `public` by hand), the hidden forwarding form on a `direct` node, and the multi-homed limitation of `auto`. README: `nat status` lists `direct`, and the cloud case.

**Review-focus questions, decided:**

- **`auto` detection.** Wrong cases are all multi-homed: a LAN machine with a public address on a second card or a tunnel that is not its route to the internet. Organisations that hand machines public addresses behind a firewall (universities) are correctly `public` — the firewall reminder is the right advice there. The UI and `nat status` already show the detected address and "(detected)" beside the override, so no interface name was added. Parked as a `NOTE:` tripwire at `publicInterfaceAddress` (`network-mode.ts`): if reported, decide on the default route's source address (cadre-core's `primaryLanAddress` probe) instead; the limitation is also stated in the docs.
- **`redetect` frequency/cost.** Its only caller is the 5-minute probe timer; `os.networkInterfaces()` is a cheap synchronous read. The extra reconcile was the real cost and is fixed above.
- **`renewOnce` skipping `direct`.** Confirmed nothing is left unrenewed: every mode change re-reads and reconciles inside the same serialized pass (`redetect`, `testReachability`, `putSettings`), so a `direct` route never survives into LAN mode for a renewal to skip; `upnp` and `null` routes are renewed as before.
- **PR #37 interaction (claim codes).** No change needed. On a VPS `primaryLanAddress()` returns the public IP; `selectNodeClaimAddresses` uses `lan` only to filter *private* addresses, so a public `lan` value keeps none of them — the same result as `lan: none` — and the public address itself is classified and kept (deduplicated) as a public address.
- **Security.** Public mode changes no listener; the UI still binds 127.0.0.1. `firewallReminder` builds its port list only from the node's TCP and WebSocket routes, so it never names the UI, health or metrics ports.
- **`isHeadless` and SSH with X forwarding.** Treated as headless; accepted — the printed lines still give a working URL, and a forwarded browser over X is the worse experience.

**Checked, nothing found:** `NatStore` validation and old-file compatibility; `putSettings` mode/UPnP transitions (releases UPnP routes, keeps manual ones, re-discovers on entering LAN); `routeOrPrediction` in public mode; CLI `nat-output` public branch and `forwardAdvice` (only for `unreachable`); UI hiding router fields and the UPnP checkbox in public mode; wizard flag handling and its tests.

**Tests:** the implementer's tests pin specified behaviour (mode selection, re-routing on switch, wizard skips, headless detection) and were kept. One added for the `SSH_CONNECTION` parse. No tests cut.

**Not ticketed:** nothing reached the filing bar.

**Verification:** `yarn workspace @serfab/cadre-host typecheck`, `build:server`, `yarn lint` (exit 0), cadre-host tests 442 pass / 4 skipped.
