description: A party can mark an invitation as "an outside approver must sign off before anyone joins", but the code that would contact that approver is never actually run — so such an invitation simply cannot be used.
prereq: bug-formation-validation-key-never-checked, debt-formation-approval-signature-replayable
files: packages/cadre-core/src/strand-solicitation.ts, packages/cadre-core/src/strand-formation-manager.ts, packages/cadre-core/src/control-formation-recorder.ts, packages/cadre-core/src/control-database.ts
----

# The formation-validation web hook is declared but never called

## What exists today

An invitation to join one of a party's networks can carry a `ValidationUrl` — a web hook the
party wants consulted before the invitation is redeemed. The hook's operator inspects the
joiner's disclosure (who they claim to be, why they want in) and returns a signed approval.
The party keeps the set of keys allowed to give that approval in its control database, and
after `bug-formation-validation-key-never-checked` lands, the database rejects any approval
that does not come from one of them.

## What is missing

Nothing ever asks the hook. Concretely:

- `StrandSolicitationService.validateStrandFormation` is the method that would call the
  `FormationSigner` hook and produce the approval. It is called by nothing outside its own
  unit test — the real formation protocol handler (`strand-formation-manager.ts`) does not
  go through it.
- The two production redemption paths (`ControlFormationUsageRecorder.recordUsage` and
  `provisionAndRecord`) never pass an approval to the control database, even though
  `ControlDatabase.redeemInvitation` / `recordFormationUsage` both accept one.
- No part of the codebase ever contacts a `ValidationUrl` over the network, and neither
  reference app offers a way to enroll an approver key in the first place.

Net effect: an invitation that names a `ValidationUrl` is **unredeemable** through the normal
join flow — the approval-required check fires and there is no approval. Confirmed empirically
(the redemption is rejected with `CHECK constraint failed: Authorized`). Only an invitation
with no `ValidationUrl` works today.

## Why it matters

"Only let people in after my approval service says yes" is the whole point of the feature, and
it is the natural mechanism for gated networks — vetting a joiner against an external
membership list, a payment, a manual review queue. Right now a party that configures it has
silently locked its own invitations rather than gated them, with no error message explaining
why.

## What "done" would look like

- The responder side of a formation request notices the invitation requires approval, sends
  the joiner's disclosure to the `ValidationUrl`, and gets back an approval signature.
- The request to the hook carries everything the approval is bound to, not just the disclosure.
  After `debt-formation-approval-signature-replayable` that is: the invitation token, a
  single-use nonce for this redemption, the network being joined, the joining peer, and the
  disclosure — minted/resolved by the responder *before* it calls the hook, and passed
  unchanged into the redeeming write so the two agree.
- That approval is threaded into the redemption write, so the control database's check passes
  for a legitimately-approved joiner.
- A party has some way to enroll and remove approver keys — the database calls exist
  (`insertValidationKey` / `deleteValidationKey`); no command or UI surfaces them.
- A joiner whose approval is refused, or whose approval service is unreachable, gets a clear
  rejection rather than an opaque constraint failure.
- Open question for whoever picks this up: whether the hook should be contacted by the
  inviting party's node (which owns the trust relationship with the hook) or by the joiner
  (which would let the joiner choose what to send). The first is almost certainly right, but
  it means the party's node makes an outbound HTTP call during formation, which has its own
  reachability and timeout implications worth designing deliberately.
