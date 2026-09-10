description: Each shared-workspace network a machine runs now gets its own listen port instead of copying the main node's, so a machine configured with a fixed port can finally start its workspaces, and those workspaces no longer advertise an address that reaches the wrong endpoint.
files: packages/cadre-core/src/strand-network-config.ts, packages/cadre-core/src/strand-instance-manager.ts, packages/cadre-core/src/types.ts, packages/cadre-core/test/strand-network-config.spec.ts, packages/cadre-core/test/strand-listen-port-collision.spec.ts, packages/cadre-core/test/strand-instance-manager-network-addrs.spec.ts, docs/architecture.md
----

## What landed

A cadre machine runs one **control** libp2p node plus one libp2p node **per strand**
(a strand is a per-app shared network/database), and all of them were built from the
same operator-written `NetworkConfig`. Two of its fields describe a *single endpoint on
the host*, so a second node could not inherit them literally. A new module derives a
per-strand view of exactly those two.

**New: `packages/cadre-core/src/strand-network-config.ts`** — one exported function,
`strandNodeAddrs(network)`, returning `{ listenAddrs?: string[] }`:

| `NetworkConfig` field | control node | strand node |
| --- | --- | --- |
| `listenAddrs`, direct entry with fixed port | binds as configured | same entry, `tcp`/`udp` port rewritten to `0` |
| `listenAddrs`, `<relay>/p2p-circuit` entry | (control takes the bare search entry) | inherited verbatim — the port in it is the *relay's*, not a local bind |
| `listenAddrs: []` | binds nothing | binds nothing |
| `announceAddrs` / `appendAnnounceAddrs` | advertised | **dropped entirely** |
| `relayAddrs`, `transports`, `connectionGater`, `enableRelay` | — | inherited unchanged |

`buildStrandRuntime` (`strand-instance-manager.ts:403`, `:445`) now calls it once and
spreads the result, replacing the previous `resolveListenAddrs(config.network)` +
`...resolveAnnounceAddrs(config.network)` pair. Both stale `NOTE:` blocks at that site
are gone.

Doc updates: `NetworkConfig.listenAddrs` gained a doc comment (it had none),
`announceAddrs` / `appendAnnounceAddrs` are now marked control-node-only, and
`docs/architecture.md` got a "What a strand node does NOT inherit" subsection under
*Reservations are requested explicitly, not discovered* plus a fix to the stale
"Both apply to the control node and to every strand node" line in its config-surface
listing (`docs/architecture.md:1064`).

## The reachability model this assumes

**A strand node is not separately dialable at a published fixed address.** It is
reached by (a) its ephemeral direct listener plus the addresses peers observe for it,
and (b) circuit relay. That is the whole justification for dropping the announce
config, and it is worth a reviewer's scrutiny — if it is wrong, the fix is wrong.

Recorded as an accepted tradeoff at the drop site (`strand-network-config.ts`, on the
`StrandNodeAddrs` doc): a hosted deployment wanting a strand node reachable at its
*own* published public port has no way to say so after this change; that would need a
per-strand network-config surface. Revisit condition stated in the `NOTE:`.

## Testing / validation

Three spec files, ~35 new cases.

**`test/strand-listen-port-collision.spec.ts` — the previously-unverified `EADDRINUSE`
claim, now verified against a real TCP stack.** Plain `createLibp2p` + `tcp()` nodes
(not `CadreNode`s — the contended resource is a socket, and a cadre node would drag a
control database into a question about `bind()`). Three cases:

- Handing a **second** node the control node's own resolved listen addrs rejects with
  `EADDRINUSE`. **This is the pre-fix behaviour reproduced**, so it is a real
  before/after, not an assertion of the claim. It passes today because the test
  constructs the collision deliberately.
- Control node + **two** strand nodes start together off one fixed-port config; the
  control node still binds exactly the configured port, and the two strands bind
  distinct ports, neither of them the fixed one.
- `listenAddrs: []` gives strand nodes no listener (the React Native "cannot listen"
  case must not gain one by accident).

**`test/strand-network-config.spec.ts` — the derivation, pure.** Covers every edge case
the plan named: `/ws` suffix preserved over a rewritten port, specific-interface binds
(`ip4`/`ip6`/`dns4`) preserved, `udp` rewritten too (QUIC contends the same way),
`/p2p-circuit` entries untouched (hand-written and `relayAddrs`-folded), port already
`0` or absent passed through byte-for-byte, unparsable entry passed through, dedupe of
entries that collapse once zeroed, order stability, idempotence, `relayAddrs`
validation still throwing, and — the control-node-untouched proof — that
`resolveListenAddrs` on the same config object returns the identical result before and
after a `strandNodeAddrs` call, with the caller's array unmutated.

**`test/strand-instance-manager-network-addrs.spec.ts`** — renamed from
`strand-instance-manager-announce-addrs.spec.ts` (`git mv`, so the rename is visible in
the diff). Its old cases *pinned the behaviour this ticket removes* — "forwards a
configured announceAddrs" and so on — and are inverted. Now pins that
`buildStrandRuntime` hands `createLibp2pNode` the derived view and nothing else,
through the existing mocked-`createLibp2pNode` harness.

**Commands run, all green:**

```
yarn lint                                    # clean
yarn typecheck                               # all workspaces + the 3 coverage meta-checks
yarn build                                   # all workspaces
yarn workspace @serfab/cadre-core test       # 111 files, 1833 passed | 1 skipped
yarn workspace @serfab/cadre-cli test        # 16 files, 232 passed
yarn workspace @serfab/cadre-host test       # 67 files, 626 passed | 4 skipped
```

No pre-existing failures surfaced; `tickets/.pre-existing-error.md` was not written.

## Known gaps — treat the tests as a floor

- **No end-to-end `CadreNode` test.** The port-collision spec uses bare libp2p nodes.
  Nothing exercises a real `CadreNode` starting a fixed-port control node and two real
  strands through `buildStrandRuntime`; that path is covered only by the mocked
  manager spec. A reviewer who thinks the integration seam deserves a real test would
  be reaching for `packages/integration-tests`.
- **Reachability is asserted, not demonstrated.** No test shows a peer actually
  reaching a strand node that no longer announces the operator's address — through
  observed addresses or through relay. The claim rests on the relay path being
  unchanged (`relayAddrs` → per-relay `<relay>/p2p-circuit`, which strand nodes still
  inherit verbatim) and on `relay-addrs.spec.ts` / `strand-transport-relay.spec.ts`
  continuing to pass, not on a new test.
- **Fewer listeners after collapse.** Two direct entries that differ only by port
  become one entry on a strand node. Intended — libp2p cannot bind the same ephemeral
  entry twice — but an operator who wrote two fixed ports expecting two strand
  listeners gets one. Pinned by a test and commented at `dedupe`; flagging it as a
  judgment call, not an accident.
- **Dedupe is exact-string**, matching `relay-addrs.ts`. Two entries that are
  semantically the same address written differently (`/dns4/h/tcp/4001` vs
  `/dns/h/tcp/4001`) do not collapse. Pre-existing behaviour, inherited deliberately.
- **The rewrite round-trips through the multiaddr normalizer** only when there is
  actually a fixed port to zero; otherwise the operator's exact string is returned.
  So a normalization difference can only appear on an entry that was going to change
  anyway — but no test pins the normalizer's output for an exotic protocol stack.
- **`announceAddrs` validation now runs only on the control node's build.** That build
  runs first, so a malformed entry still refuses node start — but the coupling is
  ordering, not structure. If a strand ever starts before the control node's libp2p
  options are resolved, a bad announce entry would go unreported. Nothing does that
  today.
