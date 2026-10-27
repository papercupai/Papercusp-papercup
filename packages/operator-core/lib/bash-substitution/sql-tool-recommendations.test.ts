import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { fingerprintSqlIntent, type SqlIntentScope } from './sql-intent-fingerprint';
import { recommendSqlTool, sqlRecommendationCandidates,
  type SqlCoverageAudit, type SqlRecommendationInput, type SqlToolCatalog } from './sql-tool-recommendations';

// Fixture identities are explicit; these simulate two registry/build reads, never
// attest that the live operator serves a tool. No SQL or tool handler is executed.
const scope: SqlIntentScope = { workspaceId: 'fixture-workspace', sourceBoundary: 'fixture-ledger',
  epoch: '2026-10', key: new Uint8Array(32).fill(61) };
const queries = {
  invocation: "SELECT tool_name,count(*) FROM tool_invocations WHERE status='ok' GROUP BY tool_name",
  task: "SELECT id,state FROM work_items WHERE id='WI-1' LIMIT 1",
  proof: "SELECT file_path,status FROM test_runs WHERE status='fail' ORDER BY started_at DESC LIMIT 5",
};
function shape(sql: string) {
  const value = fingerprintSqlIntent(sql, scope);
  if (value.status !== 'supported') throw new Error(value.reason);
  return value;
}
function catalog(name = 'testing:runs', contractRef = 'fixture-contract-v2'): SqlToolCatalog {
  return { ref: 'fixture-registry/current', buildRef: 'fixture-build/staging', coverage: 'complete',
    tools: [{ name, contractRef, args: z.object({ limit: z.number().int().min(1).max(100) }).strict() }] };
}
function fixture(sql = queries.proof, name = 'testing:runs'): SqlRecommendationInput {
  const current = catalog(name);
  const required = shape(sql);
  const audit: SqlCoverageAudit = { toolName: name, contractRef: current.tools[0]!.contractRef,
    parserVersion: required.version, fingerprint: required.fingerprint, requiredFeatures: required.features,
    fixtureRef: 'sql-tool-recommendations.test.ts:fixture-v1/' + name,
    resultRef: 'fixture-ledger:positive-and-neighbor/v1', verdict: 'exact', args: { limit: 5 }, missingFeatures: [] };
  return { sql, scope, sourceCoverage: 'complete', sourceAuthorized: true,
    exampleExpiresAt: 30 * 86400_000, now: 29 * 86400_000,
    current, served: { ...current, ref: 'fixture-registry/served', buildRef: 'fixture-build/main' },
    candidateCoverage: 'complete', audits: [audit] };
}

describe('SQL tool recommendations', () => {
  it('binds an immediately callable recommendation to its exact served contract OUTCOME-P-005', () => {
    const input = fixture();
    expect(recommendSqlTool(input)).toMatchObject({ kind: 'route-existing', toolName: 'testing:runs',
      immediatelyCallable: true, fingerprint: shape(input.sql).fingerprint,
      requiredFeatures: shape(input.sql).features, evidenceRefs: [input.current.ref, input.current.buildRef,
        input.served.ref, input.served.buildRef, input.audits[0]!.contractRef,
        input.audits[0]!.fixtureRef, input.audits[0]!.resultRef] });
  });

  it('classifies unavailable or older served testing fields as a gap, never a duplicate tool OUTCOME-P-005', () => {
    const input = fixture();
    for (const tools of [[], catalog('testing:runs', 'fixture-contract-v1').tools]) {
      expect(recommendSqlTool({ ...input, served: { ...input.served, tools } }))
        .toMatchObject({ kind: 'availability-gap', toolName: 'testing:runs', immediatelyCallable: false });
    }
    expect(recommendSqlTool({ ...input, served: { ...input.served, coverage: 'unknown' } }))
      .toMatchObject({ kind: 'insufficient-evidence', immediatelyCallable: false });
  });

  it('separates all six recommendations using exact invocation/task/test-proof evidence R4-CONTRACT', () => {
    for (const [sql, name] of [[queries.invocation, 'activity:tool-log'], [queries.task, 'work_items:get'],
      [queries.proof, 'testing:runs']]) {
      const input = fixture(sql, name);
      expect(recommendSqlTool(input).kind).toBe('route-existing');
      expect(recommendSqlTool({ ...input, served: { ...input.served, tools: [] } }).kind).toBe('availability-gap');
      const partial = { ...input.audits[0]!, verdict: 'partial' as const, missingFeatures: ['output:required-field'] };
      expect(recommendSqlTool({ ...input, audits: [partial] })).toMatchObject({ kind: 'extend-existing',
        immediatelyCallable: false, missingFeatures: ['output:required-field'] });
      const none = { ...partial, verdict: 'none' as const };
      expect(recommendSqlTool({ ...input, audits: [none] }).kind).toBe('new-tool');
      expect(recommendSqlTool({ ...input, audits: [], keepSql: {
        fingerprint: shape(sql).fingerprint, decisionRef: 'fixture-review:keep-exact-shape' } }).kind).toBe('keep-sql');
      expect(recommendSqlTool({ ...input, audits: [] }).kind).toBe('insufficient-evidence');
    }
  });

  it('refuses name/table/suggested-family equivalence and neighboring unsupported filters R4-CONTRACT', () => {
    const input = fixture();
    for (const sql of [
      queries.proof.replace("status='fail'", "status='pass'"),
      queries.proof.replace('file_path,status', 'output_tail,status'),
      queries.proof.replace('LIMIT 5', 'LIMIT 500'),
      queries.proof.replace('DESC', 'ASC'),
      queries.proof.replace("status='fail'", "status='fail' AND finished_at>now()-interval '1 day'"),
      "SELECT payload->>'failure_summary' FROM test_runs WHERE status='fail'",
    ]) expect(recommendSqlTool({ ...input, sql }).kind).toBe('insufficient-evidence');
    expect(shape(queries.proof).suggestedFamily).toBe(shape(queries.proof.replace("'fail'", "'pass'")).suggestedFamily);
    expect(recommendSqlTool({ ...input, audits: [], candidateTools: ['testing:runs'] }).kind).toBe('insufficient-evidence');
    expect(sqlRecommendationCandidates(queries.task)).toContain('work_items:get');
  });

  it('rejects stale parser, features, output/implementation contract, invalid args and unexecuted proof R4-CONTRACT', () => {
    const input = fixture(), audit = input.audits[0]!;
    for (const bad of [
      { ...audit, parserVersion: 'old-parser' }, { ...audit, fingerprint: shape(queries.task).fingerprint },
      { ...audit, requiredFeatures: { ...audit.requiredFeatures, projectedFields: [] } },
      { ...audit, contractRef: 'old-output-contract' }, { ...audit, args: { limit: 500 } },
      { ...audit, fixtureRef: '' }, { ...audit, resultRef: '' }, { ...audit, missingFeatures: ['projection'] },
    ]) expect(recommendSqlTool({ ...input, audits: [bad] }).kind).toBe('insufficient-evidence');
  });

  it('preserves UNKNOWN source residue and denies unauthorized or expired examples R4-CONTRACT', () => {
    const input = fixture();
    for (const patch of [ { sourceCoverage: 'unknown' as const }, { sourceCoverage: 'truncated' as const },
      { sourceAuthorized: false }, { now: input.exampleExpiresAt }, { now: NaN },
      { sql: 'DELETE FROM work_items' }, { sql: 'nonsense' },
    ]) {
      const output = recommendSqlTool({ ...input, ...patch });
      expect(output).toMatchObject({ kind: 'insufficient-evidence', immediatelyCallable: false,
        fingerprint: null, requiredFeatures: null, evidenceRefs: [] });
    }
    const secretInput = fixture("SELECT id FROM work_items WHERE password='credential' LIMIT 1");
    expect(recommendSqlTool(secretInput).reason).toBe('secret-bearing-source');
    const serialized = JSON.stringify(recommendSqlTool(input));
    expect(serialized).not.toContain(input.sql);
    expect(serialized).not.toContain('"args"');
  });

  it('does not call absent tools or infer a new tool from incomplete registry/lineage R4-CONTRACT', () => {
    const input = fixture();
    for (const patch of [ { current: { ...input.current, coverage: 'truncated' as const } },
      { served: { ...input.served, buildRef: '' } },
      { current: { ...input.current, tools: [...input.current.tools, ...input.current.tools] } },
      { audits: [], candidateTools: ['nonexistent:similar-name'] },
      { audits: [], keepSql: { fingerprint: shape(queries.task).fingerprint, decisionRef: 'unrelated-review' } },
    ]) expect(recommendSqlTool({ ...input, ...patch }).kind).toBe('insufficient-evidence');
    const noCoverage = { ...input.audits[0]!, verdict: 'none' as const, missingFeatures: ['filter'] };
    expect(recommendSqlTool({ ...input, audits: [noCoverage], candidateCoverage: 'unknown' }).kind)
      .toBe('insufficient-evidence');
    for (const audits of [[input.audits[0]!, noCoverage], [noCoverage, input.audits[0]!]]) {
      expect(recommendSqlTool({ ...input, audits }).kind).toBe('insufficient-evidence');
    }
  });

  it('prefers a tested served alternative and binds typed input to the actual registry schema R4-CONTRACT', async () => {
    const { default: testingRuns } = await import('../agent-tools/testing/runs');
    const input = fixture();
    const actual = { ...input.current.tools[0]!, name: testingRuns.name, args: testingRuns.args };
    const current = { ...input.current, tools: [actual] }, served = { ...input.served, tools: [actual] };
    expect(recommendSqlTool({ ...input, current, served }).kind).toBe('route-existing');
    expect(recommendSqlTool({ ...input, current, served, audits: [
      { ...input.audits[0]!, args: { limit: 50000 } },
    ] }).kind).toBe('insufficient-evidence');
    const alternative = { ...actual, name: 'fixture:served-alternative' };
    const alternativeAudit = { ...input.audits[0]!, toolName: alternative.name };
    expect(recommendSqlTool({ ...input, served: { ...served, tools: [alternative] },
      audits: [...input.audits, alternativeAudit] })).toMatchObject({
      kind: 'route-existing', toolName: alternative.name, immediatelyCallable: true,
    });
  });
});
