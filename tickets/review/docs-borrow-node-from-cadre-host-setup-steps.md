description: The phone app guide's steps for borrowing a node from a home machine were corrected after they failed on a real device, and cadre-host gained a way to set up a machine for a test session without registering an OS service. Check the new install option, the rewritten guide, and the changed app messages.
files: packages/cadre-host/src/installer/index.ts, packages/cadre-host/src/bin/host.ts, packages/cadre-host/src/installer/__tests__/installer.smoke.test.ts, packages/cadre-host/README.md, docs/cadre-host.md, docs/reference-app-rn.md, packages/reference-app-rn/app/settings.tsx, packages/reference-app-rn/src/host-node-request.ts, packages/integration-tests/src/harness/test-cadre-host.ts
----

# Review: "Borrowing a Node From a cadre-host" steps + `cadre-host install --no-service`

Background: the device run on 2026-09-17 (`tickets/blocked/rn-host-node-request-device-run.md`, "Device run 2026-09-17") found that the guide's PC steps did not work (`start` needs an `install` first, `install` always registers an OS service, `grant issue` needs a label), the app's example port (8088) did not match cadre-host's default (8765), and the firewall advice missed a Wi-Fi network marked Public with existing Block rules for `node.exe`.

## What changed

**cadre-host: `install --no-service`**
- `InstallOptions.noService?: boolean` (`installer/index.ts`). When set, `Installer.install` writes the data dir, identity key, `host.config.json` and `nat.json` seed, then returns before step 5 (service registration).
- **Deviation from the ticket:** the ticket said the flag skips step 5 "and nothing else". It also skips step 6 (browser open) and step 7 (enrollment-invite fetch), because both need a running host and nothing is listening after a `--no-service` install. The invite fetch was already best-effort and would fail with connection refused; the browser would open a dead URL. The JSDoc on `noService` and the README say so.
- `InstallResult.serviceName` is now optional; absent when no service was registered. The only reader is the CLI.
- CLI (`bin/host.ts`): `--no-service` option (commander `service === false`). With it, install prints `Service: not registered (--no-service)` and `Run the host: cadre-host start --data-dir "<dir>"`.
- Test: `installer.smoke.test.ts` → "noService writes the data dir without registering a service" (service host's `install` not called; `serviceName` undefined; config, identity and nat.json written).
- Docs: `packages/cadre-host/README.md` (`install` heading in the CLI reference, plus the `start` entry), `docs/cadre-host.md` (Status → CLI bullet).
- **Beyond the ticket:** `integration-tests/src/harness/test-cadre-host.ts` dropped its `FakeServiceHost` no-op stub and passes `noService: true`. The stub was only used for `install`, so this is the same behavior. The `serviceHost` test-only option stays on `InstallOptions` for the unit tests that assert on registration calls.

**App (reference-app-rn)**
- `8088` → `8765` in the Host URL placeholder (`app/settings.tsx`), the `requestHostNode` doc comment, the empty-address error, and the scheme-less example in `normalizeHostUrl`'s doc comment (`src/host-node-request.ts`). Spec files keep `8088` as an arbitrary fake-host URL, as the ticket said.
- Connect-timeout message now ends "…on the same Wi-Fi network, and that the host's firewall allows incoming connections." Specs assert only on `'could not reach it'`, so none changed.

**Guide (`docs/reference-app-rn.md`, "Borrowing a Node From a cadre-host")**
- "On the PC": build → `install --non-interactive --no-service --no-upnp --no-invite --data-dir <dir>` → `start --data-dir <dir>` → `grant issue "phone test"`; the management port (`uiPort`, 8765 default, the `+1..+9` fallback, `grant issue --port`); and a warning that a service install is already the running host, so `start` must not be run on top of it. `--no-browser` left out (no effect with `--non-interactive`).
- "Reaching the host from the phone": `adb reverse tcp:8765 tcp:8765`, Host URL `http://127.0.0.1:8765`. The firewall bullet was rewritten: per-profile rules, why no prompt appears, how to check (`Get-NetConnectionProfile`, the rules for this `node.exe`, `adb shell nc -w 3`), the two fixes (mark Private, or an Allow rule for `node.exe` or ports 10000–20000), and that a Block rule overrides an Allow rule (with a command that disables the Block rules for this `node.exe`).
- "If the flow stalls": the six-address example with VPN adapters (Tailscale) as a source of extra addresses; a new "Network or app?" bullet: `adb reverse` of the lent node's `ws` port as a diagnostic, with the port read from the host's local UI node page (Ports → `ws`).

## Validation done

- `yarn workspace @serfab/cadre-host test`: 68 files, 651 passed / 4 skipped.
- `yarn workspace @serfab/reference-app-rn test`: 21 files, 315 passed.
- Typecheck: cadre-host, reference-app-rn, integration-tests all clean. `yarn lint` clean.
- Integration: `cadre-host-origin-guard` and `cadre-host-sse-events` scenarios (both boot the harness through `install({ noService: true })`) pass. The other three harness scenarios were not run.
- Real CLI smoke, Windows 11, built `dist`: `install --non-interactive --no-service --no-upnp --no-invite --ui-port 18765 --data-dir <scratch>` → exit 0, printed the two new lines, wrote `host.config.json`, `identity.key`, `nat.json`, `logs/`; `start --data-dir <scratch>` → `cadre-host local UI: http://127.0.0.1:18765`; `grant issue "phone test" --no-qr --port 18765` → token printed. The scratch dir was deleted afterwards.

## Known gaps / for the reviewer

- **Not re-run on a device.** The guide was not re-walked on a phone. The firewall PowerShell commands (`Get-NetFirewallApplicationFilter … | Get-NetFirewallRule | Where-Object Action -eq Block | Disable-NetFirewallRule`, `New-NetFirewallRule …`, `Set-NetConnectionProfile …`) were written from the device-run findings and the cmdlets' documented behavior and were not executed here. The device re-run is still `tickets/blocked/rn-host-node-request-device-run.md` ("What remains").
- The claim that answering Windows' first-run prompt with only *Private networks* ticked leaves Block rules on Public is written as "probably". It matches what the device run saw (TCP and UDP Block rules on Public named "Node.js JavaScript Runtime") but its cause was not confirmed.
- The "Nodes → Ports → `ws`" pointer comes from `ui/src/routes/NodeDetail.svelte` and `/api/nodes` (which lists every orchestrator node, lent ones included). It was not checked in a browser on a donor-only install.
- The Settings screen's hint text in `app/settings.tsx` ("Phone and host must be on the same Wi-Fi network.") was not given a firewall mention; only the timeout error was.
- `--no-service` on an interactive install still runs the wizard (it asks for data dir, ports, and so on). Only the non-interactive form is documented.
