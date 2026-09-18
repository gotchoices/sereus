description: Someone with an Android phone needs to actually try borrowing a node from a home machine using the app's new Settings section, because that whole feature was written and tested without any phone being involved.
files: packages/reference-app-rn/src/phone-node-config.ts, packages/reference-app-rn/src/host-node-request.ts, packages/reference-app-rn/app/settings.tsx, docs/reference-app-rn.md
repro: none
----

# Borrowing a node from a cadre-host: nobody has tried it on a phone

## Why this needs a person

The feature landed with no device or emulator available, so every claim below is read off the code rather than seen working. The headless tests are real but they all run in Node against fakes, and Node cannot exercise the one thing that is most likely to be wrong: what the phone's bundler actually resolves and what the phone's network stack actually permits.

This is a blocked ticket rather than a backlog one because the missing ingredient is a physical Android phone on the same Wi-Fi as a PC — a dependency outside this repository, not a decision about what to build.

## What to run

`docs/reference-app-rn.md` → "Borrowing a Node From a cadre-host" is the written-down session: start `cadre-host`, issue a grant token, forward the management port with `adb reverse`, then Settings → Host Node on the phone. Follow it as written; where it turns out to be wrong, the doc is as much the deliverable as the code.

## What is actually unproven

**The dial permission.** The phone's node config now sets a permissive dial gater (`connectionGater: { denyDialMultiaddr: () => false }` in `src/phone-node-config.ts`). The reasoning is that libp2p's connection-gater package points its `react-native` entry at the browser build, which refuses to dial insecure `ws://` and private (home-network and loopback) addresses — exactly what a borrowed node is. A unit test checks the setting is present and permissive; nothing checks the premise. If the premise is wrong the setting is harmless, but if it is right and something else also blocks the dial, the request reaches "Connecting to the node…" and then fails after thirty seconds. That failure mode is the signal to watch for.

**Reaching the host at all.** The host only answers requests that look like they came from the machine it runs on, so the phone has to reach it through a forwarded port. Whether the forwarded request's `Host` header satisfies that guard has not been observed. If it does not, the app shows a message telling the user to forward the port — which is the advice they already followed, and the doc needs to say what actually works instead.

**The Windows firewall.** The doc says to allow `node.exe` on private networks when prompted. Whether that prompt appears, and whether allowing it is sufficient, is a guess.

**The plain-language wording.** Six progress lines and a dozen failure messages were written without ever being read on a phone screen. Wording that is too long, or that names something the user cannot act on, is worth correcting while someone is holding the device.

## Expected outcome

The progress line reaches "Connected." and the borrowed node's peer id shows up among the phone's connections. Chat traffic through the borrowed node is out of scope here — a borrowed node starts no strand of its own (ticket `always-on-nodes-host-strands-of-apps-they-do-not-run`).

Reconnecting to the borrowed node after an app restart cannot be checked yet: the phone picks a new cadre id on every launch until ticket `feat-rn-persist-node-start-options` lands.

## If the run finds bugs

File them as their own tickets rather than growing this one, the way the earlier device session (`rn-solo-founding-device-run`, completed) did. Update the doc section in place with whatever the run teaches.

## Device run 2026-09-17

Run by an agent over adb, 23:10–23:18 MDT, right after `rn-device-relay-run-optimystic-95fd269e` (same Metro session and bundle, sereus `76cb6880`, optimystic `95fd269e`). Galaxy Note 9 on Wi-Fi `LivingOnAPrarie` at 192.168.86.35. Windows 11 PC on the same Wi-Fi at 192.168.86.41 (also on Tailscale, 100.67.49.72).

**Still blocked, on a human decision about this PC's firewall.** Everything up to the lent node worked. The phone's dial to the node over the LAN is dropped by Windows. Unblock by doing one of these on the PC, then re-running:
- mark the Wi-Fi network Private (it is classified **Public**), or
- replace the existing inbound **Block** rules for `C:\Program Files\nodejs\node.exe` on the Public profile with an Allow rule (or add an Allow rule for the orchestrator's ports, 10000–20000).

Changing firewall or network settings on the user's machine was out of bounds for the agent.

### Steps and results

| Step | Result |
|---|---|
| Start cadre-host as the doc says (`cadre-host start`) | **Doc step does not work alone.** `start` requires a prior `install`, which also registers an OS service. Installed into a scratch data dir with a no-op service host (as `integration-tests` `test-cadre-host.ts` does, `uiPort 8088`, `noUpnp`), then `node dist/bin/host.js start --data-dir <dir>`: "node-donor mode … local UI: http://127.0.0.1:8088" within about 6 s |
| `cadre-host grant issue` | Needs `--port 8088`. The CLI defaults to 8765, the installer's default `uiPort`, and the app's placeholder says 8088. With the port: token printed, `maxNodes 1, no expiry` |
| `adb reverse tcp:8088 tcp:8088`, Host URL `http://127.0.0.1:8088` | **Works.** The forwarded request's `Host` satisfied the loopback origin guard. `POST /grants`, `GET /grants/:id/peer` and `PUT /grants/:id/seed` all succeeded |
| Phone Connect, solo (party `…000923`, no bootstrap, no relay) | 3336 ms, "Reachable: No — no relay configured" |
| Request Node, attempt 1 (LAN path) | Loan `grn_cVKw1qjM0876Lrvc` created 05:13:49.98Z and `seeded` 05:13:53.10Z (about 3 s). Progress reached "Connecting to the node…". **Failed about 66 s after the tap** with the modal "The lent node was set up but this phone could not reach it within 60 seconds. Check that the phone and the host are on the same Wi-Fi network." No detail line |
| Cleanup after attempt 1 | **Bug:** `[host-node-request] the host refused to end loan grn_cVKw1qjM0876Lrvc (HTTP 400)`. The loan stayed `seeded` and the node kept running. Filed `fix/rn-host-node-request-end-loan-refused-by-host` (Fastify `FST_ERR_CTP_EMPTY_JSON_BODY`: the app sends `content-type: application/json` on a body-less `DELETE`). The lent node's authorization-row removal logged no warning |
| Request Node, attempt 2 | Refused in about 3 s, because the leaked loan held the grant's only slot. Modal "Host node request failed", detail "Grant is already at its node cap", message "This grant has already lent out every node it is allowed to. Ask for a new grant, or end a loan on the host." Clear and actionable |
| Diagnosis of attempt 1 | From `adb shell`, `nc 192.168.86.41 10004` (and 10000) timed out and `ping` to the PC got no reply, while the router answered. On the PC, `Get-NetConnectionProfile` gave `Wi-Fi 6 … Public`, and `node.exe` has two inbound `Block` rules on the Public profile. **No firewall prompt appeared**, because Windows does not prompt again once a rule exists. The dial gater was not the cause, since a raw TCP connect from the shell fails the same way |
| Request Node, attempt 3 (loan from attempt 1 ended with a `DELETE` without the JSON header, and `adb reverse tcp:10004 tcp:10004` to forward the new node's WS port) | **Connected.** "Waiting for the node to start…" by +3 s, "Connecting to the node…" by +6.5 s, modal "Host node connected / Loan grn_sbpWiDpqEzkCi89B / Peer ID: 12D3KooWEfZLHkgjitMxUhS2mNWumjogLAnFokWQY8ZGLrgAjMmb" at +25.8 s. About 16 s of the connect stage went to the two unreachable `/ws` addresses (Tailscale, then LAN, 8 s each) before `127.0.0.1` |
| Lent peer among the phone's control connections | **Yes.** Inspector `Runtime.evaluate` on the phone's `CadreNode`: `getControlNode().getConnections()` = one connection, peer `12D3KooWEfZL…AjMmb`, `/ip4/127.0.0.1/tcp/10004/ws/p2p/…`, `open`, `outbound`. On the PC, adb's socket to port 10004 is `ESTABLISHED` |

The "Asking the host", "Adding the node to this cadre" and "Seeding" progress lines passed between two UI dumps (2–4 s each), so they were not seen on screen. Disconnect-while-requesting was not tried, because the leaked-loan bug above would have made its outcome predictable (a 400 on the `DELETE`).

### The four unproven items

- **Dial permission.** With the permissive gater in place, the phone dialed a loopback `ws://` address and connected. Whether the setting is *needed* was not tested (that would take removing it and rebuilding the bundle). The LAN failure was the firewall, not the gater.
- **Reaching the host.** Works through `adb reverse` of the management port.
- **Windows firewall.** The doc's advice does not cover a network marked Public with an existing Block rule, and no prompt appears in that case. Recorded in `fix/docs-borrow-node-from-cadre-host-setup-steps`.
- **Wording.** The progress lines seen and the three modals fit the screen and read well. The connect-failure message sends the user to check the Wi-Fi network, which was already correct. Adding "and that the host's firewall allows incoming connections" would have pointed at the real cause.

### What remains

1. Fix the PC's firewall or network category as above, then re-run with no port forward except the management port. Expected: "Connected." within about 20 s, the lent peer reached at `192.168.86.41:<ws-port>`.
2. After `fix/rn-host-node-request-end-loan-refused-by-host` lands, check on the device that a failed request ends its loan (`donations.json` → `terminated`) and that Disconnect during a request does the same.

Cleanup: both loans ended (`terminated`), no lent-node process left, cadre-host stopped, `adb reverse --remove-all` with an empty list after. The temporary install script was deleted. The scratch data dir sits outside the repo.
