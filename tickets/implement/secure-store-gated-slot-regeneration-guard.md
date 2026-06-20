description: Stop a phone from silently throwing away its real device identity and minting a fresh one when a fingerprint/Face-ID change invalidates the locked-down storage slot, by treating "slot used to hold something but now reads blank" as a read failure rather than an empty slot.
prereq:
files: packages/reference-app-rn/src/secure-key-store.ts, packages/reference-app-rn/test/secure-key-store.spec.ts, packages/reference-app-rn/app.json, packages/cadre-core/src/cadre-node.ts, docs/architecture.md
difficulty: medium
----

## Background

`SecureStoreKeyStore.get` (`packages/reference-app-rn/src/secure-key-store.ts`)
maps `expo-secure-store`'s `getItemAsync` as: **thrown** → `KeyStoreAccessError`,
**`null`** → `undefined`, **value** → bytes. `CadreNode.resolveIdentityKey`
(`packages/cadre-core/src/cadre-node.ts:508`) regenerates a fresh Ed25519 identity
**only** on `undefined`.

The original design assumed a *biometric-invalidated* gated entry (one written
with `requireAuthentication: true`, then invalidated by a fingerprint add / Face-ID
re-enroll) would surface as a **thrown** error. Per the current Expo API it does
not — `getItemAsync` on a biometric-invalidated entry resolves **`null`**,
indistinguishable from a genuinely empty slot. Our mapping turns that into
`undefined`, so `resolveIdentityKey` would **regenerate**, silently orphaning the
device's real PeerId / authority key.

This is **latent, not active**: the RN identity slot ships with
`requireAuthentication` **off** (the node comes up headless / push-woken, using
`AFTER_FIRST_UNLOCK`), so no shipped path hits it today. It becomes a real
silent-identity-loss bug the moment a developer enables `requireAuthentication` on
the identity (or any must-not-regenerate) slot. This ticket makes gating **safe to
enable**; it does **not** enable gating.

## Design decision (resolved)

**Reuse the existing `__index` entry as the unauthenticated presence marker, and
gate the new discriminator on `requireAuthentication === true`.** No second
companion write, no `set`/`delete` reordering.

Rationale for the chosen approach over the two candidates in the plan:

- **Index-as-marker (chosen).** The `sereus.ks.__index` entry already holds a JSON
  array of logical keyIds and is *always* read/written with
  `requireAuthentication` dropped (`indexOptions()`, verified by the existing test
  at `secure-key-store.spec.ts:203-212`). So the marker can never itself be
  biometric-invalidated, and it already records "this slot was written" without a
  second write per `set`. `keyId ∈ index` + material `null` is exactly the
  "was-present-but-now-null" signal we need.
- **`canUseBiometricAuthentication()` probe (rejected).** After a biometric-set
  change the device *does* have usable biometrics (the new fingerprint is
  enrolled), so the probe returns `true` while the specific entry is invalidated
  and reads `null`. It therefore cannot distinguish invalidation from a truly empty
  slot — the exact case we must separate. It only helps the unrelated
  "no biometrics enrolled at all" case. Out of scope; document why in code.

### Why gate the discriminator on `requireAuthentication === true`

For an **ungated** store, `null` must keep meaning `undefined` exactly as today —
otherwise the artificial-orphan path (index entry whose material was never written)
would start throwing, and a first launch would be misread. Gating the new branch on
`this.options.requireAuthentication === true` preserves today's defaults verbatim:
the ungated identity slot, first launch, and the existing
`index-orphan-does-not-break-get` test (`secure-key-store.spec.ts:218-227`, which
runs ungated) are all untouched.

### Why NOT reorder `set` (keep material-before-index)

`set` writes **material first, then index**; `delete` writes **index first, then
material**. In *both* normal operations the only transient inconsistency possible is
"material present, index absent" — **never** "index present, material absent". So
for a correctly-operating store, `index present + material null` can only mean the
material was successfully written in a past session and has since become unreadable
(invalidation/denial) — precisely the signal we want, with no false positive.

A tempting alternative — write the marker *before* the gated material so
"marker-present ⊇ material-present" — is **worse**: if `set` crashes between the
marker write and the material write on a *fresh* slot, the next launch reads
`material null + index present` and the guard throws `KeyStoreAccessError`, which
`resolveIdentityKey` propagates → the node **can never start** (every relaunch
re-reads the same wedged state, and there is no real identity to protect because
generation never completed). Material-first instead leaves only a **narrow residual
window**: a `set` interrupted between its two awaited writes in a *prior* session,
*followed by* a later invalidation, regenerates silently — strictly no worse than
today (where *every* gated invalidation regenerates), and far rarer. Keep
material-first; document the residual window in code.

## Specification

Change **only** `SecureStoreKeyStore.get`. After the material read returns `null`:

```
get(keyId):
  material = getItemAsync(safeKey(keyId), this.options)   // throw ⇒ KeyStoreAccessError (unchanged)
  if material is string: return decode(material)          // unchanged (corrupt ⇒ KeyStoreAccessError)
  // material === null:
  if this.options.requireAuthentication !== true:
      return undefined                                    // today's behaviour, verbatim
  // gated slot: disambiguate invalidated-vs-empty via the unauthenticated marker
  index = this.readIndex()                                // ungated; throw ⇒ KeyStoreAccessError (fail-closed)
  if index.includes(keyId):
      throw KeyStoreAccessError(keyId, "...was present but now reads null (gated slot invalidated/denied)...")
  return undefined                                        // marker absent ⇒ genuinely empty / true first launch
```

Notes for the implementer:
- Use the existing private `readIndex()` (it already uses `indexOptions()`, so the
  guard probe never triggers a prompt and never reads invalidatable material). A
  `readIndex()` rejection propagating as `KeyStoreAccessError` is correct
  fail-closed behaviour.
- Update the class/module JSDoc "Access vs absence" contract (header comment lines
  ~23-26 and the `get` comment ~144-152) to describe the gated
  was-present-but-now-null discriminator and the documented residual window.
- Do **not** touch `set`, `delete`, `readIndex`, `mutateIndex`, `list`, or
  `migrateLegacyIdentity`. Do **not** add a `requireAuthentication`-enabling
  default anywhere — gating stays off.

### app.json + Expo Go (plan implement-gap #3)

- Add `NSFaceIDUsageDescription` to `packages/reference-app-rn/app.json` under
  `expo.ios.infoPlist` (a user-facing reason string, e.g. *"Sereus uses Face ID to
  unlock this device's secure identity key."*). iOS shows it on the first Face-ID
  prompt; without it the app crashes when a gated read prompts. This is a
  prerequisite for *anyone* later enabling `requireAuthentication`.
- The `requireAuthentication` JSDoc in `secure-key-store.ts` already notes the Expo
  Go limitation; keep/extend that note so the constraint stays discoverable.

### Docs

Update `docs/architecture.md`:
- "Mobile secure backend" → **Access vs absence** bullet (~832-835): note that for a
  **gated** slot a `null` read is disambiguated via the unauthenticated `__index`
  marker (present ⇒ `KeyStoreAccessError`, absent ⇒ `undefined`).
- "Biometric invalidation" bullet (~859-863): state that the index-marker guard now
  makes an invalidated gated slot fail closed (no silent regeneration), so gating is
  safe to enable once `NSFaceIDUsageDescription` is present.

## Edge cases & interactions

- **Gated, material `null`, keyId IN index (the target case).** Past-session
  invalidation/denial ⇒ `KeyStoreAccessError`; `resolveIdentityKey` propagates ⇒ no
  regeneration. Test: gated store, `set` a slot, then delete *only* the material
  entry from the fake map (leave the index), `get` ⇒ rejects `KeyStoreAccessError`
  with `keyId`.
- **Gated, material `null`, keyId NOT in index (true first launch).** ⇒ `undefined`
  ⇒ generation proceeds, no false access error. Test: gated store, never `set`,
  `get` ⇒ `undefined`.
- **Ungated, material `null` (default, shipped path).** ⇒ `undefined` regardless of
  index contents — today's behaviour. Test: ungated store with index *forced* to
  contain the keyId but no material ⇒ still `undefined` (contrast with gated). The
  existing orphan test (`:218`) must keep passing unchanged.
- **Guard probe does not prompt.** The index read during the guard uses
  `indexOptions()` (no `requireAuthentication`). Test: assert the recorded
  `getOptionsByKey` for `INDEX_KEY` has no `requireAuthentication`.
- **Index read fails during the guard.** Backend error reading `__index` ⇒
  `KeyStoreAccessError` (fail-closed, no regeneration). Acceptable/desired.
- **Gated slot deleted cleanly.** `delete` removes the index entry then material ⇒
  next `get`: material `null`, index absent ⇒ `undefined` (genuinely empty). No
  false access error.
- **Crash mid-`delete` (index gone, material present).** `get` returns the material
  bytes (would prompt if gated) — stale-but-present, never loss.
- **Residual window (documented, accepted).** `set` interrupted between material and
  index writes in a prior session, *then* later invalidation ⇒ material `null` +
  index absent ⇒ `undefined` ⇒ regeneration. Strictly no worse than status quo;
  call it out in code comments, do not try to close it (closing it reintroduces the
  first-run permanent-wedge failure analysed above).
- **Concurrent get during an in-flight index write.** `readIndex`/`mutateIndex` are
  already serialized via `indexChain`; the guard only *reads* the index, so it sees
  a committed array. No new concurrency surface.
- **Multiple gated slots in one store.** Each keyId is independently tracked in the
  shared `__index`; the discriminator keys off `index.includes(keyId)`, so slots
  don't cross-contaminate.

## TODO

- [ ] Add the gated `null`-material discriminator to `SecureStoreKeyStore.get` per
  the spec (reuse `readIndex()`; branch on `this.options.requireAuthentication ===
  true`). Update the module-header "Access vs absence" JSDoc and the `get` inline
  comment, including the documented residual window.
- [ ] Add `NSFaceIDUsageDescription` to `packages/reference-app-rn/app.json`
  (`expo.ios.infoPlist`) with a user-facing reason string.
- [ ] Add tests to `packages/reference-app-rn/test/secure-key-store.spec.ts`
  covering every bullet in **Edge cases & interactions** above (target case,
  true-first-launch, ungated-preserves-today, guard-probe-no-prompt,
  index-read-failure-fails-closed, clean-delete-empty). Reuse the existing
  `FakeSecureStore` (it already records per-key options and supports forcing
  throws / direct map edits).
- [ ] Run `yarn workspace @serfab/reference-app-rn test 2>&1 | tee /tmp/rn-test.log`
  and `yarn workspace @serfab/reference-app-rn typecheck 2>&1 | tee /tmp/rn-tc.log`;
  confirm the existing access-vs-absence and index-orphan tests still pass
  unchanged.
- [ ] Update `docs/architecture.md` "Mobile secure backend" Access-vs-absence and
  Biometric-invalidation bullets to describe the index-marker guard.
- [ ] Sanity-check `cadre-core`'s `resolveIdentityKey` is unaffected (it already
  propagates `KeyStoreAccessError` without regenerating — no code change expected,
  just confirm the contract still holds).
