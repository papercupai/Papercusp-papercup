import { expect, it, vi } from 'vitest';
import { observeSqlDemand, aggregateSqlDemand } from './bash-substitution/sql-intent-corpus';
import type { SqlCandidateReadOptions, SqlCandidateSnapshot } from './bash-substitution/sql-tool-candidates';
import { readSqlToolCandidateWorklist } from './sql-tool-candidate-worklist';
const scope = { workspaceId: 'w', sourceBoundary: 'ledger', epoch: 'one', key: new Uint8Array(32).fill(71) };
const opts: SqlCandidateReadOptions = { workspaceId: 'w', harnessSlug: 'h', scope,
  authorize: async () => true, authorizeSource: async () => true };
function snapshot(sql = 'SELECT id FROM jobs', ranOn = '2026-10-25'): SqlCandidateSnapshot {
  const observations = Array.from({ length: 12 }, (_, i) => observeSqlDemand({ workspaceId: 'w', harnessSlug: 'h',
    namespace: 'ledger', callId: String(i), resultCallId: String(i), identityAuthority: 'ledger', provider: 'ledger',
    actor: `su-${i % 3}`, verifiedAgent: true, at: `2026-10-${23 + i % 2}T00:00:00Z`, origin: 'agent',
    status: 'ok', durationMs: 10, sql, sourceComplete: true, copyRef: String(i) }, scope));
  return { ranOn, sourceIds: ['1', '2'], examples: [], summary: aggregateSqlDemand(observations,
    { status: 'complete', scannedRows: 12, cap: 20, retention: 'complete', providers: ['ledger'] }) };
}
it('R8 worklist bounds rows, retains coverage and deduplicates overlapping snapshot demand', async () => {
  const rows = [snapshot(), snapshot('SELECT id FROM jobs', '2026-10-24'), snapshot('SELECT name FROM users')];
  const result = await readSqlToolCandidateWorklist({ ...opts, limit: 1 }, {
    read: async () => rows, history: async () => [] });
  expect(result.population).toEqual({ candidates: 2, returned: 1, omitted: 1, snapshotCap: 120 });
  expect(result.candidates[0]!.candidate.counts.ok).toBe(12);
  expect(result.candidates[0]!.candidate.eligible).toBe(true);
  expect(result.snapshots).toHaveLength(3);
  expect(result.candidates[0]!.evidenceRefs).toEqual([{ kind: 'tool-invocation', id: '1' }, { kind: 'tool-invocation', id: '2' }]);
});
it('R23 derived worklist fails closed when authority changes during history lookup', async () => {
  const read = vi.fn().mockResolvedValueOnce([snapshot()]).mockResolvedValueOnce([]);
  const result = await readSqlToolCandidateWorklist(opts, { read, history: async () => [] });
  expect(result).toMatchObject({ status: 'UNKNOWN', candidates: [], snapshots: [],
    population: { candidates: 0, returned: 0, omitted: 0 } });
});
it('R8 unsupported populations remain visible without becoming eligible demand', async () => {
  const row = snapshot(); row.summary.unknownParseOperations = 4;
  const result = await readSqlToolCandidateWorklist(opts, { read: async () => [row], history: async () => [] });
  expect(result.snapshots[0]!.residue.unknownParseOperations).toBe(4);
  expect(result.candidates[0]!.candidate.reasons).toContain('incomplete-evidence');
});
it('R8 history is bounded and dependency errors disclose no private error or population', async () => {
  const result = await readSqlToolCandidateWorklist(opts, { read: async () => [snapshot()],
    history: async () => Array.from({ length: 21 }, (_, i) => ({ editionId: String(i), workItemId: `WI-${i}`,
      suppressed: false, createdAt: '2026-10-25T00:00:00Z' })) });
  expect(result.candidates[0]!.decisionHistory).toHaveLength(20);
  expect(result.candidates[0]!.decisionHistoryTruncated).toBe(true);
  const failed = await readSqlToolCandidateWorklist(opts, { read: async () => { throw new Error('private sql'); } });
  expect(JSON.stringify(failed)).not.toContain('private');
  expect(failed.status).toBe('UNKNOWN');
});
it('R8 evidence reference cap reports omitted refs on the returned entry', async () => {
  const row = snapshot(); row.sourceIds = Array.from({ length: 101 }, (_, i) => String(i));
  const result = await readSqlToolCandidateWorklist(opts, { read: async () => [row], history: async () => [] });
  expect(result.candidates[0]!.evidenceRefs).toHaveLength(100);
  expect(result.candidates[0]!.evidenceRefsOmitted).toBe(1);
});
