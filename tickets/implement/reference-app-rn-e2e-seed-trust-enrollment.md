description: Make the RN reference-app Maestro e2e seed-apply step deterministic under the secure-default seed-trust policy. The drone fixture must enroll its own authority key and emit a CadreInvite; the e2e orchestrator threads that invite into _setup.yaml so the phone pins the drone's authority before applying the seed — instead of racing control-sync.
prereq:
files: packages/cadre-core/src/authority-key.ts, packages/cadre-core/src/index.ts, packages/reference-app-rn/test-fixture/start.mjs, packages/reference-app-rn/scripts/run-e2e.mjs, packages/reference-app-rn/maestro/_setup.yaml, packages/reference-app-rn/src/test-ids.ts, packages/reference-app-rn/app/settings.tsx, packages/reference-app-rn/src/use-cadre.ts, docs/reference-app-rn.md

## Root cause (confirmed by code read)

Under `seed-trust-coldstart-cadrenode-seam`, `CadreNode.applySeed` defaults to
`dbAnchoredTrustPolicy()` (`SeedBootstrapService` constructor,
`packages/cadre-core/src/seed-bootstrap.ts:171`): a signature-verified seed is accepted only when its
`signerKey` is already enrolled in the receiver's `CadreControl.AuthorityKey` table, or a per-call
`pinnedKeyTrustPolicy` override is supplied.

The drone test fixture (`packages/reference-app-rn/test-fixture/start.mjs:60`) generates a standalone
authority keypair (`randomBytes(32).toString('base64url')`), distinct from its libp2p peer identity.
It calls **only** `node.initializeSeedBootstrap(authorityPrivateKey)` (`start.mjs:97`) — which derives
`authorityPublicKey = getPublicKey(authorityPrivateKey, …)` for *signing* but **never enrolls that key
into the control DB**. There is no `ensureAuthorityKey` / genesis call in the fixture (contrast the
phone's `runAuthorityGenesis`, `packages/reference-app-rn/src/cadre-phone.ts:176`, and the CLI's
`--authority` path, `packages/cadre-cli/src/commands/start.ts:261`, both of which call
`controlDb.ensureAuthorityKey(publicKeyB64)`).

Two consequences:

1. The seed the drone signs has `signerKey` = the drone authority public key, which is **not** in the
   phone's `AuthorityKey` table at apply time (the phone enrolled only its own device key via
   `runAuthorityGenesis`). The secure default therefore rejects it unless the drone's `AuthorityKey`
   row has already replicated over the freshly-established control connection — a **race** against the
   manual "Apply Seed" tap (the flow waits only for `btn-disconnect`, i.e. node-started, not for
   control-sync). On a miss the modal shows `"Seed failed: Signer key is not a known authority
   (DB-anchored trust policy)"` and the shared `maestro/_setup.yaml` assertion fails, taking all three
   e2e flows down.

2. Even the intended escape hatch is currently broken in the fixture: `SeedBootstrapService.createInvite`
   populates `CadreInvite.authorityKeys` from `controlDatabase.getAuthorityKeys()`
   (`seed-bootstrap.ts:824`). Because the drone never enrolled its key, `getAuthorityKeys()` returns an
   empty set, so `authorityKeys` would serialize as `undefined` — an invite that pins nothing. The
   fixture **must enroll the drone authority first**, then mint the invite.

The phone UI side is already wired (`seed-trust-coldstart-refapp-rn`): the `input-enroll-invite` field
(`TEST_IDS.settings.enrollInviteInput` → `'input-enroll-invite'`) feeds
`cadre.authorityKeysFromInvite(...)` → `applySeed(seed, pins)` →
`pinnedKeyTrustPolicy(pins)` for one apply call (`app/settings.tsx:59`, `src/use-cadre.ts:170`). The
success modal title stays `"Seed applied"` (`settings.tsx:71`); only the body text changes to
`"Pinned N authority key(s); …"`. The `_setup.yaml` assertion checks only `modal-title` text
`"Seed applied"`, so it still matches. The automated e2e was simply never updated to paste an invite.

## Fix

Make the seed-apply step deterministic by giving the drone a real, enrolled authority and threading its
invite through the orchestrator into `_setup.yaml`, so the phone pins the drone authority before the
apply tap — exercising the cold-start trust path the feature added rather than relying on control-sync
timing.

### Deriving the drone authority public key

The drone's authority key is a raw base64url Ed25519 seed, **not** a libp2p `PrivateKey`, so
`authorityKeyFromLibp2p` (which needs a libp2p key object) does not apply here. The public key must be
derived from the raw seed via the crypto plugin's `getPublicKey` — exactly what the
`SeedBootstrapService` constructor already does internally (`seed-bootstrap.ts:175`).

`@optimystic/quereus-plugin-crypto` is **not** a direct dependency of `@serfab/reference-app-rn`
(`packages/reference-app-rn/package.json` lists `@serfab/cadre-core` and `@optimystic/db-p2p*` only),
so importing `getPublicKey` directly in `start.mjs` is fragile. Instead add a small, reusable,
already-tested-pattern helper to `@serfab/cadre-core` next to `authorityKeyFromLibp2p` and export it:

```ts
// packages/cadre-core/src/authority-key.ts
import { getPublicKey } from '@optimystic/quereus-plugin-crypto';

/**
 * Derive the base64url Ed25519 public key from a base64url 32-byte private seed
 * — the same derivation the seed-bootstrap signer uses. Use this to enroll a
 * standalone (non-libp2p) authority key into the control DB before minting an
 * invite, when the authority key is not the node's peer identity.
 */
export function authorityPublicKeyFromPrivate(privateKeyB64: string): string {
  return getPublicKey(privateKeyB64, 'ed25519', 'base64url', 'base64url') as string;
}
```

Export it from `packages/cadre-core/src/index.ts` alongside `authorityKeyFromLibp2p`
(`index.ts:14`).

### Fixture enrollment + invite (`test-fixture/start.mjs`)

After `node.initializeSeedBootstrap(authorityPrivateKey)` (line 97), enroll the drone authority into its
own control DB, then mint the invite. `CadreNode.createInvite` already returns `{ invite, encodedInvite }`
(`cadre-node.ts:1406`, `seed-bootstrap.ts:842`) — use `encodedInvite` directly (no separate
`encodeInvite` call needed):

```js
import { CadreNode, authorityPublicKeyFromPrivate } from '@serfab/cadre-core';
// …
node.initializeSeedBootstrap(authorityPrivateKey);

// Enroll the drone's own authority key so a cold-start invitee can pin it
// out-of-band. Without this, getAuthorityKeys() is empty and the minted
// invite carries no authorityKeys (undefined) — useless for trust anchoring.
const authorityPublicKey = authorityPublicKeyFromPrivate(authorityPrivateKey);
const controlDb = node.getControlDatabase();
if (!controlDb) throw new Error('Control database unavailable; cannot enroll drone authority');
await controlDb.ensureAuthorityKey(authorityPublicKey);

// Mint an enrollment invite carrying the drone authority key out-of-band.
const { encodedInvite } = await node.createInvite();
```

Add it to `test-data.json`:

```js
const testData = {
  partyId: PARTY_ID,
  droneBootstrapAddr: bootstrapAddr,
  seed: encodedSeed,
  strandId,
  enrollInvite: encodedInvite,
};
```

Order matters: `ensureAuthorityKey` must run **before** `createInvite` (so `getAuthorityKeys()` is
non-empty), and both after `initializeSeedBootstrap` (createInvite lives on the seed-bootstrap service).
The existing `createSeed()` call can stay where it is — its `signerKey` is the same authority key, now
enrolled and pinnable.

### Orchestrator env mapping (`scripts/run-e2e.mjs`)

Map `testData.enrollInvite` into `maestroEnv` as `ENROLL_INVITE`, next to `SEED` (around line 216):

```js
const maestroEnv = {
  PARTY_ID: testData.partyId,
  BOOTSTRAP_ADDR: testData.droneBootstrapAddr,
  SEED: testData.seed,
  ENROLL_INVITE: testData.enrollInvite,
  STRAND_ID: testData.strandId,
  SIDECAR_URL,
  MAESTRO_APP_ID,
};
```

(`envArgs` already maps every `maestroEnv` entry to `-e KEY=VALUE`, so no further wiring is needed.)

### Maestro setup (`maestro/_setup.yaml`)

Before the existing apply-seed tap (line 45), paste the enrollment invite into `input-enroll-invite`:

```yaml
# ── Apply seed ────────────────────────────────────────────────────────────
- tapOn:
    id: "input-seed"
- inputText: ${SEED}
- hideKeyboard
# Pin the drone's authority out-of-band so the cold phone trusts the seed's
# signer under the secure-default policy (no control-sync race).
- tapOn:
    id: "input-enroll-invite"
- inputText: ${ENROLL_INVITE}
- hideKeyboard
- tapOn:
    id: "btn-apply-seed"
- assertVisible:
    id: "modal-title"
    text: "Seed applied"
```

The success-modal body becomes `"Pinned 1 authority key(s); peer cache updated"`, but the assertion only
checks the `modal-title` text `"Seed applied"` — unchanged, so it still passes.

## Notes / decisions

- **Why not make the drone reuse its libp2p identity as the authority key** (like the CLI/phone)? That
  would let it use `authorityKeyFromLibp2p` and skip the new helper, but the fixture deliberately uses a
  separate random authority key and the node was constructed without an explicit `privateKey` (no
  accessor to pull it back out). Keeping the standalone authority key + deriving its public key is the
  smaller, lower-risk change.
- **Optional regression guard** (cheap, agent-runnable): the existing
  `packages/cadre-core/test/invite-address-push.spec.ts` already drives `initializeSeedBootstrap` /
  `createInvite` without a live network. Consider an analogous assertion that, after
  `ensureAuthorityKey(pub)`, `createInvite().invite.authorityKeys` includes `pub` (and is `undefined`
  without enrollment). This locks the fixture invariant in a unit test even though the full e2e isn't
  agent-runnable.
- Update `docs/reference-app-rn.md` where it describes the e2e seed-apply / trust flow to mention the
  enrollment-invite pin step.

## TODO

- [ ] Add `authorityPublicKeyFromPrivate(privateKeyB64)` to
  `packages/cadre-core/src/authority-key.ts` and export it from
  `packages/cadre-core/src/index.ts`.
- [ ] `test-fixture/start.mjs`: import the helper; after `initializeSeedBootstrap`, derive the public
  key, `await controlDb.ensureAuthorityKey(authorityPublicKey)`, then `await node.createInvite()` and
  add `enrollInvite: encodedInvite` to `test-data.json`.
- [ ] `scripts/run-e2e.mjs`: add `ENROLL_INVITE: testData.enrollInvite` to `maestroEnv`.
- [ ] `maestro/_setup.yaml`: tap `input-enroll-invite`, `inputText: ${ENROLL_INVITE}`, `hideKeyboard`
  before the `btn-apply-seed` tap.
- [ ] (Optional) Add a cadre-core unit test asserting `createInvite` carries the enrolled authority key
  (mirroring `invite-address-push.spec.ts`).
- [ ] Update `docs/reference-app-rn.md` to document the enrollment-invite pin in the e2e seed step.
- [ ] Validate: `yarn workspace @serfab/cadre-core build` + `yarn workspace @serfab/cadre-core test`
  (helper + optional unit test); typecheck/lint the reference-app-rn package
  (`yarn workspace @serfab/reference-app-rn typecheck` / `lint`).
- [ ] **Deferred (not agent-runnable — needs device/emulator + relay/drone harness):**
  `node packages/reference-app-rn/scripts/run-e2e.mjs` and confirm all three flows
  (`1-connect-and-send`, `2-drone-to-phone`, `3-round-trip`) pass with the seed-apply step pinning the
  drone authority via the invite. Hand to a human / CI.
