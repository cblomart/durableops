// `vitest/config` re-exports Vite's defineConfig with the `test` key typed, so
// one config file covers both build and test.
import { defineConfig } from 'vitest/config';
import vue from '@vitejs/plugin-vue';

// https://vite.dev/config/
export default defineConfig({
  plugins: [vue()],
  build: {
    // The brief targets < 300 KB gzipped. Fail loudly well before that so a
    // dependency creeping in gets noticed in review, not in production.
    chunkSizeWarningLimit: 400,
    sourcemap: true,
  },
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
      // Vue SFCs and the MSAL/browser wiring are covered by the Playwright
      // layer, not by unit tests; excluding them keeps thresholds meaningful.
      exclude: ['src/main.ts', 'src/**/*.d.ts'],
      thresholds: {
        lines: 70,
        branches: 70,
        functions: 70,
        statements: 70,
        // The API modules carry the security-relevant logic: hold them higher.
        'src/api/**': {
          lines: 80,
          branches: 80,
          functions: 80,
          statements: 80,
        },
      },
    },
  },
});
