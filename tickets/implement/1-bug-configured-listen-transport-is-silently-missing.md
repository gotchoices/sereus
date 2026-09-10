description: A node told to listen on a WebSocket address never actually does — the address is accepted and then quietly ignored, so the phone app's companion server offers no WebSocket port even though its config and documentation both say it does. Fix is to make the node actually build the WebSocket listener, and to refuse to start with a clear message on any other address kind it cannot bind.
files: packages/cadre-core/src/relay-addrs.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/strand-network-config.ts, packages/cadre-core/src/strand-instance-manager.ts, packages/cadre-core/test/relay-addrs.spec.ts, packages/cadre-core/test/strand-network-config.spec.ts, packages/cadre-cli/src/commands/start.ts, docs/reference-app-rn.md
repro: verified
difficulty: medium
----

# A configured listen address whose transport the node lacks is silently dropped

## Verified, not inferred

Ran against `@optimystic/db-p2p`'s `createLibp2pNode` with no `transports` option —
exactly what a config-file deployment produces:

| configured `listenAddrs`                              | result                                                                 |
| ----------------------------------------------------- | ---------------------------------------------------------------------- |
| `/ip4/127.0.0.1/tcp/0` + `/ip4/127.0.0.1/tcp/4402/ws` | starts fine; `getMultiaddrs()` returns **only** the TCP addr. WS gone.  |
| `/ip4/127.0.0.1/tcp/4403/ws` alone                    | throws `UnsupportedListenAddressesError` — "No transport was configured to listen on this address" |
| the first row's addrs, **plus a `wsPort` option**      | starts; `getMultiaddrs()` includes a `/ws` addr.                       |

The third row is the mechanism the fix leans on — see *Recommended shape*.

## Why the two halves never meet

- **Listen addresses** come from `network.listenAddrs` (YAML or `CADRE_LISTEN_ADDRS`)
  and pass through `resolveListenAddrs` (`relay-addrs.ts:101`) essentially as written.
- **Transports** come from `network.transports` — a list of JavaScript factory
  functions. YAML cannot express one, and `cadre-cli` never sets it, so a config-file
  deployment always leaves it unset.
- Unset means `createLibp2pNode`
  (`../optimystic/packages/db-p2p/src/libp2p-node.ts:14-36`) builds **TCP plus
  circuit-relay only**. Its WebSocket branch is gated on a separate `wsPort` option
  that `cadre-core` never passes (`grep -rn "wsPort" packages/cadre-core/src` → no hits).

libp2p's transport manager sorts configured listen addresses by which transport claims
them, drops the unclaimed ones, and raises only when **every** address was dropped.
Pair a TCP address with a WebSocket one and the TCP address carries the start — the
missing WebSocket listener is never reported.

## Two real instances

- **`cadre start --ws-port <port>`** (`packages/cadre-cli/src/commands/start.ts:104-116`)
  appends `/ip4/0.0.0.0/tcp/<port>/ws` and logs "Added WebSocket listen address". It
  adds no transport, so the flag does nothing observable. Documented as working at
  `docs/reference-app-rn.md:430`.
- **The React Native reference app's companion server.**
  `packages/reference-app-rn/drone.cadre.yaml:46` lists `/ip4/0.0.0.0/tcp/4002/ws`
  ("required — RN can't do raw TCP"); `packages/reference-app-rn/README.md:414` tells
  the developer to check the phone can reach port 4002. Nothing listens there.

### Corrections to the fix-stage ticket

- **`packages/reference-app-rn/test-fixture/drone.fixture.yaml` is NOT broken.** Its
  header says the yaml documents the fixture's settings and `start.mjs` configures the
  node programmatically — and `test-fixture/start.mjs:76-77` does pass
  `transports: [webSockets(), circuitRelayTransport()]` with a matching `/ws` listen
  addr. The fixture is out of scope; leave it alone.
- **`--ws-port` is not mentioned in `packages/cadre-cli/README.md`.** The doc that
  claims it works is `docs/reference-app-rn.md:430-433`. That is the file to update.

## Recommended shape — decided, not open

The fix-stage ticket left "reject vs derive" open. It resolves to **both, split by
transport**, because the two halves have different costs:

**Arm A — derive WebSocket.** WebSocket is the one non-TCP transport the shipped
configs actually need, and the one `@optimystic/db-p2p` already knows how to add.
`cadre-core` does not have to grow a dependency or decide transport policy: it passes
`wsPort` to `createLibp2pNode` when a resolved listen address names WebSocket, and
db-p2p's own branch adds `webSockets()`.

Mechanism, confirmed by reading `libp2p-node-base.ts:490-491`:

```
const listenAddrs = options.listenAddrs ?? defaults.listenAddrs;
const transports  = options.transports  ?? defaults.transports;
```

`wsPort` feeds **both** `defaults` entries, but the two fall back independently. Since
`cadre-core` always supplies explicit `listenAddrs`, db-p2p's synthesized
`/ip4/<wsHost>/tcp/<wsPort>/ws` default address is discarded while the `webSockets()`
transport it added survives. So `wsPort` acts as a pure on-switch here — its numeric
value never reaches a bind. Pass `0` rather than a port scraped from an address: the
strand path rewrites fixed ports to `0` anyway (`ephemeralPortListenAddr`,
`strand-network-config.ts:101`), and a config may name several WebSocket addresses on
different ports, so no single scraped port would be honest. Note the reasoning at the
call site — db-p2p's own doc comment (`libp2p-node-base.ts:170-172`) says `wsPort` is
"Ignored when `transports`/`listenAddrs` are explicitly provided", which is true of
the address half and **not** of the transport half; re-verify empirically before
relying on it, and if it ever becomes true of both, db-p2p needs an explicit
`enableWebSockets` switch instead.

**Arm B — reject everything else.** `/udp/…/quic-v1`, `/webrtc`, `/webtransport` and
friends stay unbindable, and today they are unbindable *silently*. Deriving them would
mean `cadre-core` importing transport packages into every consumer including the React
Native and browser bundles — against the cross-platform rule in `AGENTS.md`, and it
would duplicate policy that `libp2p-node.ts` owns (`relay-addrs.ts:56-59` already
names that file as the source of truth for defaults). So: name the address, name the
transport it needs, and refuse to start. This matches how `network.relayAddrs` and
`network.announceAddrs` already treat an operator typo — fail fast at config
resolution rather than come up wrong.

**Skip both arms entirely when `network.transports` is set.** A programmatic embedder
supplying transport factories owns the policy, and the factories are opaque — nothing
can be inferred from them. This is what keeps the RN phone
(`packages/reference-app-rn/src/cadre-phone.ts`), the web app, and the
integration-test harness (`node-fixtures.ts`) unaffected.

## Where the check belongs

`resolveListenAddrs(network, route)` (`packages/cadre-core/src/relay-addrs.ts:101`) is
the single function both node kinds pass through:

- control node — `cadre-node.ts:1484`, then the options object at `cadre-node.ts:1517-1521`
- strand nodes — `strand-network-config.ts:77` via `strandNodeAddrs`, then
  `strand-instance-manager.ts:403` / `:444`

Putting the rejection there covers both paths by construction, which is the invariant
worth establishing: **a configured listen address and the transports the node will
actually have are checked against each other in one place, before the node starts.**

Arm A needs its answer to reach the two options-building sites, which
`resolveListenAddrs`'s `string[] | undefined` return cannot carry. Shape suggestion —
keep the existing function's signature and add one sibling export in `relay-addrs.ts`:

```ts
/** Transport-derived libp2p options a resolved listen set implies. Throws on an
 *  address no default transport can bind. No-op when `network.transports` is set. */
export function resolveTransportOptions(
  network: NetworkConfig | undefined,
  listenAddrs: readonly string[] | undefined
): { wsPort?: number };
```

Both call sites then spread its result next to the existing
`...(network?.transports && { transports: network.transports })` line. Any shape works
as long as **both** paths call it — a helper only the control node reaches leaves
strand nodes with the bug.

Transport classification is a multiaddr component question, not a string question. The
bindable set with default transports is: `tcp` (with `ip4`/`ip6`/`dns*` prefixes),
`ws`/`wss` (note libp2p also spells secure WebSocket as `/tls/ws`), and `p2p-circuit`.
Reuse `multiaddr(addr).getComponents()` the way `isConfiguredCircuitListenAddr`
(`relay-addrs.ts:172`) and `ephemeralPortListenAddr` already do, and follow their
precedent for an unparsable entry: pass it through untouched and let libp2p report it,
so this check only ever *adds* a denial.

## Making `--ws-port` honest

Once Arm A lands, `--ws-port` starts working with no change to its own code — the
appended `/ws` address is what triggers the derivation. Verify that end-to-end rather
than assuming it; the flag's help text at `start.ts:77` describes exactly that
behaviour and should not need editing.

## Confirming the fix

- Unit: `packages/cadre-core/test/relay-addrs.spec.ts` — a `/ws` listen addr yields
  `wsPort`; a `/quic-v1` or `/webrtc` addr throws naming the address and the transport;
  a `network.transports`-bearing config yields neither.
- Unit: `packages/cadre-core/test/strand-network-config.spec.ts` — the strand path
  reaches the same check (a strand config with `/quic-v1` throws).
- Real node: build a node from `packages/reference-app-rn/drone.cadre.yaml`'s listen
  set and assert `getMultiaddrs()` contains a `/ws` entry. This is the assertion that
  would have caught the original bug; the three-row table above is the shape to pin.

## Out of scope

- `packages/reference-app-rn/test-fixture/` — already correct (see corrections above).
- Programmatic embedders passing `network.transports`: the RN phone, the web app, the
  integration-test harness. Unaffected by construction.
- Teaching `cadre-core` to derive QUIC/WebRTC transports. Arm B deliberately refuses
  instead; revisit only if an operator use case for them appears.

## TODO

- Add `resolveTransportOptions` (or equivalent) to `packages/cadre-core/src/relay-addrs.ts`:
  classifies each resolved listen addr by multiaddr components, returns `{ wsPort: 0 }`
  when any names WebSocket, throws naming address + needed transport on anything
  outside {tcp, ws/wss, p2p-circuit}, and returns `{}` unconditionally when
  `network.transports` is set. Pass an unparsable entry through untouched.
- Document at that function why `wsPort` is a switch and not a port, citing
  `libp2p-node-base.ts:490-491`.
- Call it on the control path: `cadre-node.ts` near the existing `resolveListenAddrs`
  call (`:1484`) and spread into the options object alongside `:1517-1521`.
- Call it on the strand path: `strand-network-config.ts`'s `strandNodeAddrs` (`:72-84`)
  or `strand-instance-manager.ts:403`, so `:444`'s spread carries it. Confirm the
  ephemeral-port rewrite runs before/after the check consistently — a `/ws` addr must
  still classify as WebSocket after its port is zeroed.
- Extend `packages/cadre-core/test/relay-addrs.spec.ts` and
  `packages/cadre-core/test/strand-network-config.spec.ts` per *Confirming the fix*.
- Add the real-node assertion (a `/ws` listen addr actually appears in
  `getMultiaddrs()`), placed wherever `cadre-core`'s tests already boot a libp2p node.
- Verify `cadre start --ws-port 4002` produces a `/ws` multiaddr end to end.
- Update `docs/reference-app-rn.md:430-433` if the flag's described behaviour has
  changed; leave `packages/cadre-cli/README.md` alone (it never mentioned the flag).
- Run `yarn workspace @serfab/cadre-core test` and `yarn lint`.
