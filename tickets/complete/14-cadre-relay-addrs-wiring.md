description: A node can now actually use the relay servers it is configured with, so peers can reach it from behind a home router. The setting used to be silently thrown away.
files: packages/cadre-core/src/relay-addrs.ts, packages/cadre-core/src/delegate-admission.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/strand-instance-manager.ts, packages/cadre-core/src/types.ts, packages/cadre-core/test/relay-addrs.spec.ts, packages/cadre-core/test/cadre-node-control-node-options.spec.ts, packages/cadre-cli/example.cadre.yaml, packages/cadre-cli/README.md, docs/architecture.md, docs/STATUS.md
----

# `network.relayAddrs` wiring — complete

## What shipped

`NetworkConfig.relayAddrs` was settable in `cadre.yaml`, via `CADRE_RELAY_ADDRS`, and through the
Docker entrypoint, and was read by nobody — a node told to use a relay held no reservation and
stayed unreachable behind NAT.

It is now translated into the mechanism the repo already had (a `/p2p-circuit` entry in the node's
listen addrs, which is what makes libp2p dial a relay and hold a reservation):

```
effective listen addrs = listenAddrs ++ relayAddrs.map(a => a + "/p2p-circuit")   (deduped)
```

`src/relay-addrs.ts` owns that resolution:

- `relayCircuitAddrs(relayAddrs)` — appends `/p2p-circuit` per entry, passes an entry that already
  has one through unchanged, dedupes by exact string, **throws** on an unparsable entry or one that
  names no relay peerId.
- `resolveListenAddrs(network)` — configured `listenAddrs` ++ those circuits, deduped, configured
  entries first. `undefined` when neither field is set, so callers keep omitting the key and
  inherit db-p2p's default. When `relayAddrs` is set but `listenAddrs` is not, `/ip4/0.0.0.0/tcp/0`
  is prepended so naming a relay adds reachability rather than replacing the direct listener.

Three consumers read the resolved list: `CadreNode.buildControlNodeOptions()`,
`StrandInstanceManager`'s `createLibp2pNode` call, and `CadreNode.circuitRelayTargets()` (so a
configured relay also becomes a delegate-announce target — otherwise the relay would hold the
control node's reservation but deny the strand node's).

`delegate-admission.ts` now has a single multiaddr walker with two faces: a null-returning parse
(an addr that simply names no relay) and `circuitRelayTargetOrThrow` (the config-facing form). The
asymmetry is the point — `extractCircuitRelayTargets` reads addresses discovered at runtime from
peers, where one bad entry must not be fatal; `relayCircuitAddrs` reads operator config, where a
silently dropped entry is exactly the failure this ticket removes.

Docs: `NetworkConfig.relayAddrs` doc comment, `example.cadre.yaml`, `docs/architecture.md`,
`packages/cadre-cli/README.md` env table, `docs/STATUS.md`.

## Review findings

### Checked and correct

- **Read the implement diff before the handoff.** Resolution math, dedupe, ordering, idempotence,
  and the throw-on-bad-config path all match what the tests claim, and the two
  `cadre-node-control-node-options.spec.ts` assertions do fail against the old code.
- **The `/ip4/0.0.0.0/tcp/0` fallback matches db-p2p exactly.** Verified against
  `../optimystic/packages/db-p2p/src/libp2p-node.ts` (`port ?? 0`, TCP listener unless `disableTcp`,
  a WebSocket listener only when `wsPort` is given) and `libp2p-node-base.ts:457`
  (`options.listenAddrs ?? defaults.listenAddrs` — supplying a list replaces the default wholesale,
  which is why the fallback is needed at all). Cadre sets neither `wsPort` nor `disableTcp` on
  either node, so the fallback is byte-identical to what the node would have got. The `--ws-port`
  CLI convenience appends into `network.listenAddrs`, so it never reaches the fallback branch.
- **Config plumbing end to end.** `cadre.yaml` → `CliConfigFile` → `network: config.network` in
  `packages/cadre-cli/src/commands/start.ts` → `CadreNodeConfig`. `CADRE_RELAY_ADDRS` hits the
  `_ADDRS` branch of `parseEnvValue` and arrives as an array, not a comma string. The Docker
  entrypoint writes a proper YAML list. Every path reaches the new code.
- **Existing consumers unaffected.** `reference-app-rn` (`listenAddrs: []`, no `relayAddrs`) still
  gets `[]`; `reference-app-web` (`['/p2p-circuit', '/webrtc']`, no `relayAddrs`) is untouched.
- **`enableRelay` does not interact.** It installs the circuit-relay *server*; `relayAddrs`
  reserves a slot on someone else's. Independent knobs.

### Found and fixed in this pass (minor)

- **Log regression from the walker refactor** (`delegate-admission.ts`). Folding
  `circuitRelayTarget` into a throwing walker turned two previously-silent structural cases — an
  addr with no `/p2p-circuit` at all, and a bare `/p2p-circuit` with no relay named — into thrown
  errors caught and logged as `Skipping unparsable relay addr`. Those addrs are neither unparsable
  nor unusual: `circuitRelayTargets()` feeds it every configured listen addr and every live node
  multiaddr, so a plain `/ip4/0.0.0.0/tcp/4001` logged an error string on every delegate-announce
  pass, as did the web reference's bare `/p2p-circuit`. Split into `parseCircuitRelayTarget`
  (returns null when the addr structurally names no relay, throws only on a malformed multiaddr or
  garbage peerId); `circuitRelayTargetOrThrow` converts the null. External behavior identical, one
  walker still.
- **`docs/STATUS.md` claimed `relay?: boolean` was "unused in `createLibp2pNode` today".** Stale —
  it wires `circuitRelayServer(...)` in `libp2p-node-base.ts`. Bullet rewritten and checked off,
  and it now distinguishes running a relay from reserving on one.
- **`packages/cadre-cli/README.md` env table** documented neither `CADRE_LISTEN_ADDRS` nor
  `CADRE_RELAY_ADDRS`. Both added. The table is missing several other variables too
  (`CADRE_IDENTITY_PROTOBUF`, `CADRE_ENABLE_RELAY`, `CADRE_STRAND_FILTER`, `CADRE_PUSH`) —
  pre-existing drift, deliberately not swept here. `CADRE_ANNOUNCE_ADDRS` is left undocumented on
  purpose: it is still read by nobody.

### Found and filed (major)

- **`tickets/fix/14.2-bug-cli-empty-env-overrides-config`** — the CLI treats an environment
  variable that is *set but empty* as a real override, so the shipped
  `docker-compose.yml` line `CADRE_ENABLE_RELAY=${CADRE_ENABLE_RELAY:-}` forces
  `network.enableRelay = false` on every unconfigured container. The Docker default profile is
  `storage`, whose relay default is *true*, so the one profile meant to relay for other peers never
  installs the relay server. Pre-existing and independent of this diff (found while confirming
  `enableRelay` and `relayAddrs` do not interfere), but it is the mirror image of this ticket's bug
  — a value invented rather than ignored — and it silently disables shipped infrastructure.

### Tripwires (parked in code, not ticketed)

- `relay-addrs.ts` → `circuitListenAddr`: an entry carrying components *after* `/p2p-circuit` (a
  full relayed dial address, `…/p2p/<relay>/p2p-circuit/p2p/<someone else>`) validates and is
  listened on verbatim. Only reachable by an operator pasting a peer's relayed address into
  `relayAddrs`. `NOTE:` at the function says to truncate at the `/p2p-circuit` component if that
  paste turns out to be common.
- `relay-addrs.ts` → `DEFAULT_DIRECT_LISTEN_ADDR`: the implementer's `NOTE:` naming db-p2p's
  `libp2p-node.ts` as the source of truth for that default is correct and was left as written.

### Checked, judged not worth acting on

- **Perf of re-resolving.** `circuitRelayTargets()` re-runs `resolveListenAddrs` (and so re-parses
  the multiaddrs) on every delegate-announce and grant-refresh pass. That is a handful of addrs at
  a cadence of half the 30-minute grant TTL. Memoizing would need a sentinel for the legitimate
  `undefined` result and would move the config-validation throw into the constructor; not worth the
  churn.
- **`example.cadre.yaml` stays commented out.** The implement handoff said the example was
  "uncommented"; it is not, and should not be — the placeholder `12D3KooW...` is not a valid peerId
  and now *throws at startup*. Comment text is accurate; no change.

### Known gaps carried forward (not regressions, not newly ticketed)

- **No test proves a reservation is actually held.** Everything here is unit-level over the
  config→options mapping. The end-to-end claim belongs with
  `backlog/strand-network-nat-relay-reachability`, which already owns NAT reachability for strand
  networks; a real-network scenario against `ops/`'s relay stack is the honest confirmation.
- **Behavior when a configured relay is unreachable at startup** (throw / retry / degraded) is
  untested. Worth knowing before recommending `relayAddrs` in a production config.
- **The `StrandInstanceManager` consumer is wired but unasserted.** `strand-instance-manager.spec.ts`
  starts real libp2p nodes and has no `createLibp2pNode` mock — the spec already documents that
  obstacle for the `bootstrapNodes` forwarding assertion, and the same blocks a `listenAddrs` one.
  The resolution itself is covered by `relay-addrs.spec.ts`; only the one-line forwarding is
  uncovered.
- **`network.announceAddrs` is still read by nobody** — `implement/14.1-cadre-announce-addrs-upstream`.
- **`reference-app-web` still reserves relays by hand** —
  `backlog/debt-web-relay-reservation-duplicates-core`.
- **Fixed-port `listenAddrs` still races control and strand nodes onto one port** (EADDRINUSE) — the
  pre-existing `NOTE:` in `strand-instance-manager.ts`, untouched. `relayAddrs`-derived entries are
  circuits and add no port collision.
- `relay-addrs.ts` is not exported from the package index; no consumer outside cadre-core needs it
  yet.

## Validation

- `yarn workspace @serfab/cadre-core build` — clean.
- `yarn workspace @serfab/cadre-core test` — 80 files, 1254 passed, 1 skipped, 0 failed.
- `yarn lint` (repo root) — 0 errors. 6 warnings, all "unused eslint-disable directive" in
  `packages/integration-tests/src/scenarios/zz-scratch-delete-alone.integration.ts`, pre-existing
  and untouched.
