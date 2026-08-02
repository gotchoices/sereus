import { defineConfig } from 'vitest/config';

/**
 * Two test projects, kept apart so the platform-agnostic core never drags the
 * React renderer (or, transitively, react-native) into its environment:
 *
 *  - **node** — plain-node unit tests for logic that depends only on injectable
 *    interfaces (`background-runner.ts`, `push-wake.ts`, key store, …). No React,
 *    no DOM. `background-runner.ts` stays RN-free precisely because it is never
 *    imported by anything in this project.
 *
 *  - **react** — `renderHook`-style tests that mount `useCadreInternal` with
 *    `react-test-renderer` to exercise the hook ↔ {@link BackgroundRunner} wiring
 *    (effect lifecycle, cold-start re-sync, state propagation). The native
 *    modules the hook would otherwise pull (`cadre-phone`, `app-state`,
 *    `push-wake-native`, `chat-strand`, `@serfab/cadre-core`) are `vi.mock`ed in
 *    the spec, so react-native is never loaded here either — node environment is
 *    enough for `react-test-renderer`.
 *
 * RN-coupled production modules (`app-state.ts`, screens) are not unit-targeted
 * by either project; they run under the Expo e2e harness (`scripts/run-e2e.mjs`).
 */
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'node',
          environment: 'node',
          include: ['test/**/*.spec.ts'],
          exclude: ['test/react/**'],
          globalSetup: ['./test/global-setup.ts'],
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
