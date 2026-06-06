description: Review the RN closed-strand demo simplification — the out-of-band ClosedStrandInvite envelope was removed in favor of a single encodeInvitation code + FormStrandResult.memberPrivateKey (protocol-delivered), with the strandId-bound FormationInvite threading consent end-to-end.
files: packages/reference-app-rn/src/chat-strand.ts, packages/reference-app-rn/src/use-cadre.ts, packages/reference-app-rn/src/cadre-phone.ts, packages/reference-app-rn/README.md
----

## What changed

The cadre-core gap (`formstrand-protocol-thread-consent-and-provision`) is closed: a
pure `formStrand` round-trip now (1) resolves the host strand bound to the invite,
(2) writes the `FormationUsage` consent row over libp2p, and (3) returns the host's
real `strandId` + `memberPrivateKey` in `FormStrandResult`. The RN reference app's
out-of-band workaround is removed accordingly.

### `chat-strand.ts`
- **Deleted** the `ClosedStrandInvite` interface and `encodeClosedStrandInvite` /
  `decodeClosedStrandInvite` — strand id + membership key no longer travel out of band.
- Dropped now-unused imports (`OpenInvitation`, `uint8arrays` to/from helpers).
- **Fixed** `joinClosedChatStrandFromFormation` to read `formResult.memberPrivateKey`
  (the protocol-delivered read-gating secret) instead of `formResult.invitePrivateKey`
  (the initiator's own signing key — the prior code was wrong; the helper was unused so
  it never surfaced). Added a loud throw when `memberPrivateKey` is absent (host strand
  not closed / no provisioned key) rather than attaching with a key that cannot read.

### `use-cadre.ts`
- `createClosedStrandWithInvite`: binds the invite to the strand by passing
  `{ strandId }` to `publishFormationInvite`, and returns `current.encodeInvitation(invitation)`
  directly (no envelope). No longer destructures the host member key (unused — the
  responder resolves it from the published `Strand` row at redemption).
- `joinViaInvite`: decodes with `current.decodeInvitation`, calls `formStrand`, then
  `joinClosedChatStrandFromFormation(current, formResult)` — dropped the
  `decodeClosedStrandInvite` / `invite.strandId` / `invite.memberPrivateKey` plumbing.
- Updated the `UseCadreResult` doc comments (envelope → single OpenInvitation code).

### `cadre-phone.ts`
- `publishFormationInvite` wrapper: added `strandId` to the options type (it previously
  omitted it, which is what blocked the `use-cadre.ts` typecheck) + a doc note on
  provision-then-record.
- `initializeFormationResponder` comment: the "does not yet thread the redeemed token
  to a provisioner nor write the FormationUsage consent record on the wire" caveat is
  resolved — now states the responder provisions the bound strand and records consent
  on a successful `formStrand`.

### `README.md` (Trust model / closed strands)
- Rewrote pillars 1–3 and the "on-the-wire consent handshake" boundary note: invite is
  now a single `encodeInvitation` code; strand id + membership key are delivered by the
  protocol after consent; the former gap is marked closed.

## Validation performed

- `yarn workspace @serfab/reference-app-rn typecheck` — **passes** (after rebuilding
  `@serfab/cadre-core` so the RN app type-checks against the new
  `FormStrandResult.memberPrivateKey` + `publishFormationInvite({ strandId })` .d.ts).
  Note: RN type-checks against cadre-core's built `dist/`, not source — a stale dist
  shows phantom "property does not exist" errors. `dist` is gitignored.
- `npx eslint` on the three changed `.ts` files — **clean**, no new warnings.

## What to scrutinize / known gaps

- **Multi-node integration suite NOT run** (not agent-runnable per ticket; leave for CI).
  The end-to-end consent loop (two reachable nodes, real `formStrand` over libp2p) is
  exercised only by the integration tests + cadre-core specs
  (`strand-formation-consent.spec.ts`, `control-formation-invite.spec.ts`), not on a
  single device. Reviewer: confirm CI covers the bound-invite provision-then-record path.
- **Integration harness left as-is (deliberate).** The ticket flagged optionally dropping
  `TestOpenInvitation.strandId` in favor of the now-persisted invite→strand binding.
  Rejected as not-clean: the harness's `joinStrand` uses `invitation.strandId` to locate
  the inviting party's `ControlDatabase` (`strandId` → `this.strands` → `inviterPartyId`).
  Removing it would force a blind cross-party `queryFormationInvite` scan with no way to
  pick the owning DB — strictly worse than the self-contained convenience struct. The
  harness still exercises the DB-level consent flow directly and is unaffected by the RN
  change. No harness files were touched.
- **Possible parallel issue in the WEB reference app (out of scope).**
  `packages/reference-app-web/src/lib/cadre-web.ts:474` attaches the closed strand with
  `result.invitePrivateKey` as `MemberPrivateKey` — the same wrong-field pattern this
  ticket fixed in RN. It may "work" only if that path is untested two-device. Worth a
  follow-up fix ticket if confirmed; not changed here (RN-scoped ticket).
- **`joinClosedChatStrandFromFormation` throw path is untested** by any automated test in
  this package (no RN unit tests for chat-strand). Manual two-device exercise needed.

## Suggested review checks

- Verify the host's `Strand.MemberPrivateKey` (published via `createClosedChatStrand` →
  `publishStrand(id,'c',key)`) is what the responder returns: trace
  `recorder.resolveStrand(token)` → `ControlFormationUsageRecorder` →
  `strand.MemberPrivateKey` (control-formation-recorder.ts:87-95). The invite→strand
  binding (`FormationInvite.StrandId`) is the linchpin.
- Confirm no remaining importers of the deleted `encode/decodeClosedStrandInvite` /
  `ClosedStrandInvite` (grep clean at handoff; `app/settings.tsx` only calls the hook
  methods and shows the base64url code).
