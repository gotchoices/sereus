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
 * Its `data/observable` submodule has no such import and loads cleanly, so the
 * view models get the REAL `Observable` — `notifyPropertyChange` and the
 * property-change plumbing they are built on run for real. A hand-written
 * double would quietly diverge from the class the app actually ships against.
 *
 * Scope is deliberately the observable module and nothing else. `ObservableArray`
 * is NOT reachable this way: `data/observable-array/index.js` re-imports
 * `'../observable'` as a directory, hitting the same loader rule. Do not widen
 * this file to chase it — `src/chat-vm.ts` needs another approach entirely
 * (parked as `debt-ns-chat-vm-unit-tests`).
 *
 * NOTE: importing this file makes every `vitest run` print one Vite warning —
 * "Sourcemap for .../data/observable/index.js points to a source file outside its
 * package". `@nativescript/core` ships a `.js.map` whose `sources` entry escapes
 * the package root; it is cosmetic and affects nothing but the log. If the suite
 * ever needs clean output (CI log scraping, a zero-warning gate), the fix is to
 * strip or ignore that dependency's sourcemap, not to stop using the real class.
 */

export { Observable, WrappedValue } from '@nativescript/core/data/observable/index.js';
export type { EventData, PropertyChangeData } from '@nativescript/core/data/observable/index.js';
