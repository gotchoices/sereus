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
