import { defineConfig } from '@playwright/test';
import base from './playwright.config';

const port = Number(process.env.OPERATOR_E2E_PREVIEW_PORT ?? 4173);
const baseURL = `http://127.0.0.1:${port}`;

/**
 * The Vite dev server injects CSS through its dev module graph and cannot
 * exercise the production import-preload helper. This profile owns a Vite
 * preview server over the just-built operator-vite dist and runs the one
 * regression case whose test-only preview middleware returns the first armed
 * lazy HUD stylesheet request as a real same-origin HTTP 503.
 */
export default defineConfig({
  ...base,
  testMatch: /adv-shell-nav\.spec\.ts$/,
  testIgnore: [],
  globalSetup: undefined,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  use: { ...base.use, baseURL },
  webServer: {
    command: `npm run preview -- --config vite.config.production-preview.ts --host 127.0.0.1 --port ${port} --strictPort`,
    cwd: '../operator-vite',
    url: baseURL,
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
