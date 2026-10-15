import { expect, it, vi } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { runRootCensus } from '../../../../scripts/state-census-roots.mts';
import { getHarnessAdminUrl } from '../embedded-pg-discovery';

// Deliberately separate from the fixture test: collection must preserve the
// native host environment and capture the original census source in-process.
it.runIf(process.env.PAPERCUSP_NATIVE_CENSUS === '1')(
  'records native host residue without promoting a partial census to shipment proof',
  async () => {
    const target = new URL(getHarnessAdminUrl());
    expect(['localhost', '127.0.0.1', '[::1]']).toContain(target.hostname);
    expect(target.port || '5432').toBe('5432');
    const output = process.env.PAPERCUSP_NATIVE_CENSUS_OUT;
    const cluster = process.env.PAPERCUSP_NATIVE_CENSUS_CLUSTER;
    const checkpointLogDir = process.env.PAPERCUSP_NATIVE_CENSUS_CHECKPOINT_LOG_DIR;
    expect(output && isAbsolute(output)).toBe(true);
    expect(checkpointLogDir && isAbsolute(checkpointLogDir)).toBe(true);
    expect(cluster).toMatch(/^postgres-cluster:[0-9]+$/);
    // assertRealPgAllowed documents this body-level seam for an explicitly
    // opted-in live reader. Ordinary runs remain skipped and retain the rail.
    vi.stubEnv('PAPERCUSP_FORBID_REAL_PG', undefined);
    let report: Awaited<ReturnType<typeof runRootCensus>>;
    try { report = await runRootCensus({ args: ['--host-catalogs'], checkpointLogDir }); }
    finally { vi.unstubAllEnvs(); }
    // Save the measured result even when an identity assertion fails.
    await writeFile(output!, `${JSON.stringify(report)}\n`, { mode: 0o600 });
    const databases = report.inventory.filter(entry => entry.kind === 'database');
    expect(databases.length).toBeGreaterThan(0);
    expect([...new Set(databases.map(entry => entry.root))]).toEqual([cluster]);
    expect(report.wholeInstallVerified).toBe(false);
    expect(report.ok).toBe(report.residue.length === 0);
  }, 120_000,
);
