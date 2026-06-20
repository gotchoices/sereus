description: A phone no longer silently mints a brand-new device identity when a fingerprint/Face-ID change wipes its locked-down storage slot — the store now tells "slot used to hold something but reads blank" apart from "slot was always empty" and fails closed on the former.
prereq:
files: packages/reference-app-rn/src/secure-key-store.ts, packages/reference-app-rn/test/secure-key-store.spec.ts, packages/reference-app-rn/app.json, packages/cadre-core/src/cadre-node.ts, docs/architecture.md
difficulty: medium
----

## Summary of completed work

Added a gated-slot `null`-material discriminator to `SecureStoreKeyStore.get`
(`packages/reference-app-rn/src/secure-key-store.ts`). On a `null` material read:

- **Ungated slot** (`requireAuthentication !== true`, today's default and every
  shipped path) ⇒ `undefined`, verbatim today's behaviour.
- **Gated slot** ⇒ `gatedNullResult(keyId)` consults the unauthenticated
  `sereus.ks.__index` marker: keyId present ⇒ was-written-but-now-unreadable ⇒
  throw `KeyStoreAccessError` (fail-closed, no regeneration); keyId absent ⇒
  genuinely empty / first launch ⇒ `undefined`.

`CadreNode.resolveIdentityKey` (`cadre-core/src/cadre-node.ts:508-545`) regenerates
only on falsy bytes; a rejection short-circuits, so the gated-slot throw propagates
without orphaning the device's real Ed25519 identity. No cadre-core change was made.

Also: `NSFaceIDUsageDescription` added to `app.json` (prerequisite for ever enabling
gating); JSDoc + `docs/architecture.md` updated. Gating remains **off** everywhere —
no `requireAuthentication` default was introduced (`cadre-phone.ts:74` ships ungated).

## Review findings

### Reviewed (what was checked)

- **Implement diff read first, fresh eyes** (`git show 76d10c2`): the only behavioural
  change is the `get` `null`-branch split + new private `gatedNullResult`. `set`,
  `delete`, `readIndex`, `mutateIndex`, `list`, `migrateLegacyIdentity` untouched —
  confirmed against the source, matching the "out of scope" contract.
- **End-to-end regeneration contract** (`cadre-node.ts:508-545`): `await keyStore.get`
  → generates only on falsy bytes; a rejection (the gated throw) short-circuits before
  `generateKeyPair`. Contract holds; no cadre-core edit needed. ✅
- **Ungated path byte-for-byte unchanged**: `this.options.requireAuthentication !== true`
  covers unset / `false` / `true` correctly (constructor only forwards the field when
  defined). The ungated index-orphan canary (`spec:288`) and access-vs-absence tests
  (`spec:177-213`) pass unchanged. ✅
- **Marker can't prompt or self-invalidate**: `gatedNullResult` reads the index via
  `readIndex()` → `indexOptions()`, which drops `requireAuthentication`. The
  guard-probe test (`spec:262`) asserts the index read forwards `keychainAccessible`
  but never `requireAuthentication`. ✅
- **Fail-closed on unknown index state**: an index read throw inside the guard
  propagates as `KeyStoreAccessError` (`spec:271`). ✅
- **Clean-delete and true-first-launch** both yield `undefined` (index pruned / absent)
  — `spec:251`, `spec:277`. ✅
- **app.json** is valid JSON; `NSFaceIDUsageDescription` correctly nested under
  `expo.ios.infoPlist`. **docs/architecture.md** Access-vs-absence + Biometric-
  invalidation bullets reflect the new fail-closed behaviour and the residual window.
  `cadre-phone.ts` comments still accurately describe the ungated default. ✅
- **Validation**: `yarn workspace @serfab/reference-app-rn test` → **130 passed**;
  `typecheck` → exit 0; `eslint` on both changed files → exit 0.

### Found & fixed inline (minor)

- **Multi-slot independence was reasoning-only, lightly tested** (implementer flag #4).
  Added a test (`spec` gated-discriminator block) exercising two gated slots over the
  single shared `__index`: a written-then-invalidated slot fails closed while a
  never-written slot returns `undefined`, proving per-keyId discrimination despite the
  shared marker. Tests 129 → 130, all green.

### Found, NOT fixed — accepted as documented (no new ticket)

- **Device behaviour assumed, not verified** (flag #1): the premise "Expo resolves a
  biometric-invalidated gated entry to `null`, not a throw" comes from Expo docs, not a
  device run. Both outcomes are safe — a throw hits the existing catch → `KeyStoreAccessError`;
  the `null` discriminator is only as correct as the premise. Acceptable: gating ships
  **off**, so this branch never executes in production today. A real-device smoke test is
  required before anyone flips `requireAuthentication: true` — noted below, not blocking.
- **Residual window** (flag #2): a prior-session `set` interrupted between material and
  index writes, *then* a later invalidation, leaves `material null + index absent` ⇒
  `undefined` ⇒ regeneration. Strictly no worse than the pre-guard status quo (where
  *every* gated invalidation regenerated). The alternative (marker-before-material) would
  permanently wedge a fresh slot whose `set` crashed before the material write — a worse
  failure mode. Trade-off reviewed and agreed; documented in `gatedNullResult` JSDoc.
- **Zero production runtime coverage** (flag #3): the entire `requireAuthentication === true`
  branch is a latent safety net; nothing ships gated. By design (spec forbids enabling
  gating). The `NSFaceIDUsageDescription`-crash-without-it claim is likewise from docs.

### Pre-existing-test failures

None. Full reference-app-rn suite green before and after this pass.

### Not done / deferred (out of band, not agent-runnable)

- **Real iOS/Android device smoke test** of a biometric-invalidated gated read. Cannot
  be exercised by unit tests (the in-memory `FakeSecureStore` models `null`-on-
  invalidation by construction) and is not agent-runnable. This is a gate *before*
  enabling gating, not before merging the guard — the guard is dormant until then.

### Verdict

Implementation is correct, minimal, and matches its spec (guard added; gating stays
off; `set`/`delete` untouched). The honest flags are genuine and appropriately scoped —
all reduce to "this latent branch needs a device run before activation," which is correct
and not a defect in the dormant code. One minor coverage gap closed inline. No major
findings; no new tickets warranted.
