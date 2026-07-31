import { defineConfig } from 'vitest/config';

// NOTE: this is the one package with no stale-build guard — it declares zero
// `workspace:`/`link:` dependencies, so there is nothing for `assertBuildFresh`
// to check. If it ever gains one, add a `test/global-setup.ts` + companion
// `build-targets` spec the way the other packages have (see
// `test-harness/build-freshness.ts`); nothing here will flag the omission.
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/__tests__/**/*.test.ts'],
  },
});
