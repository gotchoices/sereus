---
description: Build the release-key + manifest-signing pipeline and a build-time placeholder guard so the cadre-host update flow can be made operational by the release operator
files: packages/cadre-host/src/update/release-key.ts, packages/cadre-host/src/update/manifest.ts, packages/cadre-host/src/update/index.ts, packages/cadre-host/src/index.ts, packages/cadre-host/src/update/__tests__/manifest.test.ts, packages/cadre-host/src/update/__tests__/update-service.integration.test.ts, packages/cadre-host/scripts/release-keygen.mjs, packages/cadre-host/scripts/sign-manifest.mjs, packages/cadre-host/src/update/sign.ts, scripts/publish-package.js, docs/cadre-host.md
---

The cadre-host update subsystem verifies signed release manifests against an embedded Ed25519 production public key, but the key shipped in the binary is an all-zeros 32-byte placeholder (`PROD_KEY_BASE64` in `packages/cadre-host/src/update/release-key.ts:25`). Every authentic production manifest is therefore rejected with `signature_invalid`, so the notify/auto-apply flow is non-operational in shipped binaries — only the `CADRE_HOST_UPDATE_DEV_KEY` dev/CI override path works.

## Scope and the operator boundary

The deliverable that *fully* makes the flow operational — a real Ed25519 keypair generated offline and the private half kept in the release operator's custody — is inherently a human action and **must not** be performed by the implementing agent. Generating a keypair in the agent and committing it would put the private key in git history, defeating offline custody. So:

- **In scope (this ticket):** the key-management + manifest-signing *pipeline* and supporting guards — keygen tool, offline signing tool, promotion of the existing signer to a production-grade API, a build/publish-time guard that refuses to ship the placeholder, and the operator runbook. These reduce the operator's task to a couple of mechanical commands.
- **Out of scope (documented operator action, not code):** running keygen offline, custodying the private key, embedding the real public key, and signing/publishing the first real `latest.json`. The all-zeros placeholder stays in source until the operator replaces it; the build guard ensures a real release can never silently ship with the placeholder still present.
- **Out of scope (unchanged):** OS-level binary code-signing (signtool/codesign/notarytool/GPG) — tracked in `tickets/backlog/later/cadre-host-standalone-binary.md`. This ticket is the Ed25519 release-manifest key only.

## Architecture

### Signing is already implemented — only the name lies

`signManifestForTesting(manifest, privateKey)` (`manifest.ts:108-112`) is byte-for-byte the production signing operation: it canonicalizes with the shared `canonicalJson` from `@serfab/cadre-core` (the same serializer `verifyManifest` consumes) and emits `{ manifest, sig: 'ed25519:<base64>' }`. The only problem is the `ForTesting` name implies it is test-only. Rename it to `signManifest` and update the three import sites (`update/index.ts:325`, `src/index.ts:87`, the two test files). No backwards-compat shim needed (per AGENTS.md).

### Embedding strategy: commit the public key as source

Ed25519 public keys are not secret. The chosen approach (over build-time env injection) is to commit the raw 32-byte base64 public key directly as `PROD_KEY_BASE64` in `release-key.ts`. Rationale: it is the simplest correct option, keeps verification hermetic (no build-time secret plumbing), and rotation is just "generate new keypair → commit new public key → re-sign manifests." The existing `CADRE_HOST_UPDATE_DEV_KEY` env override is retained unchanged for dev/CI/staging and must remain the *only* non-embedded path — it is never the production verification path.

The keygen tool can optionally rewrite `PROD_KEY_BASE64` in place (atomic temp-file rename) so the operator does not hand-edit, but the default source value remains the placeholder until the operator acts.

### Placeholder guard

A new `isPlaceholderReleaseKey(env = process.env): boolean` in `release-key.ts` returns true when the *effective* key (after the env override) decodes to 32 zero bytes. Two consumers:

- **Build/publish guard (primary):** `scripts/publish-package.js`, when the package being published is `cadre-host`, aborts with a clear error if the embedded key is the placeholder — unless `CADRE_HOST_ALLOW_PLACEHOLDER_KEY=1` is set (escape hatch for internal/test publishes). This is what prevents a real release from shipping the dead key. Note `publish-package.js` is CommonJS and runs against the *source* (it shells `yarn build` then publishes); read the embedded constant from the compiled `dist` or via a small exported check — prefer importing the built `@serfab/cadre-host` export after `yarn build`, falling back to a source read if not yet built.
- **Runtime breadcrumb (secondary, low priority):** `UpdateService.check()` logs a single clear `debug` line when the placeholder is active, so a misbuilt binary is diagnosable from logs rather than only as `signature_invalid`.

### Offline tooling (standalone scripts, not shipped CLI subcommands)

Signing runs on the operator's offline machine with the private key present; signing code should **not** live in the shipped `cadre-host` binary. Two ES-module scripts under `packages/cadre-host/scripts/` (sibling to `publish-package.js`), run from a checkout:

- `release-keygen.mjs` — generate an Ed25519 keypair via `node:crypto.generateKeyPairSync('ed25519')`. Write the PKCS#8 PEM private key to `--out <path>` (default `./cadre-host-release.key`, **refuse to overwrite** an existing file, write with `0600`). Print the raw 32-byte public key as base64 (extract via `publicKey.export({format:'der',type:'spki'}).subarray(12)` — the same 12-byte SPKI header `release-key.ts` and the existing tests strip). Never print the private key to stdout. With `--write-source`, atomically rewrite `PROD_KEY_BASE64` in `src/update/release-key.ts`. Emit a prominent reminder to custody the private key offline and never commit it.
- `sign-manifest.mjs` — read the PKCS#8 PEM via `--key <path>`; build an `UpdateManifest` either from `--manifest <file.json>` or from flags (`--version`, `--package`, `--tag`, `--published-at`, `--release-notes-url`, `--min-previous-version`); run the manifest-field validation; sign via the package's `signManifest`; **self-verify** the produced signature against the public key derived from the private key before emitting; write the `{ manifest, sig }` envelope to `--out <file>` (default stdout) ready to publish to `https://releases.serfab.io/cadre-host/latest.json`.

To keep the scripts thin and the logic typed + testable (no janky ad-hoc parsing/validation in `.mjs`), extract the manifest construction + validation into a new typed module `src/update/sign.ts` exporting e.g. `buildManifest(fields): UpdateManifest` and reusing the existing field validation from `manifest.ts` (today `assertManifestFieldsWellFormed` is module-private — export it, or factor a shared `validateManifestFields`). The `.mjs` scripts are then thin CLI wrappers importing the built package.

### Publishing `latest.json`

Uploading the signed `latest.json` to the `releases.serfab.io` static host is an operator/infra step (plain static-file hosting); document it, no code required here.

## Key tests (TDD intent)

- **Signer rename round-trip:** existing `manifest.test.ts` round-trip (`sign + verify`) passes against `signManifest` — sign a sample manifest with a fresh keypair, set `CADRE_HOST_UPDATE_DEV_KEY` to its public raw base64, expect `verifyManifest` to return the manifest unchanged.
- **`isPlaceholderReleaseKey`:** returns `true` with no env override (default all-zeros source), and `false` when `CADRE_HOST_UPDATE_DEV_KEY` is set to a real (freshly generated) 32-byte key.
- **`buildManifest` / `sign.ts`:** building from flag-style fields produces a manifest that (a) passes `verifyManifest` once signed and (b) is rejected by field validation for a bad semver / bad npm name / non-ISO `publishedAt` — i.e. the signing tool cannot emit a manifest the verifier would later reject as `manifest_invalid`.
- **Self-verify path:** signing then verifying against the *derived* public key succeeds; verifying against a *different* key fails — guarding the sign tool's self-check.
- (Manual/documented, not agent-runnable) keygen → custody → embed → sign → publish dry-run by the operator.

Expected outputs: `yarn build:server` clean; `yarn test src/update/__tests__` green (existing 46 + new cases); the publish guard aborts on the placeholder and passes once a real key is embedded.

## TODO

### Phase 1 — Promote the signer and add the guard helper
- Rename `signManifestForTesting` → `signManifest` in `manifest.ts`; update exports in `update/index.ts` and `src/index.ts` and the two test files that import it.
- Add `isPlaceholderReleaseKey(env = process.env): boolean` to `release-key.ts` (decode effective key, true iff all 32 bytes are zero). Export through `update/index.ts` and `src/index.ts`.
- Export the manifest field-validation (`assertManifestFieldsWellFormed` → exported `validateManifestFields`, or re-expose) so `sign.ts` reuses the exact same rules.

### Phase 2 — Typed signing core
- Add `src/update/sign.ts` with `buildManifest(fields)` (typed construction + reuse of `validateManifestFields`) and any helper the scripts need; re-export from `update/index.ts`.
- Unit tests for `buildManifest` (valid + each rejection path) and the sign/self-verify round-trip.

### Phase 3 — Offline scripts
- `packages/cadre-host/scripts/release-keygen.mjs` (keygen, `0600` PEM, no-overwrite, optional `--write-source` atomic rewrite, public-key stdout, offline-custody warning).
- `packages/cadre-host/scripts/sign-manifest.mjs` (load key, build/validate manifest, sign via `signManifest`, self-verify, emit envelope).

### Phase 4 — Build/publish guard
- In `scripts/publish-package.js`, when publishing `cadre-host`, abort if `isPlaceholderReleaseKey()` is true (check the built `dist` export after `yarn build`), unless `CADRE_HOST_ALLOW_PLACEHOLDER_KEY=1`.
- (Low priority) one-line `debug` warning in `UpdateService.check()` when the placeholder is active.

### Phase 5 — Docs / runbook
- Extend the **Updates** section of `docs/cadre-host.md` (`docs/cadre-host.md:209-217`) with a "Release signing & key management" subsection: keygen command, offline private-key custody (never committed), embedding the public key (committed; safe because public), signing `latest.json`, publishing to `releases.serfab.io`, rotation procedure, and the `CADRE_HOST_UPDATE_DEV_KEY` dev-override caveat (development/CI only, never the prod path). Prefer extending the existing doc over a new file (AGENTS.md: don't create summary docs).

### Phase 6 — Validate and hand off honestly
- `yarn build:server` and `yarn test src/update/__tests__` in `packages/cadre-host`; stream output with `tee`.
- The review handoff must state plainly that the placeholder remains in source by design and that the flow becomes operational only after the release operator runs the (now one-command) keygen + embed + sign + publish steps — this ticket delivers the pipeline + guard + runbook, not a live production key.
