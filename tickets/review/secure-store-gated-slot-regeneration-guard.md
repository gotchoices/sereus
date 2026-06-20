description: Review the guard that stops a phone from silently minting a brand-new device identity when a fingerprint/Face-ID change wipes out the locked-down storage slot — it now treats "this slot used to hold something but now reads blank" as a read failure instead of an empty slot.
prereq:
files: packages/reference-app-rn/src/secure-key-store.ts, packages/reference-app-rn/test/secure-key-store.spec.ts, packages/reference-app-rn/app.json, packages/cadre-core/src/cadre-node.ts, docs/architecture.md
difficulty: medium
----

## What was implemented

A gated-slot `null`-material discriminator in `SecureStoreKeyStore.get`
(`packages/reference-app-rn/src/secure-key-store.ts`). The change makes biometric
gating **safe to enable** without silently orphaning the device identity; it does
**not** enable gating (the identity slot still ships ungated).

### The bug being closed (latent, not active)

`expo-secure-store.getItemAsync` on a **biometric-invalidated** gated entry (one
written with `requireAuthentication: true`, then invalidated by a fingerprint
add / Face-ID re-enroll) resolves **`null`**, not a throw — indistinguishable from a
genuinely empty slot. The old mapping turned that `null` into `undefined`, and
`CadreNode.resolveIdentityKey` (`packages/cadre-core/src/cadre-node.ts:508-545`)
regenerates a fresh Ed25519 identity on `undefined` — silently orphaning the
device's real PeerId / authority key. Nothing ships gated today, so this was latent;
it would activate the moment a developer set `requireAuthentication: true` on the
identity (or any must-not-regenerate) slot.

### The fix (only `get` changed)

After a `null` material read:
- **Ungated slot** (`requireAuthentication !== true`, today's default and every
  shipped path): return `undefined` — **verbatim** today's behaviour.
- **Gated slot**: call the new private `gatedNullResult(keyId)`, which reads the
  unauthenticated `sereus.ks.__index` marker via the existing `readIndex()`:
  - `keyId ∈ index` ⇒ the slot was written in a past session but now reads `null`
    ⇒ throw `KeyStoreAccessError` (fail-closed; `resolveIdentityKey` propagates it,
    so **no regeneration**).
  - `keyId ∉ index` ⇒ genuinely empty / true first launch ⇒ `undefined`.

The `__index` entry is reused as the presence marker because it is *always*
read/written with `requireAuthentication` dropped (`indexOptions()`), so the marker
itself can never be biometric-invalidated, and `set` already writes material
**before** the index — so `index present + material null` can only mean
"was-written-then-became-unreadable", never a false positive in a correctly-operating
store.

Also: `NSFaceIDUsageDescription` added to `packages/reference-app-rn/app.json`
(`expo.ios.infoPlist`) — a prerequisite for *anyone* enabling gating (without it the
first Face-ID prompt crashes the app). JSDoc + `docs/architecture.md` (Access-vs-absence
and Biometric-invalidation bullets) updated. **No** `requireAuthentication`-enabling
default was added anywhere — gating stays off.

## How to validate

- **Tests:** `yarn workspace @serfab/reference-app-rn test` → **129 passed** (7 files).
  New `describe('SecureStoreKeyStore — gated null discriminator')` block in
  `test/secure-key-store.spec.ts` covers: target case (gated + index + null ⇒
  `KeyStoreAccessError` w/ keyId), true-first-launch (gated, no set ⇒ `undefined`),
  ungated-preserves-today (index forced to contain keyId, no material ⇒ still
  `undefined`), guard-probe-forwards-accessibility-but-no-`requireAuthentication`,
  index-read-failure-fails-closed, clean-delete ⇒ `undefined`.
- **Typecheck:** `yarn workspace @serfab/reference-app-rn typecheck` → exit 0.
- **Lint:** `yarn eslint packages/reference-app-rn/src/secure-key-store.ts
  packages/reference-app-rn/test/secure-key-store.spec.ts` → exit 0.
- Pre-existing access-vs-absence (`:178-213`) and index-orphan (`:218-227`,
  ungated) tests pass **unchanged**.

### Use cases worth a reviewer's adversarial eye

- **The target case is what justifies the whole ticket.** Confirm the
  `KeyStoreAccessError` genuinely propagates through `resolveIdentityKey` without
  regeneration (it does today: `cadre-node.ts:525` awaits `keyStore.get` and only
  generates on falsy bytes — a rejection short-circuits). No cadre-core change was
  made; verify that contract still holds end-to-end.
- **Ungated must be byte-for-byte unchanged.** The whole safety argument for *not*
  touching `set`/`delete` rests on the ungated path being untouched. The
  index-orphan test (`:218`, ungated) is the canary — it must stay green.
- **Marker can't itself prompt/invalidate.** The guard reads `__index` with
  `indexOptions()` (no `requireAuthentication`). Confirm there is no path where the
  guard read could trigger a biometric prompt or read invalidatable material.

## Known gaps / honest flags (reviewer: treat tests as a floor)

1. **Device behaviour is assumed, not verified.** The premise — "Expo resolves a
   biometric-invalidated gated entry to `null`, not a throw" — comes from the Expo
   API docs, *not* from a real iOS/Android device run. All tests exercise the
   in-memory `FakeSecureStore`, which models `null`-on-invalidation by construction
   (we delete the material entry, keep the index). If the real native behaviour
   differs (e.g. some OS versions *do* throw, or return a sentinel), the guard still
   fails closed for the throw case (existing catch → `KeyStoreAccessError`) but the
   `null` discriminator is only as correct as that premise. Worth a real-device
   smoke test before anyone flips `requireAuthentication: true` in production.
2. **Residual window left open, by design.** A `set` interrupted *between* its
   material and index writes in a **prior** session, *followed by* a later
   invalidation, leaves `material null + index absent` ⇒ `undefined` ⇒
   regeneration. Documented in `gatedNullResult`'s JSDoc and accepted as strictly no
   worse than the pre-guard status quo (where *every* gated invalidation
   regenerated). Closing it (marker-before-material) was rejected because it would
   permanently wedge a fresh slot whose `set` crashed before the material write.
   Reviewer should confirm they agree with that trade-off rather than assume it's an
   oversight.
3. **Zero production runtime coverage.** Because nothing ships gated, this entire
   branch (`requireAuthentication === true`) never executes on any shipped path
   today — it's a latent safety net validated only by unit tests. The
   `NSFaceIDUsageDescription` crash-without-it claim is likewise from iOS/Expo docs,
   not device-tested.
4. **Multi-slot independence is covered by reasoning, lightly by tests.** The
   discriminator keys off `index.includes(keyId)`, so slots are independent, but the
   test suite exercises a single gated keyId at a time. A reviewer wanting belt-and-
   suspenders could add a two-gated-slot test (one invalidated, one intact).

## Out of scope (do not expand here)

- Enabling gating or adding a `requireAuthentication` default — explicitly forbidden
  by the spec; gating stays off.
- `canUseBiometricAuthentication()` probe — rejected in the plan (after a biometric
  change the device still *has* usable biometrics, so the probe can't distinguish
  invalidation from empty). Documented in code; do not reintroduce.
- Reordering `set`/`delete`, or touching `readIndex`/`mutateIndex`/`list`/
  `migrateLegacyIdentity` — none were changed and none should be.
