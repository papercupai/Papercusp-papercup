/** Called by the background census only. Source dispatch does not depend on mining. */
export type MiningStage = 'source' | 'aggregate' | 'commit' | 'alert' | 'purge';
export function miningFailureReason(error: unknown): string {
  const e = error as { message?: string; code?: string } | null;
  // Error messages may contain raw SQL/paths/credentials. Retain typed causes, never that text.
  if (e?.code && /^[A-Z0-9]{5}$/.test(e.code)) return `database-${e.code}`;
  if (e?.message && ['sql_mining_time_budget', 'sql_mining_window_cap', 'sql_corpus_source_denied',
    'invalid_sql_mining_scope', 'invalid_sql_mining_token', 'sql_mining_source_missing'].includes(e.message)) return e.message;
  return error instanceof Error ? 'dependency-error' : 'unknown-failure';
}
export async function boundedStage<T>(work: () => Promise<T>, budgetMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('sql_mining_time_budget')), budgetMs);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

/** One population for cadence wiring, normalized child rows and shipment checks. */
export const MONITORED_FAMILIES = ['sql', 'search-reformulation', 'result-recovery',
  'workaround-funnel', 'native-operation'] as const;
export type MonitoredFamily = typeof MONITORED_FAMILIES[number];

export interface MonitoredRuntime { sha: string; runtime: string }
export interface MonitoredSchedule {
  id: string; configHash: string; active: boolean; paused: boolean;
  expression: string; timezone: string; dueAt: string;
}
export interface MonitoredRunEvidence {
  run: MonitoredRuntime & { id: string; workspaceId: string; harnessSlug: string;
    routineId: string; configHash: string; operationId: string;
    trigger: 'scheduler' | 'manual' | 'test'; scheduledAt: string; startedAt: string; finishedAt: string };
  runtimeBefore: MonitoredRuntime; runtimeAfter: MonitoredRuntime;
  scheduleBefore: MonitoredSchedule; scheduleAfter: MonitoredSchedule;
  /** Canonical routine definition, read independently of the run's claimed descriptor. */
  expectedSchedule: Pick<MonitoredSchedule, 'id' | 'expression' | 'timezone'>;
  families: Array<MonitoredRuntime & { runId: string; family: MonitoredFamily; enabled: boolean;
    coverage: 'measured' | 'missing' | 'unsupported' | 'truncated' | 'UNKNOWN';
    scanned: number; qualifying: number; plantedCandidateIds: string[] }>;
  /** These rows come from canonical review entities/transitions, not a completion boolean. */
  reviews: Array<{ runId: string; family: MonitoredFamily; candidateId: string;
    workItemId: string; transitionId: string; outcome: 'accepted' | 'declined' | 'pending'; owner: string | null }>;
  testRuns: Array<MonitoredRuntime & { id: string; runId: string; result: 'passed' | 'failed';
    file: string; caseName: string }>;
}

/** Pure assessor only. The production reader must load each native record independently;
 * caller-authored receipts cannot certify shipment. No write or ship verdict occurs here. */
export function assessMonitoredRun(e: MonitoredRunEvidence) {
  const failures: string[] = [], unknown: string[] = [];
  const require = (ok: boolean, reason: string) => { if (!ok) failures.push(reason); };
  const nonempty = (s: unknown): s is string => typeof s === 'string' && s.trim().length > 0;
  const finiteTime = (s: string) => nonempty(s) ? Date.parse(s) : NaN;
  const count = (n: number) => Number.isSafeInteger(n) && n >= 0;
  const sameRuntime = (r: MonitoredRuntime) => r.sha === e.run.sha && r.runtime === e.run.runtime;
  require(/^[a-f0-9]{40}$/.test(e.run.sha) && nonempty(e.run.runtime) &&
    nonempty(e.run.id) && nonempty(e.run.workspaceId) && nonempty(e.run.harnessSlug), 'run-identity');
  require(sameRuntime(e.runtimeBefore) && sameRuntime(e.runtimeAfter), 'runtime-drift');
  const before = e.scheduleBefore, after = e.scheduleAfter, expected = e.expectedSchedule;
  require([before, after].every(s => s.active === true && s.paused === false &&
    nonempty(s.id) && nonempty(s.expression) && nonempty(s.timezone) &&
    /^[a-f0-9]{64}$/.test(s.configHash) && s.id === expected.id &&
    s.expression === expected.expression && s.timezone === expected.timezone), 'schedule-descriptor');
  require(before.id === after.id && before.configHash === after.configHash &&
    before.expression === after.expression && before.timezone === after.timezone, 'schedule-drift');
  require(e.run.trigger === 'scheduler' && nonempty(e.run.operationId) &&
    e.run.routineId === before.id && e.run.configHash === before.configHash, 'scheduler-origin');
  const scheduled = finiteTime(e.run.scheduledAt), started = finiteTime(e.run.startedAt), finished = finiteTime(e.run.finishedAt);
  require(Number.isFinite(scheduled) && scheduled === finiteTime(before.dueAt) &&
    Number.isFinite(started) && started >= scheduled && started - scheduled <= 120_000 &&
    Number.isFinite(finished) && finished >= started, 'schedule-timing');
  const checked: string[] = [], notChecked: string[] = [];
  require(e.families.length === MONITORED_FAMILIES.length, 'family-population');
  for (const family of MONITORED_FAMILIES) {
    const rows = e.families.filter(r => r.family === family), row = rows[0];
    if (rows.length !== 1 || !row) { notChecked.push(family); unknown.push(`family:${family}:missing-or-duplicate`); continue; }
    require(row.runId === e.run.id && sameRuntime(row) && row.enabled === true, `family:${family}:identity-or-disabled`);
    require(count(row.scanned) && count(row.qualifying) && row.qualifying <= row.scanned &&
      new Set(row.plantedCandidateIds).size === row.plantedCandidateIds.length &&
      row.plantedCandidateIds.every(nonempty) && row.plantedCandidateIds.length <= row.qualifying,
    `family:${family}:counts`);
    if (row.coverage !== 'measured') { notChecked.push(family); unknown.push(`family:${family}:${row.coverage}`); }
    else checked.push(family);
  }
  const planted = e.families.flatMap(row => row.plantedCandidateIds.map(id => ({ family: row.family, id })));
  require(planted.length > 0, 'planted-control-missing');
  require(planted.some(p => e.reviews.some(r => r.runId === e.run.id && r.family === p.family &&
    r.candidateId === p.id && nonempty(r.workItemId) && nonempty(r.transitionId) &&
    nonempty(r.owner) && ['accepted', 'declined'].includes(r.outcome))), 'canonical-review-transition');
  require(e.testRuns.some(t => nonempty(t.id) && t.runId === e.run.id && sameRuntime(t) &&
    t.result === 'passed' && t.file === 'packages/operator-core/lib/agent-opportunities/pipeline.deployed.integration.test.ts' &&
    t.caseName === 'R13-DEPLOYED'), 'deployed-test-binding');
  return { status: failures.length ? 'fail' as const : unknown.length ? 'UNKNOWN' as const : 'pass' as const,
    failures, unknown, coverage: { population: [...MONITORED_FAMILIES], checked, notChecked,
      notApplicable: [] as string[], residue: [...failures, ...unknown] } };
}
