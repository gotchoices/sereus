description: The plugin's browser-build test now loads the file directly instead of having the test framework re-process all 4.7 MB of it on every run, and the size limits now sit about 20% above the real size instead of 60% or more above it.
architecture: docs/testing.md
files:
  - packages/quereus-plugin-sereus/vitest.config.ts
  - packages/quereus-plugin-sereus/test/browser-shape.spec.ts
  - packages/quereus-plugin-sereus/test/browser-bundle.spec.ts
  - docs/testing.md
difficulty: easy
----

# Review handoff — browser bundle shape test transform, and size caps

Implemented as ticketed. Both arms are small and independent; each is described with what to check.

## What changed

**Arm 1 — load the artifact through Node, not through Vite's transform.**
- `packages/quereus-plugin-sereus/vitest.config.ts`: the `unit` project gains `server: { deps: { external: [/dist[\\/]plugin-browser\.js$/] } }`, with a comment. The `e2e` project is unchanged: no e2e spec references the artifact (grep of `test/` for `plugin-browser` hits only the two bundle specs). `browser-bundle.spec.ts` reads the file with `fs` rather than importing it, so it is unaffected either way.
- `test/browser-shape.spec.ts`: the stale "2.5 MiB ESM parses in roughly 1-5s" comment is replaced with one that says why the artifact is externalized and what the 30 s timeout now protects (a genuine hang, not import cost). The timeouts are unchanged.

**Arm 2 — caps that can fire.**
- `test/browser-bundle.spec.ts`: `MAX_RAW_BYTES` 8 MiB → `5_900_000` (20.6% above the measurement), `MAX_GZIPPED_BYTES` 3 MiB → `1_400_000` (20.4% above). Beside them: the measured bytes, the date, the producing command, a note that the number also moves with the linked `../optimystic` / `../quereus` checkouts, and the `NOTE:` that this cap is the only guard on the published payload's size (`publish-package.mjs` runs `yarn build` and ships that `dist/`; `smoke:published` cannot see inside a pre-built bundle).
- `docs/testing.md`: new section "Browser bundle checks (`@serfab/quereus-plugin-sereus`)" placed after the `smoke:published` section, plus a one-line pointer from "Where measurements live". The doc had **no** existing section on the bundle checks despite the ticket's wording ("alongside the other notes"), so this is a new section, not an edit. It carries no byte counts on purpose (that section's own rule: a second copy goes stale).

## Measurements (this machine, idle)

| | before | after |
|---|---|---|
| `browser-shape.spec.ts` first test | 9,722 ms | 473 ms |
| Vite `transform` for that file | 8.33 s | 12 ms |
| source-map "points to missing source files" warning | printed | gone |
| in the full unit run (six spec files in parallel) | — | first test 581 ms |

Bundle, from a fresh `yarn workspace @serfab/quereus-plugin-sereus build`: 4,890,498 B raw, **1,162,393 B** gzipped. The ticket quoted 1,162,304 gzipped; the 89-byte difference is unexplained — I recorded what the spec's own `gzipSync(readFileSync(...))` produces, since that is what the assertion compares against.

Validation run: `vitest run --project unit` — 6 files, 90 tests, all pass. `yarn workspace @serfab/quereus-plugin-sereus typecheck` and `yarn eslint` on the three changed source files: clean (real exit codes, not piped).

## Tests added

None. The ticket changes a test-runner setting and two constants in an assertion that already existed; neither owes a new test. The existing `stays under soft size caps` and both shape tests are the checks.

## Known gaps — where to push

- **The flake itself was not reproduced under contention.** I measured only on an idle machine (9.7 s → 0.47 s). The claim that this cures the timeout under a loaded `yarn check` rests on the ticket's headroom argument (3.7x → roughly 60x) and the reported failure, not on a loaded run. A reviewer wanting evidence could run the shape spec while another package's suite runs.
- **The tightened caps' failure direction was not exercised.** Only the constants changed; I did not temporarily lower a cap to watch it fail. The assertion is a plain `toBeLessThan` that predates this ticket, so I judged that not worth a run, but nothing in this change has been seen to fail.
- **The externalization is matched by path.** If `dist/plugin-browser.js` is renamed or moved, the setting stops applying with no failure and the test silently returns to ~8 s. The config comment says so. No check enforces it, deliberately: the cost is slowness, not a wrong answer, and both the spec comment and the doc say "check the externalization before raising the timeout".
- **`packages/quereus-plugin-sereus/README.md` still says "~2.5 MiB raw, ~550 KiB gzipped"** under the artifacts table. That was already stale before this ticket and ticket 2 will change the size again, so I added a bullet to ticket `browser-bundle-minify-published-payload`'s TODO rather than editing it twice.

## For the next ticket

`browser-bundle-minify-published-payload` lands next. After minification the artifact is about 2.0 MB raw, so today's caps become roughly 2.9x too loose; re-tightening them is already in that ticket's TODO. The comment beside the caps says where to record the new measurement.

## Review findings

_To be filled in by the reviewer._
