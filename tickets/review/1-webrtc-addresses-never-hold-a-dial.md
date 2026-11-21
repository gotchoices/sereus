description: A machine that offers both a WebRTC address and a plain relayed one used to make joins fail outright wherever WebRTC could not connect. Dials that something waits on now go through the relay, and WebRTC is only ever an extra.
architecture: docs/network/relay.md
files: packages/cadre-core/src/peer-dial.ts, packages/cadre-core/src/strand-formation-protocol.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/test/peer-dial.spec.ts, packages/integration-tests/src/scenarios/webrtc-ice-failure-falls-back-to-relay.integration.ts, packages/integration-tests/src/harness/node-fixtures.ts, packages/integration-tests/package.json, docs/network/relay.md, docs/contributing/topology-coverage.md, ops/docs/ice-servers.md
difficulty: medium
----
# A WebRTC address never holds up a dial that something is waiting on

Implements GitHub issue #61. The reviewer can close it: the scenario below is the issue's repro, in the suite.

## What changed

**One three-way address classification** (`peer-dial.ts`, `addrKind` / the `AddrKind` type): `direct` (no `p2p-circuit` component — `/webrtc-direct` is here), `relayed` (a `p2p-circuit` component with nothing negotiated after it), `webrtc` (a `p2p-circuit` component followed by `webrtc`). Every site that has to treat the three differently reads this one function instead of its own substring test.

**Three sites use it:**

- `directBeforeRelayed` now orders direct, then relayed, then WebRTC. A WebRTC address stays in the list, so a peer whose only address is a WebRTC one is still dialed.
- `reusableConnection` no longer hands an open relayed connection back for a `webrtc` address, which is the answer libp2p gives (`isDirect` is `!Circuit.exactMatch`). The docstring that claimed to mirror libp2p but did not is corrected.
- `dialFormationChannel` (`strand-formation-protocol.ts`, new `withoutWebrtcAddrs`) leaves WebRTC addresses out of the list it passes `node.dial`, unless they are all the responder published. Filtering rather than reordering, because libp2p re-sorts any list given to one dial.

**The `openFormationStream` NOTE is rewritten:** the WebRTC case it predicted is handled; the black-holed-relay-host case it also described is not, and the NOTE now says so plainly along with the remedy if that is seen.

**`dialControlBootstrapPeers` (`cadre-node.ts`) gets a `NOTE:` only** — no behaviour change. It dials by peer id, so libp2p's sorter picks the order and a WebRTC address in a bootstrap peer's record can cost it one ICE timeout; nothing waits on that pass (`start()` voids it).

**Docs:** a "Direct connections over WebRTC" section in `docs/network/relay.md` stating the rule and naming all three kinds of dial site, including the two that dial by peer id and cannot be ordered from here; one sentence in `ops/docs/ice-servers.md` under "Why there is no TURN"; the new scenario in the topology coverage map.

## Deviation from the ticket, for the reviewer to weigh

The ticket preferred `@multiformats/multiaddr-matcher`'s `Circuit` / `WebRTC` (what libp2p itself uses) over walking the components, if cadre-core could take it as a direct dependency. It could — 3.0.2 resolves and is already in the tree — but the matchers were measured first and **rejected**, and `addrKind` walks the components instead (the reason is in its docstring). Against 3.0.2:

| address | `Circuit.exactMatch` | `WebRTC.exactMatch` |
|---|---|---|
| `/ip4/…/ws/p2p/<relay>/p2p-circuit/p2p/<peer>` | true | false |
| `/ip4/…/ws/p2p/<relay>/p2p-circuit/webrtc/p2p/<peer>` | false | true |
| `/memory/relay-1/p2p/<relay>/p2p-circuit/p2p/<peer>` | **false** | false |
| a two-hop circuit (`…/p2p-circuit/p2p/<relay2>/p2p-circuit/p2p/<peer>`) | **false** | false |

The last two would come back `direct` and be dialed FIRST, which is the opposite of what this ticket is for. The matchers answer "is this a circuit-transport address of a shape I know"; `addrKind` answers "does reaching this peer need a relay hop, and does it need ICE after that hop". No scenario uses a `/memory` relay today, so neither row is reachable now — the choice is about which question the function answers, not about a live defect.

## How to validate

**The regression test is the new scenario** — `packages/integration-tests/src/scenarios/webrtc-ice-failure-falls-back-to-relay.integration.ts`:

```
yarn workspace @serfab/integration-tests test webrtc-ice-failure
```

Two relay-only parties on one dedicated loopback relay, each listening on `/webrtc` as well, each with `webRTC({ rtcConfiguration: { iceServers: [], iceTransportPolicy: 'relay' } })` so ICE can never connect. It asserts A's invitation carries both address shapes, that B's control node really routes the WebRTC one to `@libp2p/webrtc` (the anti-vacuity guard — without it a build that dropped the transport would pass for the wrong reason, since libp2p silently filters an address no transport claims), that `formStrand` succeeds inside 15 s, that B's strand becomes writable and a row B writes is readable at A, and that no connection anywhere ended up on WebRTC.

**It was confirmed to fail without the fix.** With `withoutWebrtcAddrs` undone in the built output, it reproduces the issue exactly: `FormationUnreachableError: Formation dial-connect timed out after 25000ms`, `B forms the strand: 25020 ms`. With the fix, 228-344 ms.

**Measured strand-step timings** (three runs, loopback), which the ticket asked for so the Optimystic exposure would be measured rather than guessed:

| step | ms |
|---|---|
| A's start | 565-754 |
| A founds the strand | 514-662 |
| B's start | 324-378 |
| B forms the strand | 228-344 (25020 before the fix, then failing) |
| B's `addStrand` | 402-509 |
| B's strand becomes writable | 0-1 |
| B's row reaches A | 135-276 |

**Optimystic's by-peer-id dials were not a bottleneck here, but a WebRTC dial did run.** Under `DEBUG='libp2p:webrtc*'` the run shows a WebRTC signalling exchange in flight at teardown (`initiator error parsing ICE candidate - AbortError`, `failed to handle incoming connect`): something — a by-peer-id dial whose sorted list libp2p heads with the WebRTC address — did start one, and it delayed nothing, because a relayed connection to the same peer was already open and carried every strand step. So no `blocked/` report was filed asking Optimystic to accept an address sorter. What stays uncovered is a by-peer-id dial that is somebody's FIRST contact with a strand peer, with no relayed connection open yet: that would pay up to one ICE timeout. That is parked in `docs/network/relay.md` → "Direct connections over WebRTC" (the "Dials by peer id" bullet), which is the honest home for it — there is no single code site in this repo to comment.

**The ordering contract** is a table test in the existing spec (`packages/cadre-core/test/peer-dial.spec.ts` → `addrKind + directBeforeRelayed`): the classification over five shapes including `/webrtc-direct` and a relay hop with its destination missing, the order over a mixed list of two relays plus two direct addresses, and that a peer whose only addresses are WebRTC ones stays dialable.

```
yarn workspace @serfab/cadre-core test peer-dial
```

**Gates run, all green:** `yarn lint` (ESLint plus `check:docs`), `yarn typecheck` across every workspace, `yarn check:dep-ranges`, the whole cadre-core suite (197 files, 2638 tests), and the integration scenarios most likely to be disturbed — `webrtc-ice-failure-falls-back-to-relay`, `blind-relay-phone-to-phone-e2e` (all three arms), `strand-formation-e2e`, `relay-only-control-addr` (30 tests). No pre-existing failures surfaced, so nothing was written to `tickets/.pre-existing-error.md`.

## Known gaps

- **No test for the `reusableConnection` change on its own**, as the ticket directed: `relayed-connections-try-a-webrtc-upgrade`'s scenario is what will exercise it. Today it is unreachable from a blocking dial, since a `webrtc` address is reached only after every relayed one.
- **Formation's all-WebRTC fallback is verified by inspection, not by a test.** `withoutWebrtcAddrs` returns the list unchanged when filtering would empty it; no scenario builds a responder whose only address is a WebRTC one.
- **`withoutSelfRelayed` was verified by inspection.** `relaysThrough` reads the `p2p` component immediately before each `p2p-circuit`, which a WebRTC address still carries, so such an address relaying through this node is still dropped.
- **The scenario is one arm, on loopback.** No link-delay arm: the claim is about which address is dialed, not about speed.
- **The scenario leaves a WebRTC dial in flight at teardown**, which prints `libp2p:webrtc:error … AbortError` lines when `DEBUG` includes `libp2p:webrtc*`. Nothing fails and the default run is quiet; the alternative would be waiting out a dial the scenario is asserting nobody waits for.
- **Harness change:** `ControlNodeOpts` gained a `transports` option (`packages/integration-tests/src/harness/node-fixtures.ts`), replacing the default WebSocket + circuit-relay pair. Setting it also stops cadre-core deriving transport options from `listenAddrs`, which is what lets the scenario listen on `/webrtc`.
- **`@libp2p/webrtc` was added to `integration-tests` devDependencies at exactly `6.0.33`**, matching cadre-core's. Its Node entry point pulls in `node-datachannel`, a native module (already installed); on a platform where that binding cannot load, the import fails the whole scenario file, not just one case. The fix there is a prebuild/toolchain one.
- **`addrKind` is not re-exported from `cadre-core`'s index.** Nothing outside the package needs it yet, and the next ticket's work is inside cadre-core.
