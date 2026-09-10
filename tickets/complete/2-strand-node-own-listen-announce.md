description: Each shared-workspace network a machine runs now gets its own listen port instead of copying the main node's, so a machine configured with a fixed port can finally start its workspaces, and those workspaces no longer advertise an address that reaches the wrong endpoint.
files: packages/cadre-core/src/strand-network-config.ts, packages/cadre-core/src/strand-instance-manager.ts, packages/cadre-core/src/types.ts, packages/cadre-core/test/strand-network-config.spec.ts, packages/cadre-core/test/strand-listen-port-collision.spec.ts, packages/cadre-core/test/strand-instance-manager-network-addrs.spec.ts, packages/cadre-cli/example.cadre.yaml, packages/cadre-cli/README.md, packages/cadre-host/src/orchestrator/host-process-orchestrator.ts, docs/architecture.md
----

## What landed

A cadre machine runs one **control** libp2p node plus one libp2p node **per strand**
(a strand is a per-app shared network/database), and all of them were built from the
same operator-written `NetworkConfig`. Two of its fields describe a *single endpoint on
the host*, so a second node could not inherit them literally. A new module derives a
per-strand view of exactly those two.

**`packages/cadre-core/src/strand-network-config.ts`** — one exported function,
`strandNodeAddrs(network)`, returning `{ listenAddrs?: string[] }`:

| `NetworkConfig` field | control node | strand node |
| --- | --- | --- |
| `listenAddrs`, direct entry with fixed port | binds as configured | same entry, `tcp`/`udp` port rewritten to `0` |
| `listenAddrs`, `<relay>/p2p-circuit` entry | (control takes the bare search entry) | inherited verbatim — the port in it is the *relay's*, not a local bind |
| `listenAddrs: []` | binds nothing | binds nothing |
| `announceAddrs` / `appendAnnounceAddrs` | advertised | **dropped entirely** |
| `relayAddrs`, `transports`, `connectionGater`, `enableRelay` | — | inherited unchanged |

`buildStrandRuntime` (`strand-instance-manager.ts:403`) calls it once and spreads the
result, replacing the previous `resolveListenAddrs` + `resolveAnnounceAddrs` pair.

The reachability model this rests on: **a strand node is not separately dialable at a
published fixed address.** It is reached by its ephemeral direct listener plus the
addresses peers observe for it, and by circuit relay. A hosted deployment wanting a
strand node on its own published public port would need a per-strand network-config
surface; that is recorded as an accepted-tradeoff `NOTE:` in
`strand-network-config.ts`.

Documentation: `NetworkConfig.listenAddrs` gained a doc comment, the two announce
fields are marked control-node-only, and `docs/architecture.md` got a "What a strand
node does NOT inherit" subsection plus a fix to the stale "Both apply to the control
node and to every strand node" line at `:1064`.

## Testing

Three spec files, ~36 cases.

- **`test/strand-listen-port-collision.spec.ts`** — the `EADDRINUSE` claim verified
  against a real TCP stack with plain `createLibp2p` + `tcp()` nodes. Reproduces the
  pre-fix failure (a second node handed the control node's resolved addrs rejects),
  then starts a control node and two strand nodes together off one fixed-port config
  and asserts three distinct ports; plus the `listenAddrs: []` case.
- **`test/strand-network-config.spec.ts`** — the derivation, pure: `/ws` preserved over
  a rewritten port, specific-interface binds, `udp`/QUIC, circuit entries untouched,
  already-`0` and port-less entries byte-for-byte, unparsable passthrough, collapse
  dedupe, order stability, idempotence, `relayAddrs` validation still throwing, and a
  proof that the control node's own resolution of the same config object is unchanged
  and the caller's array unmutated.
- **`test/strand-instance-manager-network-addrs.spec.ts`** — renamed via `git mv` from
  `…-announce-addrs.spec.ts`; its old cases pinned the behaviour this ticket removes
  and are inverted. Pins that `buildStrandRuntime` hands `createLibp2pNode` the derived
  view and nothing else, and which relay route the strand path takes.

**Commands run at review, all green:**

```
yarn lint                                    # clean
yarn typecheck                               # all workspaces + 3 coverage meta-checks
yarn build                                   # all workspaces
yarn workspace @serfab/cadre-core test       # 111 files, 1833 passed | 1 skipped
yarn workspace @serfab/cadre-cli test        # 16 files, 232 passed
yarn workspace @serfab/cadre-host test       # 67 files, 626 passed | 4 skipped
```

No pre-existing failures surfaced; `tickets/.pre-existing-error.md` was not written.

## Review findings

**Correctness of the derivation — checked, nothing found.** Read the diff before the
handoff. `multiaddr(Component[])` is a supported overload (`MultiaddrInput` includes
`Component[]`, `@multiformats/multiaddr` `index.d.ts:182`), so the rebuild path is not
relying on an undocumented API. `withEphemeralPort` rebuilding field-by-field rather
than spreading is load-bearing and correctly reasoned — a spread would carry the
`bytes` cache and re-encode the old port. The empty-vs-undefined split
(`resolveListenAddrs` returning `undefined` becomes `{}`; returning `[]` becomes
`{ listenAddrs: [] }`) is right, and `buildStrandRuntime` still passes `port: 0`, so
omitting the option inherits db-p2p's own ephemeral default rather than a fixed one.
Confirmed against `../optimystic/packages/db-p2p/src/libp2p-node-base.ts:490` that a
supplied `listenAddrs` fully replaces the `port`-derived default, which is what makes
the original `EADDRINUSE` premise real rather than theoretical.

**Reachability model — scrutinised as the handoff asked, and accepted.** Dropping
`appendAnnounceAddrs` as well as `announceAddrs` is correct, not over-reach: appending
the operator's proxy address would advertise the control node's port under the strand
node's peerId, so a peer dialing it reaches a node whose identity does not match and
the dial fails. Both fields therefore had to go together.

**Operator-facing documentation — three stale surfaces found and fixed in this pass.**
The change altered what a configured port actually does, and none of the operator
documentation said so:

- `packages/cadre-cli/example.cadre.yaml` — the `listenAddrs` and `appendAnnounceAddrs`
  comments now state that the control node binds the written ports, strand nodes bind
  the same entries at port `0`, and that a NAT-forwarded port reaches the control node
  only.
- `packages/cadre-cli/README.md` — the `CADRE_LISTEN_ADDRS`, `CADRE_ANNOUNCE_ADDRS` and
  `CADRE_APPEND_ANNOUNCE_ADDRS` rows carry the same correction.
- `packages/cadre-host/src/orchestrator/host-process-orchestrator.ts:566` — the `NOTE:`
  there said a managed child "is reached at that port", which after this change is true
  of its control node only. `cadre-host` is precisely the deployment that pins a p2p
  port to a NAT forward (`port-allocator.ts:58`), so this was the most misleading of
  the three. Corrected in place.

**Source hygiene — checked, one coupling gap fixed.** `strand-network-config.ts` is 136
lines (`wc -l`), four short single-purpose functions plus one interface, with the
reasoning in the module doc rather than in inline comment blocks. The diff also shrank
the comment mass at the `strand-instance-manager.ts` call site. The gap: the
CONFIGURED-vs-`'search'` relay route is load-bearing and was documented only at the
call site, while the choice is actually made inside `strandNodeAddrs`. A four-line
comment now states it where the call happens.

**Test coverage — one gap closed, the rest judged adequate.** Added a case pinning the
browser shape `reference-app-web` ships (`src/lib/cadre-web.ts:369`): a bare
`/p2p-circuit` beside `/webrtc`, neither of which names a local port, so both must pass
through byte-for-byte. Nothing had pinned that exact production config, and either
being zeroed or dropped would cost a browser node both of its ways of being reached.
The handoff's other listed gaps — no end-to-end `CadreNode` test, and reachability
asserted rather than demonstrated — are real, but are the subject of three
already-filed downstream tickets (`strand-circuit-same-party-e2e`,
`formation-carries-strand-addrs`, `blind-relay-phone-to-phone-e2e`), so re-filing them
here would duplicate queued work.

**Tripwires recorded (not filed as tickets):**

- `strand-network-config.ts`, on the `strandNodeAddrs` doc — announce validation is now
  reached only through the control node's build, which runs first. That is an ordering
  guarantee, not a structural one; the `NOTE:` names the condition that would break it.
- `strand-network-config.ts`, at `dedupe` — an operator writing two fixed ports on the
  same interface and transport gets one strand listener, not two, since the entries are
  identical once zeroed. Intended; the `NOTE:` states the revisit condition.

**Accepted tradeoffs respected.** The `NOTE:` on `StrandNodeAddrs` records that a
strand node cannot be given its own published public port. Its revisit condition (a
hosted or reverse-proxy deployment needing direct-dialable strand nodes) has not
tripped, so it was left alone.

**One major finding, filed as
`tickets/fix/1-bug-configured-listen-transport-is-silently-missing.md`.** Not a defect
in this diff, but found by following its listen-address path end to end: a listen
address written in YAML or via `--ws-port` is accepted and then silently ignored unless
the node happens to have a transport that claims it, and `cadre-cli` never sets
`network.transports` (a YAML file cannot express a transport factory). db-p2p's default
transport set is TCP plus circuit-relay only, so every `/ws`, `/wss`, `/quic-v1` and
`/webrtc` listen address on a config-file deployment binds nothing. Two shipped
instances: the documented `cadre start --ws-port` flag, and
`packages/reference-app-rn/drone.cadre.yaml`, whose WebSocket listener is commented
*"required — RN can't do raw TCP"* and does not exist. Filed at the invariant level
(check configured listen addresses against the transports the node will actually have,
in one place at config resolution) rather than as a point fix to `--ws-port`, since the
point fix leaves the class alive. `repro: static` — read from the code paths, with the
confirming commands named in the ticket. Programmatic embedders that pass
`network.transports` themselves (the RN phone, the web app, the integration-test
harness) are unaffected, which is why the suite is green.

**Nothing found on:** resource cleanup (the derivation is pure and allocates only
strings; the collision spec tears its nodes down in `afterEach`), error handling (the
one throwing path, `relayAddrs` validation, is pinned by tests and now sits outside
`buildStrandRuntime`'s `try`, which also retires the error-path placement
inconsistency noted in `tickets/complete/announce-addrs-passthrough.md`), type safety
(no `any`; `Component` imported type-only), and performance (the derivation runs once
per strand start over a list of at most a handful of entries).
