import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupEngineeringEvidenceFixture } from './_engineering-evidence-fixture';
import { readEngineeringEvidence } from './engineering-evidence';

describe('native evidence true symbol rename', () => {
  let state: Awaited<ReturnType<typeof setupEngineeringEvidenceFixture>>;
  beforeAll(async () => { state = await setupEngineeringEvidenceFixture(); }, 180_000);
  afterAll(async () => { await state?.dispose(); });
  it('ee.symbol-rename: resolves the new compiler identity, gaps the old name and preserves stale declared anchors and exact proof history', async () => {
    const { root, path, source, digest, scope, store, query, bindingId, runId } = state;
    const before = await readEngineeringEvidence(query, scope, store());
    const beforeSymbol = before.nodes.find(node => node.kind === 'symbol');
    expect(beforeSymbol?.data.name).toBe('evidenceFeature');
    await writeFile(join(root, path), source.replaceAll('evidenceFeature', 'renamedEvidenceFeature'));
    try {
      const old = await readEngineeringEvidence(query, scope, store());
      expect(old.nodes.some(node => node.kind === 'symbol')).toBe(false);
      expect(old.gaps.some(gap => gap.code === 'symbol-unresolved')).toBe(true);
      const renamed = await readEngineeringEvidence({ symbol: { path, name: 'renamedEvidenceFeature' } }, scope, store());
      const currentSymbol = renamed.nodes.find(node => node.kind === 'symbol');
      expect(currentSymbol?.data.name).toBe('renamedEvidenceFeature');
      expect(currentSymbol?.data.versionedSymbolId).not.toBe(beforeSymbol?.data.versionedSymbolId);
      expect(renamed.edges.find(edge => edge.basis === 'declared-anchor')?.state).toBe('stale');
      expect(renamed.nodes.find(node => node.kind === 'item')?.data.anchor).toMatchObject({ fingerprint: digest });
      expect(renamed.nodes.find(node => node.kind === 'proof')?.data).toMatchObject({ id: bindingId, runId });
      expect(renamed.execution.status).toBe('unobserved');
      const original = await store().proofs(scope, (await store().specs(scope,
        { workspaceId: scope.workspaceId, harness: scope.harness, plan: state.plan, item: 'P-001' }, 1))[0]!, 1);
      expect(original[0]).toMatchObject({ id: bindingId, runId, revision: 1 });
    } finally { await writeFile(join(root, path), source); }
  }, 60_000);
});
