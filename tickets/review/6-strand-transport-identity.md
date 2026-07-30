description: A device's group-chat connection and its main connection used to announce themselves under the same network name, so a shared relay server delivered messages to the wrong one. Each group connection now derives its own network name; review the fix.
prereq:
files: packages/cadre-core/src/strand-transport-key.ts (new — derivation helper), packages/cadre-core/src/cadre-node.ts (launchStrand ~L2756-2765), packages/cadre-core/src/strand-instance-manager.ts (NOTE tripwire ~L279), packages/cadre-core/test/strand-transport-key.spec.ts (new), packages/cadre-core/test/strand-transport-relay.spec.ts (new), packages/cadre-core/src/strand-addr-protocol.ts (header doc), packages/cadre-core/package.json (+2 devDeps), docs/architecture.md, docs/strands.md, tickets/backlog/strand-network-nat-relay-reachability.md
difficulty: medium
----

# Review: per-strand libp2p transport identity

Fixes https://github.com/gotchoices/sereus/issues/1. A `CadreNode` runs its control node and
each strand node as separate libp2p instances, but all of them were handed the same private
key — so they shared one peerId, and `@libp2p/circuit-relay-v2` (which keys reservations and
hop-connects by peerId) delivered relayed streams for one node to the other. Symptom:
`UnsupportedProtocolError` on strand protocols, then `NoValidAddressesError`, `strandPeers=0`.

## What was implemented

- **`strand-transport-key.ts` (new):** `strandTransportKey(identityKey, strandId)` — an
  Ed25519 key generated from the seed
  `sha256(digest(['sereus.strand-transport-key.v1', <identity seed b64url>, strandId]))`.
  Deterministic (stable peerId across restarts), domain-separated and versioned, secret-keyed
  (identity *private* seed as input, so outsiders can't enumerate a member's strand peerIds).
  Throws on non-Ed25519 identity keys.
- **`cadre-node.ts` `launchStrand`:** passes the derived key instead of `this.identityKey`
  to `startStrand`. Derives only when `identityKey` is set (same undefined-tolerance as
  before). `StrandInstanceManager` unchanged — verified by reading that `startStrand` retains
  the config (`launchConfigs.set`, strand-instance-manager.ts:217) and `resumeStrand`
  overrides only `bootstrapNodes`/`mode`, so hibernate → wake reuses the same derived key.
- **Control side untouched.** Cadre authority (owner keys, `CadrePeer` vouchers, seed
  bootstrap, formation) all key off the control node's identity, and every
  peerId→authority derivation (`ed25519PublicKeyB64FromPeerId` call sites) is a
  control-network path. Re-verified during implement: no strand-side code reads
  `libp2pNode.peerId` (`strand-database.ts` has zero peerId references; all
  `libp2pNode.peerId` uses live in `control-database.ts` / `seed-bootstrap.ts`).
- **No wire/schema change.** `getStrandMultiaddrs` returns the strand node's own
  multiaddrs, which carry the (now distinct) peerId; the strand-addr RPC just starts
  returning genuinely distinct addresses.
- **devDeps added** to `cadre-core`: `@libp2p/circuit-relay-v2 ^4.1.3`,
  `@libp2p/identify` pinned exact `4.0.10` — yarn resolved `^4.0.10` to 4.1.11, which
  requires `@libp2p/interface ^3.2.5` and type-clashes with the repo's hoisted 3.1.0
  (nested-duplicate `Uint8Array<ArrayBuffer>` mismatch). The pin dedupes against the same
  tree `@optimystic/db-p2p` uses. If the reviewer bumps the libp2p stack later, unpin then.

## How it was verified

All from `packages/cadre-core` unless noted:

- `test/strand-transport-key.spec.ts` (6 tests): stable across calls; stable across
  protobuf serialize/reload (restart shape); distinct per strandId; distinct from identity
  peerId; distinct across identity keys; rejects secp256k1.
- `test/strand-transport-relay.spec.ts` (2 tests, loopback): one relay
  (`circuitRelayServer`), two clients each answering one protocol, third node dials each
  advertised `/p2p-circuit` address.
  - **Pins the bug:** with one shared key, asserts the two circuit addrs are byte-identical
    and that the two protocols can NOT both negotiate.
  - **Proves the fix shape:** identity key + derived key ⇒ distinct circuit addrs, both
    protocols negotiate. Uses `runOnLimitedConnection: true` on handle+dial (relayed
    connections are "limited"), mirroring `strand-addr-protocol.ts`.
- Full `cadre-core` suite: 64 files, 974 passed, 1 skipped (pre-existing
  `skipIf(win32)` in key-store.spec.ts — not a new skip). `yarn typecheck`, `yarn build`,
  root `yarn lint` all clean.

## Known gaps — treat these as the review's starting point

- **End-to-end strand-over-relay in a real cadre was NOT exercised.** The relay test uses
  bare libp2p nodes, not `createLibp2pNode`/`CadreNode`. The real-network integration
  scenarios are red at HEAD for an unrelated pre-existing cause (see
  `tickets/.pre-existing-known.md`: `bug-control-db-stale-revision-not-retryable`, and
  `blocked/control-db-convergence-optimystic-p2p`) — a red integration run is not evidence
  about this change, and `packages/integration-tests` imports `@serfab/cadre-core` via
  `dist/`, so rebuild before believing any integration result.
- **No test drives `launchStrand` itself asserting the strand node's peerId differs from
  the control node's** — the wiring is a two-line change verified by reading + the full
  suite, but a reviewer wanting belt-and-braces could add a `CadreNode`-level assertion.
- **GitHub issue #1 not yet closed** — commenting on a public issue is outward-facing and
  the implement ticket said ask first; no human was available mid-run. Suggested close
  note: fixed by deriving each strand node's transport peerId from the cadre identity key +
  strandId (`strandTransportKey`, sha256 domain-separated, deterministic across restarts);
  the proposed additive `strandNetwork` config override was not taken because it only helps
  when a *second* relay exists and the collision returns the moment both nodes reserve
  through one relay — distinct peerIds cure it at any relay with no added config surface.

## Review findings

(filled by review stage)

## Tripwires recorded during implement (index — analysis lives at the sites)

- Unattested strand transport peerIds: fine while strand nodes keep the raw configured
  gater; if strand-mesh admission control is ever added, bind via a `MemberPeer` row —
  noted in the `strandTransportKey` doc comment (`strand-transport-key.ts`).
- Shared fixed listen port: control + strand nodes both receive `network.listenAddrs`; a
  fixed-port config (cadre-cli example ships `/ip4/0.0.0.0/tcp/4001`) risks EADDRINUSE —
  unverified, NOTE at the listen-addr assembly in `strand-instance-manager.ts`
  (`buildStrandRuntime`).
