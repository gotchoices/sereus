----
description: Let a friend's phone that is NOT on the same machine or LAN actually reach a home cadre-host across the internet to request a node — today that request path only works same-machine.
files: packages/cadre-host/src/donation/, packages/cadre-host/src/nat/nat-service.ts, packages/cadre-host/src/server/, docs/cadre-host.md
----

# WAN reachability for the node-donation request surface

## What this is

The node-donation realignment (`implement/1-donation-grant-tokens` →
`4-donor-docs-and-integration`) builds the full donate-a-node lifecycle, but its
grant request surface (`/grants`) is deliberately **loopback-only** in v1 — a friend's
phone can only reach it if it's on the same machine or (with a future bind change) the
same LAN. For the real target user — a friend on their phone, on the far side of the
internet, asking your basement PC for a node — the request has to cross NAT to a
residential box. That last hop is unbuilt and is the point of this ticket.

This mirrors an existing deferral: cadre-host's trust-circle redemption is already
documented as localhost-only in v1, with cross-WAN redemption parked for "a future
cadre-host-over-P2P ticket." This ticket is that work, generalized to the donation
surface.

## Why it was deferred, not decided

There are two materially different architectures, and the choice is a product +
security-posture call worth making deliberately rather than defaulting into:

**Option A — NAT-mapped public HTTP(S) port.** Reuse the existing `NatService`
(UPnP/NAT-PMP port mapping + DuckDNS) to expose the `/grants` surface on a public
port; the phone hits `https://foo.duckdns.org:PORT/grants/...` with its grant token as
bearer.
- Pro: closest to cadre-provider (which is literally a public HTTPS API); the grant
  surface already exists; smallest new concept.
- Con: opens a *second* public attack surface on a residential box (beyond the libp2p
  port); needs TLS on a machine with no real cert story (self-signed + fingerprint
  pinning carried in the grant token, or ACME against the DuckDNS name); CGNAT hosts
  can't port-map at all.

**Option B — libp2p broker protocol (recommended).** Carry the grant request as a
request/response protocol over libp2p to an always-on host-side node (the opt-in
own-cadre owner node, or a minimal dedicated listener). The grant token carries the
broker's peerId + dialable multiaddrs (exactly as a trust-circle invite already
carries `ownerAddrs`). The broker validates the grant and calls the manager's loopback
donation API to provision; peer-info and seed delivery ride back over the same libp2p
stream.
- Pro: **libp2p dialability to host-side nodes is already mandatory** — the donated
  node must be dialable by the requester's cadre over libp2p through the host's NAT
  mapping regardless, so this reuses the exact transport already required and opens **no
  new** public surface or TLS story; architecturally consistent with the p2p system;
  the grant token naturally extends the existing invite/`ownerAddrs` machinery; works
  through relays where raw port-mapping (Option A) fails on CGNAT.
- Con: needs a new request/response libp2p protocol in cadre-core (the donation
  lifecycle as a wire protocol, not just an HTTP shape); more upfront design.

**Recommendation: Option B.** The decisive argument is that the donated node's libp2p
reachability is a hard requirement of the donor model anyway (see the coupled concern
below) — given that transport must exist, routing the *request* over it too avoids a
whole second (HTTP+TLS-over-NAT) surface. Confirm with the project owner before
building, since it adds a cadre-core protocol and sets the pattern for
"cadre-host-over-P2P" generally.

## Coupled concern: per-donated-node NAT mapping

Independent of which option is chosen, a donated node serving a *remote* requester must
itself be **dialable by the requester's cadre** over libp2p — the requester's existing
cadre nodes dial the newly donated node to sync. Today `NatService` maps a port for a
single host-owned owner node only (`getPeerId`/`getMultiaddrs` bound to that one node).
The donor model needs a p2p port mapping **per donated node** (source-plan edge case:
"p2p port mapping per node, not just for the single authority node the NatService
currently serves"). This is why the v1 donor path is loopback/LAN-only. This ticket
(or a `prereq:` split off it) must extend NAT mapping to donated nodes.

## Scope when picked up

- Decide Option A vs B with the project owner (recommendation: B).
- Extend the grant token to carry whatever reach info the chosen transport needs
  (broker peerId+multiaddrs for B; public host:port + cert fingerprint for A).
- Per-donated-node NAT/relay reachability so remote requester cadres can dial the
  donated node.
- Relay fallback for CGNAT (ties into `backlog/4-relay-bootstrap-infrastructure`).
- Update the loopback-only caveat in `docs/cadre-host.md` once real WAN works.
