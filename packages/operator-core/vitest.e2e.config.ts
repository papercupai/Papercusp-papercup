import { defineVitestConfig } from '@papercusp/test-config/vitest-config';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { tsImport } from 'tsx/esm/api';
import { resolveExecutedMapPgUrl } from '../../scripts/lib/executed-source-map.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// The e2e layer (EI-24442044145393058): `*.e2e.test.ts` files that drive a live running
// system. `npm run test:file` routes such a file here, so its test_runs row records
// testLayer 'e2e' from this config's runtime `provide` — acceptance BAR clauses whose
// requiredTestLayers name 'e2e' bind only to such a row. The unit config still collects
// these files too, so the gate's unit run keeps covering them.
export async function prepareRuntimeReader(
  loadRuntime = () => tsImport('./lib/runtime-vintage.ts', import.meta.url),
  loadPg = async () => (await import('postgres')).default,
) {
  if (!process.env.PAPERCUSP_APP_OPERATION_LIVE_PROFILE) return undefined;
  const profile = JSON.parse(readFileSync(resolve(__dirname, '../..',
    process.env.PAPERCUSP_APP_OPERATION_LIVE_PROFILE), 'utf8'));
  // Validate inputs before importing the live graph or collecting any tests.
  // A ledger workspace alone does not authorize an authenticated app read.
  const names = (value: unknown): string[] => {
    if (!Array.isArray(value) || value.some(name => typeof name !== 'string'
      || !/^[A-Z][A-Z0-9_]*$/.test(name))) throw new Error('live-profile-invalid-required-env');
    return value;
  };
  const required = names(profile.requiredEnv ?? []);
  const conditional: unknown = profile.requiredEnvWhen ?? [];
  if (!Array.isArray(conditional)) throw new Error('live-profile-invalid-required-env-when');
  for (const rule of conditional) {
    if (!rule || typeof rule !== 'object' || typeof rule.equals !== 'string')
      throw new Error('live-profile-invalid-required-env-when');
    const [flag] = names([rule.env]);
    const selected = names(rule.requiredEnv);
    if (process.env[flag] === rule.equals) required.push(...selected);
  }
  const missing = [...new Set(required)].filter(name => !process.env[name]?.trim());
  if (missing.length) throw new Error('live-profile-required-env-missing:' + missing.join(','));
  // Module loading belongs to configuration preparation, outside the reporter's
  // bounded observation window. tsImport starts a fresh loader on each call.
  const { listRuntimeVintage, measureRuntimeVintageEnvironment } = await loadRuntime();
  const pg = await loadPg();
  return async () => {
    const units: unknown = profile.runtimeUnits;
    if (!Array.isArray(units) || units.length === 0 || units.length > 32
      || units.some(unit => typeof unit !== 'string' || !unit.trim() || unit.length > 120)
      || new Set(units).size !== units.length) return null;
    // The app's default getOrgPg may discover an embedded replica. Runtime
    // evidence must read the same ledger the native reporter writes, including
    // the verifier's dedicated shared-ledger override.
    const { url } = resolveExecutedMapPgUrl();
    const sql = pg(url, { max: 1, connect_timeout: 1, onnotice: () => {} });
    try {
      const rows = await listRuntimeVintage(process.env.PAPERCUSP_TEST_RUN_WORKSPACE || undefined, sql, units);
      const fingerprint = measureRuntimeVintageEnvironment(rows, units);
      return fingerprint ? { schemaVersion: 1 as const, units, fingerprint, observedAt: new Date().toISOString() } : null;
    } finally {
      await sql.end({ timeout: 0 });
    }
  };
}

export default async () => {
  const readRuntimeEnvironment = await prepareRuntimeReader();
  return defineVitestConfig({
    layer: 'e2e',
    // Optional selectors only. Fingerprints come from the running process ledger
    // and the kernel, never from the fixture or a caller-provided fingerprint.
    ...(readRuntimeEnvironment ? { readRuntimeEnvironment } : {}),
    setupFiles: [
      resolve(__dirname, 'lib/coverage-census/attribution/setup-vitest.ts'),
      resolve(__dirname, 'lib/detached-imports/setup-vitest.ts'),
    ],
  });
};
