import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/auto/**/*.ts'],
    coverage: { reporter: ['text', 'html'] }
  }
})


