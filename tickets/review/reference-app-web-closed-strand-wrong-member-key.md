description: Review the web reference app's closed-strand formation fix — host now provisions a member key + binds a FormationInvite to a real closed strand, responder wires a ControlFormationUsageRecorder, and the joiner attaches with `memberPrivateKey` (failing loudly when absent) instead of the always-`''` `invitePrivateKey`.
files: packages/reference-app-web/src/lib/cadre-web.ts
----

## What this was

The web `joinViaInvitation` attached the formed closed strand with the wrong
`FormStrandResult` field (`invitePrivateKey`, which is `''` on the manager's
`dialFormation` path) instead of `memberPrivateKey`. A bare field swap would have
made every join throw, because the web **host** never provisioned a member key:
`createInvitation` only minted the out-of-band envelope, and `ensureSolicitation`
brought up the solicitation service with **no** `ControlFormationUsageRecorder`,
so a redeeming `formStrand` fell through to the responder-provisions placeholder
and returned `memberPrivateKey: undefined`.

The fix mirrors the already-proven RN provision-then-record flow end-to-end,
staying entirely within `cadre-web.ts` (no cadre-core changes; the web
`chat-strand.ts` is schema/config only and was untouched). The web chat schema has
no member-role column, so — unlike RN — there is **no** owner/member role
assignment to mirror.

## What changed (all in `packages/reference-app-web/src/lib/cadre-web.ts`)

- **Imports**: added `ControlFormationUsageRecorder` and `generateStrandMemberKey`
  from `@serfab/cadre-core`.
- **Phase 1 — responder recorder** (`ensureSolicitation`): initializes solicitation
  with `new ControlFormationUsageRecorder(node.getControlDatabase())`, mirroring RN
  `initializeFormationResponder`. Throws if the control DB is unavailable (it must
  exist post-start) rather than silently degrading to the no-recorder path. Still
  idempotent via the `solicitationReady` guard.
- **Phase 2 — host provisions a bound closed strand**:
  - New private helper `createClosedChatStrand(cadre)`: `crypto.randomUUID()` →
    `generateStrandMemberKey()` → `openStores([strandId])` →
    `publishStrand(strandId, 'c', memberPrivateKey)` → `addStrand({ Type:'c', ... })`.
    Returns `{ strandId, memberPrivateKey }`. Mirrors RN `createClosedChatStrand`
    minus the role step.
  - `createInvitation` now: dialability guard (unchanged, runs **before** any publish
    so an undialable tab leaves no dangling strand) → `createClosedChatStrand` →
    `createOpenInvitation` → `publishFormationInvite(token, CHAT_SAPP_ID, {
    expiresAtMs, strandId })` (binds the invite to the host strand) → records the
    host strand in `formedStrands` (`type:'c'`, `memberKey`) → returns the encoded
    invitation. `CreatedInvitation` gained a `strandId` field for the host UI.
- **Phase 3 — joiner attaches with the read-gating key**: `joinViaInvitation` now
  throws loudly when `result.memberPrivateKey` is absent (verbatim RN message), then
  attaches with `MemberPrivateKey: result.memberPrivateKey`. The misleading
  "responder-minted member key" comment was replaced with an accurate
  provision-then-record description.

## Validation performed (this is a FLOOR, not a ceiling)

- `yarn workspace @serfab/cadre-core build` — clean.
- `yarn workspace @serfab/reference-app-web typecheck` — clean.
- `yarn workspace @serfab/reference-app-web build` (`tsc --noEmit && vite build`) —
  clean. The only warnings are pre-existing optimystic/db-p2p dynamic-import +
  chunk-size notes, unrelated to this diff.
- `yarn eslint packages/reference-app-web/src/lib/cadre-web.ts` — no findings.
- Confirmed no remaining `invitePrivateKey` in the closed-strand attach path (one
  reference survives only inside an explanatory comment contrasting the two keys).

**No runtime/behavioral test was run.** This path needs two dialable tabs + relay
infra to exercise the handshake; it is not single-tab unit-reproducible. A live
regression check is deferred to `reference-app-web-formation-convergence-e2e`
(backlog) — do NOT add a flaky single-tab test here.

## Use cases / what to verify in review

- **Field correctness**: the joiner attaches with `memberPrivateKey` (the host's
  read-gating secret) — confirm this is the field that authorizes reads against a
  `Type:'c'` strand, and that `invitePrivateKey` (`''` on the dial path) is never
  used to attach.
- **Loud failure**: when `formStrand` returns no `memberPrivateKey` (host strand not
  closed / responder provisioned none), the join throws rather than silently
  attaching an unreadable strand. Confirm the guard precedes `openStores`/`addStrand`.
- **Host/joiner key symmetry**: the host publishes `Strand` `Type:'c'` with the
  generated `memberPrivateKey`; the joiner — via provision-then-record — receives
  that **same** key back through the protocol and attaches with it. Sanity-check the
  recorder's `resolveStrand` returns the bound host strand's key (see
  `strand-formation-manager.ts:236-252`), so both sides share one membership secret.
- **Invite binding**: `publishFormationInvite` is called with `{ strandId }`, and the
  bound host strand exists (published + attached) before the invite is advertised.
- **No dangling strand on undialable tabs**: the `relayState.status !== 'reserved'`
  guard runs before `createClosedChatStrand`, so a non-dialable tab publishes/attaches
  nothing.
- **`formedStrands` consistency**: host and joiner both register their strand
  (`type:'c'` + `memberKey`), so `getFormedStrands()` / the `__cadre` debug hook
  surface both sides symmetrically.

## Known gaps / reviewer attention

- **Repeated `createInvitation` calls mint a fresh host strand each time** (new UUID,
  new member key, new published `Strand` row + local instance). This matches RN's
  per-invite-strand model and is acceptable for a demo, but the host UI currently has
  no notion of "the strand I'm hosting" beyond the latest `CreatedInvitation.strandId`.
  Flagging in case review prefers a single reusable host strand — out of scope here.
- **`activeStrandId` is unchanged**: formed (closed) strands live only in
  `formedStrands`, not `activeStrandId` (which tracks the Phase-1 open chat strand).
  Confirm no diagnostics path assumed otherwise.
- **Recorder wiring vs. lazy init**: `createOpenInvitation`/`formStrand` will lazily
  init solicitation with NO recorder if called before `ensureSolicitation`. All web
  entry points (`createInvitation`, `joinViaInvitation`) go through `ensureSolicitation`
  first, so the recorder is always wired — but verify no other call site bypasses it.
- Two-tab e2e convergence remains unproven here; deferred to
  `reference-app-web-formation-convergence-e2e`.
