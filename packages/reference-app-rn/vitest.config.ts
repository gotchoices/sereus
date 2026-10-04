import { defineConfig } from 'vitest/config';

/**
 * Four test projects, kept apart so the platform-agnostic core never drags the
 * React renderer (or, transitively, react-native) into its environment, and so
 * the stale-build guard only gates the tests that run other packages' `dist`:
 *
 *  - **node** — plain-node unit tests for logic that depends only on injectable
 *    interfaces (`push-wake.ts`, key store, …). No React, no DOM.
 *
 *  - **react** — `renderHook`-style tests that mount `useCadreInternal` with
 *    `react-test-renderer` to exercise the hook ↔ {@link BackgroundRunner} wiring
 *    (effect lifecycle, cold-start re-sync, state propagation), and `useChat` to
 *    exercise its poll's single-flight guard. The native modules the hooks would
 *    otherwise pull (`cadre-phone`, `app-state`, `push-wake-native`, `chat-strand`,
 *    `chat-operations`, `@serfab/cadre-core`) are `vi.mock`ed in the specs, so
 *    react-native is never loaded here either — node environment is enough for
 *    `react-test-renderer`.
 *
 *  - **metro-babel** — compiles probes with the app's own Metro Babel transformer
 *    and runs the output, to catch Babel helper defects that only exist in the
 *    Hermes bundle (Node runs that syntax natively). It loads no compiled output
 *    from other packages, so it carries no stale-build guard.
 *
 *  - **polyfills** — a drift guard over the globals this app's installed
 *    dependencies read, checked against the polyfills in `@serfab/cadre-rn` (whose
 *    own `polyfills` project tests their behaviour). The dependency graph is this
 *    app's, so the guard lives here. Its own project for the same reason as
 *    `metro-babel`: it runs none of the `node` project's stale-build guard over
 *    sibling `dist` output, so `vitest run --project polyfills` stays runnable while
 *    a sibling is unbuilt. It does read dependency `dist` trees, but only as text.
 *
 * RN-coupled production modules (`app-state.ts`, screens) are not unit-targeted
 * by any project; they run under the Expo e2e harness (`scripts/run-e2e.mjs`).
 */
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'node',
          environment: 'node',
          include: ['test/**/*.spec.ts'],
          exclude: ['test/react/**', 'test/metro-babel/**', 'test/polyfills/**'],
          globalSetup: ['./test/global-setup.ts'],
        },
      },
      {
        test: {
          name: 'metro-babel',
          environment: 'node',
          include: ['test/metro-babel/**/*.spec.ts'],
        },
      },
      {
        test: {
          name: 'polyfills',
          environment: 'node',
          include: ['test/polyfills/**/*.spec.ts'],
        },
      },
      {
        test: {
          name: 'react',
          environment: 'node',
          include: ['test/react/**/*.spec.ts'],
          setupFiles: ['test/react/setup.ts'],
        },
      },
    ],
  },
});
