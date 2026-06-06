----
description: Review — invite-driven seed-trust pinning in the RN reference app. The phone can now pin authority keys from a pasted CadreInvite and pass them as a per-call trust policy when applying a cold-start seed, so out-of-band enrollment works under the secure-default trust anchor.
files: packages/reference-app-rn/src/use-cadre.ts, packages/reference-app-rn/app/settings.tsx, packages/reference-app-rn/src/test-ids.ts, packages/reference-app-rn/src/cadre-phone.ts
----

## What landed

Cold-start trust anchoring for the RN phone, via the `CadreNode.applySeed(seed, { trustPolicy })`
seam (landed in `seed-trust-coldstart-cadrenode-seam`). The phone self-genesis as its *own* party
authority but holds no *foreign* cadre's `AuthorityKey`, so the secure default
(`dbAnchoredTrustPolicy`) rejects a seed signed by a different cadre. The fix lets the user paste the
out-of-band `CadreInvite` alongside the seed; its `authorityKeys` are pinned via
`pinnedKeyTrustPolicy(...)` for that one `applySeed` call.

### `src/use-cadre.ts`
- `UseCadreResult.applySeed` now takes an optional `pinnedAuthorityKeys?: string[]`. When non-empty,
  it builds `pinnedKeyTrustPolicy(pinnedAuthorityKeys)` and passes `{ trustPolicy }` to
  `current.applySeed`; when empty/undefined, it passes `undefined` (secure default, unchanged
  behavior).
- New `authorityKeysFromInvite(encodedInvite): string[]` — decodes a pasted `CadreInvite` via
  `current.decodeInvite(...)` and returns `.authorityKeys ?? []`.
- Added the value import `import { pinnedKeyTrustPolicy } from '@serfab/cadre-core'` (was type-only
  imports before).

### `app/settings.tsx` — Seed Bootstrap section
- New `enrollInviteInput` state + a `LabelledInput` ("Paste enrollment invite (for trust)") **inside
  the Seed Bootstrap section**, with a hint that explicitly distinguishes it from the closed-strand
  "Paste invite" box below it.
- `handleApplySeed` now derives `pins` from `enrollInviteInput` (only when non-blank), passes them to
  `cadre.applySeed(seed, pins)`, clears both inputs on success, and the success alert states the pin
  count or explicitly says "no authority keys pinned" — it never claims a pin when `pins` was empty.

### `src/test-ids.ts`
- Added `settings.enrollInviteInput = 'input-enroll-invite'` (distinct from `inviteInput =
  'input-invite'`).

### `src/cadre-phone.ts`
- **Unchanged.** The module-level `applySeed(seed)` helper is exported but has **no callers** (grep
  confirmed: the hook calls `current.applySeed` on the node directly, not this helper). The ticket
  marked threading the pins param "only if it keeps the API coherent; otherwise leave it" — leaving it
  avoids an unused param + an extra import in a dead helper.

## Validation performed (this is the floor, not the ceiling)

- `yarn workspace @serfab/reference-app-rn typecheck` → **exit 0**, no errors.
- `yarn lint` → **0 errors**, 111 pre-existing warnings, none in any of the four touched files.

## Known gaps / what review should scrutinize

- **No runtime/behavioral test.** `reference-app-rn` has no unit-test runner (no `test` script, no
  `test/` dir) and the E2E (`test:e2e` → Maestro) needs a device/emulator + a relay, so the
  pin-then-apply path was **not exercised at runtime** — only type/lint. The new
  `input-enroll-invite` test id is wired but no Maestro flow consumes it yet. A reviewer wanting
  behavioral confidence should either add a Maestro step or a thin unit harness around
  `authorityKeysFromInvite` + `applySeed` (would require standing up a `CadreNode`, non-trivial in
  this package).
- **Verify the two invite fields are truly independent** (the ticket's explicit warning): distinct
  state (`enrollInviteInput` vs `inviteInput`), distinct test ids (`input-enroll-invite` vs
  `input-invite`), distinct handlers (`handleApplySeed` vs `handleJoinViaInvite`). Confirm the
  closed-strand `OpenInvitation` / `joinViaInvite` flow is untouched.

## Edge cases (intended behavior — confirm, don't "fix" away)

- **Seed pasted, no invite, cold node** → rejects with the trust reason surfaced as
  `Seed failed: <reason>`. Correct secure default. Worth confirming the underlying reason string is
  actionable (comes from the seed-bootstrap trust evaluation, not this layer).
- **Invite with no `authorityKeys`** (older/empty invite) → `authorityKeysFromInvite` returns `[]` →
  `pins` is `[]` → `applySeed` passes `undefined` (no pin) → cold node still rejects. The alert says
  "no authority keys pinned" rather than implying success-by-pin.
- **Invite vs seed party mismatch** → pinning is per-key, not per-party (`pinnedKeyTrustPolicy`
  ignores `partyId`); a key pinned from one invite anchors any seed signed by that key. Intentional —
  the signer-key is the security boundary; no party-equality gate was added.
- **Phone's own key** → pinning a foreign key unions (never narrows); a seed signed by the phone's own
  authority key still applies with or without a pin.
- **Node not started** → both `applySeed` and `authorityKeysFromInvite` throw `'Node not started'`
  before touching `nodeRef.current`.
- **Malformed invite paste** → `decodeInvite` JSON-parses; a bad string throws, surfaced by the
  existing `catch` in `handleApplySeed` as `Seed failed: <err>`. No bespoke validator added (per
  ticket).
