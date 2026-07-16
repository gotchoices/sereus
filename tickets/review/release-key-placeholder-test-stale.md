description: Two outdated unit tests that checked the pre-release "placeholder key" assumption have been rewritten to match the current, intentional state where a real signing key is shipped.
files:
  - packages/cadre-host/src/update/__tests__/release-key.test.ts (rewritten, verified this pass)
  - packages/cadre-host/src/update/release-key.ts (unchanged, load-bearing real key — do NOT revert)
  - docs/cadre-host.md (line ~271, worth a reviewer glance — see Known gaps)
difficulty: easy
---

# Review: release-key-placeholder-test-stale

Test-only correction. No product code touched.

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

## Verification (this pass, implement stage)

- `cd packages/cadre-host && yarn test --run release-key` → 4 passed, 0 failed.
- `yarn eslint packages/cadre-host/src/update/__tests__/release-key.test.ts`
  from repo root → clean, no output.
- Confirmed `release-key.ts` `PROD_KEY_BASE64` (`'XyRVnOY9DVgU6xdMgJIguOsc9B2L1o2KoU9626Nk+OE='`)
  decodes to 32 non-zero bytes — matches the "false for embedded default"
  test assertion.
- `tickets/.pre-existing-known.md` has no `release-key` entry (already
  cleaned up by the prior fix-stage pass) — nothing stale left pointing at
  this test.
- Grepped `docs/cadre-host.md` and `scripts/publish-package.js` for
  "placeholder" (see Known gaps below) — publish guard logic and messaging
  are internally consistent with the real-key-by-default state; no code
  change needed there.

## Known gaps / for reviewer

- `docs/cadre-host.md:271` reads: *"Until the operator embeds a real key,
  the source ships an all-zeros placeholder, and a build/publish guard
  refuses to ship it."* This is phrased as a general description of the
  guard mechanism (still technically true as a statement of *how the guard
  works*), but could misread as claiming the *current* shipped state is
  still a placeholder — it isn't, since `fb79894`. Didn't touch it: it's a
  judgment call whether this reads as stale-implying or just
  mechanism-explaining, and it's outside this ticket's file scope (test
  file only). Flagging for reviewer to decide: reword for clarity, or leave
  as-is since it's not factually wrong.
- Did not exhaustively grep the whole repo for other consumers of
  `isPlaceholderReleaseKey`/`PROD_KEY_BASE64` beyond `release-key.ts`,
  `scripts/publish-package.js`, and `docs/cadre-host.md` — those three are
  the ones named in the original ticket's TODO and are confirmed
  consistent. If a reviewer wants full confidence, a repo-wide grep for
  `isPlaceholderReleaseKey` and `CADRE_HOST_ALLOW_PLACEHOLDER_KEY` would
  close that out.

## Review findings

(none yet — first pass through review stage)
