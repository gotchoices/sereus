---
description: Two node network settings — the addresses a node advertises to others, and the relay addresses it should use — can be set in config and via environment variables, are documented in the example config file, and are silently ignored.
files: packages/cadre-core/src/types.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-cli/src/config/types.ts, packages/cadre-cli/example.cadre.yaml, packages/cadre-cli/docker/entrypoint.sh
---

# Announce and relay addresses are accepted but never used

## What an operator sees

A cadre node's network settings include two address lists:

- **announce addresses** — the addresses a node tells other peers to reach it on. A node behind
  NAT, or one fronted by a DNS name and a forwarded port, listens on one address and must be
  *reachable* at a different one; the announce list is how you say so.
- **relay addresses** — the circuit-relay servers a node should reserve a slot on so that peers
  which cannot dial it directly can still reach it through a relay.

Both are settable three ways today, all of which look supported:

- in `cadre.yaml` under `network:` — `packages/cadre-cli/example.cadre.yaml` lines 49-52 show them
  as commented-out examples;
- via the environment variables `CADRE_ANNOUNCE_ADDRS` and `CADRE_RELAY_ADDRS`
  (`packages/cadre-cli/src/config/types.ts:102-103`);
- via the Docker entrypoint, which writes both into the generated config
  (`packages/cadre-cli/docker/entrypoint.sh:70,77`).

Setting any of them has **no effect whatsoever**. The value is parsed, validated, carried through
two config types, and then read by nobody.

## Where the chain stops

`NetworkConfig` declares both fields (`packages/cadre-core/src/types.ts:144-145`), but
`CadreNode.buildControlNodeOptions()` — the one place a node's config becomes libp2p node options —
never reads them. Nor does the strand-node path. A repo-wide search finds no consumer of either
field outside the type declarations and one config-shape test.

Underneath, `@optimystic/db-p2p`'s `NodeOptions` has no announce-address or relay-address option
either, so this is not a one-line forwarding fix — libp2p's address manager (`announce` /
`appendAnnounce`) and the circuit-relay reservation step would need to be reachable from that
factory first, or Sereus would need to perform the reservation itself after the node is up.

## Why it matters

The self-hosted deployments these settings exist for are exactly the ones behind NAT. An operator
who sets `CADRE_ANNOUNCE_ADDRS` to their DDNS name and forwarded port gets a node that still
advertises its LAN address and is unreachable, with nothing in the logs suggesting the setting was
ignored. The documented, environment-variable-settable, Docker-plumbed nature of these fields makes
that a reasonable thing to try.

Note that `@serfab/cadre-host` solves the same problem a different way for *invites* only, via
`NetworkConfig.inviteAddressResolver` (a NAT service supplies the externally-reachable addresses,
which are then embedded in invite payloads). That path works and is unrelated to this bug — but it
covers only the addresses written into invites, not the addresses the node announces on the wire.
Reference `packages/reference-app-web/src/lib/cadre-web.ts` for the third variant: it does relay
reservation by hand, dialing relays and listening on `/p2p-circuit` itself rather than through any
config field. Any fix should decide whether these three become one mechanism.

## Decisions a fix has to make

- Wire the fields through (which needs upstream `@optimystic/db-p2p` support for announce addresses
  and relay reservation), **or** delete them from `NetworkConfig`, the CLI config type, the env-var
  map, the example YAML, and the Docker entrypoint so nothing advertises a capability that is not
  there. Deleting is cheap and honest; wiring is what an operator behind NAT actually wants.
- Whether the relay-address list should subsume the hand-rolled reservation loop in
  `reference-app-web`, and whether announce addresses should subsume or be fed by
  `inviteAddressResolver`.

Found while writing option-wiring tests for the control network
(`debt-cadre-node-control-network-wiring-test`); that ticket deliberately does not assert the
current no-op behaviour, so nothing pins it in place.
