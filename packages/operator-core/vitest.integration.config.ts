import { defineVitestConfig } from '@papercusp/test-config/vitest-config';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tsImport } from 'tsx/esm/api';
import { prepareRuntimeReader, waitForRuntimeWitness } from './vitest.e2e.config.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Reuse the live profile's selected runtime for integration evidence as well.
// Configuration preparation stays outside the reporter's bounded observation.
const profileRuntimeReader = await prepareRuntimeReader();
// Hand the deliberately selected live target across the worker's hermetic env
// scrub. The existing reader independently measures the serving processes.
const recoveryProfile = process.env.PAPERCUSP_APP_OPERATION_LIVE_PROFILE;
const recoveryRuntime = recoveryProfile === 'packages/operator-core/test/fixtures/session-recovery.live-profile.json'
  || recoveryProfile === 'packages/operator-core/test/fixtures/session-recovery-release.live-profile.json'
  ? {
      url: process.env.PAPERCUSP_OPERATOR_URL ?? '',
      runtime: await waitForRuntimeWitness(profileRuntimeReader!),
    }
  : null;
// Preload the existing host resolver before the reporter's bounded witness
// read. Ordinary isolated integration suites do not open the live-host graph.
const liveRuntime = process.env.PAPERCUSP_WOE_SERVED_AUDIT === '1'
  ? await tsImport('./lib/runtime-vintage.ts', import.meta.url) : null;
const liveRuntimeDb = liveRuntime ? await tsImport('@papercusp/db-org', import.meta.url) : null;
const posthogRuntimeUnit = process.env.PAPERCUSP_TEST_POSTHOG_LIVE === 'true'
  ? process.env.PAPERCUSP_TEST_POSTHOG_RUNTIME_UNIT : null;
const focusedRuntimeUnit = process.env.PAPERCUSP_TEST_FOCUSED_SERVICE_LIVE === '1' ? 'focused-tsc:installed' : null;
const externalRuntimeUnit = focusedRuntimeUnit || posthogRuntimeUnit;
const remoteRuntime = externalRuntimeUnit ? await tsImport('./lib/remote-runtime-identity.ts', import.meta.url) : null;
// PostHog's producer performs two parallel authenticated reads, each bounded at
// 10s. The generic reporter deadline is intentionally 1s for local readers, so
// declare the producer's actual boundary here instead of manufacturing a witness
// after a short consumer timeout.
const POSTHOG_RUNTIME_CAPTURE_TIMEOUT_MS = 15_000;

// The SP1 C4 carve moved the plans/cross_harness integration tests here; they
// inject('baselineSchemaDsn') via _pg-tool-fixture, so this package needs the
// shared baseline-schema globalSetup (was only wired in apps/operator before).
// The admin test-runs reporter is auto-wired by defineVitestConfig.
// Coverage-census attribution (P-004) — see the note in vitest.config.ts. The INTEGRATION
// layer is where this actually produces rows: it is the layer with a reachable Postgres, so a
// flush lands instead of disabling the sink.
const config = defineVitestConfig({
  layer: 'integration',
  exclude: ['lib/blueprint/launch-blueprint-account-route.e2e.test.ts'],
  ...(profileRuntimeReader || liveRuntime || remoteRuntime ? {
    readRuntimeEnvironment: async () => {
      if (profileRuntimeReader) return profileRuntimeReader();
      if (remoteRuntime && externalRuntimeUnit) {
        const units = [externalRuntimeUnit];
        const fingerprint = await remoteRuntime.measureRuntimeEnvironment([], units);
        return fingerprint ? { schemaVersion: 1 as const, units, fingerprint, observedAt: new Date().toISOString() } : null;
      }
      const units = ['hono-host:3170'];
      const { sql } = liveRuntimeDb!.createDedicatedOrgPg('woe-integration-runtime', { max: 1 });
      try {
        const fingerprint = liveRuntime.measureRuntimeVintageEnvironment(
          await liveRuntime.listRuntimeVintage('papercusp-workspace', sql), units,
        );
        return fingerprint ? { schemaVersion: 1 as const, units, fingerprint, observedAt: new Date().toISOString() } : null;
      } finally {
        await sql.end({ timeout: 1 });
      }
    },
    // The focused reader bounds systemd and socket reads at two seconds each.
    ...(focusedRuntimeUnit && !profileRuntimeReader
      ? { runtimeEnvironmentCaptureTimeoutMs: 5_000 } : {}),
    ...(remoteRuntime && posthogRuntimeUnit && !focusedRuntimeUnit && !profileRuntimeReader
      ? { runtimeEnvironmentCaptureTimeoutMs: POSTHOG_RUNTIME_CAPTURE_TIMEOUT_MS } : {}),
  } : {}),
  globalSetup: [resolve(__dirname, 'test/_integration-substrate.globalSetup.ts')],
  setupFiles: [
    resolve(__dirname, 'lib/coverage-census/attribution/setup-vitest.ts'),
    // Integration routes also start tracked lazy imports (e.g. session end).
    // Join them before teardown, using the same registry as the unit lane.
    resolve(__dirname, 'lib/detached-imports/setup-vitest.ts'),
  ],
});
if (recoveryRuntime && config.test) {
  config.test.provide = { ...config.test.provide, sessionRecoveryRuntime: recoveryRuntime };
}
export default config;
