description: Two outdated unit tests that checked the pre-release "placeholder key" assumption were rewritten to match the current state where a real signing key ships; review also corrected two stale doc/comment claims and added an edge-case test.
files:
  - packages/cadre-host/src/update/__tests__/release-key.test.ts (rewritten in fix stage; length-mismatch test added this pass)
  - packages/cadre-host/src/update/release-key.ts (comment corrected this pass; PROD_KEY_BASE64 unchanged, load-bearing real key)
  - docs/cadre-host.md (line ~271 reworded this pass)
difficulty: easy
---

# Complete: release-key-placeholder-test-stale

Test-only correction to a stale invariant, plus two doc/comment staleness
fixes surfaced in review. No product logic changed.

## Background

`isPlaceholderReleaseKey()` (in `release-key.ts`) reports whether the
*effective* Ed25519 release-signing public key decodes to 32 zero bytes —
the all-zeros placeholder that ships in source *before* a release operator
embeds a real key. Commit `fb79894` (0.8.1 release) embedded the real
production key as `PROD_KEY_BASE64`, so the shipped default is no longer a
placeholder. Two unit tests still asserted the pre-release "placeholder
ships by default" state and were stale.

## What changed

**Fix stage (`bafcca4`)** — `release-key.test.ts`:
- Old "is true for the default all-zeros placeholder (no override)" replaced
  with "is true for an *explicit* all-zeros placeholder key" (feeds all-zeros
  via `CADRE_HOST_UPDATE_DEV_KEY`) — keeps the placeholder-detection branch
  covered, decoupled from the now-mutable embedded constant.
- Added "is false for the shipped embedded default (real key, no override)"
  — the real post-release invariant the publish guard enforces.
- "honors an explicit env argument over process.env": `isPlaceholderReleaseKey({})`
  now expects `false` (empty override falls through to the real embedded default).

**Review stage (this pass)** — fixes for findings below.

## Review findings

Read the fix-stage code diff (`bafcca4`) with fresh eyes; the implement
commit (`77904ae`) touched only ticket files. Checked every consumer of the
placeholder symbols, not just the test.

- **Checked — test correctness & coverage.** All 4 rewritten tests assert
  the right invariants against the real embedded key. **Found a gap:** the
  `raw.length !== 32 → false` branch of `isPlaceholderReleaseKey` (line 52)
  was untested. **Fixed inline:** added a test feeding a 16-byte key,
  asserting `false` (length gate short-circuits the all-zeros check). 5 tests
  now pass.
- **Checked — source comment accuracy (`release-key.ts:14-20`).** **Found
  stale:** the `PROD_KEY_BASE64` doc-comment claimed "the all-zeros value
  below is the placeholder that ships in source" — directly contradicted by
  line 21, which is the real key since `fb79894`. **Fixed inline:** reworded
  to state the real key is embedded, with the placeholder described as the
  pre-embed state.
- **Checked — release-signing runbook (`docs/cadre-host.md:271`).** This was
  the implementer's flagged "known gap." **Found stale:** "Until the operator
  embeds a real key, the source ships an all-zeros placeholder…" reads as a
  claim about the *current* shipped state, which is false since `fb79894`.
  **Fixed inline** (minor doc correction): now "The real public key is
  embedded (as of the 0.8.1 release); before an operator embeds one the
  source ships an all-zeros placeholder…". The guard-mechanism explanation is
  preserved.
- **Checked — repo-wide consumers.** Grepped all `.ts/.js/.mjs/.md` (ex
  `node_modules`, `dist`, `tickets`) for `isPlaceholderReleaseKey`,
  `PROD_KEY_BASE64`, `CADRE_HOST_ALLOW_PLACEHOLDER_KEY`. Non-test consumers:
  `update/index.ts:157` (runtime breadcrumb — fires only when the key *is*
  a placeholder; message accurate), `scripts/publish-package.js` (publish
  guard — reads `PROD_KEY_BASE64` straight from source, ignores the override;
  mechanism-accurate), `scripts/release-keygen.mjs` (embeds the key;
  mechanism-accurate), `src/index.ts` (re-export). All consistent with the
  real-key-by-default state; no further change needed. This closes the
  implementer's second known gap.
- **Major findings:** none — no new tickets filed.
- **Tripwires:** none. The length-gate branch (`raw.length !== 32 → false`)
  is now test-locked rather than left as a conditional concern.
- **Pre-existing failures:** none surfaced; `tickets/.pre-existing-known.md`
  has no `release-key` entry.

## Verification

- `cd packages/cadre-host && yarn test --run release-key` → 5 passed, 0 failed.
- `yarn eslint` on `release-key.test.ts` + `release-key.ts` (repo root) → clean.
- `PROD_KEY_BASE64` unchanged (`'XyRVnOY9DVgU6xdMgJIguOsc9B2L1o2KoU9626Nk+OE='`),
  decodes to 32 non-zero bytes — matches the "false for embedded default" test.
