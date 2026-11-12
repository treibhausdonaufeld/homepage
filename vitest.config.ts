import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
    env: { TZ: 'UTC', HMAC_SECRET: 'test-secret', SESSION_SECRET: 'test-session' },
  },
});
