description: Every shared-workspace network a node runs currently copies the main node's port and public-address settings, so a machine configured with a fixed port cannot start any workspace, and workspaces would advertise an address that reaches the wrong endpoint. Give each workspace node its own derived settings.
files: packages/cadre-core/src/strand-instance-manager.ts, packages/cadre-core/src/relay-addrs.ts, packages/cadre-core/src/announce-addrs.ts, packages/cadre-core/src/types.ts, docs/architecture.md
----

## Background

A cadre node runs one **control** libp2p node plus one extra libp2p node **per strand**
(a strand is the per-app shared network/database). `buildStrandRuntime`
(`packages/cadre-core/src/strand-instance-manager.ts:373-460`) builds each strand node
from the *same* `NetworkConfig` block as the control node, so a strand node inherits two
settings that only make sense for one node per machine:

1. **Listen addresses.** A fixed-port entry (`listenAddrs: ["/ip4/0.0.0.0/tcp/4001"]`,
   which is what `cadre-cli`'s example config ships) is bound by the control node first;
   every strand node then races to bind the same port and fails with `EADDRINUSE`.
   There is a `NOTE:` at the spread site (`strand-instance-manager.ts:432-443`).
2. **Announce addresses.** `announceAddrs` / `appendAnnounceAddrs` name the *control*
   node's public address+port. A strand node advertising them sends peers to the control
   node — and with `announceAddrs` (which REPLACES the advertised set, see
   `announce-addrs.ts`) that wrong address is the *only* one the strand node publishes.
   `NOTE:` at `strand-instance-manager.ts:446-457`.

## Decision (resolves the open question in the originating plan ticket)

**A strand node is not separately dialable at a published fixed address. Its
reachability is (a) its ephemeral direct listener with observed addresses, and (b) the
circuit-relay story** (`relayAddrs` → per-relay `<relay>/p2p-circuit` configured
listeners, which strand nodes already inherit correctly — see `relay-addrs.ts:23-27`).

Therefore, derive a strand-node view of `NetworkConfig`:

- **Listen entries: rewrite every explicit non-zero `tcp`/`udp` port to `0`** in
  *direct* (non-circuit) entries, preserving interface/transport choices (`/ws` suffix,
  specific-interface binds). Circuit entries (`…/p2p-circuit`) pass through untouched —
  a port inside a circuit entry is the RELAY's port, not a local bind.
- **`announceAddrs` and `appendAnnounceAddrs`: dropped entirely for strand nodes.** Any
  concrete announce entry names a port, and that port is the control node's.
- Everything else (`relayAddrs`, `transports`, `connectionGater`, `enableRelay`
  handling) inherits unchanged.

Tradeoff, to record as a `NOTE:` at the drop site: a hosted deployment that wants a
strand node reachable at its *own* published public port has no way to say so after
this change — that would need a per-strand network-config surface, which nothing needs
today. Revisit if a hosted/reverse-proxy deployment ever needs direct-dialable strand
nodes.

## Shape

Add a small module (suggested `strand-network-config.ts`) exporting one function that
takes the `NetworkConfig` and returns the strand-node view (or the resolved
listen/announce pieces), unit-testable without libp2p. `buildStrandRuntime` calls it
instead of `resolveListenAddrs(config.network)` + `resolveAnnounceAddrs(config.network)`
directly; delete the two stale `NOTE:` blocks there. Update the
`NetworkConfig.announceAddrs`/`appendAnnounceAddrs` doc comments in `types.ts` (they
currently say "on this node's control node and on every strand node it runs") and the
strand-node paragraph under `docs/architecture.md` → "Reservations are requested
explicitly, not discovered".

## Edge cases & interactions

- `listenAddrs: []` (React Native "cannot listen") must stay `[]` — do not resurrect a
  default direct listener; `resolveListenAddrs` already honors explicit-empty, keep that.
- `/ip4/0.0.0.0/tcp/4001/ws` → `/ip4/0.0.0.0/tcp/0/ws` (rewrite the port, keep `/ws`).
- A hand-written `<relay>/p2p-circuit` entry in `listenAddrs` passes through unchanged
  (its embedded tcp port belongs to the relay).
- Two entries that differ only by port collapse after rewrite — dedupe (first wins,
  matching `relay-addrs.ts`'s `dedupe`).
- Port already `0` or absent: entry unchanged.
- Control-node behavior must be provably untouched (its `resolveListenAddrs(…,
  'search')` / `resolveAnnounceAddrs` calls in `cadre-node.ts` do not go through the new
  helper).
- `resolveAnnounceAddrs` validation still runs for the control node; a malformed
  announce entry must still fail node start even though strand nodes now ignore it.

## TODO

- [ ] New helper module deriving strand-node listen/announce from `NetworkConfig`; unit
      tests covering every edge case above.
- [ ] `buildStrandRuntime` uses it; remove the two stale `NOTE:` blocks; add the
      accepted-tradeoff `NOTE:` about per-strand announce config.
- [ ] Update `types.ts` doc comments + `docs/architecture.md` strand-node paragraph.
- [ ] A spec proving a fixed-port `listenAddrs` config can start control node + two
      strands on one machine (this is the previously-unverified `EADDRINUSE` claim —
      verify it fails before the fix if cheap, then passes).
- [ ] `yarn lint` + affected package tests green.
