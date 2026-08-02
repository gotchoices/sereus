---
description: Tests now boot a node configured with the same peer-to-peer connection types the phone and browser apps ship, and prove its own-settings reads and writes still answer promptly. Review the new tests for whether they actually exercise that connection type rather than quietly falling back to the old one.
files: packages/cadre-core/test/control-database-offline-peers.spec.ts, packages/cadre-core/package.json, yarn.lock
difficulty: medium
---

# Review: WebRTC transports in the control-database liveness suite

## What landed

`@serfab/cadre-core`'s control-database liveness spec now runs the two reference apps' real
transport lists. Four new cases in `control-database-offline-peers.spec.ts`, inside the existing
`describe('stress and transport shapes (transaction profile)')` block:

| case | transports | sibling addresses | wall clock |
| --- | --- | --- | --- |
| `…with the BROWSER reference transport list` | `[webSockets(), circuitRelayTransport(), webRTC(), webRTCDirect()]` | relayed `/webrtc` + `/webrtc-direct` | 10.3 s |
| `…with the PHONE reference transport list` | `[webSockets(), circuitRelayTransport(), webRTC()]` | relayed `/webrtc` only | 10.3 s |
| `a WebRTC reconcile pass grinding through dead dials cannot block a local read or write` | browser list | 3 siblings, both shapes each | 30.3 s |
| `stop() resolves inside its budget with a WebRTC dial in flight` | browser list | 1 sibling, both shapes | 0.16 s |

Supporting changes:

- `packages/cadre-core/package.json` — `"@libp2p/webrtc": "6.0.14"` added to `devDependencies`
  (exact pin, matching both reference apps). `yarn.lock` delta is **one line**: the resolution
  already existed because the reference apps pin the same version.
- New spec helpers: `WEBRTC_CERTHASH`, `TransportFactory`, `browserTransports()`,
  `phoneTransports()`, `dialTransportTag()`, `expectDialRouting()`, `mintWebRtcPeer()`.

## The one thing to check hardest: is it vacuous?

The whole risk of this ticket is a test that *lists* `webRTC()` and then dials a `/ws` address —
proving nothing. The guard is `expectDialRouting`, which calls libp2p's
`transportManager.dialTransportForMultiaddr(ma)` and asserts the `Symbol.toStringTag` of whatever
transport claims each address, **before** the operation set runs. Measured on this machine:

- browser list: relayed `…/p2p-circuit/webrtc/…` → `@libp2p/webrtc`;
  `…/udp/…/webrtc-direct/certhash/…` → `@libp2p/webrtc-direct`
- phone list: relayed → `@libp2p/webrtc`; `/webrtc-direct` → `null` (nothing claims it)

A reviewer wanting to falsify this can flip an expected tag and confirm the case fails, or delete
`webRTC()` from `browserTransports()` and confirm the routing assertion — not just the timing —
goes red.

## Deviations from the plan ticket

**The `as unknown as` cast WAS needed.** The plan predicted no cast, reasoning that `cadre-core`
is not hoisting-limited. That reasoning does not hold: `tsc` shows `@libp2p/webrtc` resolving its
`@libp2p/interface` at
`node_modules/@libp2p/webrtc/node_modules/@libp2p/interface-internal/node_modules/@libp2p/interface`
— the nesting comes from `@libp2p/interface-internal`'s own pin, not from any `installConfig`. So
the same brand-skew bridge `reference-app-web/src/lib/cadre-web.ts` uses is applied here, via a
local `TransportFactory = NonNullable<NetworkConfig['transports']>[number]` alias with a comment
pointing at that file's explanation. No `any`. `webSockets()` and `circuitRelayTransport()` need no
bridge — they resolve to the hoisted copy.

**Case sizing.** The grinding-pass case uses **3** siblings (mirroring the existing blackhole
dial-storm case) under `MULTI_RECONCILE_TIMEOUT_MS`; the plan did not fix a count. Measured
30.3 s, so the 60 s budget holds with headroom and `RECONCILE_TIMEOUT_MS` (30 s) would *not* have.

**File growth.** +231 lines, not the ~130 the plan estimated. File is now 750 lines (`wc -l`),
up from 519.

## Validation actually run

- `yarn workspace @serfab/cadre-core run typecheck` — clean.
- `yarn workspace @serfab/cadre-core run test control-database-offline-peers --reporter=verbose` —
  **13 passed / 13**, 165 s. Per-case timings in the table above.
- `yarn workspace @serfab/cadre-core run test` (whole package) — 1390 passed, 5 failed, 1 skipped
  across 86 files. **All 5 failures are the already-tracked entry** in
  `tickets/.pre-existing-known.md`
  (`10-revocation-reissue-same-pk-update-unique-collision`, blocked) —
  `control-revocation-reissue.spec.ts` (4) and `control-revocation-replay.spec.ts` (1), same two
  fingerprints as recorded there. Not re-reported, not skipped, nothing touched.
- `yarn lint` — clean.
- `yarn dep-check` — knip reports no unused/unlisted dependency for `cadre-core`; only the
  pre-existing unused-files / unused-exports noise. `check-dep-ranges` passes.
- **The vitest process exits on its own** after both runs — the failure mode a green test list
  would not have shown (a native `RTCPeerConnection` outliving the suite) does not occur. Also
  confirmed standalone: a Node script that builds the browser transport list, routes addresses and
  stops the node exits with no `process.exit()`.

Note for whoever runs this next: the stale-build guard tripped on `@quereus/quereus` before the
first run and was cleared by `yarn workspace @quereus/quereus build` in `C:\projects\quereus`, as
the guard instructs. Nothing in this repo was reverted or rebuilt.

## Known gaps — treat the tests as a floor

- **The browser app's listening posture is NOT covered.** `listenAddrs: ['/p2p-circuit', '/webrtc']`
  only applies when the tab holds a relay reservation, which needs a live relay to reserve against.
  That is an integration-suite shape, out of scope here and still uncovered. Every new case runs
  the non-listening posture (`listenAddrs: []`).
- **The in-flight-dial cases assert queue depth, not queue identity.** `stop() … with a WebRTC dial
  in flight` spins on `getDialQueue().length > 0` and the grinding-pass case just races local ops
  against an unawaited pass. `expectDialRouting` proves which transport *would* claim each address,
  but nothing asserts the queued entry is the WebRTC one specifically. If a reviewer can cheaply
  read the transport off a dial-queue entry, that would close the loop.
- **The phone case asserts routing on an address that is not on the sibling's record.**
  `mintWebRtcPeer(owner, 52, false)` records only the relayed address, but the case still asserts
  the `/webrtc-direct` shape routes to `null`. Deliberate — recording it would only exercise
  libp2p's address filter and buy nothing — but it means the `null` assertion is about the
  transport list, not about anything the pass actually dialed.
- **Transaction profile only**, matching the existing transport-shape cases. The
  `transaction`/`storage` split is exercised by the departed/blackhole cases.
- **No timing assertions anywhere**, by design: an RFC 5737 (`192.0.2.0/24`) address on a CI
  network that answers it degrades a blackhole into a refused connect, and both must pass.
- **`node-datachannel` is a native module.** On a platform with no prebuilt binary it compiles from
  source at install; on one where the binding cannot load, the top-of-file `import` fails the whole
  spec file, not just the four new cases. Only exercised on win32/Node 24 here.

## Tripwires parked (index only — the analysis lives at the sites)

- File-size tripwire → `NOTE:` comment above the
  `describe('stress and transport shapes (transaction profile)')` block: split it into its own spec
  and lift the shared helpers into `control-db-node-helpers.ts` if it gains more than a couple more
  transport shapes. Carries the measured 750-line count and the command.
- Native-binding tripwire → `NOTE:` comment heading the WebRTC helper section: what breaks, and
  that the fix is a prebuild/toolchain one, not deleting the coverage.

## Review checklist

- Flip an expected transport tag in `expectDialRouting` and confirm the case fails — the
  anti-vacuity guard has to actually bite.
- Confirm the `as unknown as TransportFactory` bridge is the narrowest thing that typechecks (the
  alternative would be pinning several transitive `@libp2p/*` packages).
- Confirm `WEBRTC_CERTHASH` parses: a malformed certhash makes `multiaddr()` throw,
  `parseMultiaddrs` silently drops the address, and the case goes vacuous again — the routing
  assertion is what catches that, so check it is not accidentally skipped for the direct shape.
- Confirm the blackhole address band 51–56 does not collide with the existing 1/2/3/11/12/13/21/31/41.
- Confirm no reference app and no `CadreNode` source file was touched (`git status` should show
  only the spec, `packages/cadre-core/package.json`, and `yarn.lock`).
