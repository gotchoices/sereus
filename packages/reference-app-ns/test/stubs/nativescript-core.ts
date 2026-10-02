/**
 * Stand-in for `@nativescript/core` under the unit suite, aliased in by
 * `vitest.config.ts`.
 *
 * The package's own entry point cannot be loaded under plain Node — it reaches
 * `@nativescript/core/globals` as a *directory* import, which Node's ESM loader
 * refuses for an externalized dependency:
 *
 *   Error [ERR_UNSUPPORTED_DIR_IMPORT]: Directory import '.../@nativescript/core/globals'
 *     is not supported resolving ES modules imported from .../@nativescript/core/index.js
 *
 * Its `data/observable` and `data/observable-array` submodules load, so the view
 * models get the REAL `Observable` and `ObservableArray` — `notifyPropertyChange`,
 * the property-change plumbing and the array's `splice`/`push` run for real. A
 * hand-written double would quietly diverge from the classes the app actually
 * ships against.
 *
 * `data/observable-array/index.js` itself imports `'../observable'` as a
 * directory, yet loads: `@nativescript/core` ships ESM syntax under a
 * `package.json` with no `"type": "module"`, so Vite transforms these files
 * itself instead of handing them to Node's loader, and Vite resolves the
 * directory import. Measured under Vitest 4.1.8 / Node 24.2.0 (2026-09-29). If the
 * `ERR_UNSUPPORTED_DIR_IMPORT` error ever returns for these submodules, add
 * `test.server.deps.inline: [/@nativescript\/core/]` to `vitest.config.ts` (it
 * works, and is not needed today) — do not replace the real class with a double.
 *
 * Scope is deliberately these two modules. Widen it only for a class a view model
 * actually imports.
 *
 * NOTE: importing this file makes every `vitest run` print three Vite warnings —
 * "Sourcemap for .../data/observable/index.js points to a source file outside its
 * package", and the same for `data/observable-array/index.js` and
 * `utils/types.js`. `@nativescript/core` ships `.js.map` files whose `sources`
 * entries escape the package root; they are cosmetic and affect nothing but the
 * log. If the suite ever needs clean output (CI log scraping, a zero-warning
 * gate), the fix is to strip or ignore that dependency's sourcemaps, not to stop
 * using the real classes.
 */

export { Observable, WrappedValue } from '@nativescript/core/data/observable/index.js';
export type { EventData, PropertyChangeData } from '@nativescript/core/data/observable/index.js';
export { ObservableArray } from '@nativescript/core/data/observable-array/index.js';
