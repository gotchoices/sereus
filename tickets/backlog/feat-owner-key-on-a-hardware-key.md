description: Let an owner key live on a hardware key (YubiKey) or in a phone's hardware vault, signing on request, through the owner signer seam that `owner-signer-seam` adds.
prereq: owner-signing-through-one-signer, reference-app-rn-owner-keys
files: packages/cadre-core/src/key-store.ts, packages/cadre-rn/src, packages/reference-app-rn/src, packages/reference-app-web/src, packages/cadre-cli/src/commands
----

# Owner key on a hardware key or hardware vault

The owner signer seam takes a sign-on-request backend; this ticket adds the hardware ones. Needs real devices to verify, which is why it is not in the first pass.

- **YubiKey.** Ed25519 is available through FIDO2 (EdDSA, firmware 5.2+) and PIV (firmware 5.7+). FIDO2 signs a WebAuthn assertion rather than an arbitrary payload, so the signed bytes the control schema verifies would have to be the assertion's; decide between PIV (raw Ed25519 signature, narrower firmware support) and FIDO2 (wider support, a different verification path in the schema). Platforms: desktop (cadre-cli, web via WebAuthn) and phone (NFC / USB-C).
- **Phone hardware vault.** Android Keystore signs Ed25519 in hardware on newer devices; iOS Secure Enclave signs P-256 only, so the first pass keeps the Ed25519 key in the Keychain under hardware-backed access control. Moving to keys that never leave the hardware on iOS would need P-256 owner keys; decide whether that is worth a second algorithm in `OwnerKey`.
- Each signing prompt names the party (`control-approvals-bound-to-party`).

## What the software-only pass left for a prompting signer

From the owner-key implement tickets (`owner-signer-seam`, `owner-signing-through-one-signer`):

- **Background owner writers sign with no user present**: `JoinedStrand` publication, the pending-join runner, the `Revocation` re-issue drain, the self-row insert in `registerSelf`, the device-token publish. A signer that prompts needs a flag on `OwnerSigner` saying whether it may sign unattended, and these writers must skip (and say so) or queue for the app when it may not.
- **The write lock is held across signing**, because each `ControlDatabase` writer reads the stamps it signs inside its lock, and `lockedWithRetry` re-signs on retry. A prompt inside the lock stalls every other control write on that node (`NOTE:` at the signing callback alias). Signing outside the lock with a stamp re-check may be needed.
- **One `approve` per action** assumes the backend can hold the user's presence for several signatures (PIV touch cache, Keychain `touchIDAuthenticationAllowableReuseDuration`, Android Keystore authentication validity). FIDO2 asks for a touch per assertion, which is a second reason (beside the assertion format) it may not fit.
- **The phone's owner slot is ungated** (no `requireAuthentication`) for the background writers above; gating it is part of this ticket.

