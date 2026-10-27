import { defineConfig } from '@playwright/test';
import base from './playwright.config';

/** The shared journey has an explicit current-build or final-release manifest.
 * It starts no server and is excluded from default collection by its .live.ts suffix. */
export default defineConfig({
  ...base,
  // Controlled primitive captures are selected explicitly; canonical acceptance
  // still collects only the actual graph journey on either evidence plane.
  testMatch: process.env.PAPERCUSP_ENGINEERING_CONTROLS_LIVE === '1'
    ? /engineering-evidence-controls\.live\.ts$/ : /engineering-evidence\.live\.ts$/,
  fullyParallel: false, workers: 1, retries: 0,
  globalSetup: undefined, webServer: undefined, timeout: 12 * 60_000,
  use: { ...base.use, baseURL: process.env.OPERATOR_E2E_BASE_URL, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
});
