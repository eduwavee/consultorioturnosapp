import { defineConfig, devices } from '@playwright/test';

/**
 * Tests de punta a punta: levantan la app real (API + landing + panel compilado)
 * contra una base que se recrea con los datos de demo en cada corrida.
 *   npm run e2e -w panel
 */
const PORT = 3100;
const db = process.env.E2E_DATABASE_URL ?? process.env.TEST_DATABASE_URL
  ?? 'postgres://consultorio:consultorio@localhost:5432/consultorio_test';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  use: {
    baseURL: `http://localhost:${PORT}`,
    locale: 'es-AR',
    timezoneId: 'America/Argentina/Tucuman',
    trace: 'retain-on-failure',
  },
  // Safari incluido: aplica reglas que Chrome no aplica en localhost (por ejemplo, upgrade-insecure-requests)
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
  webServer: {
    command: 'npx tsx scripts/migrate.ts --reset && npx tsx scripts/seed.ts && npx tsx src/server.ts',
    cwd: '../api',
    url: `http://localhost:${PORT}/api/salud`,
    reuseExistingServer: false,
    timeout: 60_000,
    env: { DATABASE_URL: db, PORT: String(PORT), NODE_ENV: 'test', RUN_WORKER: 'false', PUBLIC_RATE_LIMIT: '100000', LOGIN_RATE_LIMIT: '100000' },
  },
});
