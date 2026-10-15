import { defineConfig } from '@playwright/test';
import base from './playwright.config.mts';

// R5 uses the maintained live acceptance convention, browser fixture and
// ledger reporter. Explicit runtime inputs prevent a dev-server fallback.
const origin = process.env.PAPERCUSP_BQL_ORIGIN;
if (!origin) throw new Error('Supply PAPERCUSP_BQL_ORIGIN for the identified current-build runtime.');

export default defineConfig({
  ...base,
  testMatch: /bug-queue-current-build\.live\.ts$/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  globalSetup: undefined,
  webServer: undefined,
  timeout: 90_000,
  use: { ...base.use, baseURL: origin, trace: 'retain-on-failure', video: 'off' },
});
