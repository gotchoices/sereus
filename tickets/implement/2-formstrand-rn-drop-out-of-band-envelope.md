description: Simplify the RN closed-strand consent demo now that formStrand() records consent and returns the host's real strand id + membership key — drop the out-of-band ClosedStrandInvite envelope in favor of encodeInvitation + FormStrandResult, and update the README trust-model boundary notes.
prereq: formstrand-protocol-thread-consent-and-provision
files: packages/reference-app-rn/src/chat-strand.ts, packages/reference-app-rn/src/use-cadre.ts, packages/reference-app-rn/src/cadre-phone.ts, packages/reference-app-rn/README.md, packages/integration-tests/src/harness/test-network.ts, packages/integration-tests/src/harness/types.ts
effort: high
----

## Goal

With the cadre-core gap closed (prereq
`formstrand-protocol-thread-consent-and-provision`), a pure `formStrand` handshake now
records the `FormationUsage` consent row over libp2p and returns the host's actual
`strandId` + `memberPrivateKey` in the `FormStrandResult`. Remove the RN reference app's
out-of-band workaround that exists only because that round-trip used to be incomplete.

## Changes

### RN app — drop the out-of-band envelope

`packages/reference-app-rn/src/chat-strand.ts`:
- Delete the `ClosedStrandInvite` interface and `encodeClosedStrandInvite` /
  `decodeClosedStrandInvite` (`chat-strand.ts:236-295`) — the strand id + membership key
  no longer travel out of band.
- Update `joinClosedChatStrandFromFormation` (`chat-strand.ts:205-210`) to read the
  membership key from `formResult.memberPrivateKey` (the new protocol-delivered field),
  not `formResult.invitePrivateKey` (which is the initiator's generated signing key — the
  current code uses the wrong field; it only "worked" because this helper was unused).

`packages/reference-app-rn/src/use-cadre.ts`:
- `createClosedStrandWithInvite` (`use-cadre.ts:196-208`): when the host mints the
  invite, **bind it to the strand** by passing the new `strandId` option through to
  `publishFormationInvite` (→ `insertFormationInvite`'s new `strandId`). Return
  `cadreNode.encodeInvitation(invitation)` directly — no `encodeClosedStrandInvite`
  envelope.
- `joinViaInvite` (`use-cadre.ts:214-227`): decode with `decodeInvitation`, call
  `formStrand(invitation, disclosure)`, then attach via
  `joinClosedChatStrandFromFormation(current, formResult)` using the strand id +
  membership key the result now carries — drop the `decodeClosedStrandInvite` /
  `invite.strandId` / `invite.memberPrivateKey` plumbing.
- Verify `publishFormationInvite` (wherever it is defined in the RN app) forwards the
  `strandId` option to `ControlDatabase.insertFormationInvite`.

`packages/reference-app-rn/src/cadre-phone.ts`:
- Update the `initializeFormationResponder` comment (`cadre-phone.ts:122-152`) — the
  "does not yet thread the redeemed token to a provisioner nor write the FormationUsage
  consent record on the wire" caveat is now resolved; state that the responder records
  consent on a successful `formStrand`.

### README — trust-model boundary notes

`packages/reference-app-rn/README.md` (`## Trust model / closed strands`, ~lines
159-210): rewrite the "out-of-band envelope" description and the "Closing that gap …"
follow-up note to reflect that `formStrand` now (1) records the `FormationUsage` consent
record over libp2p and (2) returns the host's real strand id + membership key, so the
invite is delivered as a single `encodeInvitation` code with no side-channel envelope.

### Integration harness (optional cleanup)

`packages/integration-tests/src/harness`: the `TestOpenInvitation.strandId` workaround
(`test-network.ts:156-166`, type in `harness/types.ts`) exists for the same missing
invite→strand binding. The harness `createInvitation`/`joinStrand` still exercise the
**DB-level** consent flow directly (not the libp2p protocol) and may keep `strandId` for
convenience — but if `insertFormationInvite` now persists `strandId`, prefer recording it
on the invite row and reading it back via `queryFormationInvite` rather than carrying it
on the test struct. Make this change only if it stays clean; otherwise leave the harness
as-is and note why.

## Validation

- `yarn workspace @serfab/reference-app-rn typecheck` (RN app compiles against the new
  `FormStrandResult.memberPrivateKey` + `encodeInvitation`/`decodeInvitation` flow).
- Lint the changed RN files (no new warnings).
- Do not run the multi-node integration suite (not agent-runnable); note for CI.

## TODO

- [ ] Remove `ClosedStrandInvite` + `encode/decodeClosedStrandInvite` from
      `chat-strand.ts`; fix `joinClosedChatStrandFromFormation` to use
      `formResult.memberPrivateKey`.
- [ ] Simplify `use-cadre.ts` `createClosedStrandWithInvite` (bind strandId on the
      invite, return `encodeInvitation`) and `joinViaInvite` (decode + `formStrand` +
      `joinClosedChatStrandFromFormation`).
- [ ] Confirm `publishFormationInvite` forwards the `strandId` option.
- [ ] Update the `cadre-phone.ts` responder comment.
- [ ] Update the README trust-model / closed-strands section.
- [ ] (Optional) Drop `TestOpenInvitation.strandId` in favor of the persisted invite
      binding if it stays clean.
- [ ] RN typecheck + lint; leave the integration suite for CI.
