----
description: The phone and browser apps talk over a peer-to-peer connection type that none of our tests ever use, so a freeze caused by that connection type would not show up until a user hit it.
prereq: debt-control-db-offline-peer-no-hang-coverage
files: packages/reference-app-web/src/lib/cadre-web.ts, packages/reference-app-rn/src/cadre-phone.ts, packages/cadre-core/test/control-database-offline-peers.spec.ts, packages/cadre-core/package.json
----

# Coverage gap: WebRTC transports are never exercised in tests

## The gap

Both reference apps configure their node with four ways of making a connection:

- `reference-app-web` (`src/lib/cadre-web.ts` ~line 334): WebSockets, circuit-relay, WebRTC, and
  WebRTC-direct.
- `reference-app-rn` (`src/cadre-phone.ts` ~line 254): WebSockets, circuit-relay, and WebRTC.

Our tests only ever use WebSockets, and — once
`debt-control-db-offline-peer-no-hang-coverage` lands — circuit-relay. **Nothing anywhere runs a
node with WebRTC configured.** A bug whose trigger is that connection type (a connect attempt that
never gives up, a shutdown that waits on one, an address that is accepted but never dialable) is
invisible to the whole suite.

This matters most for the same question the offline-peer ticket asks: when a node's other members
are switched off, does a read or write of its own settings answer from local data, or does it
freeze? A freeze that only happens under WebRTC would pass every test we have.

## Why it was not folded into the offline-peer ticket

`@libp2p/webrtc` is not a dependency of `@serfab/cadre-core`, and it does not run in plain Node —
it needs a browser or a native WebRTC binding. So covering it is a dependency and test-runtime
decision, not a test-harness one. Someone has to choose between:

- adding `@libp2p/webrtc` plus a native binding as a cadre-core devDependency and running the case
  in Node,
- running it in a browser test environment instead, or
- covering it in the reference apps' own suites rather than in cadre-core.

Note the repo's dependency gate (`yarn dep-check`) and that `reference-app-web` sets
`installConfig.hoistingLimits: "workspaces"`, so whichever package gets the dependency must declare
it explicitly.

## What "done" looks like

A node configured with the same transport list a reference app actually ships, whose other members
are unreachable, completes its settings reads and writes from local data within a bounded time —
asserted, not assumed.
