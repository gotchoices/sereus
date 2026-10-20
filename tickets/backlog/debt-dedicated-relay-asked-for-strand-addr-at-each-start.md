description: Each time a node process starts its first shared workspace, it asks a public relay (one that never answers this kind of request) to let the workspace's identity in, twice, and is refused both times; the node has no reliable way to know in advance that the relay will refuse.
architecture: docs/strands.md#some-questions
files: packages/cadre-core/src/cadre-node.ts (`resolveSiblingSeed` ~7392, `circuitRelayTargets` ~7488, `refreshDelegateGrants` ~7536, `relaysRefusingStrandAddr` doc ~821), packages/cadre-core/src/delegate-admission.ts (`relaysNotRefusing`), ../optimystic/packages/db-p2p/src/network/identify-on-open.ts (read only)
tradeoffs: The saving is two refused protocol negotiations per process start per dedicated relay, and any rule that skips a relay it is unsure about can deny a party-run relay's first reservation, which costs more than it saves.
----
# A dedicated relay is asked for strand-addr at each process start

## Measured

`message-cost-accounting`, strand case (`MESSAGE_COST_MEASURE=1 MESSAGE_COST_CASE=strand`), 2026-10-20: `/sereus/strand-addr/1.0.0` to the dedicated loopback relay, refused, **2** at A's `foundStrand` and **2** at B's `addStrand`. With `DEBUG=sereus:cadre:strand-addr`, both refusals of each pair log in the same millisecond, so they are two concurrent announce passes, not one pass asking twice (the client returns at the first `UnsupportedProtocolError`). Which two callers run concurrently was not traced. Later launches in the same process do not ask, because the refusal is remembered in memory (`relaysRefusingStrandAddr`).

## Why the node cannot tell beforehand

`formation-connection-closed-after-formation` planned to skip a relay whose identify lists no strand-addr. That does not work, so it was not shipped:

- The control node's identify is namespaced to its network (`/optimystic/control-<party>/id/1.0.0`, `libp2p-node-base.ts`). A dedicated relay serves only `/ipfs/id/1.0.0`, so the control node never identifies it, and its peer-store record carries only protocols this node negotiated with it (the circuit-relay `hop` of its own reservation, `/ipfs/ping`).
- A party-run relay of the same party shows the same partial list in the moment between its connection opening and its identify landing (Optimystic's own NOTE at `identify-on-open.ts` and `membershipOf` in `libp2p-key-network.ts` describe this). So "a non-empty list without strand-addr" also matches a party-run relay that needs the grant.
- The one definite signal, the namespaced identify being refused, is observed inside Optimystic (`identifyOnConnectionOpen`, reported only for bootstrap peers) and not exposed to an embedder.
- Skipping on identify metadata (identify ran and lists no strand-addr) is safe from the first problem but only matches a same-party relay before its strand-addr handler registers, which is the one relay that must be asked.

## Possible directions (not chosen)

- Ask only relays that are machines of this node's own party (a `CadrePeer` row): only a party control node has a membership gate that admits a strand's delegate, and a strand-addr request to any other party's node is refused by its member check anyway. Risk: a configured party relay whose `CadrePeer` row has not replicated yet would be skipped, and its first reservation denied until the reservation supervisor's re-drive hook announces.
- Ask Optimystic to expose the identify outcome (`foreign`) for every peer, which its NOTE already anticipates ("have `identifyOnConnectionOpen` report for every peer").
- Find and single-flight the two concurrent passes, which halves the cost without deciding anything about relays.
