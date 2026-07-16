----
description: Defense-in-depth the user asked for — refuse the sensitive control-network conversations (waking nodes, replicating the member database) with peers our node does not recognize as authorized, while still letting brand-new nodes through the narrow enrollment path so they can join.
prereq: membership-authorized-predicate-and-gates
files:
  - packages/cadre-core/src/cadre-node.ts (connectionGater passthrough L638; control-node build; protocol handler registration ~L342, gates L446/L457)
  - packages/cadre-core/src/types.ts (network.connectionGater L179-182)
  - packages/cadre-core/src/strand-wake-protocol.ts / strand-addr-protocol.ts (existing per-protocol isAuthorizedMember gates)
  - packages/cadre-core/src/seed-bootstrap.ts (the enrollment/seed protocol that MUST stay open to strangers)
difficulty: hard
----

# Reject unauthorized peers at the door — with an enrollment carve-out

This is the hardening layer the user called for: an outsider "shouldn't even be in the
conversation unless on the whitelist." It is **defense-in-depth, not the primary fix** —
ticket 4 already closes the wake hole at the authorization gate. This ticket shrinks the
attack surface so an unauthorized peer cannot even open the sensitive control-network
protocols (and thus cannot inject rows that replicate). The whitelist it consults is the
same node-local anchor / authorized-member set from tickets 3–4 — consulting the
replicated store here would reproduce the exact pollution the spike found.

## Why it is not a blanket connection deny

A brand-new legitimate member is NOT authorized until it connects and gets enrolled:
the seed-bootstrap protocol (`/sereus/seed/1.0.0`, drones receive seeds with no
authority), invites, and the host accept-phone handshake all require admitting a
not-yet-authorized peer for a NARROW set of protocols. A libp2p connection gater
denies whole connections before protocol negotiation, so it cannot by itself say "allow
seed, deny repo." Therefore the enforcement is **two-layer**:

- **Stream/protocol layer (primary here):** on the sensitive control protocols — the
  Optimystic control-DB repo protocol (`/optimystic/control-<party>/repo/1.0.0`, the
  path an outsider uses to WRITE rows that replicate), plus wake and strand-addr —
  reject an inbound stream whose remote peer is not `isAuthorizedMember`. Wake and
  strand-addr already do this (ticket 4). The NEW surface is gating the control-DB repo
  protocol so an unauthorized peer cannot commit rows into our cohort at all — this is
  what stops the pollution at its source. Investigate whether the repo protocol is
  registered by `@optimystic/db-p2p` (it is, via `createLibp2pNode`) and whether a
  per-stream authz hook is exposed; if not, this may require an optimystic-side seam —
  if so, file that as a `prereq`/sibling optimystic ticket and land the sereus-side
  gating for the protocols we own first.
- **Connection layer (opportunistic):** a `network.connectionGater` that denies inbound
  from peers that are neither `isAuthorizedMember` NOR within an active enrollment window
  (e.g. presenting toward the seed protocol). Keep it permissive enough that enrollment
  and address resolution still work; its value is rejecting known-nothing peers early
  and refusing to *dial* peers we have reason to distrust.

## The enrollment carve-out

Enumerate exactly which protocols a stranger may speak before authorization: the seed
protocol, and whatever the accept-phone / invite handshake needs. Everything else on the
control node requires `isAuthorizedMember`. Document this allowlist in one place so it
cannot silently drift.

## Edge cases & interactions

- **Do not break enrollment.** The push-wake replication-backed scenario and the
  formation e2e both enroll members over the wire — they must stay green. Run them.
- **Do not break address resolution / push fan-out.** Those consult the addressable
  surface and dial peers that may not be authorized-from-our-view yet; ensure the gater
  does not block the resolve/dial path. `resolvePeerAddrs` is used to REACH a peer, not
  to trust it.
- **Relay/transit.** A row can still reach us via a hub we trust even if we gate our own
  inbound — the connection gater cannot fully stop replication (that is why ticket 4's
  read-time predicate is the real fix). Gating the repo protocol on OUR node stops
  *others* pulling unauthorized writes *from us* and stops an outsider writing *to* us
  directly; state this boundary honestly in the handoff.
- **Optimystic seam risk.** If gating the control-DB repo protocol needs an upstream
  hook that does not exist, land the protocols we own, and file the optimystic-side
  work as a sibling ticket rather than half-implementing a parser/interception.

## TODO

- Define the stranger-allowlist (seed + enrollment protocols) in one referenced place.
- Add per-stream `isAuthorizedMember` gating to the control-DB repo protocol (or file
  the optimystic seam ticket if no hook exists) — the pollution-at-source surface.
- Add a `network.connectionGater` that denies known-unauthorized inbound while preserving
  enrollment + resolve/dial; wire it into the control node build.
- Tests: an unauthorized peer cannot open the repo/wake/strand-addr protocols; a
  mid-enrollment stranger CAN complete seed/accept-phone; enrollment + formation e2e stay
  green.
- `yarn lint` / `yarn typecheck` / cadre-core + integration suites green (stream long
  runs with `tee`).
