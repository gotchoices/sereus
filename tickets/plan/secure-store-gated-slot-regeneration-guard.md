description: Guard against silent identity regeneration when a biometric-gated SecureStore slot is invalidated (returns null indistinguishably from empty). This is the safety prerequisite that must land before biometric gating (requireAuthentication) is turned on for the RN identity slot.
prereq:
files: packages/reference-app-rn/src/secure-key-store.ts, packages/reference-app-rn/src/cadre-phone.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/key-store.ts, docs/architecture.md
----

## Problem

`SecureStoreKeyStore` (RN reference app) maps `expo-secure-store`'s `getItemAsync`
results as: thrown → `KeyStoreAccessError`, `null` → `undefined`, value → bytes.
Only `undefined` lets cadre-core regenerate a fresh identity.

The original mobile-secure-storage design assumed an *invalidated* gated entry
(one written with `requireAuthentication: true`, then invalidated by a biometric-set
change — new fingerprint / re-enrolled Face ID) would surface as a thrown error.
Per the current Expo API it does **not**: `getItemAsync` on a biometric-invalidated
entry resolves **`null`**, indistinguishable from a genuinely empty slot. Our
mapping therefore turns it into `undefined`, and `CadreNode.resolveIdentityKey()`
would **regenerate** a new identity — silently orphaning the device's real PeerId /
authority key.

This is **latent, not active**: the RN identity slot ships with
`requireAuthentication` **off** by default (the node must come up headless /
in the background, and `AFTER_FIRST_UNLOCK` is used instead), so no shipped code
path can hit it today. It becomes a real silent-identity-loss bug the moment a
developer enables `requireAuthentication` on the identity (or any
must-not-regenerate) slot.

## Why it matters

Silent identity regeneration is the exact failure mode the `KeyStore` seam was
designed to prevent (the access-vs-absence distinction, the fail-closed
`resolveIdentityKey`). A null-on-invalidation read defeats it for gated slots.

## Desired behaviour / specification

Decide and implement a "was-present-but-now-null" discriminator so a gated slot
that *had* material but now reads `null` is treated as **access-failure**
(`KeyStoreAccessError` → no regeneration), not absence. Candidate approaches to
evaluate (pick during design, document the trade-off):

- A small unauthenticated **presence marker** companion entry (no
  `requireAuthentication`) written alongside gated material. On read: marker
  present + material `null` ⇒ invalidated/denied ⇒ raise `KeyStoreAccessError`;
  marker absent + material `null` ⇒ genuinely empty ⇒ `undefined`. (The existing
  `__index` entry already tracks logical key presence without auth and may be
  reusable as the marker, avoiding a second write.)
- Probe `SecureStore.canUseBiometricAuthentication()` / availability to
  distinguish "device can't satisfy the prompt right now" from "slot empty".

Must preserve today's defaults (ungated identity slot keeps working exactly as
now — no marker-driven false `KeyStoreAccessError` on a true first launch).

Also required when this lands (per implement gap #3): add
`NSFaceIDUsageDescription` to `app.json` before any slot enables
`requireAuthentication`, and note the Expo Go limitation in code/docs.

## Out of scope

Enabling biometric gating itself / choosing which slots are gated — this ticket
only makes gating *safe to enable*. Update `docs/architecture.md`
("Mobile secure backend" → biometric-invalidation bullet) to reflect the chosen
guard once built.
