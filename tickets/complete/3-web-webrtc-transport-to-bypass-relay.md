----
description: COMPLETE — @libp2p/webrtc (webRTC + webRTCDirect) transport added to reference-app-web's libp2p node. Relay becomes signaling-only; NAT-to-NAT browser pairs upgrade to a direct WebRTC data path. ICE from the runtime manifest. Relay reservation cap left ON. Reviewed; minor findings fixed inline.
files: packages/reference-app-web/src/lib/optimystic.ts, packages/reference-app-web/src/lib/ice-config.ts, packages/reference-app-web/package.json, packages/reference-app-web/e2e/distributed/webrtc-upgrade.spec.ts, packages/reference-app-web/e2e/distributed/connection-path.spec.ts, packages/reference-app-web/e2e/distributed/_helpers.ts, packages/reference-app-web/e2e/solo/diagnostics.spec.ts, packages/reference-app-web/README.md
----

## What shipped

`reference-app-web`'s libp2p node now carries the canonical browser WebRTC pattern: reserve a circuit-relay slot → peer dials in over `/p2p-circuit` → SDP exchanged over the circuit → direct WebRTC connection forms → relay drops out of the data path. The 128 KiB / 2 min per-reservation cap (service-relay side, in db-p2p) was **not** touched — once the upgrade works that cap is a feature.

- `optimystic.ts`: imports `{ webRTC, webRTCDirect }` and `{ loadIceConfig }`; `const iceServers = await loadIceConfig()` before building config; `transports: [webSockets(), circuitRelayTransport(), webRTC({ rtcConfiguration: { iceServers } }), webRTCDirect()]` (the two webRTC factories carry a documented `as unknown as TransportFactory` brand-bridge cast); `listenAddrs: isDistributed ? ['/p2p-circuit', '/webrtc'] : []`. `connectionGater` and the relay cap untouched.
- `package.json`: `"@libp2p/webrtc": "6.0.14"` (exact pin — the `^6.0.24` the source ticket guessed pulls `@libp2p/interface@3.2.3` and breaks the transports array; 6.0.14 is the latest 6.x declaring `@libp2p/interface@^3.1.0`, matching db-p2p's pin).
- New `e2e/distributed/webrtc-upgrade.spec.ts` (flip-point assertion); `connection-path.spec.ts` relaxed to relay-or-webrtc; `gotoMessages`/`sendOne` lifted into `_helpers.ts` (DRY).

## Review findings

### Scope of review
Read the full implement diff (`aea0dab`) fresh, then every touched file and the files it *should* have touched: `optimystic.ts`, `ice-config.ts`, `connection-path.ts`, the three e2e specs, `package.json`, both READMEs, and `docs/`. Re-ran the full validation suite from scratch. Verified the version-pin and type-cast claims against the installed `node_modules`.

### Validation re-run (all green this pass — not just trusting the handoff table)
| Check | Command | Result |
|---|---|---|
| src typecheck | `yarn workspace @serfab/reference-app-web run typecheck` | 0 errors |
| e2e typecheck | `tsc --noEmit -p tsconfig.e2e.json` | 0 errors (incl. my spec edits) |
| svelte-check | `yarn exec svelte-check` | 0 errors / 0 warnings / 548 files |
| build | `yarn run build` (`tsc --noEmit && vite build`) | success, `✓ built in ~5s`, 1.44 MB / 432 kB gzip |

Pre-existing vite warnings (dynamic/static dual-import for `@libp2p/peer-id` + `p2p-fret` from optimystic `dist/`, and the >500 kB chunk note) are unchanged and not introduced here.

### Verified claims (the two the implementer flagged "review carefully")
- **Version pin 6.0.14** — confirmed installed at `packages/reference-app-web/node_modules/@libp2p/webrtc` declaring `@libp2p/interface@^3.1.0`; browser export resolves. Correct generation for libp2p 3.1.3.
- **Type cast runtime-safety** — confirmed the crux: every installed `@libp2p/interface` copy (incl. the 3.2.x ones webrtc's transitive deps drag in) defines `export const transportSymbol = Symbol.for('@libp2p/transport')`. `Symbol.for` is a global-registry key → identical at runtime across interface copies → libp2p's `transport[transportSymbol] === true` registration check passes. The skew is purely nominal; the cast is not papering over a runtime bug. The config object is still type-checked at the `webRTC(...)` call (only the return brand is erased), no `any`. Accepted as-is.

### MAJOR findings → new tickets
**None.** No correctness defect, missing subsystem, or design flaw warranting a fix/plan/backlog ticket was found. The transport wiring is correct, the classifier already maps `/webrtc` → `direct/webrtc` (ordered before `/p2p-circuit`, covered by `solo/connection-path-parity.spec.ts`), the relay cap was correctly left untouched, and solo `listenAddrs` correctly stays `[]`.

### MINOR findings → fixed inline this pass
1. **Regression: `e2e/solo/diagnostics.spec.ts` asserted `toHaveLength(2)` for registered transports.** The webRTC/webRTCDirect factories are added to the `transports` array **unconditionally** (solo and distributed alike — only `listenAddrs` is mode-gated), so a healthy browser bundle now registers **four** transports. The implementer's handoff claimed "Solo unchanged… existing solo specs stay green" — that was **false**; this spec would fail the moment CI runs it. **Fixed:** the spec now asserts length 4 and the presence of `websockets`, `circuit-relay`, `webrtc`, and `webrtc-direct` (the `webrtc` matcher uses a negative lookahead so it doesn't also match `webrtc-direct`); the TCP-leak guard is preserved. e2e typecheck re-confirmed green. (Still human/CI-run, like all e2e here.)
2. **Stale docs: `packages/reference-app-web/README.md` diagnostics section claimed "exactly two" browser transports in two places** (the Transports bullet and the "Did Optimystic accidentally pull in TCP?" recipe). Verified the diag panel reads each transport's `[Symbol.toStringTag]` (`diagnostics.svelte.ts:363`), which for the new transports is `@libp2p/webrtc` / `@libp2p/webrtc-direct`. **Fixed:** both spots now describe the four-transport bundle and the relay→direct upgrade, TCP-leak guidance intact. (`docs/` and the root `README.md` carry no web-transport enumeration — checked, nothing else stale.)
3. **Robustness gap the wiring introduced: `loadIceConfig()` `fetch` had no timeout, and this ticket newly `await`s it during `startNode`.** Before this change `loadIceConfig` was never on the boot path; now a configured-but-hung manifest host would stall node startup indefinitely (the default no-URL path returns immediately, so only a misconfigured/flaky manifest triggers it). `ice-config.ts` is in this review's `files:` scope, so **fixed inline:** added a 5 s `AbortController` deadline (`FETCH_TIMEOUT_MS`) with `clearTimeout` in `finally`; on timeout the existing catch returns the safe `[]` (STUN-less) fallback, preserving the never-throws contract. typecheck + svelte-check + build re-confirmed green.

### Carried-forward gaps (acknowledged, correctly NOT resolved here)
- **The e2e specs (`webrtc-upgrade.spec.ts` + the relaxed `connection-path.spec.ts` + the updated `diagnostics.spec.ts`) are NOT agent-runnable under tess** — they need `yarn build && yarn preview` (or `dev`) serving the app, Chromium, and the Tier-2 reference-peer fixture (relay + service peers). **A human / CI must run `yarn workspace @serfab/reference-app-web test:e2e` with the fixture up.** Green typecheck means "the assertions compile", not "the upgrade fires". This is a genuine floor, not a defect.
- **The upgrade may not fire on first run** (the single most likely failure mode): it depends on the dialer having the target's `/…/p2p-circuit/webrtc/p2p/<peer>` addr in its peerStore. The relayed addr already propagates and adding `/webrtc` to `listenAddrs` advertises the variant over the same identify/cohort flow, so it is *expected* self-sufficient — but unproven. Contingency (deliberately **not** filed speculatively, per the source ticket): if the e2e shows no upgrade, file `tickets/backlog/web-webrtc-signaling-addr-resolution.md` (wire a db-p2p peerStore address-resolver seam, or consume the prereq's `resolvePeerAddrs`) rather than expanding the transport work. `webrtc-upgrade.spec.ts`'s header documents this inline.
- **The relaxed `connection-path.spec.ts` poll** (`relayed >= 1 || webrtc present`) is honest but weaker — it no longer guarantees a relay was observed (the relay can upgrade away before the poll). Intentional; a reviewer wanting a strict relay-then-webrtc transition assertion can tighten it once fixture timing is proven stable. Not a defect.
- **`6.0.14` is an exact pin** and will not pick up patch fixes; any future range must stay bounded to the `^3.1.0`-interface generation (`>=6.0.8 <6.0.15`) — a plain `^6.0.14` resolves back to 6.0.24 and reintroduces the TS2322 break.

### Success criteria for the human/CI e2e pass (unchanged)
- **Upgrade flip:** two browsers connect via the Tier-2 fixture; within ~60 s `getConnectionPaths()` on ≥1 side reports a `direct` path with `transport === 'webrtc'` and `stuckOnRelay === 0`; the pair's relayed count trends to 0. (`webrtc-upgrade.spec.ts`.)
- **Solo unchanged:** solo boots with `listenAddrs: []`, no reservation, four transports present-but-idle; `solo/diagnostics.spec.ts` now expects 4. (Build/typecheck green here; e2e human/CI.)
- **Relay drop survivable / no relay for a public drone:** manual / future e2e.

## Follow-ons (already in backlog, not part of this ticket)
- `tickets/backlog/rn-webrtc-transport.md` — mirror this into `reference-app-rn` (and the `ice-config.ts` timeout improvement when that file is ported).
- `tickets/backlog/turn-credential-issuance-service.md`, `turn-relayed-path-metrics.md` — dormant TURN work referenced by `ice-config.ts`.
