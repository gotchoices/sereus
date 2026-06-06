----
description: Invite-driven seed-trust pinning in the RN reference app — let the phone pin authority keys from a pasted CadreInvite (invite.authorityKeys) and pass them as a pinnedKeyTrustPolicy when applying a cold-start seed, so out-of-band enrollment works under the secure-default trust anchor.
prereq: seed-trust-coldstart-cadrenode-seam
files: packages/reference-app-rn/src/use-cadre.ts, packages/reference-app-rn/app/settings.tsx, packages/reference-app-rn/src/test-ids.ts, packages/reference-app-rn/src/cadre-phone.ts
----

## Context

With `seed-trust-coldstart-cadrenode-seam` landed, `CadreNode.applySeed(seed, { trustPolicy })` honors a per-call override. The RN phone is a cold-start node (it self-genesis as its *own* party authority in `cadre-phone.ts:runAuthorityGenesis`, but its `AuthorityKey` table does **not** contain *another* cadre's authority key). So when the user pastes a seed signed by a different cadre's authority, the secure default (`dbAnchoredTrustPolicy`) rejects it.

The fix is **invite-driven pinning**: a `CadreInvite` carries `authorityKeys?: string[]` (added by `seed-trust-policy-and-authority-identity`, populated by `createInvite` — see `seed-bootstrap.ts:818-836`). The phone receives that invite out-of-band, pins its `authorityKeys`, and applies the subsequent seed against `pinnedKeyTrustPolicy(invite.authorityKeys)`.

### Two distinct "invite" concepts — do not conflate

- `CadreInvite` (`types.ts:700`) — phone↔authority **enrollment**; carries `authorityAddrs` + `authorityKeys`; consumed by `decodeInvite`/`dialInvite`/`acceptPhone`. **This** is the seed-trust anchor.
- `OpenInvitation` (`types.ts:391`) — closed-strand **formation** consent flow; the existing settings "Paste invite" box (`joinViaInvite`) uses this. **Unrelated** to seed trust — leave it untouched.

The RN app today has a raw "Paste seed" box (`settings.tsx:52` → `cadre.applySeed(seed)`) with no anchor, and no `CadreInvite` redemption flow at all. This ticket adds the anchor.

## Design

### use-cadre.ts

Change `applySeed` to accept optional pinned authority keys, and add a tiny decode helper so the screen can extract them from a pasted `CadreInvite`:

```ts
// UseCadreResult
/** Apply a base64url-encoded seed, optionally pinning authority keys (e.g. from a CadreInvite). */
applySeed: (encoded: string, pinnedAuthorityKeys?: string[]) => Promise<void>;
/** Decode a pasted base64url CadreInvite and return its pinned authority keys (empty if none). */
authorityKeysFromInvite: (encodedInvite: string) => string[];
```

Implementation:

```ts
const applySeed = useCallback(async (encoded: string, pinnedAuthorityKeys?: string[]) => {
  const current = nodeRef.current;
  if (!current) throw new Error('Node not started');
  const seed = current.decodeSeed(encoded);
  const trustPolicy = pinnedAuthorityKeys?.length
    ? pinnedKeyTrustPolicy(pinnedAuthorityKeys)
    : undefined;
  const result = await current.applySeed(seed, trustPolicy ? { trustPolicy } : undefined);
  if (!result.success) throw new Error(result.error ?? 'Seed application failed');
}, []);

const authorityKeysFromInvite = useCallback((encodedInvite: string): string[] => {
  const current = nodeRef.current;
  if (!current) throw new Error('Node not started');
  return current.decodeInvite(encodedInvite).authorityKeys ?? [];
}, []);
```

Import `pinnedKeyTrustPolicy` from `@serfab/cadre-core`. `CadreNode.decodeInvite` already exists (cadre-node.ts:1440).

### settings.tsx — Seed Bootstrap section

Add an optional "Paste enrollment invite (for trust)" `CadreInvite` field **inside the Seed Bootstrap section** (clearly separate from the closed-strand "Paste invite"/`joinViaInvite` field). On Apply Seed:

```ts
const handleApplySeed = async () => {
  const seed = seedInput.trim();
  if (!seed) return;
  try {
    const pins = enrollInviteInput.trim()
      ? cadre.authorityKeysFromInvite(enrollInviteInput.trim())
      : undefined;
    await cadre.applySeed(seed, pins);
    setSeedInput('');
    setEnrollInviteInput('');
    showAlert('Seed applied', pins?.length ? `Pinned ${pins.length} authority key(s); peer cache updated` : 'Peer cache updated');
  } catch (err) {
    showAlert('Seed failed', String(err));
  }
};
```

Add the new `enrollInviteInput` state + a `LabelledInput`, and a `settings.enrollInviteInput` test id to `test-ids.ts`.

### cadre-phone.ts

No functional change needed (the phone already self-genesis as authority). Optionally add a `applySeed(seed, pinnedAuthorityKeys?)` pass-through param to the module-level helper at `cadre-phone.ts:205` for symmetry if it is used elsewhere — only if it keeps the API coherent; otherwise leave it. Confirm by grep that nothing else calls the module-level `applySeed`.

## Edge cases & interactions

- **Seed pasted with no invite, cold node.** Rejects with the trust reason; the user sees `Seed failed: <trust reason>`. This is the correct secure default — assert the message is actionable, not generic.
- **Invite with no `authorityKeys`.** An older/empty invite yields `[]` → no pin → cold node rejects. The alert should make clear no keys were pinned (don't claim success-by-pin when pins were empty).
- **Invite vs seed party mismatch.** Pinning is per-key, not per-party (`pinnedKeyTrustPolicy` ignores `partyId`); a key pinned from one invite anchors any seed signed by that key. Document — do not add a party-equality gate (the signer-key anchor is the security boundary).
- **Phone is its own authority.** The phone's `AuthorityKey` already holds its own key; pinning a *foreign* key via invite unions (never narrows) — applying a seed signed by the phone's own key still works with or without a pin.
- **Node not started.** Both `applySeed` and `authorityKeysFromInvite` throw `'Node not started'` before touching `nodeRef.current` — keep the existing guard ordering.
- **Malformed invite paste.** `decodeInvite` JSON-parses; a bad string throws → surfaced via the existing `catch` in `handleApplySeed` as `Seed failed`. Acceptable; do not add a bespoke validator.
- **Don't disturb the closed-strand flow.** The existing `inviteInput`/`joinViaInvite` (`OpenInvitation`) state and handlers are untouched — verify the two invite fields don't share state or test ids.

## TODO

- Extend `UseCadreResult.applySeed` with the optional `pinnedAuthorityKeys` param and add `authorityKeysFromInvite`; implement both in `use-cadre.ts` using `pinnedKeyTrustPolicy` + `decodeInvite`.
- Add the `enrollInviteInput` field, state, and test id to `settings.tsx` / `test-ids.ts`; pin from it on Apply Seed.
- Grep for other callers of the module-level `cadre-phone.applySeed`; thread the optional pins param only if it keeps the API coherent.
- No unit-test runner is configured for `reference-app-rn` (no `test` script / `test/` dir) — rely on typecheck/build. Run `yarn workspace @serfab/reference-app-rn typecheck` (or the package's tsc/build script; check `package.json`) and stream output with `2>&1 | tee`.
- Run `yarn lint` on touched files.
