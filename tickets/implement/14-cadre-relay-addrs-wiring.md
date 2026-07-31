----
description: A node can be told which relay servers to use so peers behind a home router can still reach it, but the setting is thrown away. Make it work.
files: packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/strand-instance-manager.ts, packages/cadre-core/src/delegate-admission.ts, packages/cadre-core/src/types.ts, packages/cadre-core/test/cadre-node-control-node-options.spec.ts, packages/cadre-cli/example.cadre.yaml, docs/architecture.md
difficulty: medium
----

# Wire `network.relayAddrs` into the control and strand nodes

## What is broken

`NetworkConfig.relayAddrs` (`packages/cadre-core/src/types.ts:145`) is settable in `cadre.yaml`,
via `CADRE_RELAY_ADDRS`, and through the Docker entrypoint — and is read by nobody. Verified by a
throwaway unit test during the fix pass: with

```yaml
network:
  listenAddrs: ["/ip4/0.0.0.0/tcp/4001"]
  relayAddrs: ["/dns4/relay.example.com/tcp/4001/p2p/12D3KooW…"]
```

`CadreNode.buildControlNodeOptions()` produces options containing no trace of `relay.example.com`,
and `CadreNode.circuitRelayTargets()` returns `[]`.

## Why this is a small fix, not an upstream one

This repo already has a working way to reserve a slot on a relay: put the relay's **circuit**
multiaddr in `network.listenAddrs`.

- `@libp2p/circuit-relay-v2`'s transport is always present on the Node path — `createLibp2pNode`
  unconditionally pushes `circuitRelayTransport()` (`../optimystic/packages/db-p2p/src/libp2p-node.ts:30`).
  Listening on `…/p2p/<relay>/p2p-circuit` is what makes it dial that relay and hold a reservation.
- `CadreNode.circuitRelayTargets()` (`packages/cadre-core/src/cadre-node.ts:3328`) already scans
  `network.listenAddrs` for `/p2p-circuit` entries to decide which relays to announce a strand
  node's delegate peerId to — the grant that lets a NAT'd strand node reserve on a member's relay
  (`delegate-admission.ts`).
- Strand nodes deliberately inherit `network.listenAddrs`, and the inherited circuit entry is
  called out as intentional (`strand-instance-manager.ts:290-299`).

So `relayAddrs` is a second, friendlier door onto a mechanism that already exists. The fix is to
translate it into that mechanism, not to invent a new one:

```
effective listen addrs = listenAddrs ++ relayAddrs.map(a => a + "/p2p-circuit")   (deduped)
```

Feed that single resolved list to all three consumers (control options, strand options,
`circuitRelayTargets`) and everything downstream — reservation, delegate announce, strand
inheritance, the `/p2p-circuit`-first address publishing in `registerSelf` — works unchanged.

`network.announceAddrs` is a genuinely different problem and is **not** in this ticket; see
`cadre-announce-addrs-upstream`.

## Interface

New small module `packages/cadre-core/src/relay-addrs.ts`:

```ts
/**
 * The circuit-listen multiaddr for each configured relay: `<relayAddr>/p2p-circuit`.
 * An entry that already carries `/p2p-circuit` is passed through unchanged.
 * Throws on an entry that is unparsable or names no relay peerId — this is
 * operator configuration, so a typo must fail loudly at start rather than
 * silently costing the node its reachability.
 */
export function relayCircuitAddrs(relayAddrs: readonly string[]): string[];

/**
 * The listen multiaddrs a node actually binds: configured `listenAddrs` plus the
 * circuit-listen addr of every configured relay, deduplicated, order-stable
 * (configured entries first). Returns `undefined` when neither field is set, so
 * callers keep omitting `listenAddrs` and inherit db-p2p's default.
 */
export function resolveListenAddrs(network: NetworkConfig | undefined): string[] | undefined;
```

Note the deliberate asymmetry with `extractCircuitRelayTargets` in `delegate-admission.ts:201`,
which *skips* unparsable entries with a log line. That function reads addresses discovered at
runtime from peers, where one bad entry must not be fatal. `relayCircuitAddrs` reads operator
config, where a silently dropped entry is exactly the failure this ticket exists to remove. Reuse
`delegate-admission.ts`'s peerId-extraction logic rather than writing a second multiaddr walker —
extract the shared "which relay does this addr name" step if that is cleaner than importing it.

## Edge cases to get right

- **`listenAddrs` undefined, `relayAddrs` set.** Today the `listenAddrs` key is omitted entirely
  and db-p2p falls back to `/ip4/0.0.0.0/tcp/<port>`; `CadreNode` passes `port: 0`, so the fallback
  is `/ip4/0.0.0.0/tcp/0` (`libp2p-node.ts:21-24`). Returning only the circuit addrs here would
  silently drop the node's direct TCP listener. Prepend the literal `/ip4/0.0.0.0/tcp/0` in that
  case and tag it `NOTE:` naming `../optimystic/packages/db-p2p/src/libp2p-node.ts` as the source
  of truth, so a future upstream change to the default is greppable from here.
- **`listenAddrs: []` (React Native / phone), `relayAddrs` set.** The result is a node that now
  listens on a circuit. That is the point of setting `relayAddrs`, so allow it — but say so in the
  `NetworkConfig.relayAddrs` doc comment, because `reference-app-rn` deliberately does not listen
  (`cadre-phone.ts:266-271`) and must not acquire a listener by accident.
- **An entry that already ends in `/p2p-circuit`.** Pass through; do not append twice.
- **Duplicate relays**, or a relay whose circuit addr is already in `listenAddrs`: dedupe by exact
  string so the list stays stable across restarts.

## TODO

- Add `packages/cadre-core/src/relay-addrs.ts` with `relayCircuitAddrs` + `resolveListenAddrs` as
  specified; export from the package index only if a consumer outside cadre-core needs it.
- Replace the `...(network?.listenAddrs && { listenAddrs: network.listenAddrs })` spread in
  `CadreNode.buildControlNodeOptions()` (`cadre-node.ts:953`) with the resolved list.
- Replace the same spread in `strand-instance-manager.ts:299` with the resolved list, and update
  the `NOTE:` block above it (lines 290-298) to say the circuit entries can now come from
  `relayAddrs` as well as from a hand-written `listenAddrs`.
- Point `CadreNode.circuitRelayTargets()` (`cadre-node.ts:3328-3333`) at the resolved list so a
  configured relay becomes a delegate-announce target; update its doc comment.
- Expand the `NetworkConfig.relayAddrs` doc comment in `types.ts` to state the expected form
  (`<direct dial addr>/p2p/<relayPeerId>`, no `/p2p-circuit` suffix needed), that it is sugar for
  a circuit `listenAddrs` entry, and the RN caveat above.
- Unit-test `relay-addrs.ts`: append, idempotent pass-through, dedupe, order, `undefined`
  passthrough, the no-`listenAddrs` fallback, and the throw on a garbage entry / an entry with no
  `/p2p/<peerId>`.
- Extend `packages/cadre-core/test/cadre-node-control-node-options.spec.ts`: assert a configured
  `relayAddrs` reaches `options.listenAddrs` as a circuit addr, and **delete the stale comment at
  lines 25-28** that says these fields are deliberately unasserted.
- Add a test that `circuitRelayTargets()` returns the configured relay (call it the same way the
  existing spec reaches privates). This is the assertion that would have caught the bug.
- Uncomment and correct the `relayAddrs` example in `packages/cadre-cli/example.cadre.yaml:51-53`;
  update `docs/architecture.md:836` (`relayAddrs` line) to describe the real behavior.
- Run `yarn build && yarn test` in `packages/cadre-core`, plus `yarn lint` at the repo root.
