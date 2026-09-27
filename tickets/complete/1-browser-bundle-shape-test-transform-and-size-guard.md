description: The plugin's browser-build test now loads the file directly instead of having the test framework re-process all 4.7 MB of it on every run, and the size limits now sit about 20% above the real size instead of 60% or more above it.
architecture: docs/testing.md
files:
  - packages/quereus-plugin-sereus/vitest.config.ts
  - packages/quereus-plugin-sereus/test/browser-shape.spec.ts
  - packages/quereus-plugin-sereus/test/browser-bundle.spec.ts
  - packages/quereus-plugin-sereus/README.md
  - docs/testing.md
difficulty: easy
----

# Complete — browser bundle shape test transform, and size caps

## What landed

**Arm 1 — the artifact is loaded by Node, not transformed by Vite.** The `unit` project in `packages/quereus-plugin-sereus/vitest.config.ts` lists `dist/plugin-browser.js` under `server.deps.external`, matched by path. `test/browser-shape.spec.ts`'s stale "2.5 MiB ESM parses in roughly 1-5s" comment is replaced by one that says what the 30 s timeout now protects (a genuine hang, not import cost) and tells the next reader to check the externalization before raising it. Timeouts unchanged. The `e2e` project needs nothing: no spec outside the two bundle specs references the artifact, and `browser-bundle.spec.ts` reads it with `fs` rather than importing it.

**Arm 2 — caps that can fire.** `MAX_RAW_BYTES` 8 MiB → `5_900_000`, `MAX_GZIPPED_BYTES` 3 MiB → `1_400_000`, each about 20% above the measurement, with the measured bytes, the date, the producing command, and the `NOTE:` that this assertion is the only guard on the published browser payload's size recorded beside them.

**Docs.** `docs/testing.md` gains a "Browser bundle checks" section (the file had none) plus a pointer from "Where measurements live". `packages/quereus-plugin-sereus/README.md`'s artifact paragraph now states the real size.

## Review findings

**Checked by reading and running, not by adding tests.** The externalization's effect and the recorded byte counts were both re-measured independently of the implementer's numbers; lint, typecheck and the full unit suite were run.

- **The externalization is real and load-bearing — verified by counterfactual, which the handoff had left unverified.** I temporarily changed the regex to a name that cannot match, re-ran `browser-shape.spec.ts`, and restored it: `transform` went from 43 ms to 15.24 s and the first test from 1,739 ms to about 17.6 s. On this machine the pre-change spec therefore had only ~1.7x headroom under its 30 s budget, worse than the 3.7x the fix ticket measured — the flake explanation holds, and the fix moves it to roughly 17x. This closes the handoff's "failure direction was not exercised" gap for arm 1 (arm 2's `toBeLessThan` predates the ticket and still was not watched to fail; that remains fine).
- **The recorded measurement is accurate.** Recomputed `statSync` / `gzipSync(readFileSync(...))` on the committed artifact: 4,890,498 B raw and 1,162,393 B gzipped, exactly as the comment says, giving 20.6% and 20.4% of headroom. The handoff's unexplained 89-byte difference from the fix ticket's quoted figure is in the fix ticket's number, not this one.
- **Fixed inline: the README's public size claim was wrong by roughly 2x** and would have stayed wrong until the next ticket landed. It said "~2.5 MiB raw, ~550 KiB gzipped"; a reader deciding whether to load this from a CDN sees that paragraph. It now states the real size, says the bundle is unminified, and points at the spec for the exact bytes rather than keeping a second precise copy. `2-browser-bundle-minify-published-payload`'s TODO bullet, which quoted the old wording, was updated to match. The handoff's reason for deferring — "ticket 2 changes it again" — is true but does not justify shipping a knowingly-wrong user-facing number in the interim, and ticket 2's bullet already covered the re-edit.
- **Fixed inline: two timing claims were optimistic.** The spec comment and the doc both said the externalized import costs "about half a second" / "well under a second". Measured cold, the first test is 1,739 ms; the implementer's 473 ms was a warm file cache. Both now say "a fraction of a second warm, a second or two on a cold file cache", and the pre-change figure is given as the measured 8-18 s range rather than a single machine's 8 s. The point of these numbers is that a future reader trusts them when judging a slow run, so a figure they cannot reproduce is worse than a range.
- **Fixed inline: the doc did not say why the caps are ceiling-only.** `docs/testing.md`'s surrounding convention is explicit that budget assertions are two-sided (ceiling plus an anti-vacuity floor at half the measurement), so a bare "ceilings only" invites the next reviewer to file "add a floor". The section now says why none is needed: a bundle that collapsed to a stub fails the ESM parse and the shape test long before a floor would see it.
- **Accuracy of the new doc section, checked claim by claim.** `scripts/publish-package.mjs:189-190` does run `yarn clean && yarn build` before publishing, so the measured artifact is the shipped artifact. Both specs do rebuild on demand. Nothing else in the repository holds a size cap for this file (`grep` for `MAX_RAW_BYTES` / `MAX_GZIPPED` finds only these two constants), so "the only guard" is literally true.
- **No tickets filed, and no tripwires added.** The one conditional concern — the externalization is matched by path, so renaming the artifact silently restores the slow import — was already parked by the implementer as a comment at the exact site in `vitest.config.ts`, which is where it belongs; the cost of the trip is slowness, not a wrong answer. Nothing else found rose to the filing bar.
- **Considered and left alone: the duplicated build-on-demand `beforeAll`.** Both specs carry the same twelve-line "build the artifact if it is missing" block. It is real duplication, but it predates this ticket, it is two copies in one directory, and extracting it would widen a two-constant diff into a shared test helper for no behavioural gain. Noted here so the next person touching these files sees it has been weighed.
- **No new tests.** The change is a runner setting and two constants inside an assertion that already existed. The existing `stays under soft size caps` and the two shape tests are the checks, and the counterfactual above is the evidence that the runner setting does what it claims — a test asserting "the module was externalized" would assert vitest's internals, not this package's behaviour.
- **Not reproduced: the original flake under machine contention.** The handoff flagged this and it stands. The headroom argument is now measured on both sides (1.7x → 17x on this machine) rather than estimated, which is as close as an idle-machine run gets.

## Validation

`yarn eslint` on the changed spec and config: clean. `yarn workspace @serfab/quereus-plugin-sereus typecheck`: clean. `vitest run --project unit`: 6 files, 90 tests, all pass, `transform` 9.3 s for the whole suite.

## For the next ticket

`browser-bundle-minify-published-payload` re-tunes these caps after minification and re-states the README size; both of its TODO bullets are current.
