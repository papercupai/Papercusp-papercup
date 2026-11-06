import { defineVitestConfig } from '@papercusp/test-config/vitest-config';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { tsImport } from 'tsx/esm/api';
import { resolveExecutedMapPgUrl } from '../../scripts/lib/executed-source-map.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

function runtimeWitnessPgOptions(url: string) {
  const parsed = new URL(url);
  const tlsConfigured = Boolean(process.env.PGSSL?.trim())
    || [...parsed.searchParams.keys()].some(key => key.toLowerCase().startsWith('ssl'));
  // Node's localhost lookup can block in an ADDRCONFIG interface scan, and
  // postgres.js starts connect_timeout before that lookup. Numeric loopback
  // avoids that scan only for plain local connections; keeping the URL intact
  // and retaining the hostname on remote/TLS routes preserves their semantics.
  return {
    ...(parsed.hostname === 'localhost' && !tlsConfigured ? { host: '127.0.0.1' } : {}),
    max: 1,
    connect_timeout: 1,
    onnotice: () => {},
  };
}

function validateProfileOperatorPort(runtimeUnits: unknown, operatorUrl: string | undefined) {
  if (!Array.isArray(runtimeUnits)) return;
  const ports = runtimeUnits.flatMap(unit => {
    if (typeof unit !== 'string' || !unit.startsWith('hono-host:')) return [];
    const match = /^hono-host:([0-9]+)$/.exec(unit);
    if (!match) throw new Error('live-profile-invalid-runtime-unit');
    return [Number(match[1])];
  });
  if (ports.length === 0) return;
  const uniquePorts = new Set(ports);
  if (uniquePorts.size !== 1 || ports.some(port => !Number.isInteger(port) || port < 1 || port > 65_535)) {
    throw new Error('live-profile-invalid-runtime-unit');
  }
  if (!operatorUrl?.trim()) throw new Error('live-profile-required-env-missing:PAPERCUSP_OPERATOR_URL');
  let actualPort: string;
  try {
    const parsed = new URL(operatorUrl);
    actualPort = parsed.port || (parsed.protocol === 'https:' ? '443' : parsed.protocol === 'http:' ? '80' : '');
  } catch {
    throw new Error('live-profile-invalid-operator-url');
  }
  if (actualPort !== String(ports[0])) {
    throw new Error(`live-profile-selected-operator-port-mismatch:expected-${ports[0]}:actual-${actualPort || 'default'}`);
  }
}

type RuntimeWitnessReader<T extends { fingerprint: string }> = () => Promise<T | null>;

/** Wait briefly for the best-effort host boot report to converge before selecting a live runtime. */
export async function waitForRuntimeWitness<T extends { fingerprint: string }>(
  read: RuntimeWitnessReader<T>,
  options: { timeoutMs?: number; now?: () => number; sleep?: (milliseconds: number) => Promise<void> } = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 45_000;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? (milliseconds => new Promise<void>(resolve => setTimeout(resolve, milliseconds)));
  const startedAt = now();
  let delayMs = 250;
  while (true) {
    const witness = await read();
    if (witness && typeof witness.fingerprint === 'string' && witness.fingerprint.trim()) return witness;
    const remainingMs = timeoutMs - (now() - startedAt);
    if (remainingMs <= 0) throw new Error(`live-profile-runtime-vintage-not-ready-after-${timeoutMs}ms`);
    await sleep(Math.min(delayMs, remainingMs));
    delayMs = Math.min(delayMs * 2, 5_000);
  }
}

// The e2e layer (EI-24442044145393058): `*.e2e.test.ts` files that drive a live running
// system. `npm run test:file` routes such a file here, so its test_runs row records
// testLayer 'e2e' from this config's runtime `provide` — acceptance BAR clauses whose
// requiredTestLayers name 'e2e' bind only to such a row. The unit config still collects
// these files too, so the gate's unit run keeps covering them.
export async function prepareRuntimeReader(
  loadRuntime = () => tsImport('./lib/runtime-vintage.ts', import.meta.url),
  loadPg = async () => (await import('postgres')).default,
  loadNativeRuntime = () => tsImport('./lib/testing-native-runtime.ts', import.meta.url),
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
  if (required.includes('PAPERCUSP_OPERATOR_URL')) {
    validateProfileOperatorPort(profile.runtimeUnits, process.env.PAPERCUSP_OPERATOR_URL);
  }
  // A verifier owns a disposable native process, rather than the shared units
  // named by the profile. Reuse the same source/kernel custody check as the
  // Playwright reporter; an invalid native witness must never fall back to PG.
  if (process.env.VERIFY_TAURI_PID || process.env.VERIFY_TAURI_PORT) {
    const { prepareNativeRuntimeReader } = await loadNativeRuntime();
    const read = prepareNativeRuntimeReader(resolve(__dirname, '../..'),
      process.env.VERIFY_TAURI_SOURCE_REF ?? null);
    if (!read) throw new Error('live-profile-native-runtime-unavailable');
    return async () => read();
  }
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
    const sql = pg(url, runtimeWitnessPgOptions(url));
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
