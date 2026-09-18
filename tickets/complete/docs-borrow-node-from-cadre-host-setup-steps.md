description: The phone app guide's steps for borrowing a node from a home machine were corrected after they failed on a real device, and cadre-host gained a way to set up a machine for a test session without registering an OS service.
files: packages/cadre-host/src/installer/index.ts, packages/cadre-host/src/bin/host.ts, packages/cadre-host/src/installer/__tests__/installer.smoke.test.ts, packages/cadre-host/README.md, docs/cadre-host.md, docs/architecture.md, docs/reference-app-rn.md, packages/reference-app-rn/app/settings.tsx, packages/reference-app-rn/src/host-node-request.ts, packages/integration-tests/src/harness/test-cadre-host.ts
----

# "Borrowing a Node From a cadre-host" steps + `cadre-host install --no-service`

The device run on 2026-09-17 (`tickets/blocked/rn-host-node-request-device-run.md`) found that the guide's PC steps did not work: `start` needs an `install` first, `install` always registered an OS service, and `grant issue` needs a label. It also found that the app's example port (8088) did not match cadre-host's default (8765), and that the firewall advice did not cover a Wi-Fi network marked Public with existing Block rules for `node.exe`.

## What landed

- **`cadre-host install --no-service`** (`InstallOptions.noService`). Writes the data dir, identity key, `host.config.json` and the `nat.json` seed, then returns before service registration. It also skips the browser open and the enrollment-invite fetch, because nothing is listening after such an install. `InstallResult.serviceName` is optional (absent in this case). The CLI prints `Service: not registered (--no-service)` and the `start --data-dir` command to run.
- The integration-test harness (`test-cadre-host.ts`) uses `noService: true` in place of its no-op service-host stub.
- **App:** example port 8088 → 8765 in the Host URL placeholder, doc comments and the empty-address error. The connect-timeout message now also points at the host's firewall.
- **Guide** (`docs/reference-app-rn.md`): build → `install --non-interactive --no-service --no-upnp --no-invite --data-dir <dir>` → `start` → `grant issue "phone test"`; how the management port is chosen; the Windows firewall (per-profile rules, how to check, two fixes, Block overrides Allow); a "Network or app?" diagnostic using `adb reverse` of the lent node's `ws` port.
- Docs: `packages/cadre-host/README.md`, `docs/cadre-host.md`, `docs/architecture.md` (installer bullet).

## Review findings

**Checked:** the implement diff (`1c100d1a`) end to end; every guide claim against the source: the `uiPort` fallback to +9 (`server/server.ts`), the `grant issue` label argument and `--port` / `$CADRE_HOST_PORT` defaults (`bin/host.ts`), the lent-node port range 10000–20000 (`orchestrator/host-process-orchestrator.ts`), the `/ws` listen addresses, and the UI's "Ports … ws" line (`ui/src/routes/NodeDetail.svelte`). All matched. Ran the guide's read-only firewall commands on the Windows PC from the device run: `Get-NetConnectionProfile` and `Get-NetFirewallApplicationFilter -Program (Get-Command node).Source | Get-NetFirewallRule` work as written and list the two Block rules on Public.

**Found and fixed in this pass:**
- The guide said answering Windows' prompt with only *Private networks* ticked "probably" leaves Block rules on Public. The PC shows two Block rules on Public (TCP and UDP) and **no Allow rule on any profile**, so that cause does not fit what is on the machine. Replaced it with the verified facts: no prompt appears once any rule exists; the PC had Block rules on Public and no Allow rule.
- Following from that, the "mark the network Private" fix now says it works *only* when an Allow rule for `node.exe` covers Private, noting the 2026-09-17 PC had none. The blocked device-run ticket's unblock list got the same note, because its first option (mark Private) would likely not have been enough on its own.
- The example `New-NetFirewallRule` opens TCP 10000–20000 to every program on every Public network. Added a line saying to remove it after the session, with the `Remove-NetFirewallRule` command.
- The `-DisplayName "*Node*"` note said it finds "other Node installs". On this PC it finds rules for an unrelated program (`nodeodm.exe`). Reworded to "other programs with Node in the name".
- `installer/index.ts`: the `// 5. Service-host registration.` comment sat above the shared `uiUrl` constant. Moved the constant above the comment so the step comment heads the `noService` branch.
- `docs/architecture.md`'s installer bullet did not mention `--no-service`. Added it.
- Test gap: the implement test covered `noService` only with `nonInteractive: true`, where the invite fetch never runs anyway. Added "noService on an interactive install skips the enrollment-invite fetch" (wizard stub, `fetch` spied, not called).

**Considered, no change:**
- The Settings screen's hint text still has no firewall mention. Left as is: the hint is already four sentences, and the connect-timeout error, which appears exactly when the firewall is the problem, now names it.
- `--no-service` on an interactive install still runs the wizard. That is consistent (the wizard asks for data dir and ports, which still apply). Only the non-interactive form is documented, which is enough for the guide.
- `cadre-host status` after a `--no-service` install reports "Service installed: no", which is accurate. `uninstall` after one would try to deregister a service that does not exist; that is the same as running `uninstall` on any machine without the service and was not changed.
- Re-running `install` on an existing data dir rewrites `host.config.json` (new `installId`, ports reset to the flags given). That was already true before this change, and the guide runs `install` once per data dir.

**Not verified:** the guide has still not been walked on a phone, and the administrator firewall commands (`Set-NetConnectionProfile`, `New-NetFirewallRule`, `Disable-NetFirewallRule`) were not run, because changing this PC's firewall is the human decision the blocked ticket `rn-host-node-request-device-run` is waiting on. The device re-run remains that ticket's job.

**Tripwires:** none.

**Validation:** `yarn workspace @serfab/cadre-host test` 68 files, 652 passed / 4 skipped; `yarn workspace @serfab/reference-app-rn test` 21 files, 315 passed; `yarn workspace @serfab/cadre-host run typecheck` clean; integration-tests `tsc --noEmit` clean; `yarn lint` clean. The integration harness scenarios were not re-run in review; the implementer ran `cadre-host-origin-guard` and `cadre-host-sse-events`, and the review changes do not touch that path.
