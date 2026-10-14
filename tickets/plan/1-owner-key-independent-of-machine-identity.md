description: An owner key is a credential a person holds, independent of any machine, but today a machine's owner key is the key behind its peer id. Separate them in the schema, the owner writers, machine removal, strand founder-ness, key storage, the CLI and the test harness, so a user can hold several owner keys (phone vault, OS vault, hardware key, file/QR backup) and no machine is an owner by virtue of its identity.
files: schemas/control.qsql, packages/cadre-core/src/control-schema.ts, packages/cadre-core/src/control-database.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/machine-removal.ts, packages/cadre-core/src/ed25519-key.ts, packages/cadre-core/src/key-store.ts, packages/cadre-core/src/seed-bootstrap.ts, packages/cadre-rn/src/key-store.ts, packages/cadre-cli/src/commands/start.ts, packages/cadre-cli/src/commands/enroll.ts, packages/cadre-cli/src/commands/enroll-add.ts, packages/integration-tests/src/harness/test-party.ts, packages/reference-app-rn/src, packages/reference-app-web/src, docs/architecture.md
----

# Owner keys are independent of machine identity

## The design (decided by the project owner)

- **An owner key is something a person possesses.** Holding it gives the right to admit or invite machines into a cadre and to add or remove other owner keys. The set of owner keys lives in the control database (`OwnerKey`).
- **Owner keys are independent of machines.** A machine's network identity (its libp2p key, behind its peer id) is never an owner key, and an owner key is never derived from one. A phone that holds an owner key holds it as a separate key beside its node identity.
- **A user may hold several.** Typically one on the phone plus backups.
- **Where an owner private key lives:** the phone's hardware vault, a hardware key such as a YubiKey, the OS vault (Keychain, Android Keystore, Windows DPAPI/Credential Manager, libsecret), or a file / QR code the user keeps.
- **Servers do not normally hold one.** A server holds an owner key only when the user deliberately adds one to it. Nothing in the product does that on the user's behalf.

This replaces the rule in `docs/architecture.md` ("A machine's owner key is the key behind its peer id") and the single-key model in "Node Key Material & the KeyStore Seam" (owner key derived from the identity key via `ed25519KeyPairFromLibp2p`). No backward compatibility is needed: existing cadres are not migrated.

## Where the code diverges today

- `OwnerKey` row and "Removing a machine" in `docs/architecture.md` state the conflation as a rule.
- `CadreNode.addOwner` takes the key behind a peer id rather than an owner public key.
- `ControlDatabase.removeMachine` deletes the machine's `OwnerKey` row with its `CadrePeer` row (`machine-removal.ts`).
- `Strand.FounderOwnerKey` is documented as recording which *machine* published the row, and a launch derives founder-ness by comparing it with "its own owner key" (`docs/architecture.md`, Strand Membership Bootstrap). With independent keys this no longer identifies a machine.
- `registerSelf` / `insertSelfPeerRecord` assume an owner node writes its own `CadrePeer` row with its own key.
- cadre-cli `--owner` (`start.ts`, `enroll.ts`, `enroll-add.ts`) turns the node's libp2p identity into an owner key (`ownerKeyFromLibp2p`).
- `test-party.ts`: "The owner node MUST adopt the owner keypair as its libp2p identity."
- Reference apps: "its owner key is removed too" on machine removal; the RN approval prompt shows "this device's owner fingerprint", assuming one key per device.

## Decisions for this pass

- **Owner signing goes through a sign-on-request seam, not raw key material.** A hardware key or hardware vault never exports its private key, so `KeyStore.get` (which returns bytes) cannot be the owner-key interface. Add an owner signer seam (public key, party-bound `sign(payload)`), with a software implementation over the existing `KeyStore` (separate slot from `cadre/identity`) and a file/QR implementation. Every owner-signed action must work as one prompted signature, because a YubiKey signs only on request, often with a touch.
- **Algorithm stays Ed25519.** Where the platform's hardware does not sign Ed25519 (iOS Secure Enclave is P-256 only), the phone keeps the Ed25519 private key in the OS vault under hardware-backed access control, rather than changing the owner-key algorithm. Hardware-key adapters are `backlog/feat-owner-key-on-a-hardware-key`; this pass only has to leave the seam able to take them.
- **File / QR export.** An owner key can be exported once to a file or QR code and imported on another device. The export is the private key, so the apps must say so plainly and should offer passphrase encryption of the file form; decide the encoding in the plan (reuse the existing invitation/QR encoding where possible).
- **Machine admission.** Every machine, phones included, is admitted by an owner signature over its `CadrePeer` row (or by a machine invitation), never because its own key is an owner. A phone that holds an owner key signs its own machine's row with that owner key.
- **Machine removal does not touch `OwnerKey`.** Removing a lost phone that held an owner key needs an explicit owner-key removal; the apps offer it next to machine removal instead of doing it implicitly.
- **Owner-key labels.** `OwnerKey` gains an optional user-supplied label ("phone", "YubiKey", "paper backup") so the apps can list keys; the control database cannot know where a key is kept, only what the user said.
- **Strand founder-ness.** `FounderOwnerKey` stays "the owner key that signed the insert" (provenance). The "this machine founds" decision gets a machine-scoped signal; choose it in the plan (for example the publishing machine's peer id on the row, pinned to the `CadrePeer` row the signer vouched for).
- **cadre-cli `--owner`** becomes the deliberate "add an owner key to this server" path: it generates or imports an owner key separate from the node identity and is labelled as such. Tests may keep using it as a founder.
- **Signing prompts name the party.** Every owner-signed approval binds the party id (`control-approvals-bound-to-party`), and one owner key can own several cadres, so a prompt shows which cadre it is for.

## Edge cases & interactions (for the plan to carry into implement tickets)

- The last owner key: `MinOneOwner` and "removal refused when the signer would remove itself or the last live owner" still hold; removing a machine can no longer empty the owner table, so check whether any path relied on that.
- The trusted-owner anchor (`owner-anchor-follows-owner-key-changes`) follows `OwnerKey` chains; it must not assume an owner key maps to a peer id anywhere (seed delivery, `ownerKeys` in invitations, push-wake trust gates in `push-wake-e2e.integration.ts`).
- A device with no owner key at all (an always-on node, a joined phone that is not an owner) must work everywhere it does today.
- One owner key on two devices (imported from QR) signing concurrently.
- `backlog/debt-owner-key-add-while-alone-has-no-reissue`: adding a backup key often happens on one device; its choice (refuse while alone) should land with or before this.
- `blocked/decide-non-owner-machine-completes-a-pending-join` option A (pre-approval signed by the owner device) is compatible.
- `blocked/decide-owner-recovery` shrinks once backup keys and owner grants exist; note it in that ticket when this lands.

## TODO (plan stage)

- Write the design above into `docs/architecture.md`, replacing the single-key model and the "machine's owner key" rule.
- Split into implement tickets sized to one run each, chained by `prereq:`: (a) owner signer seam + software/file/QR backends; (b) schema (`OwnerKey` label, founder-machine signal) and owner writers (`addOwner` by public key, `removeMachine` leaves owner keys); (c) machine admission and `registerSelf` under owner signing; (d) cadre-cli `--owner` and the integration harness; (e) reference apps: owner-key list, export/import, removal prompt.
