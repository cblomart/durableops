// `vitest/config` re-exports Vite's defineConfig with the `test` key typed, so
// one config file covers both build and test.
import { defineConfig } from 'vitest/config';
import vue from '@vitejs/plugin-vue';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

// Version comes from package.json (release-please bumps it at release time); the
// short SHA pins exactly which build is live. Both are frozen into the bundle so
// the footer can show them with no runtime lookup.
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
  version: string;
};
function gitSha(): string {
  try {
    return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    return 'nogit';
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [vue()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __BUILD_SHA__: JSON.stringify(gitSha()),
  },
  build: {
    // The brief targets < 300 KB gzipped. Fail loudly well before that so a
    // dependency creeping in gets noticed in review, not in production.
    chunkSizeWarningLimit: 400,
    // No production sourcemap. It embeds the full original source — including the
    // e2e auth-seam string — into a file served at the app origin, which both
    // bloats the deploy and defeats the "seam absent from dist/" CI guarantee.
    // `vite dev` keeps sourcemaps regardless, so local debugging is unaffected.
    sourcemap: false,
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
