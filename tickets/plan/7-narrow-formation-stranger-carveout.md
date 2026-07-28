----
description: The new "don't let unknown devices connect to us" protection is switched off on the phone app, because that app always turns on the feature for meeting new people — so in practice unknown devices can still connect. Narrow the exemption so it only applies while the device is actually expecting a stranger.
prereq: membership-connection-gater
files:
  - packages/cadre-core/src/cadre-node.ts (admitInboundControlConnection check 4; initializeStrandSolicitation; formStrand / createOpenInvitation lazy init)
  - packages/cadre-core/src/strand-solicitation.ts (StrandSolicitationService, FormationUsageRecorder seam)
  - packages/cadre-core/src/membership-connection-gater.ts (module doc — the stranger allowlist lives here)
  - packages/reference-app-rn/src/cadre-phone.ts (initializeFormationResponder — called unconditionally at node bring-up)
  - packages/reference-app-web/src/lib/cadre-web.ts (ensureSolicitation — lazy, but permanent once used)
  - packages/cadre-core/test/membership-connection-gater.spec.ts (decision-matrix tests)
difficulty: medium
----

# Narrow the strand-formation exemption in the control-network connection gate

## Background, in plain terms

A cadre node now refuses inbound control-network connections from devices it can
positively tell are not authorized members (`membership-connection-gater.ts`,
wired in `CadreNode.createControlNode`). Because a libp2p connection gater
decides per *connection* — before any protocol is negotiated — the policy has to
admit a connection whenever some legitimate stranger conversation *could* be
riding it. One of those exemptions is: "this node has a strand-formation
responder registered, so strangers are expected."

Strand formation is how two *different* parties agree to share a strand. The
inviting side publishes an open invitation and the joining side dials in — a
genuine stranger. So the exemption is correct in principle.

## The problem

The exemption is currently "a responder object exists", which is a **permanent,
process-lifetime** condition, not "a stranger is expected right now":

- `CadreNode.initializeStrandSolicitation()` sets `strandSolicitationService`
  and it is only cleared by `stop()`.
- `reference-app-rn` (`initializeFormationResponder`) calls it **unconditionally
  during node bring-up**, before any invitation exists. So on the phone
  reference app the stranger exemption is open from the first second of every
  run, and the connection gate never denies anyone.
- `reference-app-web` (`ensureSolicitation`) calls it lazily on the first
  formation action — but once called, the exemption is open for the rest of the
  process too.
- `CadreNode.formStrand` and `CadreNode.createOpenInvitation` also lazily
  initialize the service. `formStrand` is the **initiator** side: it dials out
  and needs no inbound stranger admission at all, yet it currently opens the
  exemption just the same.

Net effect: the connection-layer defense that shipped is inert on the primary
client. The read-time voucher predicate and the per-stream gates (chain steps
4–5) still hold — nothing is *unsafe* — but the defense-in-depth layer buys
nothing where it matters most.

## What we want

The exemption should track *expectation of a stranger*, not *capability to serve
one*. Desired behavior:

- A node admits not-yet-authorized inbound peers on formation grounds only while
  it has at least one **unexpired open invitation outstanding** — i.e. an
  invitation it minted (or was configured to honor) that has not expired and has
  not been consumed.
- With no outstanding invitation, a registered responder alone must NOT suspend
  stranger denial. A stranger that dials anyway is refused at the connection
  layer; the formation protocol itself remains the trust decision for anyone
  admitted.
- Initiating formation (`formStrand`) must not open the exemption. Dialing out is
  never gated; the initiator has no reason to accept unknown inbound peers.
- Registering the responder must stay safe to do eagerly at startup — clients
  should not have to choose between "wire the responder early" and "keep the
  gate armed". Once this lands, `reference-app-rn`'s unconditional
  `initializeFormationResponder` becomes correct rather than gate-defeating.

## Why this needs design, not just an edit

The information needed ("is any open invitation outstanding?") is not available
to `StrandSolicitationService` today. Invitation records live behind the
injected `FormationUsageRecorder` seam — in the reference apps that is
`ControlFormationUsageRecorder` over the `CadreControl.FormationInvite` /
`FormationUsage` tables — and a service constructed with no recorder (the lazy
path) has no invitation state at all. So the design has to settle:

- where outstanding-invitation state lives (a registry inside
  `StrandSolicitationService`, a query added to the recorder seam, or both),
- what a service with **no** recorder should report (it accepts every token
  blindly today — arguably it should not open the exemption either),
- whether invitations minted before a restart should still hold the exemption
  open (parallels the in-memory enrollment window's restart behavior, see the
  step-6 review findings),
- how the responder's own token check and the connection gate stay consistent so
  a peer is not admitted by one and refused by the other in a confusing order.

## Acceptance

- A node with a registered formation responder and no outstanding invitation
  denies an unauthorized inbound peer.
- The same node, after minting an open invitation, admits it; after the
  invitation expires or is consumed, denies again.
- An initiator-only node (`formStrand` path, never minted an invitation) denies
  unauthorized inbound peers.
- Existing cross-party formation end-to-end coverage
  (`strand-formation-e2e` phases 1/3/4) still passes unchanged.
- `membership-connection-gater.ts`'s module doc — the single documented place
  for the stranger allowlist — describes the narrowed condition.
