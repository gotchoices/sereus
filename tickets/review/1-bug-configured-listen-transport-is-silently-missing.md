description: A node told to listen on a WebSocket address used to accept the address and then quietly ignore it, so the phone app's companion server offered no WebSocket port even though its config said it did; the node now actually opens that listener, and refuses to start with a clear message on any address kind it cannot bind.
files: packages/cadre-core/src/relay-addrs.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/strand-network-config.ts, packages/cadre-core/src/strand-instance-manager.ts, packages/cadre-core/src/types.ts, packages/cadre-core/src/index.ts, packages/cadre-core/test/listen-transport-options.spec.ts, packages/cadre-core/test/relay-addrs.spec.ts, packages/cadre-core/test/strand-network-config.spec.ts, packages/cadre-core/test/cadre-node-control-node-options.spec.ts, packages/cadre-cli/src/config/types.ts, packages/cadre-cli/example.cadre.yaml
difficulty: medium
----

# Review: a configured listen address now reaches a real listener, or refuses start

## What changed

One new exported function, `resolveTransportOptions` (`packages/cadre-core/src/relay-addrs.ts:196`),
sits beside the existing `resolveListenAddrs` and answers the question nothing was
asking: *given the addresses this node was told to bind, which transports does it need?*

- **WebSocket is derived.** Any resolved listen entry naming `/ws` or `/wss` yields
  `{ wsPort: 0 }`, which `@optimystic/db-p2p`'s `createLibp2pNode` reads as "add
  `webSockets()`". The value never reaches a bind — see *The load-bearing assumption*.
- **Everything else is refused.** An entry outside {tcp, ws/wss, p2p-circuit} throws
  `UnbindableListenAddressError`, naming each offending address and the libp2p package
  it would need. Previously libp2p's transport manager dropped such an address in
  silence whenever at least one other address survived.
- **Both are skipped entirely when `network.transports` is set** — an embedder
  supplying transport factories owns transport policy, and factories are opaque.
- An **unparsable** entry passes through untouched (libp2p reports those itself), so
  this check only ever adds a denial.

Wired at both — and only — libp2p-node build sites:

| path    | call site                                                    | spread into                        |
| ------- | ------------------------------------------------------------ | ---------------------------------- |
| control | `cadre-node.ts:1489` (`buildControlNodeOptions`)              | `cadre-node.ts:1526`               |
| strand  | `strand-network-config.ts:102` (`strandNodeAddrs`)            | `strand-instance-manager.ts:~447`  |

`StrandNodeAddrs` grew a `wsPort?: number` field so the strand path's existing
`...addrOptions` spread carries it with no new plumbing.

Docs updated where an operator or embedder actually reads: `NetworkConfig.listenAddrs`
(`cadre-core/src/types.ts`), the CLI's config type, and `example.cadre.yaml`'s
`listenAddrs` block. `docs/reference-app-rn.md:430-433` was **left alone on purpose** —
it describes `--ws-port` as appending a `/ws` listen address, which is exactly what it
does; the flag was already documented correctly and simply did not work.

## Verified end to end, not just unit-tested

- **The bug reproduces without the fix.** A real `createLibp2pNode` given
  `['/ip4/127.0.0.1/tcp/0', '/ip4/127.0.0.1/tcp/0/ws']` and no `wsPort` returns exactly
  one multiaddr — the TCP one. The `/ws` listener is absent and nothing reports it.
- **It is fixed with it.** The same call plus `resolveTransportOptions`' output returns
  both, including the `/ws` entry at the configured port.
- **`cadre start --ws-port 4402` works for real.** Built the CLI, ran it against a solo
  memory config, polled its `/status` health endpoint, and read back:
  ```
  /ip4/192.168.86.41/tcp/4402/ws/p2p/12D3KooW…
  /ip4/127.0.0.1/tcp/4402/ws/p2p/12D3KooW…
  ```
  No change to `start.ts` was needed — the appended address is what triggers the
  derivation, as the fix-stage ticket predicted.

## The load-bearing assumption — check this first

`wsPort: 0` is a **switch, not a port**. It works because `createLibp2pNodeBase`
(`../optimystic/packages/db-p2p/src/libp2p-node-base.ts:490-491`) falls back to its
default listen addrs and its default transports *independently*:

```ts
const listenAddrs = options.listenAddrs ?? defaults.listenAddrs;
const transports  = options.transports  ?? defaults.transports;
```

`cadre-core` always passes explicit `listenAddrs`, so the `/ip4/<wsHost>/tcp/0/ws`
address db-p2p synthesizes from `wsPort` is discarded while the `webSockets()`
transport it added survives. db-p2p's own doc comment on `wsPort`
(`libp2p-node-base.ts:170-172`) says it is "Ignored when `transports`/`listenAddrs` are
explicitly provided", which is true of the address half and **false of the transport
half**. That contradiction is the fix's foundation, so it is re-verified empirically
rather than trusted: `test/listen-transport-options.spec.ts` boots a real node, and one
of its assertions (`exactly one /ws multiaddr, at the configured port`) fails if db-p2p
ever starts honouring the synthesized address too. The reasoning is written out at
`relay-addrs.ts` → `WS_TRANSPORT_SWITCH_PORT`.

Worth an adversarial look: is that empirical assertion strong enough to catch a db-p2p
change that makes the comment true of *both* halves? If db-p2p started ignoring
`wsPort` entirely, the `/ws` multiaddr disappears and the spec fails loudly — that case
is covered. The weaker case is db-p2p keeping the transport but changing how the switch
is spelled.

## Testing

`yarn workspace @serfab/cadre-core test` — **112 files, 1885 passed, 1 skipped.**
`yarn workspace @serfab/cadre-cli test` — **16 files, 232 passed.**
`yarn lint` — clean. Both packages build.

No pre-existing failures surfaced; `tickets/.pre-existing-error.md` was not written.

New/changed tests:

- **`test/listen-transport-options.spec.ts` (new).** The only spec here that boots a
  real libp2p node, because every unit assertion upstream was already green while the
  node listened on nothing. Three cases: the shipped drone shape binds *both* halves;
  a `/ws`-only config binds the operator's exact port and exactly one `/ws` address
  (proving `wsPort` never reaches a bind); a strand node's derived set binds `/ws` at
  an ephemeral port rather than the operator's fixed one.
- **`test/relay-addrs.spec.ts`** — 19 cases on the classifier: every WebSocket spelling
  (`/ws`, `/wss`, `/tls/ws`, `/tls/sni/…/ws`, ip6), TCP and circuit yielding nothing,
  QUIC/WebRTC/WebTransport throwing with the right package named, outermost-transport
  naming, an unknown transport layered over `tcp` refused rather than read as TCP,
  every offending entry reported (not just the first), unparsable passthrough, and the
  `network.transports` bypass.
- **`test/strand-network-config.spec.ts`** — the strand path reaches the same check,
  and a `/ws` entry still classifies as WebSocket *after* its port is zeroed.
- **`test/cadre-node-control-node-options.spec.ts`** — the control path carries
  `wsPort`, omits it when nothing names WebSocket, refuses an unbindable address, and
  does neither when `network.transports` is set.

## Known gaps and things to push on

- **The pairing is convention, not structure.** `resolveListenAddrs` and
  `resolveTransportOptions` are two sibling exports a caller must remember to use
  together. Both current build sites do, and `createLibp2pNode` has exactly two callers
  in this repo (verified by grep) — but a third could resolve listen addrs and forget
  the transports, reinstating the bug on that path. Parked as a `NOTE:` at
  `relay-addrs.ts` → `resolveTransportOptions` saying to fold the two into one function
  if a third site appears. **A reviewer may reasonably argue the fold should happen
  now** rather than being deferred; the counter-argument is that it touches every
  existing `resolveListenAddrs` call site and its tests for no behaviour change.
- **A behaviour change slightly beyond the ticket's stated set:** an address naming a
  host and no transport at all (`/ip4/1.2.3.4`) now refuses start too. It was silently
  dropped before, by exactly the mechanism this closes, so refusing is consistent — but
  it is a new failure mode for a config that used to "work" by doing nothing, and it is
  worth a second opinion. Pinned by a test in both `relay-addrs.spec.ts` and (as an
  `EMBEDDER_TRANSPORTS` fixture) `strand-network-config.spec.ts`.
- **Three pre-existing strand tests needed their fixtures amended,** not their
  assertions: they asserted the *address rewrite* using QUIC / WebRTC / port-less
  addresses, which the new check now refuses. Each gained an opaque
  `network.transports` marker (`EMBEDDER_TRANSPORTS`, documented at the top of the
  spec) — which is what a real deployment of those addresses carries anyway:
  `reference-app-web` ships `['/p2p-circuit', '/webrtc']` together with its own
  transport factories (`packages/reference-app-web/src/lib/cadre-web.ts:347,369`).
  Confirm that is a fixture correction and not a weakened assertion.
- **`/wss` normalization was observed, not researched.** `@multiformats/multiaddr`
  parses `/ip4/…/tcp/443/wss` to components `['ip4','tcp','wss']` in the version this
  repo resolves; the classifier handles `ws` and `wss` both, so either normalization
  works. If a future multiaddr version rewrites `wss` to `tls/ws`, that is still
  handled — but nothing pins the version.
- **The transport-package name table is best-effort.** `TRANSPORT_PACKAGES` maps
  component names to libp2p packages for the error message only; a wrong or missing
  entry degrades to "an unrecognized transport" and never changes whether an address is
  accepted.
- **Not touched, and confirmed unaffected by grep:**
  `packages/reference-app-rn/test-fixture/` (its `start.mjs` passes transports
  programmatically), the RN phone, the web app, the integration-test harness
  (`node-fixtures.ts:154` sets `transports: wsTransports()`), and
  `cadre-host` / `cadre-provider`, which both emit TCP-only `CADRE_LISTEN_ADDRS`.
- **Not run:** the `integration-tests` package. Its harness sets `transports`
  explicitly at every node it builds, so the derivation is a no-op there by
  construction — but that is a static argument, not an executed one.

## Out of scope, deliberately

Teaching `cadre-core` to derive QUIC/WebRTC/WebTransport transports. Doing so would
import transport packages into every consumer including the React Native and browser
bundles, against the cross-platform rule in `AGENTS.md`, and would duplicate policy
`@optimystic/db-p2p`'s `libp2p-node.ts` owns. Refusal is the deliberate alternative;
an embedder that needs them passes `network.transports`.
