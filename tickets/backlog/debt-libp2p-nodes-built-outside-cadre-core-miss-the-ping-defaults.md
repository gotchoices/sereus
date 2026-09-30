description: Sereus now waits longer before deciding a peer has gone quiet, so a slow phone is no longer disconnected mid-sync. Three other places in the codebase build the same kind of network node and were not given that setting, so a slow phone talking to one of them can still be dropped.
architecture: docs/architecture.md
files:
  - packages/quereus-plugin-sereus/src/connect.ts (`createNode`)
  - packages/quereus-plugin-sereus/src/connect-browser.ts (`createNode`)
  - packages/integration-tests/src/harness/test-party.ts (`createLibp2pNode` call)
  - packages/cadre-core/src/types.ts (`DEFAULT_CONNECTION_MONITOR`, the value to share)
  - packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/strand-instance-manager.ts (the two sites that already apply it)
  - packages/cadre-core/src/relay-addrs.ts (the sibling "convention, not structure" note about the same two sites)
tradeoffs: Nothing in this repo reaches the uncovered paths today — cadre always injects a node it built itself — so a maintainer may reasonably judge this speculative until someone actually runs a standalone SQL session against a strand, and the cheapest version of the fix moves a constant between packages, which is churn for a value nobody is currently reading.
----

# Every libp2p node this repo builds should run the same liveness-ping settings

## What is going on

libp2p pings each open connection on a timer and closes the connection when a ping is not answered in time. Its stock settings are aggressive enough to disconnect a phone that is merely busy — the problem reported as gotchoices/sereus#13. Sereus now ships its own settings for that ping (`DEFAULT_CONNECTION_MONITOR`), and applies them at the two places `cadre-core` builds a node: the control node and each strand node.

Three other places in this repo build a libp2p node and get libp2p's stock settings instead:

- `packages/quereus-plugin-sereus/src/connect.ts` — the Node path a standalone Quereus SQL session takes to join a strand.
- `packages/quereus-plugin-sereus/src/connect-browser.ts` — the browser path of the same.
- `packages/integration-tests/src/harness/test-party.ts` — the bare nodes the cross-package test harness builds.

The setting has to match on both ends, because either end's monitor closing the connection closes it for both. So a slow phone on a strand whose other participant came in through one of these paths can still be dropped mid-sync, with the same symptom the original report describes.

## Why it is not urgent

No code path in this repo reaches the two `quereus-plugin-sereus` node builders today. `cadre-core` always constructs the libp2p node itself and injects it, so `connectToStrand` never creates one. The gap is reachable only by an outside consumer of the published `@serfab/quereus-plugin-sereus` package that lets it build its own node, and by the test harness — where it means the harness exercises settings production does not use.

## What would settle it

The useful outcome is not three more copies of the same literal. It is that a new node-build site cannot silently miss the settings. `packages/cadre-core/src/relay-addrs.ts` already carries a note saying the same thing about listen-address derivation: pairing the two halves is a convention, and a third site can forget.

The obvious shape, and the one the codebase already uses for shared constants that both packages need (`CONTROL_CLUSTER_POLICY` and its siblings live in `quereus-plugin-sereus` and are re-exported from `cadre-core`'s `types.ts`), is to move the settings down to `quereus-plugin-sereus`, apply them at its own node builders, and re-export from `cadre-core` so nothing about the public surface changes. `cadre-core` depends on `quereus-plugin-sereus`, not the other way round, so this is the only direction that works without a new package.

Whether the integration harness should take the same settings or deliberately keep libp2p's — a harness that pings on the production schedule is slower to notice a node it killed — is part of the same decision and should be answered explicitly rather than by default.

Picking that shape is a design call, which is why it is written up rather than done inline.

## Second arm (2026-09-26, from `relayed-links-up-to-a-three-second-round-trip`): the connection limits

cadre-core now also sets libp2p's `connectionManager.dialTimeout` and `inboundUpgradeTimeout` on the control node and every strand node, derived from `NetworkConfig.linkRoundTripMs` (`connectionManagerTimeouts()` in `packages/cadre-core/src/link-budget.ts`, 16 s each at the default). The same three sites miss it and keep libp2p's 10 s. Its failure is sharper than the ping one: a node built at one of these sites is the LISTENER for connections other machines open to it, and above a 2.5-second round trip it discards a half-built relayed connection while the dialer's own dial still succeeds, so every stream on that connection dies with `Unexpected EOF` and nothing reports why. Whatever shape settles the ping settings should carry these two limits as well — with the extra wrinkle that they are derived from a declaration, not a constant, so moving them down to `quereus-plugin-sereus` means moving the derivation (or taking the limits as an input) rather than moving one frozen value.

**Update 2026-09-29 (`adopt-optimystic-link-round-trip-option`):** cadre-core no longer sets the two limits itself and `connectionManagerTimeouts()` is gone. It now hands the declared round trip to Optimystic (`NodeOptions.linkRoundTripMs`, `@optimystic/db-p2p` 1.8.0), which derives the two limits from it (five round trips with a 10 s floor, 17.5 s at the default) along with its own request dial and response deadlines (21 s and 10.5 s at the default, against 3 s and 10 s undeclared). A node built at one of the three sites declares no link, so it keeps all of Optimystic's LAN deadlines, not only libp2p's 10 s. The wrinkle above gets simpler: what has to reach those sites is now one number, `linkRoundTripMs` (resolved with `resolveLinkRoundTripMs`), not a derivation.
