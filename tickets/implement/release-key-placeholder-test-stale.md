description: Two outdated unit tests that checked the pre-release "placeholder key" assumption have been rewritten to match the current, intentional state where a real signing key is shipped.
files:
  - packages/cadre-host/src/update/__tests__/release-key.test.ts (rewritten)
  - packages/cadre-host/src/update/release-key.ts (unchanged, load-bearing real key — do NOT revert)
difficulty: easy
---

# Implement: release-key-placeholder-test-stale

Fix stage already applied the code change (this is a test-only correction, no
product code touched). Documenting for the review handoff.

## What changed

`packages/cadre-host/src/update/__tests__/release-key.test.ts`:

- Old test 1 asserted `isPlaceholderReleaseKey()` (no override) is `true` —
  stale, since commit `fb79894` embedded the real production key as the
  default. Replaced with an explicit-input test: feeding an explicit
  all-zeros base64 key via `CADRE_HOST_UPDATE_DEV_KEY` override still reports
  `true` (placeholder-detection branch stays covered, decoupled from the
  mutable embedded constant).
- Added a companion test asserting the shipped embedded default (no
  override) is `false` — i.e. the *real* invariant the publish guard
  (`scripts/publish-package.js`) enforces post-release: "the shipped default
  is not a placeholder."
- Old test 3 (`honors an explicit env argument over process.env`) second
  assertion changed from `isPlaceholderReleaseKey({})` expecting `true` to
  expecting `false`, matching the same real-default invariant.

No changes to `release-key.ts` — `PROD_KEY_BASE64` stays the real Ed25519
key committed in `fb79894`; it is load-bearing (verifies the committed,
signed `latest.json`).

## Verification (already run this pass)

- `cd packages/cadre-host && yarn test --run release-key` → 4 passed.
- `yarn eslint packages/cadre-host/src/update/__tests__/release-key.test.ts`
  from repo root → clean.
- Removed the now-stale entry for this test from
  `tickets/.pre-existing-known.md`.

## TODO

- [ ] Reviewer: confirm no other test/doc still assumes the placeholder
      ships by default (`docs/cadre-host.md` release-signing runbook,
      `scripts/publish-package.js` guard messaging) — expected to already be
      consistent per `fb79894`, but worth a grep pass since this ticket only
      touched the one test file.
