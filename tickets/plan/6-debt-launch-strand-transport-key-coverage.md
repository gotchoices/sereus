description: Add a test proving that when a device joins a group chat, that group connection really does announce itself under its own network name instead of reusing the device's main one.
prereq:
files: packages/cadre-core/src/cadre-node.ts (launchStrand ~L2756-2795), packages/cadre-core/src/strand-transport-key.ts, packages/cadre-core/test/cadre-node-strand-seed.spec.ts (injection pattern to copy)
difficulty: easy
----

# Cover the strand-launch wiring, not just the key helper

A cadre node runs its control connection and each strand it participates in as separate
libp2p nodes. They used to share one network identity (peerId), which broke relayed
connections; `launchStrand` now derives a distinct per-strand key via `strandTransportKey`
before handing it to `StrandInstanceManager.startStrand`.

`strandTransportKey` itself is well covered (`test/strand-transport-key.spec.ts`: stability
across calls and across a serialize/reload round-trip, distinctness per strand and per
identity, rejection of non-Ed25519 keys), and the relay collision it cures is pinned on
loopback libp2p nodes (`test/strand-transport-relay.spec.ts`). What no test covers is the
**wiring in between**: that `launchStrand` actually derives the key and passes it through, so
a future edit reintroducing `privateKey: this.identityKey` would go unnoticed.

## Expected behavior to assert

- Launching a strand hands `startStrand` a private key whose peerId is **not** the control
  node's peerId.
- That key equals `strandTransportKey(identityKey, strandId)` — i.e. it is the derived key,
  not some freshly generated one (which would also be distinct but would lose peerId
  stability across restarts).
- Launching two different strands on the same node yields two different keys.
- With no identity key configured, no key is passed through, so libp2p generates its own
  (still distinct per node).

## Notes for whoever picks this up

No real libp2p node is needed. `test/cadre-node-strand-seed.spec.ts` already establishes the
pattern: construct a `CadreNode`, assign private fields through a cast, and invoke the private
method under test. Here that means injecting `identityKey` plus a fake `strandManager` whose
`startStrand` records the config it received, then calling `launchStrand`. Leaving
`controlNode`/`controlDatabase` unset is fine — `resolveCohortSeed` returns an empty seed in
that state — and `hibernationManager.trackStrand` no-ops while the manager is not running, so
nothing else has to be stubbed.
