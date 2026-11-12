import { defineConfig } from '@playwright/test';

const PORT = 4455;

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 60_000,
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'off',
    launchOptions: process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : undefined,
  },
  webServer: {
    // frische Datenbank, Mails landen im Log (kein SMTP)
    command: `rm -rf test-results/e2e && mkdir -p test-results/e2e && DATABASE_PATH=test-results/e2e/t.db MATRIX_STATE_FILE=test-results/e2e/m.json PUBLIC_URL=http://localhost:${PORT} PORT=${PORT} MIN_FORM_SECONDS=0 node server.mjs > test-results/e2e/server.log 2>&1`,
    url: `http://localhost:${PORT}/health`,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
