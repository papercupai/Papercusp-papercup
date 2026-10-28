/** P008: passive pull worklist. Nothing from this read is persisted or executed. */
import { getOrgPg } from '@papercusp/db-org';
import { readSqlCandidates, type SqlCandidateReadOptions } from './bash-substitution/sql-tool-candidates';
import { miningScopeId } from './agent-opportunities/privacy';
import { rankSqlToolCandidates, type SqlToolCandidateScore } from './sql-tool-candidate-score';
import { sqlCandidateReviewIdentity } from './sql-tool-candidate-review';

export interface SqlCandidateDecisionRef {
  editionId: string;
  workItemId: string;
  suppressed: boolean;
  createdAt: string;
}
export interface SqlCandidateWorklistEntry {
  candidate: SqlToolCandidateScore;
  sourceRef: { scopeId: string; ranOn: string };
  evidenceRefs: Array<{ kind: 'tool-invocation'; id: string }>;
  evidenceRefsOmitted: number;
  decisionHistory: SqlCandidateDecisionRef[];
  decisionHistoryTruncated: boolean;
}
export interface SqlCandidateWorklist {
  status: 'ok' | 'UNKNOWN';
  candidates: SqlCandidateWorklistEntry[];
  population: { candidates: number; returned: number; omitted: number; snapshotCap: 120 };
  snapshots: Array<{ ranOn: string; coverage: ReturnType<typeof rankSqlToolCandidates>['coverage'];
    residue: ReturnType<typeof rankSqlToolCandidates>['residue'] }>;
}
export type SqlCandidateWorklistOptions = SqlCandidateReadOptions & { limit?: number };
export interface SqlCandidateWorklistDeps {
  read?: typeof readSqlCandidates;
  /** Receives the caller's read options too, so an injected history can stay scope-aware like the default. */
  history?: (candidate: SqlToolCandidateScore, opts: SqlCandidateWorklistOptions) => Promise<SqlCandidateDecisionRef[]>;
}
const empty = (): SqlCandidateWorklist => ({ status: 'UNKNOWN', candidates: [], snapshots: [],
  population: { candidates: 0, returned: 0, omitted: 0, snapshotCap: 120 } });

/** Scope/ACL misses and dependency failures share one content-free answer. No denied counts. */
export async function readSqlToolCandidateWorklist(opts: SqlCandidateWorklistOptions,
  deps: SqlCandidateWorklistDeps = {}): Promise<SqlCandidateWorklist> {
  const limit = opts.limit ?? 25;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('invalid_sql_worklist_limit');
  try {
    const snapshots = await (deps.read ?? readSqlCandidates)(opts);
    if (!snapshots.length) return empty();
    const entries = new Map<string, SqlCandidateWorklistEntry>();
    const coverage: SqlCandidateWorklist['snapshots'] = [];
    for (const snapshot of snapshots) {
      const ranked = rankSqlToolCandidates(snapshot.summary);
      coverage.push({ ranOn: snapshot.ranOn, coverage: ranked.coverage, residue: ranked.residue });
      for (const candidate of ranked.candidates) {
        // Newest authorized snapshot wins; overlapping rolling windows never add demand.
        if (entries.has(candidate.id)) continue;
        entries.set(candidate.id, { candidate,
          sourceRef: { scopeId: miningScopeId(opts.scope, opts.harnessSlug), ranOn: snapshot.ranOn },
          evidenceRefs: snapshot.sourceIds.slice(0, 100).map(id => ({ kind: 'tool-invocation' as const, id })),
          evidenceRefsOmitted: Math.max(0, snapshot.sourceIds.length - 100),
          decisionHistory: [], decisionHistoryTruncated: false });
      }
    }
    const selected = [...entries.values()].sort((a, b) => b.candidate.score - a.candidate.score
      || a.candidate.id.localeCompare(b.candidate.id)).slice(0, limit);
    for (const entry of selected) {
      const history = deps.history ? await deps.history(entry.candidate, opts) : await readHistory(opts, entry.candidate);
      entry.decisionHistory = history.slice(0, 20);
      entry.decisionHistoryTruncated = history.length > 20;
    }
    // Derivation/history reads may take time. Resolve the contributing sources again
    // before releasing counts, membership, decisions or refs to the caller.
    const current = await (deps.read ?? readSqlCandidates)(opts);
    if (snapshots.some(snapshot => !current.some(row => row.ranOn === snapshot.ranOn
      && JSON.stringify(row.sourceIds) === JSON.stringify(snapshot.sourceIds)
      && JSON.stringify(row.summary) === JSON.stringify(snapshot.summary)))) return empty();
    return { status: 'ok', candidates: selected, snapshots: coverage,
      population: { candidates: entries.size, returned: selected.length,
        omitted: entries.size - selected.length, snapshotCap: 120 } };
  } catch { return empty(); }
}

async function readHistory(opts: SqlCandidateReadOptions, candidate: SqlToolCandidateScore): Promise<SqlCandidateDecisionRef[]> {
  const { lifecycleId } = sqlCandidateReviewIdentity({ workspaceId: opts.workspaceId,
    harnessSlug: opts.harnessSlug, submittedBy: 'worklist-read', candidate, contractRef: 'identity-only' });
  const sql = opts.client ?? getOrgPg().sql;
  const rows = await sql<{ edition_id: string; artifact_id: string; suppressed: boolean; created_at: Date }[]>`
    SELECT edition_id,artifact_id,suppressed,created_at FROM harness_shared.sql_candidate_reviews
    WHERE workspace_id=${opts.workspaceId} AND harness_slug=${opts.harnessSlug} AND lifecycle_id=${lifecycleId}
    ORDER BY created_at DESC,edition_id LIMIT 21`;
  return rows.map(row => ({ editionId: row.edition_id, workItemId: row.artifact_id,
    suppressed: row.suppressed, createdAt: new Date(row.created_at).toISOString() }));
}

/** Evidence is hydrated from current source authority, never from a saved worklist packet. */
export async function readSqlToolCandidateEvidence(opts: SqlCandidateReadOptions, candidateId: string) {
  try {
    const snapshots = await readSqlCandidates(opts);
    const snapshot = snapshots.find(row => rankSqlToolCandidates(row.summary).candidates.some(c => c.id === candidateId));
    return snapshot ? { status: 'ok' as const, examples: snapshot.examples,
      evidenceRefs: snapshot.sourceIds.slice(0, 100).map(id => ({ kind: 'tool-invocation' as const, id })),
      evidenceRefsOmitted: Math.max(0, snapshot.sourceIds.length - 100) }
      : { status: 'UNKNOWN' as const, examples: [], evidenceRefs: [], evidenceRefsOmitted: 0 };
  } catch { return { status: 'UNKNOWN' as const, examples: [], evidenceRefs: [], evidenceRefsOmitted: 0 }; }
}
