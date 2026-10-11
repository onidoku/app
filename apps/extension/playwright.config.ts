import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'e2e',
  // One browser profile with one extension instance; tests share the test site's state.
  workers: 1,
  timeout: 30_000,
  reporter: 'list',
  webServer: {
    command: 'node ../test-site/server.mjs',
    url: 'http://localhost:4173',
    reuseExistingServer: true,
  },
});
