import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupEngineeringEvidenceFixture } from './_engineering-evidence-fixture';

describe('native engineering evidence public graph handler', () => {
  let state: Awaited<ReturnType<typeof setupEngineeringEvidenceFixture>>;
  beforeAll(async () => { state = await setupEngineeringEvidenceFixture(true); }, 180_000);
  afterAll(async () => { await state?.dispose(); });

  it('ee.query-exact: public handler joins real compiler ownership to exact canonical spec, proof and case rows', async () => {
    const { runId, bindingId, plan, publicQuery } = state;
    const report = await publicQuery();
    expect(report.error).toBeNull(); expect(report.status).toBe('measured');
    expect(report.evidence?.gaps.filter(g => g.code === 'authority-unavailable')).toEqual([]);
    expect(report.evidence?.nodes.find(n => n.kind === 'spec')?.data).toMatchObject({ plan, item: 'P-001', id: 'EE-1', revision: 1 });
    expect(report.evidence?.nodes.find(n => n.kind === 'proof')?.data).toMatchObject({ id: bindingId, revision: 1, runId });
    expect(report.evidence?.nodes.find(n => n.kind === 'test-case')?.data).toMatchObject({ runId, key: 'ee.intent-exact', occurrence: 1, status: 'pass' });
    expect(report.evidence?.nodes.filter(n => n.kind === 'decision').map(n => n.data.decision)).toEqual(['D-001']);
    expect(report.evidence?.execution.status).toBe('unobserved');
    expect(JSON.stringify(report)).not.toContain('foreign-plan');
  }, 60_000);
  it('ee.query-item: public item selector retains bounded recovery and explicit decision applicability', async () => {
    const { plan, publicQuery } = state;
    const report = await publicQuery({ plan, item: 'P-001', limit: 3, include_context: true });
    expect(report.error).toBeNull(); expect(report.evidence?.nodes).toHaveLength(3);
    expect(report.evidence?.truncated).toBe(true);
    const context = await publicQuery({ plan, item: 'P-001', include_context: true });
    expect(context.evidence?.gaps.some(g => g.code === 'decision-applicability-unknown')).toBe(true);
    expect(context.evidence?.edges.some(e => e.basis === 'unscoped-context')).toBe(true);
  }, 60_000);
  it('ee.query-negative: unknown item and foreign scope cannot acquire unrelated requirement support', async () => {
    const { plan, publicQuery } = state;
    const missing = await publicQuery({ plan, item: 'P-999' });
    expect(missing.evidence?.nodes).toEqual([]);
    expect(missing.evidence?.gaps.some(g => g.code === 'no-visible-item-anchor')).toBe(true);
    const foreign = await publicQuery({ plan, item: 'P-001', harnesses: ['foreign-repo'] });
    expect(foreign.evidence).toBeNull(); expect(foreign.error).toContain('harness scope');
  }, 60_000);
  it('ee.query-ambiguous: same-name declarations require a location before exposing ownership', async () => {
    const { root, path, source, publicQuery } = state;
    const ambiguous = 'namespace A { export function evidenceFeature() { return 1; } }\nnamespace B { export function evidenceFeature() { return 2; } }\n';
    await writeFile(join(root, path), ambiguous);
    try {
      const report = await publicQuery();
      expect(report.evidence?.nodes).toEqual([]);
      expect(report.evidence?.gaps.some(g => g.code === 'ambiguous-symbol')).toBe(true);
      const exact = await publicQuery({ file_path: path, name: 'evidenceFeature', line1: 2 });
      expect(exact.evidence?.nodes.find(n => n.kind === 'symbol')?.data.line1).toBe(2);
      expect(exact.evidence?.edges.find(e => e.basis === 'declared-anchor')?.state).toBe('stale');
    } finally { await writeFile(join(root, path), source); }
  }, 60_000);
});
