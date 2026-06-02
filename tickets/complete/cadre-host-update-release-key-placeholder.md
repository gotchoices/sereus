---
description: Release-key + manifest-signing pipeline and build-time placeholder guard that make the cadre-host update flow operator-ready (live key remains a documented operator action, by design)
files: packages/cadre-host/src/update/manifest.ts, packages/cadre-host/src/update/release-key.ts, packages/cadre-host/src/update/sign.ts, packages/cadre-host/src/update/index.ts, packages/cadre-host/src/index.ts, packages/cadre-host/scripts/release-keygen.mjs, packages/cadre-host/scripts/sign-manifest.mjs, scripts/publish-package.js, packages/cadre-host/src/update/__tests__/sign.test.ts, packages/cadre-host/src/update/__tests__/release-key.test.ts, docs/cadre-host.md
---

# Release-key + manifest-signing pipeline + placeholder guard — COMPLETE

## Summary of delivered work

The cadre-host update flow verifies signed manifests against an embedded Ed25519 public key that ships in source as an all-zeros placeholder (by design — generating a real key in-agent would commit the private half to git). This work delivered the **key-management + signing pipeline + guards** so a release operator can make the flow live with a couple of mechanical commands:

- `signManifestForTesting` → `signManifest` (the name was the only lie; it was always the production op). All import sites updated, no back-compat shim.
- `isPlaceholderReleaseKey(env)` on `release-key.ts` — true iff the effective key decodes to 32 zero bytes; consumed by the runtime breadcrumb and (originally) the publish guard.
- `validateManifestFields` exported so the signer reuses the verifier's exact rules.
- `src/update/sign.ts` typed signing core: `buildManifest` (typed construction + validation), `derivePublicKeyBase64`, `signAndSelfVerify` (signs then verifies against the key derived from the same private key, via an explicit env override so the self-check is independent of the trusted key).
- Offline `.mjs` operator tools: `release-keygen.mjs` (Ed25519 keypair → PKCS#8 PEM, `0600`, no-overwrite, optional `--write-source` atomic rewrite of `PROD_KEY_BASE64`) and `sign-manifest.mjs` (loads the PEM, builds + signs + self-verifies, emits the `{ manifest, sig }` envelope). Both use `node:util.parseArgs`.
- Build/publish guard in `scripts/publish-package.js`: aborts a `cadre-host` publish if the embedded key is still the placeholder, with `CADRE_HOST_ALLOW_PLACEHOLDER_KEY=1` escape hatch.
- Runtime breadcrumb: `UpdateService.check()` logs one debug line when the placeholder is active.
- Docs: `docs/cadre-host.md` "Release signing & key management" runbook (keygen → embed → sign → publish, rotation, dev-override caveat).

The all-zeros placeholder **remains in source by design**; the flow goes live only after the operator runs the runbook. OS-level binary code-signing stays out of scope (`tickets/backlog/later/cadre-host-standalone-binary.md`).

## Review findings

### What was checked
- Read the full implement diff (`695f3d0`) with fresh eyes before the handoff summary, then read the post-change `release-key.ts`, `manifest.ts`, `sign.ts`, `update/index.ts`, `index.ts`, both new `.mjs` scripts, the publish guard, all tests, and the docs section.
- Traced cross-package propagation of the `signManifest` rename (cadre-host + integration-tests); grepped the whole repo for stale `signManifestForTesting` refs (none) and for external consumers of the new/renamed exports (only the integration scenario + the offline `.mjs`, all correct).
- Verified the central premise empirically: the all-zeros placeholder key **constructs** via `createPublicKey` and `crypto.verify` returns `false` (→ the `signature_invalid` path), rather than throwing an unhandled error. So the documented "every authentic manifest rejected `signature_invalid`" behavior is real, not an uncaught crash.
- Aspect sweep: SPP/DRY (signer reuses `validateManifestFields`/`canonicalJson`; single signer), type safety (no `any`; `ManifestFields` typed; explicit env override object), error handling (`.mjs` use `die()` for expected errors; guard throws actionable messages), resource cleanup (n/a — pure crypto + sync fs), cross-platform (noted Windows `0600` no-op, already documented).

### Findings and disposition

**MAJOR (fixed inline) — publish guard could be silently bypassed by the dev-key env var.**
The guard called `isPlaceholderReleaseKey()` (via the built export, with a source-read fallback that also honored the override). Both honor `CADRE_HOST_UPDATE_DEV_KEY`. That override is a documented **dev/CI runtime** affordance and never ships in the npm package — so if it were set on the publish/CI machine, the guard would read the override key, see a non-placeholder, and **pass while the binary still carried the all-zeros placeholder**. The guard was asking the wrong question (effective runtime key vs. embedded byte string).
*Fix:* `scripts/publish-package.js` now reads `PROD_KEY_BASE64` straight from source (the byte string the build compiles verbatim into `dist`) and decides placeholder-ness from that alone, deliberately ignoring the override. This also removed the dynamic `import()` of the whole built `dist/index.js` (a concern the implementer self-flagged — it pulled in the full server/fastify surface just to read one boolean) and let `assertReleaseKeyEmbedded` go back to synchronous. Verified with a harness: with a real dev key set in `process.env`, the source-read guard still reports the placeholder as present (verdict `true`). Updated the `docs/cadre-host.md` step-4 description to match (it had cited `isPlaceholderReleaseKey`, now inaccurate for the guard).

**MINOR (acknowledged, not changed):**
- `publicKeyMatchesEmbedded` in `manifest.ts` is exported but unused across the whole repo. It is **pre-existing** (not touched by this ticket's diff), so left alone to avoid scope creep — candidate for a future dead-code cleanup.
- `buildManifest`/`validateManifestFields` validate version, `minPreviousVersion`, `publishedAt`, and the npm package name, but **not** the npm dist-`tag`. A garbage tag would pass and only surface during `npm install pkg@tag` in the apply path. This is **pre-existing** verifier behavior (the verifier never validated the tag either), not a regression introduced here — noted for awareness.
- The offline `.mjs` CLIs and the root `scripts/publish-package.js` guard still have **no automated tests** — there is no test runner wired for root `scripts/`, and adding one is disproportionate to a single source-read function. The core placeholder detection is unit-tested via `isPlaceholderReleaseKey`; the guard's source-read path was validated manually (harness above). Acceptable gap; a `scripts/` test harness would be a reasonable standalone follow-up if desired.
- `release-keygen.mjs --write-source` and a full real `publish-package.js cadre-host` run were **not** exercised end-to-end (doing so would write a real key into tracked source / actually `npm publish`). The regex rewrite and guard detection were validated in isolation. Same boundary the implementer documented; unchanged.

### Tests / build (all green at HEAD + after the inline fix)
- `yarn workspace @serfab/cadre-host run build:server` — clean (tsc; cadre-host has no separate lint/typecheck script — the server build *is* the typecheck).
- `yarn workspace @serfab/cadre-host run test` — **359 passed, 3 skipped** (full suite, incl. the 57 update tests: 8 `sign.test.ts`, 3 `release-key.test.ts`, 13 `manifest.test.ts`, 12 update-service integration).
- `yarn workspace @serfab/integration-tests run build` — clean (the `signManifest` rename propagated correctly across the package boundary).
- `node --check scripts/publish-package.js` — syntax OK after the edit.

No new tickets filed: the one major finding was a small, well-contained guard correctness fix applied inline; everything else is pre-existing or an acknowledged, proportionate gap.
