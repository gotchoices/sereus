description: A test that loads the plugin's browser build occasionally fails on a busy machine because the test framework re-processes the whole 4.7 MB file every run instead of just loading it. Stop it doing that, and tighten the size limits that are currently so loose the file could grow by two thirds without anyone noticing.
architecture: docs/testing.md
files:
  - packages/quereus-plugin-sereus/vitest.config.ts
  - packages/quereus-plugin-sereus/test/browser-shape.spec.ts
  - packages/quereus-plugin-sereus/test/browser-bundle.spec.ts
  - packages/quereus-plugin-sereus/scripts/build-browser.mjs
difficulty: easy
----

# Load the browser bundle instead of transforming it, and make the size caps mean something

Two arms. Both live in this one package's test setup, both come from the same measurement pass, and the second needs the numbers the first one produces — so they land together.

## Arm 1 — the timeout is spent in Vite, not in the bundle

`test/browser-shape.spec.ts` does `await import(pathToFileURL(bundlePath).href)` inside a test with a 30-second budget. The artifact it imports, `dist/plugin-browser.js`, sits under the package root, so vitest's module runner does not hand it to Node — it pulls the whole 4.66 MiB file through Vite's transform pipeline, and reads the 12.7 MB source map beside it on the way (Vite prints `Sourcemap for ".../dist/plugin-browser.js" points to missing source files` as it does so).

Measured on an idle machine, at `00c731bc`:

| | wall clock |
|---|---|
| `node` importing the artifact directly | 474 ms |
| the same import inside vitest (first test) | **8,197 ms**, of which Vite reports `transform 6.99s` |
| the same import inside vitest (second test, module cached) | 128 ms |

So on an idle machine the test uses 8.2 s of its 30 s budget — 3.7x headroom. Under a full `yarn check` the machine is carrying every other package's suite in parallel, and 3.7x of contention is an ordinary afternoon. That is the whole flake. Raising the number buys a bigger idle machine, not a fix.

Excluding the artifact from Vite's pipeline was tried and measured. Adding this to the `unit` project in `vitest.config.ts`:

```ts
server: { deps: { external: [/dist[\\/]plugin-browser\.js$/] } },
```

took the first test from **8,197 ms to 408 ms** and `transform` from 6.99 s to 13 ms. Both tests still pass, the source-map warning goes away, and the import cost stops scaling with the artifact's byte count — which is the property worth having, because the byte count is going to keep moving.

Do that. Then replace the stale comment above the first test — it says "2.5 MiB ESM parses in roughly 1-5s on a cold cache; give it headroom", which describes neither the current size nor, now, the mechanism. Say what the timeout is actually protecting against and why the artifact is externalized, so the next person who sees a slow run does not reach for a bigger number.

Keep the 30-second timeouts. At 408 ms they are no longer load-bearing, and there is no reason to make them tight.

Note the change in `docs/testing.md` alongside the other notes about what the bundle checks do and do not cover.

## Arm 2 — the size caps are too loose to fire

`test/browser-bundle.spec.ts` already has a size assertion (`stays under soft size caps`): 8 MiB raw, 3 MiB gzipped. The bug report that produced this ticket said no size guard existed anywhere in the package. That was wrong — the guard exists. What is true is that it cannot do its job: the artifact measures 4,890,498 bytes raw and 1,162,304 bytes gzipped, which is 58% and 39% of its respective caps. The growth from roughly 2.5 MiB to 4.66 MiB that prompted the report passed underneath it without a word, and the file could still gain another two thirds in silence.

Tighten both caps to sit just above the measured numbers — enough headroom that ordinary churn does not trip them, little enough that a structural jump does. Roughly 20% is the right order; pick the exact figures from the build you measure.

Record the measurement beside the constants: the byte count, the date, and the command that produced it, so the next person to hit the cap can tell a deliberate bump from a regression. `scripts/build-browser.mjs` already prints raw and gzipped sizes on every build — cite it.

One thing the caps cannot see, worth a `NOTE:` comment at the cap constants rather than a ticket of its own: this assertion measures the artifact built from the local tree, and that is also the artifact that gets published (`scripts/publish-package.mjs:190` runs `yarn build` and ships `dist/`). `yarn smoke:published` installs from the registry and is described in `docs/releasing.md` as "the only gate that can see a defect which exists solely in the published dependency graph" — but it cannot see into this bundle, because the bundle was already built before the tarball was packed. The cap here is therefore the only guard on the published browser payload's size. Say so at the site.

## Not in scope

Making the bundle smaller. That is ticket `browser-bundle-minify-published-payload`, which lands next and will re-tune the caps this ticket sets.

## TODO

- Add `server: { deps: { external: [/dist[\\/]plugin-browser\.js$/] } }` to the `unit` project in `packages/quereus-plugin-sereus/vitest.config.ts`. Confirm the `e2e` project does not need it (it does not import the artifact).
- Run `yarn workspace @serfab/quereus-plugin-sereus exec vitest run --project unit test/browser-shape.spec.ts --reporter=verbose` and confirm the first test drops to well under a second and `transform` collapses.
- Replace the stale `2.5 MiB` comment in `test/browser-shape.spec.ts` with one that explains the externalization and what the timeout now guards.
- Measure the artifact fresh (`yarn workspace @serfab/quereus-plugin-sereus build` prints both numbers) and tighten `MAX_RAW_BYTES` / `MAX_GZIPPED_BYTES` in `test/browser-bundle.spec.ts` to roughly 20% above what you measure.
- Add the measured bytes, the date, and the producing command as a comment beside those constants.
- Add the `NOTE:` at the same site recording that this cap is the only guard on the published browser payload, because `smoke:published` cannot see inside a pre-built bundle.
- Update `docs/testing.md` where it describes the bundle checks.
- Run the package's full unit suite and confirm it is green.
