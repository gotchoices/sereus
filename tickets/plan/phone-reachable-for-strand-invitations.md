description: A phone cannot invite another party into a private (closed) chat strand, because inviting requires an address others can reach and a phone never has one — the reference app's "Create Closed Strand + Invite" button can only fail, and it leaves a half-created strand behind when it does.
files:
  - packages/cadre-core/src/cadre-node.ts:6520-6535 (`createOpenInvitation` throws `No multiaddrs available for invitation` when `getMultiaddrs()` is empty)
  - packages/cadre-core/src/relay-addrs.ts:100-119 (an explicit empty `listenAddrs` stays empty; a circuit listener is added only when `network.relayAddrs` is set)
  - packages/cadre-core/src/cadre-node.ts:5642-5666 (start-time relay reservation is skipped when no relays are configured; `reserveRelays()` only fills a listener `relayAddrs` created)
  - packages/reference-app-rn/src/cadre-phone.ts:126-131,242-261 (no `relayAddrs` option; comment at 256-259 claims the dialed circuit reservation is advertised without a listen addr)
  - packages/reference-app-rn/src/use-cadre.ts:341-355 (closed strand is founded before the invitation is attempted)
  - packages/reference-app-rn/app/settings.tsx:203-211
  - packages/integration-tests/src/scenarios/blind-relay-phone-to-phone-e2e.integration.ts (the working shape: `listenAddrs: []` + `relayAddrs: [relay]`)
  - packages/integration-tests/src/scenarios/strand-formation-cross-party-seed.integration.ts (responder must be dialable on control and strand networks)
  - docs/reference-app-rn.md (Trust model / closed strands), docs/architecture.md (Reference apps, Relay Integration), docs/strands.md
----

# A phone can issue a closed-strand invitation someone can redeem

## The use case

The Sereus trust model is invitation-only strands: one party creates a closed strand, hands another party an invitation out of band, and the invitee consents and joins over the formation protocol ([`docs/reference-app-rn.md`](../../docs/reference-app-rn.md), "Trust model / closed strands"). The expected everyday case is a person on their phone inviting someone else — who may bring one or more always-on nodes of their own (cadre-host or cadre-cli machines).

The formation protocol has the **invitee dial the host** (`strand-formation-cross-party-seed.integration.ts`: the joiner dials the responder's control node, then the responder's strand nodes from addresses carried in the result). So the inviting side must be reachable on both its control network and its strand network.

## What happens on a phone today

- The phone node is started with `listenAddrs: []` and no `relayAddrs` (`cadre-phone.ts:242-261`), so `resolveListenAddrs` yields no circuit listener (`relay-addrs.ts:115-118`) and the start-time relay drive does nothing (`cadre-node.ts:5642-5645`).
- `CadreNode.createOpenInvitation` uses `getMultiaddrs()` as the invitation's bootstrap list and throws `No multiaddrs available for invitation` when it is empty (`cadre-node.ts:6529-6531`).
- So "Create Closed Strand + Invite" in the reference app can only fail. Worse, `createClosedStrandWithInvite` founds and publishes the closed strand *before* attempting the invitation (`use-cadre.ts:345-347`), so every tap leaves an orphaned closed strand selected in the UI. (That ordering is a small app-side fix handled separately; the reachability gap is this ticket.)
- The comment at `cadre-phone.ts:256-259` says the phone's "dialed circuit reservation + the `/webrtc` upgrade are advertised over the existing identify/cohort flow without a listen addr". Against `relay-addrs.ts` that does not hold — without `relayAddrs` there is no reservation to advertise. Correct or remove it as part of this work.

The one proven working shape is in the integration suite, not the app: `blind-relay-phone-to-phone-e2e.integration.ts` runs a `listenAddrs: []` node with `relayAddrs: [relay]`, and its invitation's bootstrap becomes `/p2p-circuit` addresses that a stranger can dial.

## What the design has to settle

- **Where a phone's relay comes from.** Options visible today: an operator/app-configured relay list (the tested shape; nothing in the app supplies one — no constant, env var, or manifest, unlike ICE servers which come from `EXPO_PUBLIC_ICE_CONFIG_URL`); or the phone's **own cadre's always-on nodes**, which already run the relay server by default on the storage profile and are known to the phone through `CadrePeer` rows. The second needs no infrastructure and matches the deployment story (phone + home host) — but a solo phone has no such node, so decide what a solo phone's invite button does (clear "not reachable yet — add a host or configure a relay" error, as the web reference app does, rather than a thrown internal error).
- **Strand networks too.** Formation needs the host's strand nodes reachable, and a strand node gets a relay reservation of its own (one supervised bare `/p2p-circuit` listener per relay — `strand-network-config.ts`, `strand-instance-manager.ts`) only from `network.relayAddrs`. A relay supplied through `CadreNode.reserveRelays()` instead — the web reference app's shape — reaches the control node only: its strand nodes keep an unsupervised bare listener that nothing drives, so they publish no circuit addr of their own. So whatever supplies the control node's relay must reach strand instances as well, and today only the config field does. (`bug-strand-relay-reservation-not-resupervised` landed 2026-09-14: strand reservations that exist now recover on their own after a relay restart, hangup, or refresh.)
- **Relay reservations on a phone that hibernates.** The app's background runner hibernates on background; reservations are lost with the connection. Decide whether an outstanding invitation needs anything beyond "re-reserve on resume".
- **Sibling dependency.** `phone-adds-cadre-host-node-to-its-cadre` needs a phone to be reachable (or a reversed dial) for the same underlying reason. If the chosen answer is "reserve on your own cadre's host node", that ticket provides the host node and this one provides the reservation; order them with `prereq:` accordingly.

## Expected behaviour when done

- Phone (party A) with a reachable relay — its own donated/host node, or a configured relay — taps "Create Closed Strand + Invite", gets an invitation whose bootstrap addresses are circuit addresses through that relay.
- A second party B (cadre-cli owner node, optionally with its own cadre-host donated node) redeems it with `formStrand`; B's nodes join the strand; a message sent on the phone is readable on B's nodes and the reverse.
- A phone with no relay available gets a clear, user-level message and no orphaned strand.
- An integration scenario covers the "relay supplied by the inviter's own always-on node" shape if that is the chosen design (the existing blind-relay scenario covers only a dedicated relay).

## Related

- `debt-docs-relay-support-reads-more-complete-than-it-is` — docs say "inbound-to-phone is not available"; update them when this lands.
- `feat-scenario-two-relay-circuit` — two parties on different relays (likely the real shape once each party relays through its own host).
- `bug-strand-relay-reservation-not-resupervised` — strand relay slots not re-acquired after a relay restart.
- `later/rn-webrtc-direct-dial` — the direct-upgrade path that would take the relay out of the data path.
- `feat-reference-app-approver-key-ui` — adjacent closed-strand UI work in the same screen.
