import { afterEach, describe, expect, it } from 'vitest';
import type { ObservedSurface } from '@papercusp/testing-shell/census';
import { captureRuntimeSecurityCensus, readRuntimeSecurityCensus, registerRuntimeSecurityCapture } from './runtime';

const releases: Array<() => void> = [];
afterEach(() => { for (const release of releases.splice(0)) release(); });
const surface = (id: string): ObservedSurface => ({ kind: 'mounted-http-handler',
  surfaceId: id, fidelity: 'observed', attrs: { actualEffectCoverage: 'unknown' } });

describe('owning-process security discovery', () => {
  it('captures more than the transport page ceiling without dropping gaps or relabeling closure', async () => {
    const surfaces = Array.from({ length: 503 }, (_, i) => surface(`row-${i}`));
    releases.push(registerRuntimeSecurityCapture(async () => ({ surfaces, declaredSurfaces: [], unresolved: ['fixture-gap'] })));
    const snapshot = await captureRuntimeSecurityCensus(), page = await readRuntimeSecurityCensus(500);
    expect(snapshot).toMatchObject({ total: 503, count: 503, offset: 0, truncatedByLimit: false,
      populationComplete: false, closureAccepted: false, executionAdmitted: false });
    expect(snapshot.rows).toHaveLength(503); expect(snapshot.unresolved).toContain('fixture-gap');
    expect(page.discoverySha256).toBe(snapshot.discoverySha256); expect(page.rows).toHaveLength(500);
  });
  it('keeps absent or failed host capture unavailable and unqualified', async () => {
    const absent = await readRuntimeSecurityCensus();
    expect(absent.status).toBe('unavailable');
    expect(absent.unresolved).toContain('security-host-capture-not-registered');
    releases.push(registerRuntimeSecurityCapture(async () => { throw Error('fixture failure'); }));
    const failed = await readRuntimeSecurityCensus();
    expect(failed.status).toBe('unavailable');
    expect(failed.unresolved).toContain('security-host-capture-failed');
    expect(failed.populationComplete).toBe(false); expect(failed.executionAdmitted).toBe(false);
  });

  it('hashes the full population, preserves duplicates and detaches live metadata', async () => {
    const surfaces = [surface('one'), surface('two')];
    releases.push(registerRuntimeSecurityCapture(async () => ({ surfaces, declaredSurfaces: [], unresolved: ['nested-unknown'] })));
    const first = await readRuntimeSecurityCensus(1), larger = await readRuntimeSecurityCensus(2);
    expect(first.discoverySha256).toBe(larger.discoverySha256);
    expect(first.total).toBe(2); expect(first.rows).toHaveLength(1);
    expect(first.truncatedByLimit).toBe(true); expect(larger.truncatedByLimit).toBe(false);
    (surfaces[0]!.attrs as Record<string, unknown>).actualEffectCoverage = 'changed';
    expect(first.rows[0]!.attrs.actualEffectCoverage).toBe('unknown');
    expect((await readRuntimeSecurityCensus()).discoverySha256).not.toBe(first.discoverySha256);
    surfaces.push(surface('two'));
    const duplicate = await readRuntimeSecurityCensus();
    expect(duplicate.total).toBe(3);
    expect(duplicate.unresolved.some(gap => gap.startsWith('security-census-duplicate:'))).toBe(true);
    expect(duplicate.unresolved).toContain('nested-unknown'); expect(duplicate.closureAccepted).toBe(false);
  });

  it('rejects invalid bounds and lets old disposers preserve the replacement host', async () => {
    const old = registerRuntimeSecurityCapture(async () => ({ surfaces: [], declaredSurfaces: [], unresolved: [] }));
    releases.push(registerRuntimeSecurityCapture(async () => ({ surfaces: [surface('replacement')], declaredSurfaces: [], unresolved: [] })));
    old(); expect((await readRuntimeSecurityCensus()).total).toBe(1);
    for (const limit of [0, 501, 1.5]) await expect(readRuntimeSecurityCensus(limit)).rejects.toThrow('invalid_limit');
  });

  it('retrieves later pages against the full population identity and refuses changed populations', async () => {
    const surfaces = [surface('three'), surface('one'), surface('two')];
    releases.push(registerRuntimeSecurityCapture(async () => ({ surfaces, declaredSurfaces: [], unresolved: [] })));
    const whole = await readRuntimeSecurityCensus(3), first = await readRuntimeSecurityCensus(1);
    const second = await readRuntimeSecurityCensus(1, { offset: 1, expectedDiscoverySha256: first.discoverySha256 });
    const last = await readRuntimeSecurityCensus(1, { offset: 2, expectedDiscoverySha256: first.discoverySha256 });
    expect([...first.rows, ...second.rows, ...last.rows]).toEqual(whole.rows);
    expect(second).toMatchObject({ offset: 1, count: 1, total: 3, truncatedByLimit: true });
    expect(last).toMatchObject({ offset: 2, count: 1, truncatedByLimit: false });
    expect(await readRuntimeSecurityCensus(1, { offset: 3 })).toMatchObject({ count: 0, rows: [], truncatedByLimit: false });
    surfaces.push(surface('four'));
    await expect(readRuntimeSecurityCensus(1, { offset: 1, expectedDiscoverySha256: first.discoverySha256 }))
      .rejects.toThrow('population_changed');
    expect(last.populationComplete).toBe(false); expect(last.executionAdmitted).toBe(false);
  });

  it('rejects malformed page identities before calling the host capture', async () => {
    let captures = 0;
    releases.push(registerRuntimeSecurityCapture(async () => { captures++; return { surfaces: [], declaredSurfaces: [], unresolved: [] }; }));
    for (const offset of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      await expect(readRuntimeSecurityCensus(1, { offset })).rejects.toThrow('invalid_offset');
    }
    await expect(readRuntimeSecurityCensus(1, { expectedDiscoverySha256: 'not-a-digest' })).rejects.toThrow('invalid_discovery_digest');
    expect(captures).toBe(0);
  });
});
