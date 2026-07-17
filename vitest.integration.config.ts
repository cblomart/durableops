import { defineConfig } from 'vitest/config';

/**
 * Integration tests against real Azure. Separate from the unit config so
 * `npm test` stays offline, fast and credential-free, and so coverage
 * thresholds are not computed from a run that needs a live task hub.
 *
 * Runs on merges to main and nightly — not on every PR (see the brief).
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/integration/**/*.test.ts'],
    // Real orchestrations take time to reach their states.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // Shared task hub: parallel files would race on the same instances.
    fileParallelism: false,
  },
});
