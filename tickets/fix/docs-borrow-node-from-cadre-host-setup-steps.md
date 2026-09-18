description: The phone app guide's steps for borrowing a node from a home machine did not work as written on the first real try. A setup step is missing, the port shown in the app does not match the host's default, and the firewall advice does not cover the case that blocked the test. Correct the guide.
files: docs/reference-app-rn.md ("Borrowing a Node From a cadre-host"), packages/reference-app-rn/app/settings.tsx (Host URL placeholder), docs/cadre-host.md (if the install note belongs there too)
repro: device run 2026-09-17, recorded in tickets/blocked/rn-host-node-request-device-run.md
----

# Correct the "Borrowing a Node From a cadre-host" steps

Each item below was seen on the 2026-09-17 device run (Galaxy Note 9, Windows 11 PC, same Wi-Fi).

## 1. `cadre-host start` needs an install first

The doc's "On the PC" block starts with `cadre-host start`. On a machine with no install that exits with `host.config.json not found. Run cadre-host install first`. `cadre-host install` writes `host.config.json` and the identity key, and it also **registers an OS service** (NSSM on Windows, systemd/launchd elsewhere). That is a lot to ask for a test session. The run installed into a scratch data dir with a no-op service host, the same way `integration-tests/src/harness/test-cadre-host.ts` does, then ran `node packages/cadre-host/dist/bin/host.js start --data-dir <dir>`.

The doc should say what to run. Either `cadre-host install --non-interactive --data-dir <dir> --no-browser --no-invite --no-upnp` and accept the service registration, or a documented way to install without it. If there is no such way, consider adding a flag such as `install --no-service`.

## 2. Which port

- `cadre-host grant issue` talks to the management API on `--port`, which **defaults to 8765**, the installer's default `uiPort`. With any other `uiPort`, `grant issue` fails unless `--port` is passed.
- The app's Host URL placeholder is `http://127.0.0.1:8088`, and the doc's examples leave the port unnamed. A default install binds 8765, so the placeholder points the user at the wrong port. Use 8765 in the placeholder, or say in the doc that the port is `uiPort` from `host.config.json`.

## 3. Firewall: a network marked Public, and an existing Block rule

The doc says "Allow `node.exe` on private networks when prompted". On the test PC:

- The home Wi-Fi was classified **Public** by Windows (`Get-NetConnectionProfile` → `NetworkCategory Public`).
- `node.exe` already had **inbound Block rules on the Public profile** (TCP and UDP, "Node.js JavaScript Runtime"), probably from a prompt answered earlier. Windows does not prompt again once a rule exists.

So no prompt appeared. The phone's connections to the PC's LAN address timed out (`nc 192.168.86.41 10004` from `adb shell`: `Timeout`, while the router answered ping), and the request failed after 60 s at "Connecting to the node…". The doc should say how to check this (`Get-NetConnectionProfile`, `Get-NetFirewallRule` / `Get-NetFirewallApplicationFilter` for `node.exe`, or `nc <pc-lan-ip> <ws-port>` from `adb shell`). It should also give the two fixes: mark the network Private, or add an inbound allow rule for `node.exe` (or the orchestrator's port range, 10000–20000 by default) on the profile the network uses.

## 4. The addresses the phone tries

`GET /grants/:id/peer` reported six addresses: TCP and `/ws` on the Tailscale address (100.67.49.72), the LAN address and `127.0.0.1`. The phone can use only `/ws`, and it spent about 8 s on each unreachable one before the next. The doc's "If the flow stalls" already describes this. Add that VPN adapters (Tailscale here) are one source of such addresses.

## 5. A way to check the rest of the flow when the LAN path is blocked

The host reports a `127.0.0.1/…/ws` address for the lent node. With `adb reverse tcp:<ws-port> tcp:<ws-port>` (the fifth port of the node's block, 10004 for the first loan on a fresh host), the phone's dial to that address reaches the node and the flow reaches "Connected." That is how the run got past the firewall. It does not cover strand traffic, which uses ports chosen at start, so the doc's statement that forwarding is not a working setup still holds for chat. It is still a useful diagnostic, because it separates a network problem from a problem in the app.

## TODO

- Rewrite "On the PC" with a working install + start + grant sequence (item 1), naming the port (item 2).
- Fix the Host URL placeholder in `app/settings.tsx` to the default port (item 2).
- Expand the firewall paragraph (item 3) and "If the flow stalls" (items 4–5).
- Consider adding "and that the host's firewall allows incoming connections" to the connect-timeout message in `src/host-node-request.ts`. On the device run it named only the Wi-Fi network, which was already correct.
