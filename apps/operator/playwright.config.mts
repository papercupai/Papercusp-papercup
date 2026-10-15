// ESM is required by guarded Playwright collection: its CommonJS transform
// changes the input text before the committed-source guard can judge it.
import { defineConfig, devices, type ReporterDescription } from '@playwright/test';
import { preparePlaywrightTempDirectory } from '../../scripts/lib/playwright-temp-directory.cjs';

preparePlaywrightTempDirectory();

const PORT = Number(process.env.OPERATOR_E2E_PORT ?? 3055);
const BASE_URL = process.env.OPERATOR_E2E_BASE_URL ?? `http://localhost:${PORT}`;

const reuseExisting = process.env.OPERATOR_E2E_REUSE_SERVER === '1';

/**
 * Specs owned by a dedicated profile config (`playwright.<profile>.config.ts`).
 * They need credentials or env that a default run does not have, and some throw
 * at MODULE LOAD without it (hosted-http1-acceptance reads its storage-state
 * path at top level). Playwright aborts the WHOLE run on a single load error,
 * so collecting one of them here meant every unfiltered `playwright test` ran
 * zero tests (WI-10006736). `playwright-config.test.ts` fails if a profile
 * config's testMatch selects a file this default config would still collect.
 */
export const PROFILE_OWNED_SPECS: RegExp[] = [
  /hosted-http1-acceptance\.spec\.ts$/,
  /adv-shell-nav\.spec\.ts$/,
];

export default defineConfig({
  testDir: './e2e',
  testMatch: /.*\.spec\.(?:ts|mts)$/,
  testIgnore: PROFILE_OWNED_SPECS,
  // Warm the cold Vite dev server once before any worker starts, so no
  // worker's first test races dependency optimization (WI-10006792).
  globalSetup: './e2e/_warm-dev-server.ts',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 2 : 4,
  reporter: (() => {
    // Custom reporter (P-011) writes per-file Playwright results to
    // harness_shared.test_runs. Fail-soft per D-007 — never throws.
    // Opt-out via PAPERCUSP_DISABLE_TEST_RUNS_REPORTER=1.
    const adminReporter: ReporterDescription[] =
      process.env.PAPERCUSP_DISABLE_TEST_RUNS_REPORTER === '1'
        ? []
        : [['./test/reporters/admin-test-runs-reporter-playwright.ts', {}]];
    return process.env.CI
      ? [['junit', { outputFile: 'junit-e2e.xml' }], ['html', { open: 'never' }], ...adminReporter]
      : [['list'], ...adminReporter];
  })(),
  timeout: 60_000,
  use: {
    baseURL: BASE_URL,
    actionTimeout: 10_000,
    navigationTimeout: 30_000,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: reuseExisting
    ? undefined
    : {
        // The first `--` lets the outer npm script forward arguments; the second
        // reaches the nested workspace npm command so Vite receives them. Keeping
        // the selected port explicit makes a collision fail instead of letting Vite
        // walk to a different port that Playwright never polls.
        command: `npm run dev -- -- --port ${PORT} --strictPort`,
        url: BASE_URL,
        // WI-5603: this branch is reached exactly when the caller asked for
        // an ISOLATED, dedicated server (OPERATOR_E2E_REUSE_SERVER unset /
        // not '1') — reuseExistingServer must be false here. It was
        // hardcoded `true`, which silently defeated the whole point: on
        // this shared dev box a persistent systemd `papercup-vite.service`
        // always already answers on the default port (3055), so Playwright
        // treated it as "already up" and reused THAT live, heavily-loaded
        // shared instance instead of spinning a fresh one — for every run,
        // regardless of the env var. Route settings-page navigation flakes
        // (WI-5603) trace to exactly this: tests silently ran against the
        // shared instance under real concurrent fleet load. With `false`,
        // an isolated run now either spins its own dedicated server (when
        // OPERATOR_E2E_PORT points at a free port) or fails LOUDLY with a
        // port-already-in-use error instead of silently degrading to a
        // shared, contended instance.
        reuseExistingServer: false,
        timeout: 120_000,
        stdout: 'pipe',
        stderr: 'pipe',
        // PAPERCUSP_ENABLE_HMR=1 is REQUIRED for the SPA to render under Vite.
        // Without it the dev server serves a noop `/@vite/client` stub (the
        // desktop-static-host path) that omits `createHotContext`; Vite's
        // dev-transformed modules import that symbol, so the import throws,
        // the module graph fails, and `#root` never mounts → every UI spec
        // sees a blank page. With HMR on, the real client is served and the
        // app mounts. (See operator-vite/dev-mode.ts + vite.config.ts L107.)
        //
        // PAPERCUSP_FAKE_LLM=1 activates the fake-LLM injection seam so the
        // chat-streaming + plan-agent-launch specs RUN (scripted deltas)
        // instead of auto-skipping (P-028 de-skip).
        //
        // When reusing an external server (OPERATOR_E2E_REUSE_SERVER=1, e.g. a
        // Tauri shell or a standing :3055) that server must ITSELF carry BOTH
        // PAPERCUSP_ENABLE_HMR=1 and PAPERCUSP_FAKE_LLM=1 — the standing
        // `dev:operator` service runs HMR-disabled (for the desktop), so a
        // reused :3055 renders blank; point at an HMR-enabled vite instead.
        //
        // PAPERCUSP_DEV_WATCH=0 turns Vite's file watcher off. HMR stays on (the
        // SPA needs the real client), but a peer's save to this SHARED tree can no
        // longer full-reload every open test page mid-run (WI-10006950: three
        // peer-triggered `page reload`s in one full-suite run, one of which killed
        // global-shortcuts.spec.ts:134 with "Execution context was destroyed").
        env: {
          ...process.env,
          PAPERCUSP_FAKE_LLM: '1',
          PAPERCUSP_ENABLE_HMR: '1',
          PAPERCUSP_DEV_WATCH: '0',
        },
      },
});
