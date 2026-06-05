----
description: The libp2p strand-formation protocol does not thread the redeemed invite token to the provisioner, never writes the FormationUsage consent record on the wire, and OpenInvitation carries no strand id — so a pure formStrand() round-trip cannot record consent or return the host's actual closed strand
files: packages/cadre-core/src/strand-formation-manager.ts, packages/cadre-core/src/strand-solicitation.ts, packages/cadre-core/src/strand-formation-protocol.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/control-formation-recorder.ts, packages/cadre-core/src/types.ts
----

## Problem

The consent path delivered by `formationinvite-fix-curve-and-wire-consent` is
functional at the **ControlDatabase** layer (`insertFormationInvite`,
`recordFormationUsage`, `redeemInvitation`, `ControlFormationUsageRecorder`) and
is exercised by the integration harness (`test-network.ts`
`createInvitation`/`joinStrand`, which call those DB methods directly). But the
**libp2p formation protocol** that `CadreNode.formStrand()` actually drives does
not connect to it end-to-end. Three concrete gaps, discovered while building the
RN closed-strand consent demo (`reference-app-rn-closed-strand-consent-demo`):

1. **Token not threaded to the provisioner.** `StrandFormationManager`'s
   responder path (`provisionAsResponder`) calls
   `strandProvisioner.provisionStrand('', initiatorPartyId, this.partyId)` — note
   the empty `sAppId` (see also the backlogged
   `formation-provision-sappid-not-threaded`) AND the absence of the invitation
   **token**. The provisioner therefore cannot redeem the specific invite (it has
   nothing to key `redeemInvitation`/`recordFormationUsage` on).

2. **FormationUsage consent record never written on the wire.** The
   `FormationListener` responder validates the token and provisions, but nothing
   in the protocol flow calls `recordUsage` / `recordFormationComplete`. So a real
   `formStrand` round-trip leaves **no `FormationUsage` row** — the consent record
   that is supposed to authorise the join (and that the harness writes by hand).
   `validateStrandFormation` + `recordFormationComplete` exist on
   `StrandSolicitationService` but are not invoked by the manager's listener.

3. **`OpenInvitation` carries no strand id.** `OpenInvitation` is `{ token,
   sAppId, expiration, bootstrap }`. In a provision-then-record model the invitee
   needs to know *which* strand to attach; in the responder-provisions model the
   responder must return its real strand, but `provisionAsResponder` currently
   fabricates a placeholder strand id when no provisioner is wired (and even with
   one, returns whatever the provisioner makes, not a pre-existing host strand).
   The integration harness works around this with `TestOpenInvitation` (adds
   `strandId`); the RN reference app works around it with an out-of-band envelope
   carrying `{ invitation, strandId, memberPrivateKey }`.

Net effect: `formStrand()` today validates the invite **token** (consent gate)
but does not record consent, does not provision/return the host's actual closed
strand, and cannot by itself tell the invitee which strand to join. The RN
reference app papers over (2)/(3) with the out-of-band envelope and documents the
gap; this ticket should close it in cadre-core so a pure `formStrand` handshake
is sufficient.

## Expected behavior

A single `formStrand(invitation, disclosure)` call over libp2p, against a host
that minted + published the invite, should:

- thread the invitation **token** (and `sAppId`) through to the responder's
  provisioner/recorder,
- write a `FormationUsage` consent record for the redeemed token (using
  `recordFormationUsage` against a pre-existing host strand, or `redeemInvitation`
  for consent-creates-strand — the design must **pick one model explicitly** and
  document it, resolving the consent-creates-strand vs provision-then-record
  ambiguity flagged in the consent-wiring review),
- return a `FormStrandResult` whose `strandId` is the host's **actual** strand
  (so the invitee can attach it), with the membership key delivered through the
  protocol rather than out of band,
- enforce single-use / `TotalUses` and expiry via the
  `ControlFormationUsageRecorder` already wired as the responder's
  `formationUsageRecorder`.

## Specifications / requirements

- Decide and document the provisioning model (provision-then-record vs
  consent-creates-strand). The reference app and harness currently lean
  provision-then-record (host owns the strand; invitee records usage), so that is
  the likely target.
- Extend the formation protocol message/result types as needed to carry the
  strand id + membership key from responder to initiator (so `OpenInvitation`
  and/or the formation result conveys the host's strand). Avoid a half-baked
  parser — extend the existing `strand-formation-protocol` message shapes.
- Wire the responder to record the `FormationUsage` consent row as part of a
  successful formation (the missing `recordFormationComplete` call), keyed by the
  threaded token.
- Add a cadre-core test that drives a responder with a real
  `ControlFormationUsageRecorder` + provisioner and asserts a `formStrand` (or its
  manager-level equivalent) (a) validates the token, (b) writes exactly one
  `FormationUsage` row, (c) returns the host's strand id. The libp2p two-node leg
  may stay in `integration-tests` (not agent-runnable); the DB-effects assertions
  should be unit-testable against the in-memory control DB.
- Once landed, simplify the RN reference app: drop the out-of-band
  `ClosedStrandInvite` envelope (`encodeClosedStrandInvite`/`decodeClosedStrandInvite`
  in `chat-strand.ts`) in favor of `encodeInvitation` + the `FormStrandResult`,
  and update the README "Trust model / closed strands" boundary notes.

## References

- `packages/cadre-core/src/strand-formation-manager.ts:218-233` —
  `provisionAsResponder` (empty `sAppId`, no token, placeholder strand id).
- `packages/cadre-core/src/strand-solicitation.ts:282-371` —
  `validateStrandFormation` + `recordFormationComplete` (exist, not invoked by the
  manager listener).
- `packages/cadre-core/src/control-formation-recorder.ts` — the DB-backed
  recorder (`recordUsage` → `redeemInvitation`).
- `packages/integration-tests/src/harness/test-network.ts:130-198` —
  `createInvitation`/`joinStrand` (the canonical DB-level consent flow + the
  `TestOpenInvitation` strand-id workaround).
- `tickets/complete/formationinvite-fix-curve-and-wire-consent.md` — the consent
  path this builds on (and its "consent-creates-strand vs provision-then-record"
  note).
- `tickets/backlog/formation-provision-sappid-not-threaded.md` — the related
  empty-`sAppId` gap (same call site).
