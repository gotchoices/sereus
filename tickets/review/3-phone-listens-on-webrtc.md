description: The phone app now offers a WebRTC address whenever it has a relay, so another machine can open a direct connection to a phone instead of everything going through the relay server. Needs a review pass, and a device run that has not happened.
architecture: docs/platforms/react-native.md#transport-and-reachability
files: packages/cadre-core/src/edge-node/listen-addrs.ts, packages/cadre-core/src/edge-node/index.ts, packages/cadre-core/src/edge-node/config.ts, packages/cadre-core/src/edge-node/platform.ts, packages/cadre-rn/src/phone-node/index.ts, packages/cadre-rn/README.md, packages/reference-app-rn/src/cadre-phone.ts, packages/reference-app-web/src/lib/web-edge-platform.ts, packages/cadre-host/src/orchestrator/host-process-orchestrator.ts, docs/platforms/react-native.md, docs/platforms/browser.md
----
# The phone listens on `/webrtc` when it has a relay

## What landed

**A shared listen-address helper.** `webrtcListenAddrs(relayAddrs)` in a new `packages/cadre-core/src/edge-node/listen-addrs.ts`, exported from `@serfab/cadre-core/edge-node`. It returns `['/webrtc']` when `relayAddrs` is non-empty, `[]` otherwise. Its comment states the reason a `/webrtc` listener is free of the "a phone cannot listen" objection: it binds no socket, it registers the signalling handler and derives its address from the relay reservation, so with no relay there is no signalling path and the solo posture (accepting nothing) is kept.

**Both apps use it.** `web-edge-platform.ts` dropped its own local `listenAddrs` function for the helper — same behaviour, one copy. `cadre-phone.ts` now passes `listenAddrs: webrtcListenAddrs`, which is the behaviour change: the phone advertises `<relay>/p2p-circuit/webrtc/p2p/<id>` whenever it holds a reservation, so a peer can dial it directly.

**The kit re-exports it.** `@serfab/cadre-rn/phone-node` re-exports `webrtcListenAddrs` alongside the other edge-node names it republishes, so the RN app reaches the kit through its one door rather than adding a second import route into `@serfab/cadre-core/edge-node`. That was a judgement call beyond the ticket's literal wording — the ticket said "exported from `@serfab/cadre-core/edge-node`", which it also is. Flagging it in case the reviewer prefers the app import cadre-core directly.

**Comments corrected.** `cadre-phone.ts` (the transports comment no longer claims a hole-punch that nothing was configured for; it now describes the `/webrtc` address offered alongside the relay, and a new comment sits on `listenAddrs`), `edge-node/config.ts` and `edge-node/platform.ts` (an app carrying WebRTC adds `/webrtc`, not just a browser; "binds no socket" rather than "accepts no inbound connection"), and `host-process-orchestrator.ts` ("has no TCP or WebSocket listener" instead of "listens on nothing", plus why the phone is still the one that dials — a managed child carries no WebRTC transport).

**Docs.** `docs/platforms/react-native.md` → "Transport and reachability" (the opening claim, the config block, which now shows `listenAddrs: webrtcListenAddrs`, and the no-relay case) and "Reachability: configuring a relay" (the address paragraph, plus a new bullet saying a direct path is not guaranteed and two phones whose networks do not let ICE connect stay relayed). Two things beyond the ticket's list, both to keep one home per fact: `docs/platforms/browser.md` now names the shared helper instead of inlining the same expression, and the kit README's platform-options table gained the `listenAddrs` row it never had.

## Out of scope, left alone

Several docs and source comments still say a phone or a browser tab "listens on nothing" or "cannot listen" (`docs/cadre/membership.md`, `docs/hosting/cadre-host.md`, `docs/getting-started.md`, `packages/cadre-core/src/bootstrap-peer-store.ts`, `relay-addrs.ts`, `types.ts`, and others). Each remains true in the sense that matters where it is written — a phone's only address still comes from a relay reservation, and nothing can dial it without one — so none was rewritten. A reviewer who disagrees about a specific one should say which.

## What to check

- **The helper's branch is the whole decision.** No relay → `[]` → cadre-core's derivation leaves the listen list empty (`relay-addrs.ts` → `resolveListenAddrs`), which is the pre-existing posture. A relay → `['/webrtc']` plus the bare `/p2p-circuit` entry cadre-core adds.
- **`/webrtc` cannot make a start throw.** `resolveTransportOptions` (`relay-addrs.ts:232`) returns `{}` immediately when `network.transports` is set, which the edge node always sets, so the `UnbindableListenAddressError` path that would reject `/webrtc` as having no default transport is never reached. Verified by reading both; worth a second pair of eyes, since an app that passed no `transports` while passing this helper WOULD hit that error. That combination is not reachable today: `createEdgeNode` supplies a default transport list.
- **Strand nodes.** `strandNodeAddrs` (`strand-network-config.ts:128`) keeps non-circuit entries and `ephemeralPortListenAddr` passes `/webrtc` through unchanged (it names no fixed port), so every strand node also offers a WebRTC address. Wanted: strand traffic is the bulk. Verified by reading.
- **Relay down at start.** `requireRelay: false` is unchanged, so the `/webrtc` listener comes up with nothing to advertise until a reservation lands — the web tab's behaviour today. Verified by inspection only.
- **Relays changed at runtime.** Settings → Relay restarts the node with new start options, and the helper runs again at build time, so there is nothing live to update.

## Validation run

- `@serfab/cadre-core` typecheck and build: clean. `@serfab/cadre-core test`: 198 files, 2654 passed, 1 skipped.
- `@serfab/cadre-rn` typecheck, build, `test`: clean; 16 files, 174 passed.
- `@serfab/reference-app-rn` typecheck: clean. `test`: 20 files, 180 passed.
- `@serfab/reference-app-web` typecheck: clean. `test`: 4 files, 11 passed.
- `@serfab/cadre-host` typecheck: clean. `yarn lint` (ESLint + `check:docs`): exit 0, 66 Markdown files OK.
- **No new test.** The change is one two-line branch plus wiring, and `webrtc-addresses-never-hold-a-dial`'s scenario already runs a phone-shaped party with `listenAddrs: ['/webrtc']`.
- **`test:bundle` FAILED, and not because of this ticket.** `yarn workspace @serfab/reference-app-rn test:bundle` fails at 99.3% with `Unable to resolve module @optimystic/db-core from packages/cadre-core/dist/index.js`. That import (`cadre-core/src/index.ts:245`) and its importer are unchanged at HEAD, and cadre-core's root entry was already in the phone app's bundle graph before this change. Written up in `tickets/.pre-existing-error.md` for the runner's triage pass. Consequence for this ticket: the Android export did not confirm the bundle, so nothing here is verified past typecheck and unit tests.
- **The device run was NOT performed** — no phone was involved at any point. Still owed, by a human: two phones on different networks still join (relayed); a phone and a machine on the same LAN go direct, with Diagnostics showing a `webrtc` connection. The second is the only thing that proves the feature works end to end.
