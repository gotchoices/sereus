----
description: The phone and browser apps talk over a peer-to-peer connection type that none of our tests ever use, so a freeze caused by that connection type would not show up until a user hit it. Add tests that run a node with that connection type configured and prove its own-settings reads and writes still answer promptly.
files: packages/cadre-core/test/control-database-offline-peers.spec.ts, packages/cadre-core/test/control-db-node-helpers.ts, packages/cadre-core/package.json, packages/reference-app-web/src/lib/cadre-web.ts, packages/reference-app-rn/src/cadre-phone.ts, packages/cadre-core/src/cadre-node.ts
difficulty: medium
----

# Cover the WebRTC transports in the control-database liveness suite

## What this is

`@serfab/cadre-core`'s control-database liveness specs boot a real `CadreNode` whose siblings are
unreachable and assert that every read and write of the node's own settings answers from local rows
inside a deadline. Today those specs configure only WebSockets and circuit-relay. Both reference
apps also ship WebRTC:

- `packages/reference-app-web/src/lib/cadre-web.ts` (~line 334):
  `[webSockets(), circuitRelayTransport(), webRTC(), webRTCDirect()]`
- `packages/reference-app-rn/src/cadre-phone.ts` (~line 254):
  `[webSockets(), circuitRelayTransport(), webRTC()]`

Nothing in the repo runs a node with those transports. This ticket closes that.

The prerequisite (`debt-control-db-offline-peer-no-hang-coverage`) has landed — the harness this
builds on is `packages/cadre-core/test/control-database-offline-peers.spec.ts` plus
`control-db-node-helpers.ts`.

## Decisions already made (do not re-open)

### Run it in Node, in cadre-core

The plan ticket left three options open (Node with a native binding / a browser test environment /
the reference apps' own suites). **Node, in cadre-core, is settled** — verified by running it:

- `@libp2p/webrtc@6.0.14` lists `node-datachannel@^0.29.0` as a hard `dependency`, and its Node
  entry point is `export { RTCPeerConnection, … } from 'node-datachannel/polyfill'`.
- `import('@libp2p/webrtc')` and `new RTCPeerConnection()` both succeed under Node 24 on this
  machine, with the copy already installed under `packages/reference-app-web/node_modules`.
- A real libp2p node built with `[webSockets(), circuitRelayTransport(), webRTC(), webRTCDirect()]`
  started, routed and dialed WebRTC addresses, and stopped cleanly in Node (measurements below).

The alternatives lose: the browser app's suite runs under a browser/jsdom environment and the phone
app's under Jest, and neither owns the code under test — the question ("does a control read hang?")
is `cadre-core`'s.

### Add `@libp2p/webrtc` as a cadre-core devDependency, pinned to `6.0.14`

Pin exactly, matching both reference apps (`"@libp2p/webrtc": "6.0.14"`, no caret). The whole point
of the spec is to run the transport list a reference app actually ships; a floating range would let
the test drift onto a version no app ships.

Gates checked, no changes needed to any of them:

- `yarn check:dep-ranges` only inspects `dependencies` / `peerDependencies` /
  `optionalDependencies` of packages named in the root `resolutions` `link:` entries. A registry
  devDependency is out of its scope.
- `knip` (`yarn dep-check`) resolves `packages/cadre-core` with its default vitest plugin, so a
  devDependency imported from `test/**/*.spec.ts` counts as used. No `ignoreDependencies` entry.
- `packages/cadre-core/test/global-setup.ts`'s `TARGETS` stale-build list and its guard
  `build-targets.spec.ts` cover only workspace/`link:` **dependencies**. A registry devDependency is
  invisible to both.
- `reference-app-web`'s `installConfig.hoistingLimits: "workspaces"` isolates *that* package's tree;
  `cadre-core` has no such setting, so its devDependency hoists normally.

### Extend the existing spec file, do not create a new one

Put the new cases in `control-database-offline-peers.spec.ts`, inside its existing
`describe('stress and transport shapes (transaction profile)')` block — the block that already holds
the circuit-relay-in-the-transport-set case. It reuses `bootOwnerNode`, `insertResolvableOfflinePeer`,
`runControlOperationSet`, `expectIntactAfterPass` and `within` as-is; those live inside that spec
file, not in `control-db-node-helpers.ts`, so a new file would mean moving ~200 lines of a
just-landed spec for no behavioural gain.

The file is 519 lines today and this adds roughly 130. Add a `NOTE:` comment at the top of the
transport-shapes block: if that block grows past a few more shapes, split it into its own spec and
lift the shared minting/operation-set helpers into `control-db-node-helpers.ts`.

### No `as unknown as` cast is expected

`packages/reference-app-web/src/lib/cadre-web.ts:80` bridges the WebRTC factories to db-p2p's
`Libp2pTransports` with a cast, because that package's isolated tree gives it a second physical copy
of `@libp2p/interface` (whose `transportSymbol` is a `unique symbol`, so the brands differ by
identity). `cadre-core` is not hoisting-limited, and it already passes `webSockets()` — which nests
its own `@multiformats/multiaddr@13` exactly the way `@libp2p/webrtc` does — into
`NetworkConfig.transports` with no cast and typechecks. Write the transports plainly. **If**
`yarn workspace @serfab/cadre-core run typecheck` disagrees, apply the same
`as unknown as Libp2pTransports[number]` bridge with a comment pointing at `cadre-web.ts`'s
explanation, and say so in the review handoff. Do not reach for `any`.

## The vacuity trap — read this before writing the test

Putting `webRTC()` in the transport list proves nothing on its own. `reconcileControlCohort` dials
whatever `resolvePeerAddrs` returns, and libp2p routes each address to the transport that claims it.
A sibling recorded at `/ip4/192.0.2.1/tcp/4001/ws/…` is dialed by **WebSockets** no matter what else
is in the list — the WebRTC transports are then dead weight and the case is a rename of a test that
already exists.

So each new case must (a) record the sibling at an address the WebRTC transports actually claim, and
(b) **assert which transport libp2p picked** before running the operation set. libp2p exposes this
on the transport manager:

```ts
import type { Multiaddr } from '@multiformats/multiaddr';

/**
 * The transport libp2p would dial `addr` with, by its `Symbol.toStringTag`
 * (`@libp2p/webrtc`, `@libp2p/webrtc-direct`, `@libp2p/websockets`, …), or null
 * when no configured transport claims it. `components` is not on the public
 * `Libp2p` interface, so this peeks the same way `pendingPeerWrites` does.
 */
function dialTransportTag(node: CadreNode, addr: Multiaddr): string | null {
	const libp2p = node.getControlNode();
	expect(libp2p).not.toBeNull();
	const transport = (libp2p as unknown as {
		components: {
			transportManager: {
				dialTransportForMultiaddr(ma: Multiaddr): { readonly [Symbol.toStringTag]: string } | undefined;
			};
		};
	}).components.transportManager.dialTransportForMultiaddr(addr);
	return transport ? String(transport[Symbol.toStringTag]) : null;
}
```

`dialTransportForMultiaddr(ma): Transport | undefined` is declared on `TransportManager` in
`@libp2p/interface-internal` (and implemented in `libp2p@3.1.3`). Type it structurally inline as
above rather than adding `@libp2p/interface-internal` as a devDependency for one call — a phantom
import would fail `yarn dep-check`, and a declared dep for one type is not worth it.

## Address shapes (measured, not assumed)

With `[webSockets(), circuitRelayTransport(), webRTC(), webRTCDirect()]` configured, on a Node
libp2p node with **no** `connectionGater` override (matching `controlNodeConfig`):

| address | routed to | blackhole dial settles in |
| --- | --- | --- |
| `/ip4/192.0.2.N/tcp/4001/ws/p2p/<peer>` | `@libp2p/websockets` | ~10 s (existing cases) |
| `/ip4/192.0.2.N/udp/4001/webrtc-direct/certhash/<hash>/p2p/<peer>` | `@libp2p/webrtc-direct` | ~10.0 s |
| `/ip4/192.0.2.N/tcp/4001/ws/p2p/<relay>/p2p-circuit/webrtc/p2p/<peer>` | `@libp2p/webrtc` | ~10.0 s |
| both WebRTC addresses dialed as one set (what `dialControlSibling` does) | — | ~10.0 s total |

Method: a standalone script under `packages/reference-app-web` built the node above, called
`dialTransportForMultiaddr` for each address, then `libp2p.dial(ma)` with **no** `signal`, timing the
rejection. Every one rejected with `TimeoutError` at libp2p's own ~10 s dial timeout —
`CadreNode.dialControlSibling` calls `controlNode.dial(addrs)` with no signal, so that default is
what governs. `stop()` with no dial in flight returned in ~3 ms.

Consequence for budgets: one WebRTC sibling costs about the same as one WebSockets sibling, so the
spec's existing `RECONCILE_TIMEOUT_MS` (30 s) covers every new case. Do not widen it.

Certhash: `/webrtc-direct` needs a syntactically valid multihash or `multiaddr()` throws and
`parseMultiaddrs` silently drops the address (straight back into vacuity — which the routing
assertion above catches). Use a fixed literal, base64url (`u`-prefixed) sha2-256 multihash of 32
arbitrary bytes; this one is verified to parse and route:

```
uEiDriKKtLzKrTdlDsdqSFqCGZ5uV1Sy4rDeYcTNTNKgpJQ
```

It is never verified against anything, because the connect never gets an answer.

Configure `webRTC()` and `webRTCDirect()` with **no** `rtcConfiguration` — the reference apps pass
ICE servers from a runtime manifest, but the test must not reach a STUN/TURN host. Host candidates
are enough to arm the dial, as the measurements above show.

`resolvePeerAddrs` orders `/p2p-circuit` addresses first and drops unparsable ones, but never
rewrites an address, so the existing set-equality anti-vacuity assertion in
`insertResolvableOfflinePeer` works unchanged for these shapes. Assert on sets, not order.

## Edge cases & interactions

- **Vacuity by routing.** Every new case asserts `dialTransportTag(...)` equals the expected WebRTC
  tag *before* the operation set runs. A case that skips this is not a WebRTC case.
- **The phone shape must NOT claim `/webrtc-direct`.** With `[webSockets(), circuitRelayTransport(),
  webRTC()]`, `dialTransportTag` for a `/webrtc-direct/…` address returns `null` and libp2p filters
  the address out — the dial fails instantly and tests nothing. Assert the `null` explicitly: it is
  what proves the two shapes are genuinely different, and it stops someone "fixing" the phone case
  by pasting the browser case's address in.
- **Shutdown with an unanswerable WebRTC connect in flight.** `stop()` must not wait on it. Reuse
  the existing `getDialQueue().length > 0` spin from `stop() resolves inside its budget with a
  blackhole dial in flight`, and keep its escape hatch: if the pass settles first, `stop()` must
  still be bounded. The abandoned pass must still **resolve** afterwards.
- **A grinding pass must not block a local read or write.** Kick `reconcileControlCohort()`
  unawaited, run the whole operation set under its normal per-operation deadlines, then await the
  pass. Mirrors the existing dial-storm case, under the browser transport list.
- **Blackhole address numbering.** The file already uses `192.0.2.{1,2,3,11,12,13,21,31,41}`. Use a
  fresh band (51+) so a future reader can tell which case an address belongs to.
- **RFC 5737 degradation.** As the file's header already states, a CI network that answers
  `192.0.2.0/24` degrades a blackhole into a refused connect. Both must pass; assert liveness and
  contents, never timing.
- **`insertSelfPeerRecord` signs over the address string.** The WebRTC addresses contain no commas,
  so the comma-joined `CadrePeer.Multiaddr` column round-trips them intact. If a future address shape
  contains a comma this breaks silently — the set-equality assertion in `insertResolvableOfflinePeer`
  is the guard.
- **Native-binding availability.** `node-datachannel` is a native module with prebuilt binaries. A
  platform with no prebuild builds from source (cmake) at install time, and a platform where the
  binding cannot load fails the whole spec file at import, not just the new cases. Record this as a
  `NOTE:` at the WebRTC helpers in the spec, and confirm the vitest process **exits on its own**
  after `yarn workspace @serfab/cadre-core run test` — native peer connections that outlive the
  suite would hang the run, and that is the one failure mode a green test list would not show.
- **Profiles.** The existing transport-shape cases run `transaction` only; keep that. The
  `transaction`/`storage` split is exercised by the departed/blackhole cases and is orthogonal to
  the transport list.

## Out of scope (do not grow this ticket)

- The browser app's **listening** posture (`listenAddrs: ['/p2p-circuit', '/webrtc']` when it holds a
  relay reservation). That needs a live relay to reserve against, which is an integration-suite
  shape, not a cadre-core unit shape. Say so in the review handoff.
- Any change to the reference apps or their suites.
- Any change to `CadreNode` itself. If a new case fails, that is a real finding — report it, do not
  loosen the test.

## TODO

### Phase 1 — dependency

- Add `"@libp2p/webrtc": "6.0.14"` to `packages/cadre-core/package.json` `devDependencies`, keeping
  the block alphabetical.
- `yarn install`; confirm the lockfile change is limited to the new devDependency's resolution.
- Confirm `node -e "import('@libp2p/webrtc').then(m => m.webRTC())"` resolves from
  `packages/cadre-core`.

### Phase 2 — spec helpers

- In `control-database-offline-peers.spec.ts`, import `webRTC` / `webRTCDirect` from
  `@libp2p/webrtc`, and `multiaddr` + the `Multiaddr` type from `@multiformats/multiaddr`.
- Add the `dialTransportTag` peek exactly as sketched above, with the doc comment explaining why it
  reaches past the public `Libp2p` interface.
- Add `WEBRTC_CERTHASH`, plus a comment stating it is an arbitrary sha2-256 multihash that is never
  verified.
- Add a minting helper that owner-inserts a sibling recorded at the WebRTC address shapes (relayed
  `/webrtc`, and optionally `/webrtc-direct`), built on `insertResolvableOfflinePeer` so the
  resolve-non-empty anti-vacuity assertion still runs. The relay component's peerId is a throwaway
  generated key.
- Add an assertion helper that checks each of a sibling's addresses routes to its expected transport
  tag.
- Add the `NOTE:` comments called for above (file-size tripwire; native-binding tripwire).

### Phase 3 — cases (all inside `stress and transport shapes (transaction profile)`)

- `serves every control read/write locally with the BROWSER reference transport list` —
  `[webSockets(), circuitRelayTransport(), webRTC(), webRTCDirect()]`; one sibling recorded at both
  a `/webrtc-direct/…` and a relayed `/webrtc` address; assert both route to `@libp2p/webrtc-direct`
  and `@libp2p/webrtc` respectively; `runControlOperationSet`; `reconcileControlCohort()` within
  `RECONCILE_TIMEOUT_MS`; `expectIntactAfterPass`.
- `serves every control read/write locally with the PHONE reference transport list` —
  `[webSockets(), circuitRelayTransport(), webRTC()]`; one sibling at a relayed `/webrtc` address;
  assert it routes to `@libp2p/webrtc` **and** that a `/webrtc-direct/…` address routes to `null` in
  this shape; then the same operation set / reconcile / intact-after-pass sequence.
- `a WebRTC reconcile pass grinding through dead dials cannot block a local read or write` — browser
  transport list, pass kicked off unawaited, full operation set under its normal deadlines, pass
  awaited afterwards, `expectIntactAfterPass`.
- `stop() resolves inside its budget with a WebRTC dial in flight` — browser transport list, spin on
  `getDialQueue().length > 0`, `stop()` inside the body under `LIFECYCLE_TIMEOUT_MS`, then assert
  the abandoned pass resolves. Keep the idempotent `stop()` leak guard in `finally`.

### Phase 4 — validate

- `yarn workspace @serfab/cadre-core run typecheck`
- `yarn workspace @serfab/cadre-core run test 2>&1 | tee /tmp/cadre-core-test.log` — stream it; the
  suite is long. Confirm the four new cases pass **and** that the process exits without hanging.
- `yarn lint`
- `yarn dep-check`
- Write the `review/` handoff: state whether the cast was needed, the measured wall-clock of each
  new case, whether the vitest process exited cleanly, and that the browser app's listening posture
  remains uncovered.
