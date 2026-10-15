import { defineConfig } from '@playwright/test';
import base from './playwright.config';
import { readPlanAuditReleaseConfig } from './e2e/_plan-audit-release-config';

const release = readPlanAuditReleaseConfig();

// Reuse the maintained Chromium/temp-preflight/reporter profile. This profile
// reaches the existing release runtime and does not start a development server.
export default defineConfig({
  ...base,
  testMatch: /plan-audit-release\.live\.ts$/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  globalSetup: undefined,
  webServer: undefined,
  timeout: 12 * 60_000,
  outputDir: release.evidenceDir,
  use: { ...base.use, baseURL: release.origin, trace: 'off', video: 'off', screenshot: 'only-on-failure' },
});
