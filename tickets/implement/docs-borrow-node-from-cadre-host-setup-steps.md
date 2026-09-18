description: The phone app guide's steps for borrowing a node from a home machine did not work on the first real try: a setup step is missing, the port is wrong, and the firewall advice misses the case that blocked the test. Correct the guide, and add a way to set up the home machine for a test session without registering it as an OS service.
files: docs/reference-app-rn.md ("Borrowing a Node From a cadre-host"), packages/reference-app-rn/app/settings.tsx (Host URL placeholder, line ~348), packages/reference-app-rn/src/host-node-request.ts (connect-timeout message ~line 403; example port in doc comment ~181 and error text ~608), packages/cadre-host/src/bin/host.ts (`install` command ~line 91), packages/cadre-host/src/installer/index.ts (`InstallOptions`, `Installer.install` step 5), packages/cadre-host/src/installer/__tests__/installer.smoke.test.ts, packages/cadre-host/README.md (CLI reference `install` heading), docs/cadre-host.md (CLI summary ~line 554)
repro: verified — device run 2026-09-17 (tickets/blocked/rn-host-node-request-device-run.md, "Device run 2026-09-17"); the causes below were confirmed by reading the code
----

# Correct the "Borrowing a Node From a cadre-host" steps

The steps are in `docs/reference-app-rn.md` under "Borrowing a Node From a cadre-host". On the 2026-09-17 device run (Galaxy Note 9, Windows 11 PC, same Wi-Fi) they failed in several places. Each item gives what the code does and what to change.

## 1. The "On the PC" block does not work as written

The block is currently:

```bash
cadre-host start                 # note the management port it binds
cadre-host grant issue           # prints the grant token to paste into the phone
```

Three problems:

- **`start` needs an install first.** On a machine with no install it exits with `host.config.json not found. Run cadre-host install first`.
- **`install` always registers and starts an OS service.** `Installer.install` (`packages/cadre-host/src/installer/index.ts`, step 5) calls `serviceHost.install(ctx)` unconditionally. On Windows that is NSSM (`service-host/nssm.ts`): it throws if `nssm.exe` is not on the PATH, which happens *after* `host.config.json` and the identity key are written, so the install reports failure but leaves a usable data dir behind. When NSSM is present it also **starts** the service, and the service binds `uiPort`. A `cadre-host start` run after that finds `uiPort` in use and falls back to `uiPort+1..+9` (`bin/host.ts` ~line 447), so two hosts run on the same data dir. The only way to install without a service today is the test-only `serviceHost` option that `integration-tests/src/harness/test-cadre-host.ts` passes. The device run used the same approach from a script.
- **`grant issue` requires a label.** `grant issue <label>` has a required argument (`bin/host.ts` ~line 735). The doc omits it.

**Decision: add `cadre-host install --no-service`.** A test session needs a data dir and a foreground `start`, not an auto-start service. The flag skips step 5 and nothing else. `InstallResult.serviceName` then needs a value the CLI can print, for example `none (--no-service)`, or it can become optional with the CLI printing `Service: not registered`. Don't make the flag test-only. It is the documented way to run a host by hand.

With the flag, the doc's block becomes (repo checkout form; `cadre-host` on a global install):

```bash
yarn workspace @serfab/cadre-host build
node packages/cadre-host/dist/bin/host.js install --non-interactive --no-service --no-upnp --no-invite --data-dir <dir>
node packages/cadre-host/dist/bin/host.js start --data-dir <dir>          # prints "cadre-host local UI: http://127.0.0.1:<port>/"
node packages/cadre-host/dist/bin/host.js grant issue "phone test"        # add --port <port> if start bound anything but 8765
```

The doc should also say that a normal `cadre-host install` (service registered) already runs the host, so `start` must not be run on top of it.

Check whether `--no-browser` is still needed. It has no effect with `--non-interactive` (`shouldOpenBrowser` requires `!nonInteractive`), so leave it out of the doc command.

## 2. Which port

- `grant issue` / `grant list` / `grant revoke` talk to `--port`, which defaults to `CADRE_HOST_PORT` or **8765** (`bin/host.ts` line 63). 8765 is also the installer's default `uiPort` (`installer/wizard.ts` `DEFAULT_UI_PORT`). `start` binds `uiPort`, or `uiPort+1..+9` if that port is taken, and prints the port it used.
- The app's Host URL placeholder is `http://127.0.0.1:8088` (`app/settings.tsx` ~line 348), and `src/host-node-request.ts` uses the same example in a doc comment (~181) and in the "enter the host's address" error (~608). Change all three to `8765`. The spec files' `8088` is an arbitrary fake-host URL and can stay.
- In the doc, name the port: the management port is `uiPort` from `host.config.json`, 8765 by default. The `adb reverse` line and the Host URL use it.

## 3. Firewall: a network marked Public, and an existing Block rule

The doc says "Allow `node.exe` on private networks when prompted". On the test PC the home Wi-Fi was classified **Public** (`Get-NetConnectionProfile` → `NetworkCategory Public`), and `node.exe` already had **inbound Block rules on the Public profile** (TCP and UDP, "Node.js JavaScript Runtime"), probably from a prompt answered earlier. Windows does not prompt again once a rule exists, so no prompt appeared. The phone's connections to the PC's LAN address timed out (`nc 192.168.86.41 10004` from `adb shell` → `Timeout`, while the router answered ping).

Replace the bullet with:

- **How to check:** `Get-NetConnectionProfile` shows the network category. `Get-NetFirewallApplicationFilter -Program <path to node.exe> | Get-NetFirewallRule` (or `Get-NetFirewallRule -DisplayName "*Node*"`) lists existing rules with their `Action` and `Profile`. `adb shell nc -w 3 <pc-lan-ip> <ws-port>` tests the path from the phone.
- **Fixes, either one:** mark the network Private (`Set-NetConnectionProfile -InterfaceAlias <alias> -NetworkCategory Private`), or add an inbound allow rule for `node.exe`, or for the orchestrator's port range (10000–20000 by default, `orchestrator/host-process-orchestrator.ts` `DEFAULTS`), on the profile the network uses. Also say that a Block rule overrides an Allow rule, so an existing Block rule for `node.exe` on that profile has to be removed or disabled.

## 4. The addresses the phone tries (add to "If the flow stalls")

`GET /grants/:id/peer` reported six addresses: TCP and `/ws` on the Tailscale address (100.67.49.72), the LAN address, and `127.0.0.1`. The phone can use only the `/ws` ones, and it spends up to 8 s on each unreachable one. The existing "Stuck at 'Connecting to the node'" bullet already describes the per-address wait. Add that VPN adapters (Tailscale, for example) are a common source of these extra addresses.

## 5. A check that separates a network problem from an app problem (add to "If the flow stalls")

The host reports a `/ip4/127.0.0.1/tcp/<ws-port>/ws` address for the lent node. `adb reverse tcp:<ws-port> tcp:<ws-port>` makes the phone's dial to that address reach the node, and the flow reaches "Connected." The WebSocket port is the lent node's `ws` port. It was 10004 for the first loan on a fresh host, but read it from the reported addresses rather than assuming it. This does not make chat work: strand nodes listen on ports the OS picks at start, so the doc's statement that forwarding is not a working setup still holds. As a diagnostic it is useful. If the flow connects with the forward and times out without it, the problem is the network or the firewall, not the app.

## 6. The connect-timeout message

`src/host-node-request.ts` ~line 403 ends with "Check that the phone and the host are on the same Wi-Fi network." On the device run the Wi-Fi was already correct and the firewall was the cause. Extend it to also name the host's firewall, for example "…same Wi-Fi network, and that the host's firewall allows incoming connections." Check `test/host-node-request.spec.ts` for an assertion on this wording.

Note: `fix/rn-host-node-request-end-loan-refused-by-host` also edits `src/host-node-request.ts` (the end-loan request). The sites differ, so no ordering is needed.

## TODO

- cadre-host: add `--no-service` to `install` in `bin/host.ts` and a `noService?: boolean` to `InstallOptions`. Skip step 5 when set, and make `InstallResult.serviceName` reflect that. Add a case to `installer.smoke.test.ts` asserting the service host's `install` is not called and `host.config.json` + `identity.key` are written.
- cadre-host: add `--no-service` to the `install` heading in `packages/cadre-host/README.md`'s CLI reference and to the CLI summary in `docs/cadre-host.md` (~line 554).
- Doc: rewrite "On the PC" (items 1–2). Include the install / start / grant sequence, the `<label>` argument, the port, and the warning not to `start` on top of a service install.
- Doc: update "Reaching the host from the phone" to name port 8765 (`uiPort`) in the `adb reverse` line and Host URL.
- Doc: replace the firewall bullet (item 3) and extend "If the flow stalls" (items 4–5).
- App: change the `8088` examples to `8765` in `app/settings.tsx` and `src/host-node-request.ts`. Extend the connect-timeout message (item 6).
- Run `yarn workspace @serfab/cadre-host test`, `yarn workspace @serfab/reference-app-rn test`, `yarn lint`, and the type checks for both packages.
