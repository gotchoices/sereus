description: Every strand founding and attach awaits a strand-addr request to each circuit relay (the delegate announcement), and a dedicated relay such as relay.sereus.org refuses the protocol, so each founding spends a relayed round trip (~95 ms on Node, more on a phone) on an answer that never comes (GitHub #49, second point).
files: packages/cadre-core/src/cadre-node.ts (`resolveSiblingSeed` ~6686-6707, `circuitRelayTargets` ~6777, `recordDelegateAnnounces` ~6798, `announceDelegateToRelay` ~6874), packages/cadre-core/src/strand-addr-protocol.ts (`dialOneSibling` ~389), ops/docker/libp2p-infra/src/main.ts (~95-113)
----

# strand-addr asks relays that do not serve it

The delegate announcement exists for party-run relays (a `CadreNode` with `enableRelay`), whose gate admits a strand node's derived peer id only on a delegate grant (`docs/strands.md` → "Relay willingness"). A dedicated relay (`ops/docker/libp2p-infra`, relay.sereus.org) runs only identify, ping and `circuitRelayServer`, and answers `UnsupportedProtocolError`. That is by design: `blind-relay-phone-to-phone-e2e` asserts the relay does not list the protocol.

`resolveSiblingSeed` awaits the announcement inline before `startStrand`, because grants must be recorded before the strand node dials its reservation (~6491-6494). Nothing remembers a refusal, so every founding and attach pays for it. Against a relay that is down, it can cost up to 2 × `relayedRequestBudgetMs` (28.5 s).

## Fix

Remember, per relay peer id, that it answered `UnsupportedProtocolError`, meaning it is not a party-run relay. Skip it in `circuitRelayTargets` for the announcement until the node restarts. Keep awaiting the announcement for relays that serve it. Add a unit test for the memo, and check that the founding trace no longer shows a strand-addr dial to the dedicated relay.
