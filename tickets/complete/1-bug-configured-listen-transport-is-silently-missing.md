description: A node told to listen on a WebSocket address used to accept the address and then quietly ignore it, so the phone app's companion server offered no WebSocket port even though its config said it did; the node now actually opens that listener, and refuses to start with a clear message on any address kind it cannot bind.
files: packages/cadre-core/src/relay-addrs.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/strand-network-config.ts, packages/cadre-core/src/strand-instance-manager.ts, packages/cadre-core/src/types.ts, packages/cadre-core/src/index.ts, packages/cadre-core/test/listen-transport-options.spec.ts, packages/cadre-core/test/relay-addrs.spec.ts, packages/cadre-core/test/strand-network-config.spec.ts, packages/cadre-core/test/cadre-node-control-node-options.spec.ts, packages/cadre-cli/src/config/types.ts, packages/cadre-cli/example.cadre.yaml, packages/cadre-cli/README.md, docs/architecture.md
----

# A configured listen address now reaches a real listener, or refuses start

## What shipped

`resolveTransportOptions` (`packages/cadre-core/src/relay-addrs.ts`) sits beside
`resolveListenAddrs` and answers the question nothing was asking: given the addresses
this node was told to bind, which transports does it need?

- **WebSocket is derived.** A resolved listen entry naming `/ws` or `/wss` yields
  `{ wsPort: 0 }`, which `@optimystic/db-p2p`'s `createLibp2pNode` reads as "add
  `webSockets()`". The value is a switch, never a bind.
- **Anything the default transports cannot bind is refused**, with
  `UnbindableListenAddressError` naming each offending address and the libp2p package it
  would need. libp2p previously dropped such an address in silence whenever at least one
  other address survived.
- **Both arms are skipped when `network.transports` is set** — a programmatic embedder
  owns transport policy and its factories are opaque.
- An **unparsable** entry passes through untouched, so the check only ever adds a denial.

Wired at both libp2p-node build sites that derive a listen set from `NetworkConfig`:
`cadre-node.ts` → `buildControlNodeOptions`, and `strand-network-config.ts` →
`strandNodeAddrs` (whose `StrandNodeAddrs` grew a `wsPort?: number` field so the existing
`...addrOptions` spread carries it).

Verified end to end during implementation: the bug reproduces against a real
`createLibp2pNode` without the fix (only the TCP multiaddr comes back), is fixed with it,
and `cadre start --ws-port 4402` was run for real and read back its bound `/ws` addresses.

## Review findings

### Checked

Read the implement diff (`c62ae34`) before the handoff summary. Scrutinised the
classifier against the actual `@libp2p/tcp` and `@optimystic/db-p2p` sources rather than
the handoff's description of them; swept every `listenAddrs`/`createLibp2pNode` site in
the repo (not only the ones the handoff named); re-read every doc that documents
`NetworkConfig.listenAddrs`; ran lint, both test suites, both builds, the
integration-tests typecheck, and the three repo-wide typecheck-coverage guards.

### Fixed in this pass

- **A `/unix/<path>` listen address was refused, but `@libp2p/tcp` binds it.**
  `listenTransportKind` accepted only a bare `tcp` stack, so `/unix/%2Ftmp%2Fcadre.sock`
  classified as unsupported and failed startup — while `@libp2p/tcp`'s `listenFilter`
  (`node_modules/@libp2p/tcp/dist/src/tcp.js:176`) accepts an exact TCP match **or** any
  address starting `/unix/` (a named pipe on Windows). That is the new gate denying an
  address the default transports actually bind — a behaviour regression introduced by
  this change, and the opposite of its job. The contradiction was visible in the code
  itself: `TRANSPORT_PACKAGES` mapped `unix` to the string "`@libp2p/tcp` bound to a unix
  socket path", i.e. it named the transport the node already had and refused anyway.
  Fixed: `unix` now classifies as `tcp`, its `TRANSPORT_PACKAGES` entry is gone, the
  operator-facing message says `TCP (including /unix/<path>)`, and
  `relay-addrs.spec.ts` pins it. Verified the component name is exactly `unix` by
  parsing the address with the resolved `@multiformats/multiaddr`.
- **The `NOTE:` at `resolveTransportOptions` claimed "`createLibp2pNode` has exactly
  those two callers in this repo". It has five** — also
  `integration-tests/src/harness/test-party.ts` and `quereus-plugin-sereus`'s
  `connect.ts` and `connect-browser.ts`. None of the three can reinstate the bug (they
  pass no `listenAddrs`, or pass their own transports with it), so the tripwire's
  *conclusion* holds, but its stated evidence was wrong and a future maintainer checking
  it would find the count doesn't match. Reworded to the accurate claim — the only two
  callers that derive a listen set from a `NetworkConfig` — naming the other three so the
  next reader doesn't have to re-run the grep.
- **Two docs that document this field were left stale.** The handoff updated
  `NetworkConfig.listenAddrs`, the CLI config type and `example.cadre.yaml`, but
  `docs/architecture.md`'s `NetworkConfig` excerpt (~line 1112) mirrors that same comment
  and said nothing about the bindable set or the new startup failure, and
  `packages/cadre-cli/README.md`'s `CADRE_LISTEN_ADDRS` row lists failure modes for its
  sibling env vars while omitting this one. Both updated. `docs/architecture.md` is the
  entry-point doc per `AGENTS.md`, so a reader who starts there would otherwise have
  learned the old rules.

### Filed as a new ticket

- **`backlog/bug-dialed-addresses-get-no-transport-derivation`.** The derivation covers
  the addresses a node *binds* and not the ones it *dials*: nothing derives transports
  from `network.relayAddrs` or `controlNetwork.bootstrapNodes`, so a machine pointed at a
  WebSocket relay or bootstrap peer with TCP-only listen addresses starts cleanly, never
  reserves or joins, and reports nothing — the identical failure mode this ticket closed,
  on the other half. Pre-existing, not a regression from this change, and dormant in this
  repo (no shipped config names one; and any `/ws` listen entry switches the transport on
  as an unrelated side effect, which masks it further). Filed at the boundary-invariant
  rung rather than as a point fix: the ticket states the invariant over the whole config
  ("every multiaddr this node will bind **or dial** is claimed by a transport it will
  have"), which retires `relayAddrs`, `bootstrapNodes`, and any future address-bearing
  field at once, and flags the open design question — whether the dial half should refuse
  start or warn — as something to settle before writing code. Static, not reproduced; the
  ticket names the experiment that would confirm it.

### Considered and declined

- **Folding `resolveListenAddrs` and `resolveTransportOptions` into one function now.**
  The handoff explicitly invited this argument. Declined: `resolveListenAddrs` has a
  third caller in `cadre-node.ts:1455` (a read-only `listensOnCircuit` predicate that
  wants no transport options at all) plus ~25 direct test assertions, so the fold changes
  every one of them for zero behaviour delta, and the existing `NOTE:` already records
  both the risk and its trigger condition (a third config-derived build site). Revisit
  when that trigger fires, as the note says.
- **`/ip4/1.2.3.4` — a host with no transport — now refuses start.** The handoff asked
  for a second opinion on this being slightly beyond the ticket's stated set. Confirmed
  correct and kept: `@libp2p/tcp`'s matcher requires an ip **and** a tcp component, so
  such an entry matched no transport and was dropped by exactly the silent mechanism this
  change closes. Refusing is the consistent answer, and it is pinned by tests on both
  paths.
- **The `EMBEDDER_TRANSPORTS` fixture amendments in `strand-network-config.spec.ts`.**
  Confirmed these are fixture corrections, not weakened assertions: the marker was added
  only to fixtures whose *addresses* are unbindable (QUIC, WebRTC, port-less), every
  asserted rewrite output is byte-identical to before, and it matches what a real
  deployment of those addresses carries — `reference-app-web` ships
  `['/p2p-circuit', '/webrtc']` together with its own factories
  (`packages/reference-app-web/src/lib/cadre-web.ts:347,369`, read and confirmed).
- **The `/wss` normalization the handoff flagged as "observed, not researched".** No
  action needed and no tripwire warranted: the classifier handles `ws`, `wss`, `tls/ws`
  and `tls/sni/…/ws` and all four are pinned by tests, so any normalization a future
  `@multiformats/multiaddr` picks lands on a handled branch. Verified the current
  parse of all four shapes directly.
- **`cadre-node.ts` at 6331 lines.** Real size debt, but pre-existing, untouched by this
  diff (+11 lines), and already tracked by
  `tickets/backlog/debt-cadre-node-single-file-size`. Not re-filed.
- **Operator docs not extended with `/unix/<path>`.** `example.cadre.yaml`,
  `NetworkConfig.listenAddrs`, the CLI config type and the two READMEs say "TCP,
  WebSocket, circuit-relay"; a unix path is a TCP-transport address in libp2p's model, so
  that phrasing already covers it, and spelling out a form nobody configures would be
  noise. The error message names it, which is where an operator who tries one meets it.

### No tripwires recorded

Nothing surfaced in the "fine now, only matters if X later" shape that wasn't already
parked. The two conditional concerns at these sites — the convention-not-structure
pairing and db-p2p's `wsPort` switch changing spelling — already carry `NOTE:` comments
from the implement stage at `relay-addrs.ts` → `resolveTransportOptions` and
`WS_TRANSPORT_SWITCH_PORT`, with the second re-verified empirically by
`test/listen-transport-options.spec.ts` on every run. Both were re-read and left in
place; only the first's factual claim was corrected, as above.

### Test coverage assessment

The implementer's suite is genuinely strong for once — 19 classifier cases, both wiring
paths, and one spec that boots a real libp2p node because every unit assertion upstream
was already green while the node listened on nothing. The gap it had was the `/unix/`
case, which is exactly what the missing test let through; that is now covered. Error
paths, the `network.transports` bypass, unparsable passthrough, multi-address reporting
and the post-rewrite strand classification were all already covered.

### Validation run

- `yarn lint` — clean (exit 0).
- `yarn workspace @serfab/cadre-core test` — **112 files, 1886 passed, 1 skipped**
  (1885 before; +1 is the new `/unix/` case).
- `yarn workspace @serfab/cadre-cli test` — **16 files, 232 passed.**
- `yarn workspace @serfab/cadre-core build`, `yarn workspace @serfab/cadre-cli build` —
  both clean. The CLI suite runs against compiled output and its stale-build guard fired
  until `cadre-core` was rebuilt, as designed.
- `yarn workspace @serfab/cadre-core typecheck`,
  `yarn workspace @serfab/integration-tests typecheck` — both clean. The integration-test
  package was typechecked specifically because it consumes the changed `StrandNodeAddrs`
  type and the implement stage had not run it.
- `yarn check:test-file-typecheck-coverage`, `yarn check:vitest-typecheck-coverage` —
  both clean; the new spec file is inside its package's type-check program.

No pre-existing failures surfaced; `tickets/.pre-existing-error.md` was not written.

### Not run

The `integration-tests` package's scenarios. Its harness sets `network.transports`
explicitly at every node it builds (`node-fixtures.ts:154`, read and confirmed), so the
derivation is a no-op there by construction — a static argument, as the handoff said, but
one I verified rather than took on trust, and its typecheck was run.
