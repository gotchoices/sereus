description: Review PR #41 (merged locally): cadre-host tells a machine behind a router (lan) from one holding a public IP (public, e.g. a VPS), routes node ports directly in public mode with no UPnP, and the installer stops re-asking flagged values and prints an ssh -L command when headless.
architecture: docs/cadre-host.md#nat-and-ddns
files: packages/cadre-host/src/nat/network-mode.ts, packages/cadre-host/src/nat/nat-service.ts, packages/cadre-host/src/nat/nat-store.ts, packages/cadre-host/src/nat/reachability.ts, packages/cadre-host/src/nat/types.ts, packages/cadre-host/src/nat/index.ts, packages/cadre-host/src/bin/host.ts, packages/cadre-host/src/bin/nat-output.ts, packages/cadre-host/src/bin/ui-access.ts, packages/cadre-host/src/installer/index.ts, packages/cadre-host/src/installer/wizard.ts, packages/cadre-host/ui/src/routes/Connectivity.svelte, packages/cadre-host/ui/src/components/NodeReachabilityCard.svelte, packages/cadre-host/ui/src/lib/reachability.ts, packages/cadre-host/ui/src/lib/state.svelte.ts, packages/cadre-host/src/nat/__tests__/network-mode.test.ts, packages/cadre-host/src/nat/__tests__/nat-service.test.ts, packages/cadre-host/src/nat/__tests__/nat-store.test.ts, packages/cadre-host/src/installer/__tests__/wizard.test.ts, packages/cadre-host/src/__tests__/ui-access.test.ts, docs/cadre-host.md, packages/cadre-host/README.md, .release-notes.pending.md
----
# cadre-host LAN vs public-IP network mode (PR #41, kjeib)

External PR, merged locally as `Merge PR #41: cadre-host LAN vs public-IP network mode, and an install that gets you to the GUI`. Conflict only in `.release-notes.pending.md` (both sections kept). Read its commit first.

## What landed

- **`nat.json` `network`: `auto` (default) | `lan` | `public`**, set from Connectivity → Network or `cadre-host nat settings --network` (validated in `NatStore`). `auto` is public when any non-internal interface holds a public IPv4 (`publicInterfaceAddress`), re-read at start, on `redetect` and on `testReachability`.
- **Public mode**: every node port gets a `direct` route at its own number; no UPnP discovery or mapping (`usesUpnp()`); CGNAT ruled out; public addresses use the interface IP (or the DDNS hostname); verdict `direct` with a firewall reminder as its reason; a manual forward still wins. Switching mode re-routes every node and leaving `lan` releases UPnP mappings.
- **Installer**: the wizard skips questions answered by flags, skips UPnP on a public IP, drops the unused DDNS prompt; `install` reports the mode; `install` and `cadre-host ui` print `ssh -L <port>:127.0.0.1:<port> user@host` when headless (SSH session, or Linux without a display), and `ui` then exits without opening a browser.

## Review focus

- **`auto` detection.** Any public IPv4 on any interface flips the host to public mode. Check machines where that is wrong: a public address on a VPN or tunnel interface, a host with a routed public IP behind a provider firewall that blocks the ports, a LAN machine on an ISP that hands out public addresses on a second NIC. The manual setting covers these; decide whether the UI should say what was detected and on which interface.
- **`redetect` now always enqueues work** (it previously did nothing when UPnP was off or a gateway was known). Check its callers' frequency and that the extra interface read and possible `reconcileOnce` are cheap.
- **`renewOnce`** now skips `direct` routes by checking `source !== 'upnp' && source !== null`; confirm no route state is left unrenewed in LAN mode.
- **Interaction with PR #37** (`claim-code-phone-addresses`): claim codes on a public host use `primaryLanAddress()` (the public IP) as `lan`. The PR suggests public mode should default claim codes to `lan: none`; decide.
- **Security**: public mode changes no listener; the UI still binds 127.0.0.1. Confirm the firewall reminder never suggests opening the UI or health/metrics ports.
- **`isHeadless`** treats every SSH session as headless, including an SSH session on a desktop with X forwarding; acceptable, confirm.
- **Docs**: `docs/cadre-host.md` "NAT and DDNS" gained the mode section; the Port mapping section and README's Connectivity text should match.

## Verification at merge

`yarn build`, `yarn lint`, cadre-host 441 pass (4 skipped). The `orchestrator.test.ts` SIGKILL-timing failure the PR mentions did not reproduce here.
