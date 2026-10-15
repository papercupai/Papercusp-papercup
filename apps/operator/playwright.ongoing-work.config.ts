import { defineConfig } from '@playwright/test';
import base from './playwright.config';

const targetBaseURL = process.env.OPERATOR_E2E_BASE_URL?.trim();
if (!targetBaseURL) {
  throw new Error('The ongoing-work acceptance profile requires an explicit OPERATOR_E2E_BASE_URL');
}

const expectedSha = process.env.PAPERCUSP_ONGOING_ACCEPTANCE_SHA?.trim();
if (!expectedSha || !/^[a-f0-9]{10,40}$/.test(expectedSha)) {
  throw new Error('The ongoing-work acceptance profile requires PAPERCUSP_ONGOING_ACCEPTANCE_SHA from the selected runtime health');
}

let targetURL: URL;
try {
  targetURL = new URL(targetBaseURL);
} catch {
  throw new Error(`The ongoing-work acceptance target must be an absolute URL: ${targetBaseURL}`);
}

const localHosts = new Set(['localhost', '127.0.0.1', '[::1]']);
if (localHosts.has(targetURL.hostname) && !['3070', '3170'].includes(targetURL.port)) {
  throw new Error(`The ongoing-work acceptance profile supports current-build :3170 or final-release :3070, not ${targetURL.origin}`);
}
if (!localHosts.has(targetURL.hostname) && targetURL.protocol !== 'https:') {
  throw new Error('The ongoing-work acceptance profile requires HTTPS for a remote artifact');
}

/** Explicit real-data acceptance profile, reused for current-build rehearsal and final release. */
export default defineConfig({
  ...base,
  // This profile measures one caller-selected artifact. Never inherit the
  // default config's Vite webServer or its arbitrary OPERATOR_E2E_PORT fallback.
  webServer: undefined,
  testMatch: /ongoing-work-shipment\.live\.ts$/,
  testIgnore: [],
  globalSetup: './e2e/_warm-ongoing-work.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 90_000,
  use: { ...base.use, baseURL: targetBaseURL, trace: 'retain-on-failure' },
});
