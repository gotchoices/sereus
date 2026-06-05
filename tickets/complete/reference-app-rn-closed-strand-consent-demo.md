description: RN reference demonstrates Sereus's trust/permission model via a closed strand — host mints + publishes a FormationInvite, invitee consents via formStrand, schema-gated attach, app-level owner/member roles. Open quick-start path intact. Reviewed and completed; builds + typechecks + 319 cadre-core tests + lint + Metro bundle all green.
prereq:
files: packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/strand-member-key.ts, packages/cadre-core/src/index.ts, packages/cadre-core/test/publish-formation-invite.spec.ts, packages/reference-app-rn/src/chat-strand.ts, packages/reference-app-rn/src/chat-operations.ts, packages/reference-app-rn/src/use-cadre.ts, packages/reference-app-rn/src/cadre-phone.ts, packages/reference-app-rn/src/test-ids.ts, packages/reference-app-rn/app/settings.tsx, packages/reference-app-rn/app/index.tsx, packages/reference-app-rn/README.md, schemas/chat-simple.qsql, packages/reference-app-rn/test-fixture/start.mjs

# Closed-strand consent demo (RN reference)

The RN reference previously only created **open** strands and told everyone to
share one Party ID. It now also demonstrates Sereus's trust/permission model: a
**closed** strand formed through an explicit host→invitee consent handshake, with
all four pillars wired and documented. The open quick-start path is intact.

**Status: reviewed; cadre-core typecheck + reference-app-rn typecheck green; 319
cadre-core tests pass; eslint clean on the diff; Metro bundle (`test:bundle`)
exits 0 (3580 modules).**

# What changed (implement stage, commit ed70a8c)

### cadre-core (reusable seam)
- **`strand-member-key.ts` (new)** — `generateStrandMemberKey()` mints an
  ed25519 `MemberPrivateKey` (base64 protobuf, same encoding `formStrand` uses).
  Exported from `index.ts`.
- **`cadre-node.ts` — new `publishFormationInvite(token, sAppId, options?)`** —
  the authority-signed `FormationInvite` insert `createOpenInvitation` omits.
  Mirrors `publishStrand`; delegates to `controlDatabase.insertFormationInvite`.
  Without this row the host's recorder can't validate the token.

### reference-app-rn
- **`chat-strand.ts`** — `Member.Role` added to the embedded schema;
  `CHAT_SAPP_ID` exported; `createClosedChatStrand` / `joinClosedChatStrand` /
  `joinClosedChatStrandFromFormation`; the `ClosedStrandInvite` envelope
  (`encode`/`decodeClosedStrandInvite`). Open helpers untouched.
- **`chat-operations.ts`** — `ChatRole`; `insertMember(..., role?)` (idempotent
  `insert or ignore`); `queryMembers` + `ChatMember` carry `Role`.
- **`use-cadre.ts`** — `createClosedStrandWithInvite()` + `joinViaInvite(encoded)`
  on `UseCadreResult` (surfaced through `cadre-context`).
- **`cadre-phone.ts`** — wires the formation **responder** at startup with a
  `ControlFormationUsageRecorder`; thin `createOpenInvitation` / `publishFormationInvite`
  / `formStrand` pass-throughs.
- **`app/settings.tsx` + `test-ids.ts`** — "Closed Strand (Invite-Only)" section.
- **`README.md`** — "Trust model / closed strands" section + corrected Party-ID framing.
- **`schemas/chat-simple.qsql` + `test-fixture/start.mjs`** — `Member.Role` mirrored.

The implement ticket also filed
**`tickets/fix/formstrand-protocol-thread-consent-and-provision.md`** for the
on-the-wire consent gap (token not threaded to provisioner, `FormationUsage` not
written over libp2p, `OpenInvitation` carries no strand id) — the reason the app
delivers the strand id + member key out-of-band rather than via `formStrand`.

# Review findings

Adversarial pass: read the implement diff (ed70a8c) and the post-implement triage
(eb96850) with fresh eyes before the handoff summary. Scrutinized for correctness,
the host/invitee consent contract, DRY, type safety, error/edge paths, resource
cleanup, doc staleness, and the schema-mirror invariant. Lint + full test suite +
typecheck + Metro bundle re-run.

## Fixed in this pass (minor)

- **Closed-strand member display names were clobbered to the raw peerId.**
  `assignLocalMemberRole` registered the local member as `insertMember(instance,
  id, id, role)` — passing the 52-char peerId as the **Name** — while the chat
  screen (`app/index.tsx`) registers members as `User-<last4>`. Because
  `insertMember` is `insert or ignore` on `Id`, and the role assignment runs
  *before* `refreshStrands()` → before `useChat` mounts, the role-assignment row
  always wins the Name. Net effect: every closed-strand participant (owner **and**
  joiner) showed as a long raw peerId in the member list, inconsistent with the
  `User-xxxx` names everywhere else. (The Role itself was safe — same ordering
  makes the `owner` row win Role correctly; only the Name was affected.)
  - Fix: extracted `memberDisplayName(peerId)` into `chat-operations.ts` and used
    it in both `assignLocalMemberRole` (`chat-strand.ts`) and the chat screen
    (`app/index.tsx`), so both inserts agree on the Name regardless of order and
    the inline `User-${slice(-4)}` duplication is removed (DRY). Open-strand
    behavior is byte-identical to before.

- **No node-level test for the new `publishFormationInvite`** (the implement
  handoff's stated "highest-value gap"). The DB-level `insertFormationInvite` was
  covered, but the node wrapper's self-signing path (`getSelfSigningKey` →
  authority-signed insert) was not.
  - Fix: added **`packages/cadre-core/test/publish-formation-invite.spec.ts`** (3
    tests, boots a self-signing node the way `seed-bootstrap.spec.ts` does):
    (a) happy path lands a `FormationInvite` row that `ControlFormationUsageRecorder.isTokenValid`
    accepts; (b) a non-enrolled-authority node is rejected by the
    `FormationInvite.AuthorizedAddOrRemove` constraint and nothing lands (probe #2
    from the handoff); (c) an unstarted node throws. Suite is now 319 (was 316).

## Verified (no change needed)

- **`publishFormationInvite` mirrors `publishStrand` exactly** — same start/no-key
  guards, same `sign(..., 'ed25519', 'bytes', 'base64url', 'base64url')` callback
  shape, delegates to a thoroughly-tested DB method. Signature matches
  `insertFormationInvite(token, sAppId, authorityKey, signMessage, options)`.
- **Formation responder wiring** — `initializeFormationResponder` pre-initializes
  `strandSolicitation` with the DB-backed recorder before the lazy no-recorder
  path in `createOpenInvitation`/`formStrand` can run; fail-soft (logs, never
  throws). `initializeStrandSolicitation` is only lazily re-invoked when the
  service is absent, so no double-init clobbers the recorder.
- **Envelope round-trip** is pure and total — `decodeClosedStrandInvite` validates
  all three required fields and throws on a partial/garbage envelope rather than
  returning a half object.
- **Schema-mirror invariant** — `Member.Role` is identical across the embedded
  `CHAT_SCHEMA` (chat-strand.ts), `schemas/chat-simple.qsql`, and the drone
  fixture `test-fixture/start.mjs`.
- **Context surfacing** — `cadre-context.tsx` passes the whole typed
  `UseCadreResult` through, so `createClosedStrandWithInvite` / `joinViaInvite`
  reach the Settings screen with no extra plumbing.
- **The partial on-the-wire consent gap is correctly a follow-up ticket, not an
  inline fix.** `formstrand-protocol-thread-consent-and-provision.md` is accurate
  and well-scoped (its source references check out), and is the right disposition
  for a major cadre-core protocol change — out of scope for an RN reference demo.
- **App-level role boundary** — confirmed no first-class per-strand RBAC table
  exists in the control schema; `owner`/`member` correctly lives in the chat
  `Member.Role` column and is documented as such.

## Observations (not actioned — non-blocking)

- **Metro `path` shim / `.pre-existing-error.md` are already resolved.** The
  triage pass (commit eb96850) de-static'd the `require('path')` in cadre-core's
  `getStrandStoragePath` (plain string join), reverted the temporary
  `metro.config.js` `path`→empty-stub workaround, and deleted
  `tickets/.pre-existing-error.md`. cadre-core `dist` reflects the fix and the
  bundle now succeeds with no `path` mapping. The implement ticket's
  "Pre-existing failure flagged" / metro shim notes are therefore historical only.
- **`ClosedStrandInvite` envelope carries an unchecked `v: 1` version field**
  (written on encode, ignored on decode). Harmless today; the follow-up fix ticket
  plans to drop the envelope entirely once `formStrand` returns the host's strand,
  so adding version-gating now would be churn on code slated for removal.
- **`joinViaInvite` sets `disclosure.partyId` to the local peerId, but
  `StrandSolicitationService.formStrand` overwrites it** with a freshly-generated
  member key's peerId. Cosmetic and cadre-core-internal — not this ticket's diff.
- **No automated test exercises the RN closed-strand flow** (the app has no unit
  test runner — only `typecheck`/`test:bundle`/`test:e2e`). The two-device
  handshake needs real devices + a drone and is not agent-runnable; this remains a
  manual reviewer probe, as the handoff noted.
- **Pre-existing drone-fixture divergence** (`start.mjs` `Message.Id integer` vs
  the app's `Message.Id text` from `message-pk-collision-free`) was correctly
  flagged by the implementer as out of scope; not introduced here, left untouched.

# How to validate

Ran green during review:
- `yarn workspace @serfab/cadre-core typecheck` — exit 0.
- `yarn workspace @serfab/cadre-core test` — **319 passed (25 files)** (incl. the
  new `publish-formation-invite.spec.ts`).
- `yarn workspace @serfab/reference-app-rn typecheck` — exit 0.
- `eslint` on the changed/added TS/TSX — 0 errors.
- `yarn workspace @serfab/reference-app-rn test:bundle` — bundled 3580 modules,
  exit 0 (no `path` shim — the triage fix holds).

Not exercisable in-agent (documented): the two-device host↔invitee handshake
(needs real devices + a relay/drone) and the on-the-wire `FormationUsage` consent
record (tracked by `formstrand-protocol-thread-consent-and-provision`).
