description: The web reference app attaches a formed closed strand with the wrong FormStrandResult field — `invitePrivateKey` (the initiator's signing key, or '' on the responder-creates path) instead of `memberPrivateKey` (the read-gating secret). Reads cannot be authorized. Same class of bug fixed for RN in `formstrand-rn-drop-out-of-band-envelope`.
files: packages/reference-app-web/src/lib/cadre-web.ts
----

## Symptom

`joinViaInvitation` in `packages/reference-app-web/src/lib/cadre-web.ts` provisions the
formed closed strand locally with the wrong membership key:

```ts
// cadre-web.ts ~line 471-478
await cadre.addStrand({
  strandRow: {
    Id: result.strandId,
    MemberPrivateKey: result.invitePrivateKey,   // ← WRONG FIELD
    Type: 'c',
  },
  sAppConfig: getChatSAppConfig(),
});
```

The inline comment claims this is "the responder-minted member key so reads are
authorized," but `FormStrandResult.invitePrivateKey` is **not** the member key.

## Why it's wrong

`FormStrandResult` (packages/cadre-core/src/types.ts:405-419) carries two distinct keys:

- `invitePrivateKey` — the **initiator's own generated signing key** for future
  messages. On the responder-creates path it is set by the `StrandSolicitationService`
  layer; on the manager's `dialFormation` path (strand-formation-manager.ts:173) it is
  the empty string `''`.
- `memberPrivateKey` — the **closed-strand read-gating secret**, delivered through the
  formation protocol after consent (provision-then-record). This is the field that
  authorizes reads against a `Type:'c'` strand.

Attaching a closed strand with `invitePrivateKey` as `MemberPrivateKey` means the
strand is brought up with a key that cannot decrypt/authorize reads (or with `''`),
so the join silently produces an unreadable strand. This is the exact bug that was
fixed for the RN app in `formstrand-rn-drop-out-of-band-envelope` (which introduced the
loud-throw guard in `joinClosedChatStrandFromFormation`).

## Expected behavior

Attach with `result.memberPrivateKey`, and fail loudly when it is absent (the host
strand was not closed, or the responder provisioned no key) rather than attaching with
a key that cannot read — mirroring the RN fix
(`chat-strand.ts:joinClosedChatStrandFromFormation`).

## Notes for the implementer

- Confirm which formation path the web demo actually exercises. The web
  `createInvitation` (cadre-web.ts ~430) mints an `OpenInvitation` but does **not**
  bind a `strandId` to the `FormationInvite`, so today it takes the *responder-provisions*
  fallback (strand-formation-manager.ts:255+), where `memberPrivateKey` comes from the
  wired `StrandProvisioner` (or is undefined when none is wired). If the web demo is
  meant to host a pre-created closed strand like RN does, it should also pass
  `{ strandId }` to `publishFormationInvite` so the responder resolves the host's real
  `MemberPrivateKey` (provision-then-record). Decide the intended web flow as part of
  this fix — don't just swap the field if the host side never provisions a key.
- This path is likely untested two-device (single-tab cannot exercise the handshake),
  which is why the wrong field has gone unnoticed. A regression check belongs with the
  web formation e2e work (`reference-app-web-formation-convergence-e2e` in backlog).
- The cadre-core consent loop itself is correct and unchanged — this is purely a
  reference-app field-selection bug.
