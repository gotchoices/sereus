---
description: Review the release-key + manifest-signing pipeline and build-time placeholder guard that make the cadre-host update flow operator-ready (the live key remains a documented operator action, by design)
files: packages/cadre-host/src/update/manifest.ts, packages/cadre-host/src/update/release-key.ts, packages/cadre-host/src/update/sign.ts, packages/cadre-host/src/update/index.ts, packages/cadre-host/src/index.ts, packages/cadre-host/scripts/release-keygen.mjs, packages/cadre-host/scripts/sign-manifest.mjs, scripts/publish-package.js, packages/cadre-host/src/update/__tests__/sign.test.ts, packages/cadre-host/src/update/__tests__/release-key.test.ts, packages/cadre-host/src/update/__tests__/manifest.test.ts, packages/cadre-host/src/update/__tests__/update-service.integration.test.ts, packages/integration-tests/src/scenarios/cadre-host-update-notify.integration.ts, docs/cadre-host.md
---

# Release-key + manifest-signing pipeline + placeholder guard

## What this delivers (and the deliberate boundary)

The cadre-host update flow verifies signed manifests against an embedded Ed25519 public key. That key was an all-zeros placeholder, so every authentic production manifest was rejected `signature_invalid` and only the `CADRE_HOST_UPDATE_DEV_KEY` dev override worked.

This ticket builds the **key-management + signing pipeline + guards** so an operator can make the flow live with a couple of mechanical commands. It deliberately does **not** generate a real keypair or embed a real key — doing so in-agent would commit the private key to git history and defeat offline custody. **The all-zeros placeholder remains in `src/update/release-key.ts` by design.** The flow becomes operational only after the release operator runs keygen → embed → sign → publish (now a runbook, see `docs/cadre-host.md` "Release signing & key management"). The build/publish guard ensures a real release can never silently ship with the placeholder still present.

OS-level binary code-signing (signtool/codesign/notarytool/GPG) remains out of scope (tracked in `tickets/backlog/later/cadre-host-standalone-binary.md`).

## Changes made

**Phase 1 — signer promotion + guard helper**
- Renamed `signManifestForTesting` → `signManifest` in `manifest.ts` (it was always byte-for-byte the production signing op; only the name lied). Updated all import sites: `update/index.ts`, `src/index.ts`, both update test files, and `packages/integration-tests/src/scenarios/cadre-host-update-notify.integration.ts`. No back-compat shim (per AGENTS.md).
- Added `isPlaceholderReleaseKey(env = process.env): boolean` to `release-key.ts` — true iff the *effective* key (after the env override) decodes to 32 zero bytes. Exported through `update/index.ts` + `src/index.ts`.
- Exported the manifest field-validation as `validateManifestFields` (was module-private `assertManifestFieldsWellFormed`) so the signer reuses the exact verifier rules.

**Phase 2 — typed signing core (`src/update/sign.ts`)**
- `buildManifest(fields: ManifestFields): UpdateManifest` — typed construction + `validateManifestFields`, so the signer cannot emit a manifest the verifier would later reject `manifest_invalid`.
- `derivePublicKeyBase64(privateKey)` — raw 32-byte public key (strips the 12-byte SPKI header, same as the tests/keygen).
- `signAndSelfVerify(manifest, privateKey)` — signs via `signManifest`, then verifies the signature against the key *derived from the same private key* (via `verifyManifest` with an explicit env override, so the self-check is independent of whatever key the environment trusts). Throws if it can't verify its own output.

**Phase 3 — offline scripts** (`packages/cadre-host/scripts/`, ES modules, not shipped in the package)
- `release-keygen.mjs` — `generateKeyPairSync('ed25519')`; writes PKCS#8 PEM to `--out` (default `./cadre-host-release.key`, mode `0600`, refuses to overwrite via both an `existsSync` check and `flag:'wx'`); prints the raw public key base64; `--write-source` atomically rewrites `PROD_KEY_BASE64` (temp-file + rename); prints a prominent offline-custody warning; never prints the private key. Uses `node:util.parseArgs` (no hand-rolled parser).
- `sign-manifest.mjs` — loads the PKCS#8 PEM (`--key`), builds fields from `--manifest <file.json>` or flags (`--version/--package/--tag/--published-at/--release-notes-url/--min-previous-version`), signs + self-verifies via the built package, writes the `{ manifest, sig }` envelope to `--out` or stdout. Thin wrapper over `@serfab/cadre-host`.

**Phase 4 — build/publish guard**
- `scripts/publish-package.js` (CommonJS) now, when publishing `cadre-host`, aborts after `yarn build` if `isPlaceholderReleaseKey()` is true — dynamically `import()`s the built `dist/index.js` export, falling back to a source read of `PROD_KEY_BASE64` if dist is absent. Escape hatch: `CADRE_HOST_ALLOW_PLACEHOLDER_KEY=1`. (Restructured the script into an async `main()` to allow the dynamic ESM import from CJS.)
- Runtime breadcrumb: `UpdateService.check()` logs one `debug` line when the placeholder is active, so a misbuilt binary is diagnosable from logs, not just opaque `signature_invalid`.

**Phase 5 — docs**: extended the Updates section of `docs/cadre-host.md` with a "Release signing & key management" subsection (keygen, offline custody, embedding, signing, publishing to `releases.serfab.io`, rotation, and the dev-override caveat). Also refreshed the now-stale "backlog" comments in `release-key.ts`.

## Validation performed (this is the floor, not the ceiling)

- `yarn workspace @serfab/cadre-host run build:server` — clean.
- `yarn workspace @serfab/cadre-host run test src/update/__tests__` — **57 passed** (46 existing + 11 new: 8 in `sign.test.ts`, 3 in `release-key.test.ts`).
- `yarn workspace @serfab/integration-tests run build` — clean (the rename propagated correctly).
- Ran `release-keygen.mjs` end-to-end in a temp dir: generated a key, confirmed `0600`/no-overwrite (exit 1 on re-run), printed public key + custody warning.
- Ran `sign-manifest.mjs` end-to-end against that key: produced a valid self-verified `{ manifest, sig }` envelope.
- Confirmed the built `isPlaceholderReleaseKey()` export returns `true` for the placeholder (guard would abort) and `false` with a real override.
- Validated the `--write-source` regex rewrite in isolation (exactly one `PROD_KEY_BASE64` occurrence; replacement removes the placeholder) — **not** run against the real source, to avoid committing a real key.

### Suggested reviewer use cases / probes
- Sign a manifest, set `CADRE_HOST_UPDATE_DEV_KEY` to the derived public key, drive `UpdateService.check()`/`apply()` against a fixture fetcher — confirm the renamed `signManifest` is wired through the real apply path, not just unit round-trips.
- Feed `sign-manifest.mjs` a deliberately bad `--published-at` / `--version` / `--package` and confirm it fails *before* emitting (no invalid envelope ever written).
- Feed `--manifest` a full `UpdateManifest` JSON (nested `channels.npm`) and a flat-fields JSON — confirm both normalize identically.
- Exercise the publish guard's source-read fallback (delete/rename `dist/` then call the guard) and the `CADRE_HOST_ALLOW_PLACEHOLDER_KEY=1` bypass.

## Known gaps / honest flags for review

- **Placeholder still in source — intended.** The flow is non-operational until the operator embeds a real key. This is the documented boundary, not an oversight. Verify the runbook is sufficient.
- **`--write-source` not executed against real source.** Only its regex was validated in isolation (running it would write a real key into a tracked file). The atomic temp-rename + single-occurrence assumptions look sound but haven't been exercised on the live file.
- **Publish guard not run as a real publish.** Only the detection function was verified; the full `publish-package.js cadre-host` path (which would actually `yarn npm publish`) was not run. The async restructure of that CJS script deserves a read — confirm the `execSync` ordering (clean → build → guard → publish) and error propagation via `main().catch` are correct.
- **Guard dynamic-imports the whole built `dist/index.js`** (pulls in the full package surface, incl. server/fastify) just to read one boolean. It works, but an unrelated import-time failure would trip the fallback path; consider whether a narrower export entry is worth it.
- **`sign-manifest.mjs` `--manifest` shape is a light heuristic** (`raw.channels?.npm ?? flat`). Not a parser, but confirm it can't silently misread an unexpected shape.
- **`parseArgs` requires Node ≥18.3** (stable). Package `engines` says `>=18`; a 18.0–18.2 runtime would lack stable `parseArgs`. Likely fine for an operator tool, but flag if the floor matters.
- **`0600` is a no-op on Windows** (same caveat as the keytar note already in the docs). The private-key file is readable by any account on a Windows box; the custody warning covers intent but not enforcement.
- New tests cover `buildManifest`/`signAndSelfVerify`/`isPlaceholderReleaseKey` at the unit level; the `.mjs` CLIs themselves have no automated tests (validated manually only).
