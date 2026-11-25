description: Someone with a real phone needs to check that the phone app now connects directly to another machine instead of sending everything through the relay server, because no phone was involved in building or testing the change.
architecture: docs/contributing/device-testing.md#device-test-runs
files: packages/reference-app-rn/src/cadre-phone.ts, packages/cadre-core/src/edge-node/listen-addrs.ts, packages/reference-app-rn/app/settings.tsx, docs/platforms/react-native.md, docs/contributing/device-testing.md
repro: none
----
# Nobody has seen a phone take a direct connection

**Blocked on:** a physical phone (two would be better) and a native build of the reference app, plus a reachable relay. That is a dependency outside what an agent can do here. It is unblocked when a person runs the session below and records the results in this ticket.

## Why a person is needed

`phone-listens-on-webrtc` made the phone app offer a WebRTC address whenever it holds a relay reservation, which is what lets another machine open a direct connection to the phone rather than paying the relay for every byte. Everything about it was checked headlessly: the configuration resolves to the intended addresses, the Android JavaScript bundle builds, and an integration scenario already exercises a node of exactly this shape. None of that puts a phone on a real network. The one thing that proves the feature works is a real phone holding a connection that classifies as `webrtc` rather than `circuit-relay`.

A native rebuild is needed only if the app on the device predates `react-native-webrtc` — the change itself adds no native module (`docs/platforms/react-native.md` → "When a native rebuild is needed").

**Where to look, since the phone app has no diagnostics screen.** The React Native reference app shows only the relay-reservation posture in its status banner; it has no per-connection view, which `docs/platforms/reference-apps.md` records as a deliberate difference from the web app. So read the connection from the other end instead: a cadre-cli node's `/status` endpoint reports `cadre_connections_direct` and `cadre_connections_by_transport` (`packages/cadre-cli/src/server/health.ts`), and the web reference app's Diagnostics page shows its own connections' transports. On the phone itself the evidence is logcat with the `sereus:cadre:webrtc-upgrade` debug namespace enabled.

## What to run

Follow `docs/contributing/device-testing.md` § Device test runs.

1. **A phone and a machine on one local network go direct.** Phone and an always-on cadre-cli node on the same Wi-Fi, both pointed at a reachable relay. Join or connect, then read the node's `/status`: a connection to the phone should appear under transport `webrtc`, and `cadre_connections_direct` should be non-zero. Record how long after the connection first opened the direct one appeared — the relayed connection comes first and the upgrade runs in the background, so expect a short gap (measured at about 0.5 s between a phone and a node on one network, in `relayed-connections-try-a-webrtc-upgrade`).
2. **Two phones on different networks still work.** Each phone on its own network — mobile data on one is the easiest way — joined to one party. The join must succeed and chat must flow. Whether the connection ends up direct here is information, not a pass condition: between two networks that allow no direct path there is no path to find, and staying relayed is the documented outcome (`docs/network/relay.md` → "Direct connections over WebRTC"). What would be a failure is a join that now fails, or messages that stop.
3. **No relay configured.** With Settings → Relay cleared, the phone should behave exactly as it did before: it founds and runs solo, and the status banner reports no reservation. This is the arm that confirms the change is inert without a relay.
4. **Battery and radio, informally.** Leave the phone idle for twenty minutes or so with a party whose other machine is unreachable over a direct path, and note whether the phone feels warm or the battery drops faster than usual. Repeated ICE attempts wake the radio; they are rate-limited by a doubling wait from 1 minute to 30 minutes, and this is the first time that runs on a phone with an address of its own.

## Expected outcome

Arm 1 shows a `webrtc` connection. Arm 2 joins and chats either way. Arm 3 is unchanged from before the feature. Arm 4 shows nothing unusual.

If arm 1 stays relayed on one local network, the thing to capture is logcat with `sereus:cadre:webrtc-upgrade` enabled: the upgrade service logs why it declined (`no-webrtc-addr` means the phone's address never reached the peer, `remote-dials` means it decided the other side should dial, `in-backoff` means an earlier attempt failed). If arm 2 regresses, that is the case `webrtc-addresses-never-hold-a-dial` was meant to close, and it should be reported against that rule rather than against this ticket.
