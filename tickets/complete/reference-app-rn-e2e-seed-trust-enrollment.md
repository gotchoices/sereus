description: COMPLETE — The RN reference-app Maestro e2e seed-apply step is now deterministic under the secure-default seed-trust policy (`dbAnchoredTrustPolicy`). The drone fixture enrolls its own authority key and mints a `CadreInvite` carrying it; `run-e2e.mjs` threads it as `ENROLL_INVITE` and `_setup.yaml` pastes it into `input-enroll-invite` before tapping Apply Seed, so the cold phone pins the drone authority out-of-band instead of racing control-sync. A new `authorityPublicKeyFromPrivate` helper in cadre-core derives the standalone authority public key. Reviewed: build + full test suite (338) + reference-app-rn typecheck + eslint all re-run green; one minor docs paragraph-break fix applied inline. The full three-flow Maestro e2e remains NOT agent-runnable (needs emulator + drone) and is deferred to a human/CI.
prereq:
files: packages/cadre-core/src/authority-key.ts, packages/cadre-core/src/index.ts, packages/cadre-core/test/authority-key.spec.ts, packages/reference-app-rn/test-fixture/start.mjs, packages/reference-app-rn/scripts/run-e2e.mjs, packages/reference-app-rn/maestro/_setup.yaml, docs/reference-app-rn.md
----

# Complete: RN e2e seed-trust enrollment

The shared Maestro `_setup.yaml` seed-apply assertion was racing control-sync:
under `dbAnchoredTrustPolicy` (the secure default since
`seed-trust-coldstart-cadrenode-seam`) the cold phone accepts a seed only if the
signer key is already enrolled in its `AuthorityKey` table. The drone fixture
signed with a standalone authority key it never enrolled, so acceptance depended
on the drone's `AuthorityKey` row replicating over the freshly-established
control connection before the apply tap — which the flow never waits for.

## What shipped

### cadre-core (the reusable seam)

- **`authority-key.ts`** — new `authorityPublicKeyFromPrivate(privateKeyB64)`:
  derives the base64url Ed25519 public key from a base64url 32-byte seed via the
  crypto plugin's `getPublicKey` — the same derivation `SeedBootstrapService`'s
  constructor does internally. Standalone-key analogue of
  `authorityKeyFromLibp2p` (which needs a libp2p key object).
- **`index.ts`** — exports the new helper.

### reference-app-rn fixture + orchestrator + Maestro

- **`test-fixture/start.mjs`** — after `initializeSeedBootstrap`: derive the
  public key, fetch the control DB (throws if unavailable),
  `ensureAuthorityKey(authorityPublicKey)`, then `createInvite()` and write
  `enrollInvite: encodedInvite` into `test-data.json`. Enroll precedes mint;
  both follow init. The existing `createSeed()` is unchanged (same signer key,
  now enrolled).
- **`scripts/run-e2e.mjs`** — adds `ENROLL_INVITE: testData.enrollInvite` to
  `maestroEnv` (`envArgs` maps it to `-e KEY=VALUE`).
- **`maestro/_setup.yaml`** — before `btn-apply-seed`: tap `input-enroll-invite`,
  `inputText ${ENROLL_INVITE}`, `hideKeyboard`. Assertion still checks only the
  `modal-title` `"Seed applied"` (stable across the body-text change).

### docs

- **`docs/reference-app-rn.md`** — Phase 2: `enrollInvite` added to the
  test-data field list and a paragraph documenting the enroll → invite →
  `ENROLL_INVITE` → pin flow. (Review fixed two missing blank lines so the new
  block reads as its own paragraph rather than merging into the surrounding
  prose.)

## Review findings

### Scope reviewed

Read the full implement diff (`11c5970`) with fresh eyes before the handoff,
then traced every claim to source: the new helper, the fixture wiring order,
`ControlDatabase.ensureAuthorityKey`/`getAuthorityKeys`,
`SeedBootstrapService.createInvite`, the invite encode/decode path, the
phone-side `settings.tsx`/`use-cadre.ts` apply-seed chain, the
orchestrator env mapping, the Maestro `_setup.yaml`, and the docs. Aspect angles
considered: correctness, side effects, DRY, error handling, type safety,
serialization integrity, test coverage (happy/edge/regression), and docs
accuracy.

### Correctness — no issues found

- **Helper derivation is correct** and matches the seed-bootstrap signer's own
  derivation; the existing `getPublicKey`-equality test plus a sign/verify
  round-trip lock it.
- **Fixture ordering is correct**: `initializeSeedBootstrap` → derive →
  `ensureAuthorityKey` → `createInvite`. `getAuthorityKeys()` is non-empty when
  `createInvite` reads it, so the minted invite carries `authorityKeys`.
- **`createInvite` is read-only** (`seed-bootstrap.ts:799`): it reads multiaddrs
  + authority keys and JSON-encodes them. No persistence, no token consumption,
  no formation-invite row — safe to call during fixture bootstrap.
- **`ensureAuthorityKey` genesis semantics are correct for this use**
  (`control-database.ts:333`): first-write-wins, no-ops if any authority key
  already exists. The drone is a fresh in-memory node with an empty control DB,
  so its own key becomes the genesis authority — exactly as a real `--authority`
  CLI/phone node would. Enrolling the drone's own key also makes it report
  itself as an authority in `queryPeers` (`seed-bootstrap.ts:627`), which is
  more correct, not a regression.
- **Serialization is lossless**: `encodeInvite`/`decodeInvite` are
  `JSON.stringify` → base64url → `JSON.parse` (`seed-bootstrap.ts:919`), and
  `authorityKeys` is a plain `string[]` (`types.ts:725`), so it survives the
  round-trip. The phone reads it back via `decodeInvite(...).authorityKeys ?? []`
  (`use-cadre.ts:190`) into `pinnedKeyTrustPolicy`.
- **Phone UI wiring matches the new invite shape**: `handleApplySeed`
  (`settings.tsx:59`) decodes the pasted invite to pins and calls
  `applySeed(seed, pins)`; the field id `input-enroll-invite` exists
  (`test-ids.ts:14`) and is rendered in settings (`settings.tsx:173`).

### Tests — adequate; one documented overlap

- Re-ran `yarn workspace @serfab/cadre-core test`: **338 passed (27 files)**,
  including the 4 new `authority-key.spec.ts` assertions.
- The new CadreNode-level `createInvite` tests overlap with the pre-existing
  service-level `seed-bootstrap.spec.ts:983-1005` ("carries the AuthorityKey
  table" / "omits when empty"). Kept as-is: the new tests additionally exercise
  the `authorityPublicKeyFromPrivate` helper and the exact fixture sequence
  (helper → `ensureAuthorityKey` → `createInvite`) at the `CadreNode` layer,
  which the service-level tests do not. The redundancy is cheap and the coverage
  is at a different altitude — not worth churning.
- `ensureAuthorityKey` first-write-wins genesis is already independently covered
  by `control-database-genesis.spec.ts` (insert→true, repeat→false against a
  real control DB), so the invariant chain (genesis → `getAuthorityKeys` →
  `createInvite` → encode/decode → pin) is covered piecewise. The implementer's
  "suggested probe #1" (a single combined real-DB integration test) would be
  marginal and was not added.

### Minor finding — fixed inline

- **Docs paragraph breaks** (`docs/reference-app-rn.md`): the new trust-policy
  block was wedged into what markdown rendered as a single paragraph (no blank
  line before/after). Added two blank lines so it reads as its own paragraph.
  Prose-only; no semantic change.

### Major findings — none

No findings warranting a new fix/plan/backlog ticket. The implementation is
sound and the only genuinely-unverified surface (the live three-flow Maestro
e2e) is legitimately not agent-runnable, not a code defect.

### Validation re-run during review (all green)

- `yarn workspace @serfab/cadre-core build` — exit 0.
- `yarn workspace @serfab/cadre-core test` — **338 passed (27 files)**.
- `yarn workspace @serfab/reference-app-rn typecheck` — exit 0.
- `eslint` on the four touched lintable files — exit 0.

## Deferred (not agent-runnable — hand to a human / CI)

The full Maestro e2e (`node packages/reference-app-rn/scripts/run-e2e.mjs`)
needs an Android emulator with the dev-client APK, `adb`, the Maestro CLI, and
the live drone fixture + relay harness. Confirm all three flows
(`1-connect-and-send`, `2-drone-to-phone`, `3-round-trip`) pass with the
seed-apply step pinning the drone authority via `ENROLL_INVITE`. This is the
real proof the race is gone; the unit tests only lock the fixture's
invite-content invariant. The `modal-title`-only assertion would also not catch
a regression where pinning silently degrades to zero keys yet apply still
somehow succeeds — there is no e2e-level "pinned N" assertion (guarded on the
empty-invite half by the cadre-core `authorityKeys`-undefined test).
