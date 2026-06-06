description: Invite-driven seed-trust pinning in the RN reference app. The phone pins authority keys from a pasted CadreInvite and passes them as a per-call trust policy when applying a cold-start seed, so out-of-band enrollment works under the secure-default (`dbAnchoredTrustPolicy`) trust anchor.
files: packages/reference-app-rn/src/use-cadre.ts, packages/reference-app-rn/app/settings.tsx, packages/reference-app-rn/src/test-ids.ts, packages/reference-app-rn/src/cadre-phone.ts, docs/reference-app-rn.md

## What landed

Cold-start trust anchoring for the RN phone via the `CadreNode.applySeed(seed, { trustPolicy })` seam
(from `seed-trust-coldstart-cadrenode-seam`). The phone self-genesises as its own party authority but
holds no foreign cadre's `AuthorityKey`, so the secure default rejects a seed signed by a different
cadre. The user pastes the out-of-band `CadreInvite` alongside the seed; its `authorityKeys` are pinned
via `pinnedKeyTrustPolicy(...)` for that one `applySeed` call.

- **`src/use-cadre.ts`** — `applySeed(encoded, pinnedAuthorityKeys?)` builds `pinnedKeyTrustPolicy` when
  pins are non-empty (else passes the secure default unchanged); new `authorityKeysFromInvite(encoded)`
  decodes a `CadreInvite` and returns `.authorityKeys ?? []`. Value import of `pinnedKeyTrustPolicy`.
- **`app/settings.tsx`** — new `enrollInviteInput` state + a `LabelledInput` ("Paste enrollment invite
  (for trust)") inside the Seed Bootstrap section, with a hint distinguishing it from the closed-strand
  "Paste invite" box. `handleApplySeed` derives pins only when the field is non-blank, clears both inputs
  on success, and the success alert states the pin count or "no authority keys pinned".
- **`src/test-ids.ts`** — `settings.enrollInviteInput = 'input-enroll-invite'`.
- **`src/cadre-phone.ts`** — unchanged (its module-level `applySeed` helper is exported but has no
  callers).

## Review findings

### Verified correct
- **API contract vs. cadre-core.** `applySeed` calls `current.applySeed(seed, { trustPolicy })` matching
  `CadreNode.applySeed(seed, { trustPolicy?: SeedTrustPolicy })` (`cadre-node.ts:1323`).
  `authorityKeysFromInvite` reads `decodeInvite(...).authorityKeys`, an optional `string[]` on
  `CadreInvite` (`types.ts:725`). `pinnedKeyTrustPolicy` is a real **value** export from
  `@serfab/cadre-core` (`index.ts:112`); the import was correctly promoted from type-only.
- **Empty/undefined pin handling is consistent end-to-end.** Blank invite → `pins = undefined`; invite
  with no `authorityKeys` → `pins = []`. Both fall through `pinnedAuthorityKeys?.length` (falsy) to the
  secure default, and the alert's `pins?.length` check correctly reports "no authority keys pinned"
  rather than implying a pin. A cold node still rejects in both cases — intended.
- **Inputs cleared only on success.** `applySeed` throws on `!result.success`; the `catch` surfaces
  `Seed failed: <reason>` and leaves both inputs intact. Success clears both.
- **Two invite fields are independent (the ticket's explicit warning).** Distinct state
  (`enrollInviteInput` vs `inviteInput`), test ids (`input-enroll-invite` vs `input-invite`), and
  handlers (`handleApplySeed` vs `handleJoinViaInvite`). The closed-strand `OpenInvitation` /
  `joinViaInvite` flow is untouched.
- **Guard ordering / type safety.** Both new hook methods throw `'Node not started'` before touching the
  node, matching the existing pattern. No `any`. Stable `useCallback` deps consistent with the file.

### Minor — fixed in this pass
- **DRY (`settings.tsx`).** `enrollInviteInput.trim()` was computed twice in `handleApplySeed`; hoisted
  to a single `const enrollInvite`. Typecheck + lint re-run green.
- **Stale docs (`docs/reference-app-rn.md`).** "Step 4: Apply a Seed" described pasting a seed with no
  mention of the trust anchor. Added a "Cold-start trust" note explaining the secure default and the new
  optional enrollment-invite field. (Line 141's "no signature verification…" was confirmed in scope of
  the permissionless **chat schema**, not seed trust — left unchanged, correctly.)

### Major — filed as a new ticket
- **`fix/reference-app-rn-e2e-seed-trust-enrollment`** — the implement pass wired the **manual** UI path
  but not the **automated** Maestro e2e. The drone fixture (`test-fixture/start.mjs`) signs the seed with
  its own authority key and emits no invite; the phone (own genesis authority, secure default) only
  trusts that key if the drone's `AuthorityKey` row replicates over control-sync before the manual
  "Apply Seed" tap. That is a race the flow does not wait on (it waits only for `btn-disconnect`), so the
  `_setup.yaml` "Seed applied" assertion may fail and take all three shared flows down. Unverified here
  because Maestro needs a device/emulator + relay (deferred in implement). The ticket specifies threading
  a drone `CadreInvite` through `start.mjs` → `run-e2e.mjs` → `_setup.yaml` (via `input-enroll-invite`)
  to make the seed-apply deterministic, and flags that the fixture must first confirm the drone's
  authority key is actually enrolled in its control DB for `createInvite` to emit `authorityKeys`.

### Checked, no action
- **`src/cadre-phone.ts` dead `applySeed(seed)` helper** — exported, zero callers (the hook uses
  `current.applySeed` on the node). Pre-existing (outside this diff); leaving it avoids churning an
  unrelated dead export. Not worth a ticket on its own; a `dead-code-cleanup-and-knip-gate` backlog
  ticket already exists to sweep such cases.
- **`decodeInvite` does no validation.** A non-invite paste (e.g. a seed) JSON-parses with no
  `authorityKeys` → `[]` → no pin → cold node rejects; a malformed string throws and is surfaced as
  `Seed failed: <err>`. Graceful degradation; no bespoke validator warranted (per ticket).
- **Per-key (not per-party) pinning.** `pinnedKeyTrustPolicy` ignores `partyId`; a key pinned from one
  invite anchors any seed signed by that key. Intentional — the signer key is the security boundary.

### Validation performed
- `yarn workspace @serfab/reference-app-rn typecheck` → exit 0 (before and after the inline edit).
- `eslint` on all four touched files + the edited `settings.tsx` → exit 0, no errors/warnings.
- Runtime/behavioral: **not exercised** — `reference-app-rn` has no unit-test runner, and the Maestro
  e2e needs a device/emulator + relay (see the filed fix ticket). Carried forward as a known gap.
