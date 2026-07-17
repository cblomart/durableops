import { defineConfig, devices } from '@playwright/test';

/**
 * Deterministic E2E: the built app, with MSAL and every Azure call stubbed.
 *
 * No network, no tenant, no tokens — these tests must pass on a laptop with no
 * Azure access at all, and must never be the reason CI needs a credential. The
 * live smoke test against a real deployment is a separate, nightly concern.
 */
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env['CI'],
  retries: process.env['CI'] ? 2 : 0,
  reporter: process.env['CI'] ? 'github' : 'list',
  use: {
    baseURL: 'http://localhost:4173',
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    // Tests run against the real production build, not the dev server: CSP and
    // bundling differences are exactly the sort of thing that breaks in prod.
    command:
      'npm run build:e2e && cp public/config.json.example dist/config.json && npm run preview -- --port 4173',
    url: 'http://localhost:4173',
    reuseExistingServer: !process.env['CI'],
    timeout: 120_000,
  },
});
