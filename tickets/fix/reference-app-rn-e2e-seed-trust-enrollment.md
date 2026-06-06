description: The RN reference-app Maestro e2e applies a drone-signed seed under the new secure-default seed-trust policy without pinning the drone's authority key, so the cold-start phone may reject it. Thread an enrollment CadreInvite from the drone fixture through the e2e orchestrator into the Seed Bootstrap flow so the seed-apply step is deterministic instead of relying on a control-sync race.
files: packages/reference-app-rn/test-fixture/start.mjs, packages/reference-app-rn/scripts/run-e2e.mjs, packages/reference-app-rn/maestro/_setup.yaml, packages/reference-app-rn/src/test-ids.ts, packages/reference-app-rn/src/cadre-phone.ts, packages/cadre-core/src/seed-bootstrap.ts

## Background

`seed-trust-coldstart-cadrenode-seam` made `dbAnchoredTrustPolicy()` the secure default for
`CadreNode.applySeed`: a signature-verified seed is only accepted when its `signerKey` is already in
the receiver's `CadreControl.AuthorityKey` table (or pinned out-of-band). `seed-trust-coldstart-refapp-rn`
wired the **manual** escape hatch into the phone UI — a "Paste enrollment invite (for trust)" field
(`input-enroll-invite`) whose `CadreInvite.authorityKeys` are pinned via `pinnedKeyTrustPolicy` for one
`applySeed` call. The phone sets no `seedTrustPolicy` (`packages/reference-app-rn/src/cadre-phone.ts`),
so it runs on the secure default.

The **automated** Maestro e2e was not updated to match. The drone test fixture
(`test-fixture/start.mjs`) generates its **own** authority keypair (`randomBytes(32)`), signs the seed
with it, and writes only `{ partyId, droneBootstrapAddr, seed, strandId }` to `test-data.json` — no
invite / authority key. The phone runs `runAuthorityGenesis` with its **own** device key, so its
`AuthorityKey` table contains the phone's key, not the drone's. `maestro/_setup.yaml` then pastes
`${SEED}` and asserts the `"Seed applied"` modal.

## Problem

Under the secure default the phone does not trust the drone's signer key at apply time unless the
drone's `AuthorityKey` row has already replicated to the phone's control DB over the just-established
connection. That replication is a **race** against the manual "Apply Seed" tap (the flow waits only for
`btn-disconnect`, i.e. node-started, not for control-sync). If the row has not landed, the modal shows
`"Seed failed: Signer key is not a known authority (DB-anchored trust policy)"` and the
`_setup.yaml` assertion at the seed step fails — taking all three e2e flows with it (they share
`_setup.yaml`).

This was **not caught**: the refapp-rn implement/review passes could only run typecheck + lint; the
Maestro e2e needs a device/emulator + relay and was deferred. So the regression risk is unverified, not
ruled out. Even if control-sync currently wins the race by luck of timing, the e2e should not depend on
it — it should exercise the cold-start trust path the feature added.

## Requirements

- The e2e seed-apply step must be **deterministic** under the secure-default trust policy — no reliance
  on control-sync timing.
- The drone fixture must emit an out-of-band trust anchor for its own authority, and the phone e2e flow
  must pin it before applying the seed, using the existing `input-enroll-invite` field.
- All three Maestro flows (`1-connect-and-send`, `2-drone-to-phone`, `3-round-trip`) must pass via the
  shared `_setup.yaml`.

## Specification / suggested approach

- **`test-fixture/start.mjs`** — after `node.initializeSeedBootstrap(authorityPrivateKey)`, mint a
  `CadreInvite` for the drone's own authority and export it. `SeedBootstrapService.createInvite`
  populates `CadreInvite.authorityKeys` from `controlDatabase.getAuthorityKeys()`
  (`packages/cadre-core/src/seed-bootstrap.ts:824`). **Verify the drone's authority key is actually
  enrolled in its control DB** in this fixture setup (`profile: 'storage'`, in-memory storage, no
  explicit genesis call) — if `getAuthorityKeys()` returns empty, `authorityKeys` is `undefined` and the
  invite is useless; the fixture must enroll/genesis the drone authority first (mirror how the phone's
  `runAuthorityGenesis` populates its table, or whatever the seam/cli path does). Add the encoded invite
  to `test-data.json`, e.g. `enrollInvite: node.encodeInvite(invite)`.
- **`scripts/run-e2e.mjs`** — map `testData.enrollInvite` into `maestroEnv` as `ENROLL_INVITE` (next to
  `SEED` at line ~216).
- **`maestro/_setup.yaml`** — before the existing apply-seed tap, `tapOn: { id: "input-enroll-invite" }`,
  `inputText: ${ENROLL_INVITE}`, `hideKeyboard`. The "Seed applied" assertion then holds because the
  drone's key is pinned. (The success modal copy becomes `"Pinned N authority key(s); ..."`; the
  assertion only checks the title `"Seed applied"`, so it still matches — confirm.)
- Re-run the full Maestro suite on a device/emulator with the relay/drone fixture and confirm all three
  flows pass. This validation is **not** agent-runnable headless — it needs the device + relay harness.

## Acceptance

- `node packages/reference-app-rn/scripts/run-e2e.mjs` (with the device/emulator + relay prerequisites)
  runs all three flows green, with the seed-apply step pinning the drone authority via the enrollment
  invite rather than relying on control-sync timing.
