/** Live-plane acceptance evidence for verification-system-improvements-2026-10-10
 * AUTO-BAR-R-4 / R-12 (P-004) and AUTO-BAR-R-5 / R-13 (P-005). It reads the
 * verification-health measurement from the running staging operator, never a
 * fixture. The e2e config records the execution-time runtime witness from the
 * live-profile selectors (hono-host:3170), so a passing row is bound to the
 * process that actually served the read. Skipped unless
 * PAPERCUSP_APP_OPERATION_LIVE_PROFILE names a profile, so the unit gate,
 * which also collects this file, does not reach a live system. */
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { beforeAll, describe, expect, it } from 'vitest';
import { prepareRuntimeReader } from '../../vitest.e2e.config';

const execute = promisify(execFile);
const root = fileURLToPath(new URL('../../../../', import.meta.url));
const profilePath = process.env.PAPERCUSP_APP_OPERATION_LIVE_PROFILE;

interface LiveHealth {
  triageGaps: unknown;
  activePlansConsidered: unknown;
  unreachablePlans: unknown;
  staleAcceptanceUndispositioned: unknown;
  staleAcceptanceScopeExcluded: unknown;
  acceptancePlansConsidered: unknown;
  measurementErrors: unknown;
  scope: unknown;
}

describe.skipIf(!profilePath)('verification health bars on the live staging operator', () => {
  let health: LiveHealth;

  beforeAll(async () => {
    const profile = JSON.parse(readFileSync(resolve(root, profilePath!), 'utf8'));
    // Read-only: one plans:verification-health call. No binds, writes or restarts.
    expect(profile.origin).toBe('http://127.0.0.1:3170');
    expect(profile.runtimeUnits).toEqual(['hono-host:3170']);
    const readRuntime = await prepareRuntimeReader();
    const witness = await readRuntime!();
    expect(witness, 'The actual execution runtime must be independently measurable').not.toBeNull();
    expect(witness?.units).toEqual(['hono-host:3170']);

    const script = `
      const r = await tools.plans.verificationHealth({});
      const h = r.health;
      if (!h || typeof h !== 'object') throw new Error('verification health measurement unavailable');
      return { triageGaps: h.triageGaps, activePlansConsidered: h.activePlansConsidered,
        unreachablePlans: h.unreachablePlans,
        staleAcceptanceUndispositioned: h.staleAcceptanceUndispositioned,
        staleAcceptanceScopeExcluded: h.staleAcceptanceScopeExcluded,
        acceptancePlansConsidered: h.acceptancePlansConsidered,
        measurementErrors: h.measurementErrors, scope: r.scope };
    `;
    const { stdout } = await execute('ptool', ['code:run', '--url', profile.origin,
      '--harness', 'papercusp', '--raw', '--json', JSON.stringify({ script })],
    { cwd: root, timeout: 45_000, maxBuffer: 256_000 });
    const result = JSON.parse(stdout);
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(result.partial).not.toBe(true);
    expect(result.childFailures ?? []).toEqual([]);
    health = result.summary;
    // Every bar below reads a measurement, not a failed or empty one.
    expect(health.measurementErrors).toEqual([]);
    expect(health.scope).toMatchObject({ workspaceId: 'papercusp-workspace' });
  }, 60_000);

  it('AUTO-BAR-R-4-P-004: triageGaps is 0 over a non-empty active-plan census', () => {
    expect(health.triageGaps).toBe(0);
    expect(health.activePlansConsidered).toEqual(expect.any(Number));
    expect(health.activePlansConsidered as number).toBeGreaterThan(0);
  });

  it('AUTO-BAR-R-12-P-004: unreachablePlans is present and 0', () => {
    expect(health.unreachablePlans).not.toBeNull();
    expect(health.unreachablePlans).toBe(0);
  });

  it('AUTO-BAR-R-5-P-005: staleAcceptanceUndispositioned is 0 over a non-empty acceptance census', () => {
    expect(health.staleAcceptanceUndispositioned).toBe(0);
    expect(health.acceptancePlansConsidered).toEqual(expect.any(Number));
    expect(health.acceptancePlansConsidered as number).toBeGreaterThan(0);
  });

  it('AUTO-BAR-R-13-P-005: staleAcceptanceScopeExcluded is reported as a count (>= 0)', () => {
    expect(Number.isInteger(health.staleAcceptanceScopeExcluded)).toBe(true);
    expect(health.staleAcceptanceScopeExcluded as number).toBeGreaterThanOrEqual(0);
  });
});
