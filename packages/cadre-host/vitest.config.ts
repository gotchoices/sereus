import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/__tests__/**/*.test.ts', 'ui/__tests__/**/*.test.ts'],
    globalSetup: ['./src/__tests__/global-setup.ts'],
  },
});
