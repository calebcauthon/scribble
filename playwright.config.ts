import { defineConfig, devices } from '@playwright/test'

/**
 * End-to-end tests drive the real client bundle against the real server, with the
 * fake GitHub from `fixture/` standing in for the API. `npm run fixture` boots both.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: 'http://localhost:8787',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1100, height: 720 } } }],
  webServer: {
    command: 'npm run fixture',
    url: 'http://localhost:8787/health',
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
})
