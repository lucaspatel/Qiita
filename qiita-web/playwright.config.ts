import { defineConfig, devices } from '@playwright/test';

// Browser tests for whole workflows (tests/e2e). They run against their own dev
// server with no backend: QIITA_BASE names an address nothing listens on and every
// API call is answered by the test (tests/e2e/fixtures.ts), so a run never touches a
// real Qiita and does not depend on the developer's ~/.qiita config.
const PORT = 5181;

export default defineConfig({
  testDir: 'tests/e2e',
  fullyParallel: true,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: { baseURL: `http://127.0.0.1:${PORT}`, trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 1000 } } }],
  webServer: {
    command: `npx vite dev --port ${PORT} --strictPort --host 127.0.0.1`,
    url: `http://127.0.0.1:${PORT}/library-prep`,
    reuseExistingServer: !process.env.CI,
    env: { QIITA_BASE: 'http://127.0.0.1:9', QIITA_CONFIG: '/nonexistent/qiita-config.toml' }
  }
});
