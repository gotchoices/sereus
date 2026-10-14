description: Let an owner key live on a hardware key (YubiKey) or in a phone's hardware vault, signing on request, through the owner signer seam that `owner-key-independent-of-machine-identity` adds.
prereq: owner-key-independent-of-machine-identity
files: packages/cadre-core/src/key-store.ts, packages/cadre-rn/src, packages/reference-app-rn/src, packages/reference-app-web/src, packages/cadre-cli/src/commands
----

# Owner key on a hardware key or hardware vault

The owner signer seam takes a sign-on-request backend; this ticket adds the hardware ones. Needs real devices to verify, which is why it is not in the first pass.

- **YubiKey.** Ed25519 is available through FIDO2 (EdDSA, firmware 5.2+) and PIV (firmware 5.7+). FIDO2 signs a WebAuthn assertion rather than an arbitrary payload, so the signed bytes the control schema verifies would have to be the assertion's; decide between PIV (raw Ed25519 signature, narrower firmware support) and FIDO2 (wider support, a different verification path in the schema). Platforms: desktop (cadre-cli, web via WebAuthn) and phone (NFC / USB-C).
- **Phone hardware vault.** Android Keystore signs Ed25519 in hardware on newer devices; iOS Secure Enclave signs P-256 only, so the first pass keeps the Ed25519 key in the Keychain under hardware-backed access control. Moving to keys that never leave the hardware on iOS would need P-256 owner keys; decide whether that is worth a second algorithm in `OwnerKey`.
- Each signing prompt names the party (`control-approvals-bound-to-party`).
