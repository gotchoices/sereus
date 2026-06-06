description: REVIEW — The RN reference-app Maestro e2e seed-apply step is now deterministic under the secure-default seed-trust policy (`dbAnchoredTrustPolicy`). The drone fixture enrolls its own authority key and mints a `CadreInvite` carrying it; `run-e2e.mjs` threads that invite as `ENROLL_INVITE` and `_setup.yaml` pastes it into `input-enroll-invite` before tapping Apply Seed, so the cold phone pins the drone authority out-of-band instead of racing control-sync. A new `authorityPublicKeyFromPrivate` helper in cadre-core derives the standalone authority public key. cadre-core build + full test suite (338) green; reference-app-rn typecheck green; eslint on touched files clean. The full three-flow Maestro e2e is NOT agent-runnable (needs emulator + drone) and was deferred.
prereq:
files: packages/cadre-core/src/authority-key.ts, packages/cadre-core/src/index.ts, packages/cadre-core/test/authority-key.spec.ts, packages/reference-app-rn/test-fixture/start.mjs, packages/reference-app-rn/scripts/run-e2e.mjs, packages/reference-app-rn/maestro/_setup.yaml, docs/reference-app-rn.md
----

# Review: RN e2e seed-trust enrollment

The shared Maestro `_setup.yaml` seed-apply assertion was racing control-sync:
under `dbAnchoredTrustPolicy` (the secure default since
`seed-trust-coldstart-cadrenode-seam`) the cold phone accepts a seed only if the
signer key is already enrolled in its `AuthorityKey` table. The drone fixture
signed with a standalone authority key it **never enrolled**, so the phone could
only accept the seed if the drone's `AuthorityKey` row had already replicated
over the freshly-established control connection — and the flow waits only for
node-started (`btn-disconnect`), not control-sync. On a miss the apply modal
showed `"Seed failed: Signer key is not a known authority …"` and all three e2e
flows went down.

The phone UI side (the `input-enroll-invite` field → `authorityKeysFromInvite`
→ `pinnedKeyTrustPolicy` for one apply) was already wired by
`seed-trust-coldstart-refapp-rn`; the automated e2e simply never pasted an
invite, and the drone's invite carried no `authorityKeys` anyway.

## What changed

### cadre-core (the reusable seam)

- **`authority-key.ts`** — new `authorityPublicKeyFromPrivate(privateKeyB64)`:
  derives the base64url Ed25519 public key from a base64url 32-byte seed via the
  crypto plugin's `getPublicKey` — the *same* derivation
  `SeedBootstrapService`'s constructor does internally
  (`seed-bootstrap.ts:175`). This is the standalone-key analogue of
  `authorityKeyFromLibp2p` (which needs a libp2p key object and so does not
  apply to the fixture's random authority seed).
- **`index.ts`** — exports the new helper alongside `authorityKeyFromLibp2p`.

### reference-app-rn fixture + orchestrator + Maestro

- **`test-fixture/start.mjs`** — after `initializeSeedBootstrap(authorityPrivateKey)`:
  derive the public key, fetch the control DB (throws loudly if unavailable),
  `await controlDb.ensureAuthorityKey(authorityPublicKey)`, then
  `await node.createInvite()` and write `enrollInvite: encodedInvite` into
  `test-data.json`. **Order matters**: enroll before mint (so
  `getAuthorityKeys()` is non-empty when `createInvite` reads it), both after
  `initializeSeedBootstrap` (createInvite lives on the seed-bootstrap service,
  and the node is already started so libp2p multiaddrs resolve). The existing
  `createSeed()` call is unchanged — its `signerKey` is the same authority key,
  now enrolled and pinnable.
- **`scripts/run-e2e.mjs`** — adds `ENROLL_INVITE: testData.enrollInvite` to
  `maestroEnv`. `envArgs` already maps every entry to `-e KEY=VALUE`, so no
  further wiring.
- **`maestro/_setup.yaml`** — before the `btn-apply-seed` tap: `tapOn`
  `input-enroll-invite`, `inputText ${ENROLL_INVITE}`, `hideKeyboard`. The
  success-modal **body** becomes `"Pinned 1 authority key(s); …"` but the
  assertion checks only the `modal-title` text `"Seed applied"`, which is
  unchanged — so it still passes. The env-var header comment block was updated
  to document `ENROLL_INVITE`.

### docs

- **`docs/reference-app-rn.md`** — Phase 2 (Scripted Integration): added
  `enrollInvite` to the test-data field list and a paragraph explaining the
  enroll → invite → `ENROLL_INVITE` → pin flow that makes the apply step
  deterministic. (The manual-flow "Cold-start trust" note at Step 4 was already
  present from `seed-trust-coldstart-refapp-rn`.)

## How to validate (use cases)

### Unit (ran green — added to `packages/cadre-core/test/authority-key.spec.ts`)

- **`authorityPublicKeyFromPrivate` derives the same public key as the
  seed-bootstrap signer** — asserts the helper output equals a direct
  `getPublicKey(priv, 'ed25519', 'base64url', 'base64url')`, locking the
  fixture's signer/enrolled-key agreement.
- **`authorityPublicKeyFromPrivate` produces a verifying public key** —
  sign-with-private / verify-with-derived-public round-trip.
- **`createInvite` includes the enrolled key in `invite.authorityKeys`** —
  drives a real `CadreNode` with libp2p + control DB stubbed (mirrors
  `invite-address-push.spec.ts`); after `ensureAuthorityKey(pub)`, the minted
  invite's `authorityKeys` contains `pub`.
- **`createInvite` leaves `authorityKeys` undefined without enrollment** — the
  regression that motivated the fix: empty `getAuthorityKeys()` ⇒ `undefined`
  ⇒ an invite that pins nothing.

### Build / typecheck / lint (all ran green)

- `yarn workspace @serfab/cadre-core build` — clean (exit 0).
- `yarn workspace @serfab/cadre-core test` — **338 passed (27 files)**,
  including the 4 new `authority-key.spec.ts` assertions described above.
- `yarn workspace @serfab/reference-app-rn typecheck` — clean (exit 0).
- `eslint` on the four touched lintable files (cadre-core src ×2, the spec, and
  `start.mjs`) — 0 errors. `run-e2e.mjs` sits under the `scripts/` ESLint ignore
  pattern (warning only, not linted); no per-package `lint` script exists for
  reference-app-rn.

### Suggested reviewer probes (not covered here)

1. **The standalone-key path end-to-end at the service layer.** The new unit
   tests stub the control DB. A heavier test that starts a real `CadreNode`,
   runs the fixture's enroll-then-mint sequence against a live control DB, and
   asserts `createInvite().invite.authorityKeys` contains the derived key would
   exercise `ensureAuthorityKey` + `getAuthorityKeys` for real (the stub asserts
   only the wiring). Lower value than the deferred e2e but worth weighing.
2. **`pinnedKeyTrustPolicy` actually accepts the pasted invite's key.** The
   phone-side `authorityKeysFromInvite → applySeed(seed, pins)` path
   (`use-cadre.ts:170`, `settings.tsx:59`) is RN/React with no unit harness in
   this repo; its only coverage is the Maestro flow. Confirm the decode →
   pin → one-shot-policy chain still matches the invite shape this fixture now
   emits (`authorityKeys: [drone-pub]`).

## Honest gaps / things for the reviewer to weigh

- **The full Maestro e2e was NOT run in-agent (deferred — not agent-runnable).**
  `node packages/reference-app-rn/scripts/run-e2e.mjs` needs an Android emulator
  with the dev-client APK, `adb`, the Maestro CLI, and the live drone fixture +
  relay harness. Hand to a human / CI: confirm all three flows
  (`1-connect-and-send`, `2-drone-to-phone`, `3-round-trip`) pass with the
  seed-apply step pinning the drone authority via `ENROLL_INVITE`. This is the
  real proof the race is gone; the unit tests only lock the fixture's
  invite-content invariant.
- **`ensureAuthorityKey` is idempotent / first-write-wins.** It no-ops if the
  control DB already has *any* authority key (`control-database.ts:335`). In the
  fixture the drone is a fresh in-memory node with an empty control DB, so the
  drone's own key is the genesis authority — correct here. Flagged only so the
  reviewer doesn't mistake it for a per-key enroll.
- **Assertion still only checks `modal-title`.** By design (keeps the assertion
  stable across the body-text change), but it means the e2e would NOT catch a
  regression where pinning silently degrades to zero keys yet the apply still
  somehow succeeds (e.g. policy fallback). The new cadre-core
  `authorityKeys`-undefined test is the guard against the empty-invite half of
  that; there is no e2e-level assertion on "pinned N".
- **Single drone authority key assumption.** The body text the implement ticket
  predicted is `"Pinned 1 authority key(s); …"`. If the fixture ever enrolls
  more than one authority, that count changes — harmless for the title-only
  assertion, but the doc/comment wording ("Pinned 1") would drift.
