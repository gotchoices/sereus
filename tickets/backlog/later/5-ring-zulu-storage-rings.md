priority: 1
description: Implement Ring Zulu participation and storage ring opt-in (blocked on Arachnode)
prereq: Arachnode storage system (not yet built), packages/cadre-core profile configuration
----
Blocked on the Arachnode storage ring system not being built yet.

The profile distinction between `transaction` and `storage` currently has no real effect beyond FRET hints. Once Arachnode is available:

- **Ring Zulu (Transaction)**: all nodes participate in transaction verification and ephemeral caching
- **Storage rings** (Ring 3 → 2 → 1 → 0): storage-profile nodes join the appropriate concentric ring based on capacity
- Profile configuration in CadreNode should map to actual ring participation

## Blocked on
- Arachnode storage ring system design and implementation

## Premise check

Read against `../optimystic` at 1.27.0 and this repository during the documentation rewrite. Nothing was run. The premise above, that Arachnode is "not yet built" and that the profile "has no real effect beyond FRET hints", does not match the code.

- **Optimystic starts Arachnode.** `../optimystic/packages/db-p2p/src/libp2p-node-base.ts` reads `options.arachnode?.enableRingZulu` (default true). When it is true and the node has FRET, it builds a `StorageMonitor`, a `RingSelector` and an `ArachnodeFretAdapter`, announces the node's ring ("Announced Arachnode membership: Ring %d"), and wires the rebalance and ring-shift paths. `../optimystic/docs/arachnode.md` and `docs/arachnode-ring-handoff.md` there describe the design.
- **cadre-core already maps the profile to that option.** `buildControlNodeOptions` in `cadre-node.ts` and `buildStrandRuntime` in `strand-instance-manager.ts` both pass `arachnode: { enableRingZulu: profile === 'storage' }`, and `cadre-node-control-node-options.spec.ts` asserts it for both profiles. So a storage-profile node takes part in Optimystic's ring membership today and a transaction-profile node does not.
- **The stub is unused.** `packages/cadre-core/src/arachnode-stub.ts` (`ArachnodeStub`, `createArachnodeStub`) is exported from `index.ts` and constructed nowhere in `packages/*/src`.
- **In flight.** `4.1-node-roles-in-cadre-core` (in `implement/`) changes the mapping to `enableRingZulu: roles.alwaysOn`.

What this ticket could still mean is not settled by the code: which ring a node of a given capacity joins is decided by Optimystic's `RingSelector`, and no Sereus setting reaches it beyond the one boolean. Whether Sereus wants more control than that (the "storage ring opt-in" above) is the open part. The `prereq:` line and the "Blocked on" section name work that exists.
