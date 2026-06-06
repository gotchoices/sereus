description: Fix the web reference app's closed-strand formation flow so reads are authorized. Today `joinViaInvitation` attaches the formed closed strand with the wrong `FormStrandResult` field (`invitePrivateKey`, which is `''` on this path) instead of `memberPrivateKey`, AND the host side (`createInvitation`) never provisions a member key — so a mere field swap would make every join throw. Mirror the RN provision-then-record flow end-to-end (host creates a closed strand + binds it to the invite via `publishFormationInvite({ strandId })` with a `ControlFormationUsageRecorder` wired; joiner attaches with `memberPrivateKey` and fails loudly when absent).
prereq:
files: packages/reference-app-web/src/lib/cadre-web.ts, packages/reference-app-web/src/lib/chat-strand.ts
----

## Problem (confirmed by code inspection)

`joinViaInvitation` in `packages/reference-app-web/src/lib/cadre-web.ts:471-478`
provisions the formed closed strand with the wrong membership key:

```ts
await cadre.addStrand({
  strandRow: {
    Id: result.strandId,
    MemberPrivateKey: result.invitePrivateKey,   // ← WRONG FIELD
    Type: 'c',
  },
  sAppConfig: getChatSAppConfig(),
});
```

`FormStrandResult` (`packages/cadre-core/src/types.ts:405-419`) carries two distinct keys:

- **`invitePrivateKey`** — the initiator's own generated signing key. On the
  manager's `dialFormation` path it is the empty string `''`
  (`strand-formation-manager.ts:173`).
- **`memberPrivateKey`** — the closed-strand read-gating secret, delivered through
  the formation protocol after consent (provision-then-record). This is the field
  that authorizes reads against a `Type:'c'` strand
  (`strand-formation-manager.ts:236-252`).

Attaching with `invitePrivateKey` brings the strand up with a key (`''`) that
cannot authorize reads → the join silently produces an unreadable strand. Same
class of bug fixed for RN in `formstrand-rn-drop-out-of-band-envelope` (which added
the loud-throw guard in `joinClosedChatStrandFromFormation`,
`reference-app-rn/src/chat-strand.ts:211-222`).

## Why a field swap alone is NOT enough

The web host never provisions a member key today, so `result.memberPrivateKey`
would always be `undefined` and the corrected join would *always* throw. The web
formation flow is currently non-functional end-to-end:

- `createInvitation` (`cadre-web.ts:428-447`) calls only `createOpenInvitation`
  (mints the out-of-band envelope). It does **not** create a host closed strand,
  does **not** call `publishFormationInvite`, and does **not** bind a `strandId`.
- `ensureSolicitation` (`cadre-web.ts:404-411`) calls
  `node.initializeStrandSolicitation()` with **no** `ControlFormationUsageRecorder`,
  so token validity/consent and — critically — `resolveStrand` (the
  provision-then-record lookup that returns the host's real `memberPrivateKey`) are
  never wired.

So on redemption the responder hits the responder-provisions fallback with no
provisioner → returns a structural placeholder with `memberPrivateKey: undefined`
(`strand-formation-manager.ts:255-262`).

## Decision — mirror RN's provision-then-record flow

The intended web flow is the one RN already proved
(`reference-app-rn/src/use-cadre.ts:197-208` `createClosedStrandWithInvite` +
`cadre-phone.ts:142-154` `initializeFormationResponder`):

1. **Host** creates a closed strand locally (generates a member key, publishes the
   `Strand` row `Type:'c'` under its authority, attaches the instance).
2. **Host** mints an `OpenInvitation` and publishes a `FormationInvite` **bound to
   that `strandId`** via `publishFormationInvite(token, sAppId, { strandId, ... })`.
3. **Host** has a `ControlFormationUsageRecorder` wired into the solicitation
   service, so a redeeming `formStrand` resolves the bound host strand
   (provision-then-record), writes the single `FormationUsage` consent row, and
   returns the host's real `strandId` + `memberPrivateKey`
   (`strand-formation-manager.ts:236-252`).
4. **Joiner** attaches with `result.memberPrivateKey`, failing loudly when absent.

Tradeoff / scope note: the alternative (swap the field only, leave the host as-is)
keeps the diff to one line but leaves the demo's join permanently throwing — it
removes the silent-corruption bug but delivers no working closed-strand join. We
choose the end-to-end fix so the consent/read-authorization flow actually works,
matching RN. This stays within the two reference-app files; no cadre-core changes
(the consent loop is already correct — `formstrand-protocol-thread-consent-and-provision`).

Note the web chat schema (`chat-strand.ts:24-37`) has `Member(Id, Name)` only — no
role column — so unlike RN there is **no** owner/member role assignment to mirror;
host/join strand bring-up is just `publishStrand` + `addStrand` / `addStrand`.

## Relevant existing code

- Web (to change): `reference-app-web/src/lib/cadre-web.ts`
  - `ensureSolicitation` (`:404`), `createInvitation` (`:428`),
    `joinViaInvitation` (`:457`), `addChatStrand` (`:594`, the open-strand
    bring-up pattern: `openStores([id])` then `addStrand`).
- Web schema/config: `reference-app-web/src/lib/chat-strand.ts`
  (`getChatSAppConfig`, `CHAT_SAPP_ID`, `CHAT_STRAND_ID`).
- RN reference (the working pattern to mirror):
  - `reference-app-rn/src/chat-strand.ts:142-164` `createClosedChatStrand`
  - `reference-app-rn/src/chat-strand.ts:177-196` `joinClosedChatStrand`
  - `reference-app-rn/src/chat-strand.ts:211-222` `joinClosedChatStrandFromFormation` (loud-throw guard)
  - `reference-app-rn/src/cadre-phone.ts:142-154` `initializeFormationResponder` (recorder wiring)
  - `reference-app-rn/src/use-cadre.ts:197-208` `createClosedStrandWithInvite` (host: create closed strand + bound invite)
- cadre-core APIs:
  - `cadre-node.ts:963` `publishStrand(strandId, type, memberPrivateKey)`
  - `cadre-node.ts:1006` `publishFormationInvite(token, sAppId, { expiresAtMs?, totalUses?, validationUrl?, strandId? })`
  - `cadre-node.ts:1474` `initializeStrandSolicitation(options?)`
  - `strand-member-key.ts` `generateStrandMemberKey()` (exported from cadre-core index)
  - `control-formation-recorder.ts` `ControlFormationUsageRecorder` (exported from cadre-core index)
  - `types.ts:405-419` `FormStrandResult` (`memberPrivateKey` vs `invitePrivateKey`)
  - `strand-formation-manager.ts:236-252` provision-then-record (`resolveStrand` → `memberPrivateKey`)

## Verification / testing note

This path needs two dialable tabs to exercise (single-tab cannot drive the
handshake), so it is not unit-reproducible here. The web `createInvitation` already
requires `relayState.status === 'reserved'`, so relay infra is a precondition. A
regression check belongs with the web formation e2e work
(`reference-app-web-formation-convergence-e2e`, in backlog) — do not add a flaky
single-tab test. For this ticket, validate via `yarn` typecheck/lint/build of
`reference-app-web` (and `yarn build` of cadre-core if needed for fresh types).

## TODO

### Phase 1 — wire the responder recorder
- In `cadre-web.ts`, import `ControlFormationUsageRecorder` from `@serfab/cadre-core`.
- Change `ensureSolicitation` to initialize solicitation with a
  `ControlFormationUsageRecorder` backed by `node.getControlDatabase()`, mirroring
  RN's `initializeFormationResponder` (`cadre-phone.ts:142-154`). Keep it
  idempotent (the `solicitationReady` guard) and fail-soft only where RN does —
  but throw if the control database is unavailable (it must exist post-start).

### Phase 2 — host: create a closed strand bound to the invite
- In `createInvitation`, before/after minting the invitation:
  - Generate a member key via `generateStrandMemberKey()` (imported from cadre-core).
  - Generate a strand id (`crypto.randomUUID()`).
  - `await openStores([strandId])`, then `await cadre.publishStrand(strandId, 'c', memberPrivateKey)`
    and `await cadre.addStrand({ strandRow: { Id: strandId, MemberPrivateKey: memberPrivateKey, Type: 'c' }, sAppConfig: getChatSAppConfig() })`.
    (Mirror RN `createClosedChatStrand`; web has no member-role step.)
  - `await cadre.publishFormationInvite(invitation.token, CHAT_SAPP_ID, { expiresAtMs: invitation.expiration.getTime(), strandId })`.
  - Track the host strand in `formedStrands` (type `'c'`, `memberKey` = generated key)
    so diagnostics/`getFormedStrands()` stay consistent. Optionally add `strandId`
    to the `CreatedInvitation` return shape for the host UI.
- Decide where the closed-strand creation helper lives: inline in `cadre-web.ts`
  is fine (web `chat-strand.ts` is schema/config only, no strand-lifecycle code),
  but factor a small `createClosedChatStrand`-style helper if it keeps `cadre-web.ts`
  readable and DRY.

### Phase 3 — joiner: attach with the read-gating key, fail loudly
- In `joinViaInvitation`, replace `MemberPrivateKey: result.invitePrivateKey` with
  `result.memberPrivateKey`, guarded by a loud throw when it is absent — mirror RN
  `joinClosedChatStrandFromFormation` (`reference-app-rn/src/chat-strand.ts:211-222`):
  ```
  if (!result.memberPrivateKey) throw new Error(
    'formStrand returned no membership key — the host strand is not closed or the ' +
    'responder provisioned no member key; cannot attach a closed chat strand');
  ```
- Fix the misleading inline comment at `cadre-web.ts:469` ("responder-minted member
  key") to describe the actual provision-then-record source.

### Phase 4 — validate
- `cd packages/reference-app-web` and run typecheck + lint + build, streaming output
  (`yarn <cmd> 2>&1 | tee /tmp/web.log`). Rebuild cadre-core first if types are stale.
- Confirm no remaining references to `invitePrivateKey` in the closed-strand attach path.
- Hand off to review noting the two-tab e2e is deferred to
  `reference-app-web-formation-convergence-e2e`.
