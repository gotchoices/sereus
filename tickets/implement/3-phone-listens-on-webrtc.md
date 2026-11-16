description: The phone app carries WebRTC but never offers a WebRTC address, so no other machine can open a direct connection to a phone, and two phones always talk through the relay server. The phone should offer one whenever it has a relay, as the web app already does.
prereq: webrtc-addresses-never-hold-a-dial
architecture: docs/platforms/react-native.md#transport-and-reachability
files: packages/reference-app-rn/src/cadre-phone.ts, packages/reference-app-web/src/lib/web-edge-platform.ts (`listenAddrs` ~77), packages/cadre-core/src/edge-node/platform.ts, packages/cadre-core/src/edge-node/config.ts (comment ~79-83), packages/cadre-core/src/edge-node/index.ts, packages/cadre-host/src/orchestrator/host-process-orchestrator.ts (comment ~100-110), docs/platforms/react-native.md
difficulty: easy
----
# The phone listens on `/webrtc` when it has a relay

## What is missing

`cadre-phone.ts` adds `webRTC({ rtcConfiguration: { iceServers } })` to the phone's transports, and its comment says a relayed connection "hole-punches to a direct `/webrtc` data path". It doesn't.

- **No `/webrtc` address.** The phone passes no `listenAddrs`, so the edge node's default `[]` applies (`edge-node/config.ts`) and the phone never advertises a `<relay>/p2p-circuit/webrtc/p2p/<id>` address. A WebRTC connection is opened by dialling the listener's `/webrtc` address, so no peer can open one to a phone.
- **What still works.** A phone can dial out to a web tab, which does listen. Phone-to-phone and Node-to-phone stay relayed for good.
- **The docs' reason doesn't apply.** `docs/platforms/react-native.md` → "Transport and reachability" says "A phone dials out over WebSocket and cannot listen". That is true of TCP and WebSocket. A `/webrtc` listener binds no socket: it registers the signalling handler and derives its address from the relay reservation the phone already holds.
- **Already verified.** GitHub #61 ran phone-shaped Node parties and an S7 with `listenAddrs: ['/webrtc']`. Both went direct when ICE could connect.

The prereq has to land first. Without it, offering a WebRTC address makes joins fail wherever ICE can't connect (#61: 3 of 3 phone-to-phone runs on different home networks).

## Change

- **A shared helper**, `webrtcListenAddrs(relayAddrs)`, in cadre-core's edge-node module, exported from `@serfab/cadre-core/edge-node`. It returns `['/webrtc']` when `relayAddrs` is non-empty, else `[]`. With no relay there is no signalling path, and the solo posture (accepting nothing) stays as it is.
- **Use it in both apps.** `web-edge-platform.ts` replaces its local `listenAddrs` function with the helper. `cadre-phone.ts` passes `listenAddrs: webrtcListenAddrs`; `PhoneNodePlatform` already takes `listenAddrs`, since it extends `EdgeNodePlatform`.
- **Comments**: fix the `cadre-phone.ts` comment so it describes a WebRTC connection offered alongside the relay. In `edge-node/config.ts` and `edge-node/platform.ts`, say that an app carrying WebRTC adds `/webrtc`, not just a browser. In `host-process-orchestrator.ts`, change "listens on nothing" to "has no TCP or WebSocket listener".
- **Docs** (`docs/platforms/react-native.md` → "Transport and reachability" and its subsection "Reachability: configuring a relay"): update the config block and the relay paragraph to say the phone offers a WebRTC address when it has a relay, and that two phones whose networks don't allow a direct path stay relayed.

## Edge cases & interactions

- **The relay is down at start** (`requireRelay: false`): the `/webrtc` listener comes up with nothing to advertise until a reservation lands. This is the web tab's behaviour today. Verify by inspection.
- **Strand nodes** inherit the configured listen entries (`strand-network-config.ts` → `strandNodeAddrs` keeps non-circuit entries), so each strand node also offers a WebRTC address. That is wanted, because strand traffic is the bulk. Verify by inspection.
- **Relays changed at runtime** (Settings → Relay restarts the node with new start options): the helper runs again at build time. No live update needed.
- **No microphone or camera use**: data channels only. `app.json` already carries the WebRTC plugin's "Unused" permission text.
- **Battery**: a listener costs nothing at rest. Upgrade attempts are rate-limited by `relayed-connections-try-a-webrtc-upgrade`.

## Verification

- `yarn workspace @serfab/reference-app-rn typecheck`, its tests, and `test:bundle` (Android export).
- `reference-app-web` typecheck and tests, for the helper swap.
- No new test: this is wiring, and the prereq's scenario already covers a phone-shaped party with `listenAddrs: ['/webrtc']`.
- **Device run, handed to a human:** two phones on different networks still join (relayed), and a phone plus a machine on the same LAN go direct (Diagnostics shows a `webrtc` connection). Say in the handoff that this was not run.

## TODO

- Add and export `webrtcListenAddrs` from cadre-core's edge-node module.
- Use it in `web-edge-platform.ts` and `cadre-phone.ts`.
- Correct the comments in `cadre-phone.ts`, `edge-node/config.ts`, `edge-node/platform.ts` and `host-process-orchestrator.ts`.
- Update `docs/platforms/react-native.md`.
- Run the verification above, and note that the device run is pending.
