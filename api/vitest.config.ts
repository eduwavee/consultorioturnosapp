import { defineConfig } from 'vitest/config';

const testDb = process.env.TEST_DATABASE_URL ?? 'postgres://consultorio:consultorio@localhost:5432/consultorio_test';

export default defineConfig({
  test: {
    env: {
      DATABASE_URL: testDb, NODE_ENV: 'test', PUBLIC_RATE_LIMIT: '100000', LOGIN_RATE_LIMIT: '100000',
      WHATSAPP_VERIFY_TOKEN: 'verificar-test', WHATSAPP_APP_SECRET: 'secreto-app-test', CRON_SECRET: 'cron-test',
      PUBLIC_URL: 'https://consultorio.test',
    },
    globalSetup: './test/setup.ts',
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 60_000,
  },
});
