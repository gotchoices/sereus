description: RN closed-strand demo simplified — out-of-band ClosedStrandInvite envelope removed in favor of a single encodeInvitation code + protocol-delivered FormStrandResult.memberPrivateKey, with the strandId-bound FormationInvite threading consent end-to-end. Reviewed and completed.
files: packages/reference-app-rn/src/chat-strand.ts, packages/reference-app-rn/src/use-cadre.ts, packages/reference-app-rn/src/cadre-phone.ts, packages/reference-app-rn/README.md
----

## Summary

The cadre-core gap (`formstrand-protocol-thread-consent-and-provision`) is closed, so a
pure `formStrand` round-trip now resolves the host strand bound to the invite, writes the
`FormationUsage` consent row over libp2p, and returns the host's real `strandId` +
`memberPrivateKey` in `FormStrandResult`. The RN reference app's out-of-band workaround
was removed accordingly:

- **chat-strand.ts** — deleted the `ClosedStrandInvite` interface + `encode/decodeClosedStrandInvite`
  and their now-unused imports (`OpenInvitation`, `uint8arrays`). `joinClosedChatStrandFromFormation`
  now reads `formResult.memberPrivateKey` (the protocol-delivered read-gating secret) instead
  of the wrong `invitePrivateKey`, and throws loudly when the key is absent.
- **use-cadre.ts** — `createClosedStrandWithInvite` binds the invite to the strand via
  `publishFormationInvite({ strandId })` and returns `encodeInvitation(invitation)` directly;
  `joinViaInvite` decodes the plain `OpenInvitation`, runs `formStrand`, and attaches via
  `joinClosedChatStrandFromFormation`. Doc comments updated.
- **cadre-phone.ts** — `publishFormationInvite` wrapper accepts `strandId`; responder
  init/caveat comments updated to reflect the closed loop.
- **README.md** — Trust-model pillars + on-the-wire-consent boundary note rewritten; the
  former gap is marked closed.

## Review findings

### Verified against cadre-core (the change's load-bearing dependency)
The RN code consumes three cadre-core surfaces; all three are present and behave as the
RN code assumes:
- `FormStrandResult.memberPrivateKey` exists and is documented as the closed-strand
  read-gating secret, distinct from `invitePrivateKey` (types.ts:405-419). ✔
- `publishFormationInvite(token, sApp, { strandId })` accepts `strandId` and persists it
  on the `FormationInvite` row (cadre-node.ts:1006-1026). ✔
- The provision-then-record path resolves the bound strand's `MemberPrivateKey` and
  returns it: `provisionAsResponder` → `recorder.resolveStrand(token)` →
  `strand.MemberPrivateKey` (strand-formation-manager.ts:236-252,
  control-formation-recorder.ts:85-97). ✔
The strandId-binding linchpin (`FormationInvite.StrandId` → resolveStrand → host's
`MemberPrivateKey`) is sound.

### Correctness of the wrong-field fix
Confirmed `invitePrivateKey` is never the member key on any path — `''` on the manager's
`dialFormation` path (strand-formation-manager.ts:173) and the initiator's own signing
key on the solicitation-service path (strand-solicitation.ts:265). The prior RN code
(`MemberPrivateKey: formResult.invitePrivateKey`) was genuinely wrong; the fix to
`memberPrivateKey` + the loud throw on absence is correct.

### Dead-code / leftover references
- grep across `packages/reference-app-rn` (excluding README): **no** remaining importers
  or references to `ClosedStrandInvite` / `encodeClosedStrandInvite` /
  `decodeClosedStrandInvite` / `envelope`. ✔ `app/settings.tsx` only calls the hook
  methods and renders the base64url code — unaffected.
- `CreateClosedStrandResult.memberPrivateKey` is no longer destructured by callers but is
  retained as a sensible part of the create API (the host legitimately knows its own key).
  Not a finding.

### Docs
Read every touched file's docs + the README section. The README Trust-model rewrite
(pillars 1-3 + the on-the-wire boundary note) accurately reflects the new single-code +
protocol-delivered-key reality and correctly marks the former gap closed. cadre-phone.ts
responder comment and the `joinClosedChatStrandFromFormation` JSDoc match the implemented
behavior. Docs are current. ✔

### Lint + typecheck (required — both pass)
- Rebuilt `@serfab/cadre-core` (RN type-checks against its built `dist/`, not source),
  then `yarn workspace @serfab/reference-app-rn typecheck` — **exit 0, no errors**.
- `npx eslint src/chat-strand.ts src/use-cadre.ts src/cadre-phone.ts` — **exit 0, clean**.

### Tests
No RN unit tests exist for `chat-strand` in this package, so the new throw path in
`joinClosedChatStrandFromFormation` is exercised only manually (two-device). The
end-to-end consent loop over real libp2p is covered by cadre-core specs
(`strand-formation-consent.spec.ts`, `control-formation-invite.spec.ts`) and the
integration suite, neither agent-runnable on a single device (left to CI per ticket).
Adding RN-level unit coverage for the throw path is reasonable but low-value (thin
wrapper over an `if`); not filed. **Empty category note:** no new automated tests were
added in this pass because the change is a deletion + field-swap whose behavior is
guarded by the typechecker and verified by cadre-core's existing consent specs — there
is no agent-runnable test seam at the RN layer.

### Integration harness (deliberately untouched — confirmed correct)
The implementer's choice to leave `TestOpenInvitation.strandId` in place is correct: the
harness's `joinStrand` uses `invitation.strandId` to locate the inviting party's
`ControlDatabase`; removing it would force a blind cross-party `queryFormationInvite`
scan. The RN change does not touch the harness. ✔

### Major finding → filed as a new ticket (NOT fixed here, out of RN scope)
The **web** reference app has the identical wrong-field bug this ticket fixed for RN:
`packages/reference-app-web/src/lib/cadre-web.ts:474` attaches the formed closed strand
with `result.invitePrivateKey` as `MemberPrivateKey` (the comment even mislabels it "the
responder-minted member key"). Confirmed against the same cadre-core types that make the
field wrong on every path. Filed `tickets/fix/reference-app-web-closed-strand-wrong-member-key.md`
with repro + a note to decide the intended web host flow (bind `strandId` vs.
responder-provisions) rather than blindly swap the field.

### Disposition
Implementation is correct, internally consistent with cadre-core, documented accurately,
and lints/typechecks clean. No minor findings required inline fixes. One major finding
(web parallel bug) filed as a fix ticket. Done.
