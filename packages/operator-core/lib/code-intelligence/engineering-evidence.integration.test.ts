import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readEngineeringEvidence } from './engineering-evidence';
import { getHarnessAdminUrl } from '../embedded-pg-discovery';
import { ensureBootstrap } from '../agent-tools/locks/su-lock-store';
import { setupPlanPgFixture } from '../agent-tools/plans/__tests__/_pg-tool-fixture';
import { setupEngineeringEvidenceFixture } from './_engineering-evidence-fixture';

describe('native engineering evidence canonical PG adapters', () => {
  let state: Awaited<ReturnType<typeof setupEngineeringEvidenceFixture>>;
  beforeAll(async () => { state = await setupEngineeringEvidenceFixture(); }, 180_000);
  afterAll(async () => { await state?.dispose(); });

  it('ee.intent-exact: traverses real compiler, anchor, immutable proof and exact case rows', async () => {
    const { scope, runId, bindingId, plan, digest, store, query } = state;
    const graph = await readEngineeringEvidence(query, scope, store());
    expect(graph.gaps.filter(g => g.code === 'authority-unavailable')).toEqual([]);
    expect(graph.nodes.find(n => n.kind === 'item')?.data).toMatchObject({ plan, item: 'P-001',
      anchor: { kind: 'path', fingerprintKind: 'file', fingerprint: digest, state: 'current' } });
    expect(graph.nodes.find(n => n.kind === 'proof')?.data).toMatchObject({ id: bindingId, revision: 1, runId });
    expect(graph.nodes.find(n => n.kind === 'test-case')?.data).toMatchObject({ runId, key: 'ee.intent-exact', occurrence: 1, status: 'pass' });
    expect(graph.edges.length).toBeGreaterThan(0);
    for (const edge of graph.edges) {
      expect(['plans:get', 'plans:get-specs', 'plans:get-spec-evidence', 'testing:runs']).toContain(edge.authority?.tool);
      expect(edge.authority.args).toMatchObject({ harness: scope.harness });
      if (edge.authority.tool === 'testing:runs') expect(edge.authority.args.testRunIds).toEqual([runId]);
      else expect(edge.authority.args.slug).toBe(plan);
      if (edge.authority.tool === 'plans:get-spec-evidence') expect(edge.authority.args.bindingIds).toEqual([bindingId]);
      if (edge.authority.tool === 'plans:get-specs') expect(edge.authority.args).toMatchObject({ specIds: ['EE-1'], revision: 1 });
    }
    expect(graph.nodes.filter(n => n.kind === 'decision').map(n => n.data.decision)).toEqual(['D-001']);
    expect(graph.execution.status).toBe('unobserved');
    expect(JSON.stringify(graph)).not.toContain('foreign-plan');
  }, 60_000);
  it('ee.tenant-repo: refuses an unregistered root and bounds actual SQL ownership results', async () => {
    const { scope, runId, plan, harness, store, query } = state;
    await expect(readEngineeringEvidence(query, { ...scope, root: '/' }, store())).rejects.toThrow('scope_forbidden');
    const adapter = store();
    const [symbol] = await adapter.symbol(scope, query.symbol);
    expect(symbol).toBeDefined();
    const rows = await adapter.items(scope, query, symbol!, 1);
    expect(rows).toHaveLength(1); expect(rows[0]).toMatchObject({ workspaceId: scope.workspaceId, harness, plan });
    expect(await adapter.run({ ...scope, workspaceId: 'ee-foreign' }, runId)).toBeNull();
    expect(await adapter.cases({ ...scope, harness: 'foreign-repo' }, runId, 21)).toEqual([]);
  }, 60_000);
  it('ee.rename: source edits stale the declared file anchor without rewriting it', async () => {
    const { scope, root, path, source, digest, store, query } = state;
    await writeFile(join(root, path), source.replace('return 1', 'return 2'));
    try {
      const graph = await readEngineeringEvidence(query, scope, store());
      expect(graph.edges.find(e => e.basis === 'declared-anchor')?.state).toBe('stale');
      expect(graph.nodes.find(n => n.kind === 'item')?.data.anchor).toMatchObject({ fingerprint: digest });
    } finally { await writeFile(join(root, path), source); }
  }, 60_000);
  it('ee.pruned-cases: retains the protected receipt and exposes missing case rows as unknown', async () => {
    const { db, scope, runId, bindingId, harness, store, query } = state;
    await db`DELETE FROM harness_shared.test_case_runs WHERE test_run_id=${runId}`;
    await db`DELETE FROM harness_shared.test_runs WHERE workspace_id=${scope.workspaceId} AND harness_slug=${harness} AND id=${runId}`;
    // Migration1378 deliberately retains any run cited by immutable proof.
    // Legacy absent-run handling is covered by the contract test; this current
    // schema must not defeat its retention guard merely to fabricate that state.
    expect(await store().run(scope, runId)).toMatchObject({ id: runId, status: 'pass' });
    const graph = await readEngineeringEvidence(query, scope, store());
    expect(graph.nodes.find(n => n.kind === 'proof')?.data.id).toBe(bindingId);
    expect(graph.nodes.find(n => n.kind === 'test-run')?.data).toMatchObject({ id: runId, status: 'pass' });
    expect(graph.nodes.filter(n => n.kind === 'test-case')).toEqual([]);
    expect(graph.gaps.some(g => g.code === 'test-cases-unavailable')).toBe(true);
    expect(graph.gaps.some(g => g.code === 'test-run-unavailable')).toBe(false);
  }, 60_000);
  it('ee.fixture-handoff: rotates dedicated admin URL pins and restores the surviving database', async () => {
    const outer = getHarnessAdminUrl();
    const nested = await setupPlanPgFixture({ isolated: true });
    try {
      const inner = getHarnessAdminUrl();
      expect(new URL(inner).pathname).not.toBe(new URL(outer).pathname);
      const [database] = await nested.admin`SELECT current_database() AS name`;
      expect(new URL(inner).pathname).toBe(`/${database!.name}`);
    } finally { await nested.dispose(); }
    expect(getHarnessAdminUrl()).toBe(outer);
    // Exercise the same dedicated resolver as later evidence measurement,
    // after the nested database has actually been dropped.
    await ensureBootstrap();
  }, 180_000);
});
