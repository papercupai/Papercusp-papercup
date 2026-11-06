import { describe, expect, inject, it, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import { integrationNeedsPostgres, setupIntegrationSubstrate } from '../test/_integration-substrate.globalSetup';
import type {} from '../test/_integration-substrate.globalSetup';

// Exercises the real integration config/globalSetup selection. If the baseline
// database is selected alongside this canary, its baseline must still be ready.
describe('integration selection without a PostgreSQL dependency', () => {
  it.each(['su-session-claude-mcp', 'su-session-omp-authority'])('keeps installed %s authority on its private migrated PG and preserves mixed selection setup', async file => {
    const fixture = fileURLToPath(new URL(`./${file}.integration.test.ts`, import.meta.url));
    const baseline = vi.fn(async () => { throw new Error('Shared PG must not initialize'); });
    const org = vi.fn(async () => { throw new Error('Shared org must not initialize'); });
    await setupIntegrationSubstrate({}, [fixture], { baseline, org });
    expect(baseline).not.toHaveBeenCalled(); expect(org).not.toHaveBeenCalled();
    expect(integrationNeedsPostgres([fixture, fixture + '.unknown'])).toBe(true);
    expect(integrationNeedsPostgres([])).toBe(true);
  });
  it('runs the installed compiler socket fixture without initializing shared PG', async () => {
    const fixture = fileURLToPath(new URL('./tsc-service.integration.test.ts', import.meta.url));
    const baseline = vi.fn(async () => { throw new Error('Shared PG must not initialize'); });
    const org = vi.fn(async () => { throw new Error('Shared org must not initialize'); });
    await setupIntegrationSubstrate({}, [fixture], { baseline, org });
    expect(baseline).not.toHaveBeenCalled();
    expect(org).not.toHaveBeenCalled();
    expect(integrationNeedsPostgres([fixture, fixture + '.unknown'])).toBe(true);
    expect(integrationNeedsPostgres([])).toBe(true);
  });
  it('does not initialize shared PG before the self-owned loop-recovery fixture', async () => {
    const fixture = fileURLToPath(new URL('./harness/routines/reconcile-loop-routines.integration.test.ts', import.meta.url));
    const baseline = vi.fn(async () => { throw new Error('Shared PG must not initialize'); });
    const org = vi.fn(async () => { throw new Error('Shared org must not initialize'); });
    await setupIntegrationSubstrate({}, [fixture], { baseline, org });
    expect(baseline).not.toHaveBeenCalled();
    expect(org).not.toHaveBeenCalled();
    expect(integrationNeedsPostgres([fixture, fixture + '.unknown'])).toBe(true);
  });
  it('keeps the grading runtime fixture on its own database while preserving mixed selection setup', async () => {
    const fixture = fileURLToPath(new URL('./release/grading-audit-runtime.integration.test.ts', import.meta.url));
    const canary = fileURLToPath(new URL('./integration-substrate-selection.integration.test.ts', import.meta.url));
    const baseline = vi.fn(async () => { throw new Error('Shared PG must not initialize'); });
    const org = vi.fn(async () => { throw new Error('Shared org must not initialize'); });
    await setupIntegrationSubstrate({}, [fixture, canary], { baseline, org });
    expect(baseline).not.toHaveBeenCalled();
    expect(org).not.toHaveBeenCalled();
    expect(integrationNeedsPostgres([fixture, fixture + '.unknown'])).toBe(true);
    expect(integrationNeedsPostgres([])).toBe(true);
  });
  it('keeps selected-operator digest acceptance outside shared PG setup', async () => {
    const fixture = fileURLToPath(new URL('./agent-tools/sessions/digest.selected-operator.integration.test.ts', import.meta.url));
    const baseline = vi.fn(async () => { throw new Error('Shared PG must not initialize'); });
    const org = vi.fn(async () => { throw new Error('Shared org must not initialize'); });
    await setupIntegrationSubstrate({}, [fixture], { baseline, org });
    expect(baseline).not.toHaveBeenCalled();
    expect(org).not.toHaveBeenCalled();
    expect(integrationNeedsPostgres([fixture, fixture + '.unknown'])).toBe(true);
  });
  it('enrolls filesystem/parser native fixtures while retaining mixed and full database setup', () => {
    const native = fileURLToPath(new URL('./agent-tools/plans/plan-native-declarations.integration.test.ts', import.meta.url));
    const canary = fileURLToPath(new URL('./integration-substrate-selection.integration.test.ts', import.meta.url));
    const privateCoverage = fileURLToPath(new URL('./code-intelligence/test-coverage-map.integration.test.ts', import.meta.url));
    const reuseGraph = fileURLToPath(new URL('./code-intelligence/reuse-graph.integration.test.ts', import.meta.url));
    expect(integrationNeedsPostgres([native])).toBe(false);
    expect(integrationNeedsPostgres([native, canary])).toBe(false);
    expect(integrationNeedsPostgres([privateCoverage, canary])).toBe(false);
    expect(integrationNeedsPostgres([reuseGraph, canary])).toBe(false);
    expect(integrationNeedsPostgres([reuseGraph, native + '.unknown'])).toBe(true);
    expect(integrationNeedsPostgres([privateCoverage, native + '.unknown'])).toBe(true);
    expect(integrationNeedsPostgres([native, native + '.unknown'])).toBe(true);
    expect(integrationNeedsPostgres([])).toBe(true);
  });
  it('keeps grouped coverage, in-memory providers and clone remediation independent of shared PG', async () => {
    const fixtures = ['test-coverage-map', 'reuse-brief-providers', 'clone-remediation'].map(name =>
      fileURLToPath(new URL(`./code-intelligence/${name}.integration.test.ts`, import.meta.url)));
    const baseline = vi.fn(async () => { throw new Error('Shared PG must not initialize'); });
    const org = vi.fn(async () => { throw new Error('Shared org must not initialize'); });
    await setupIntegrationSubstrate({}, fixtures, { baseline, org });
    expect(baseline).not.toHaveBeenCalled();
    expect(org).not.toHaveBeenCalled();
    expect(integrationNeedsPostgres([...fixtures, fixtures[0] + '.unknown'])).toBe(true);
  });
  it('runs notification repository fixtures without shared PG and preserves mixed selection setup', async () => {
    const fixture = fileURLToPath(new URL('./fire-and-forget-classification.integration.test.ts', import.meta.url));
    const baseline = vi.fn(async () => { throw new Error('Shared PG must not initialize'); });
    const org = vi.fn(async () => { throw new Error('Shared org must not initialize'); });
    await setupIntegrationSubstrate({}, [fixture], { baseline, org });
    expect(baseline).not.toHaveBeenCalled();
    expect(org).not.toHaveBeenCalled();
    expect(integrationNeedsPostgres([fixture, fixture + '.unknown'])).toBe(true);
    expect(integrationNeedsPostgres([])).toBe(true);
  });
  it('keeps integration evidence and matches the selected database substrate', () => {
    expect(inject('papercuspTestLayer')).toBe('integration');
    const substrate = inject('operatorIntegrationSubstrate');
    expect(['none', 'postgres']).toContain(substrate);
    if (substrate === 'none') expect(inject('baselineSchemaDsn')).toBeUndefined();
    else expect(inject('baselineSchemaDsn')).toEqual(expect.stringMatching(/^postgres(?:ql)?:\/\//));
  });
});
