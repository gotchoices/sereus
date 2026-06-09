import { defineConfig } from 'vitest/config';

/**
 * Unit tests for platform-agnostic app logic (e.g. `background-runner.ts`) that
 * runs in plain node — it depends only on injectable interfaces, never on the
 * react-native runtime. RN-coupled modules (`app-state.ts`, components) are not
 * targeted here; they are exercised by the Expo e2e harness (`scripts/run-e2e.mjs`).
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.spec.ts'],
  },
});
