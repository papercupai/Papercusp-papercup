/** P-015: measure PR bypasses from explicit rule cohorts, not the opt-in delivery flag. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import { getOrgPg } from '@papercusp/db-org';
import type { Sql } from 'postgres';
import { loadHarnessRegistry, type ProjectEntry } from '../harness-registry';
import { CompletionSettlementManifestSchema, TERMINAL_COMPLETION_EVIDENCE_KEY } from '../coord-lifecycle/records';
import { completionHeadBlobMap } from '../agent-tools/work_items/completion-freshness';
import { createGitHubPrHost } from '../pr-host/github';
import type { PrHost } from '../pr-host/types';
import { STANDING_PR_BRANCH } from '../harness/git-sync/decide-standing-pr';
import { normalizeRemote } from '../pr-host/pr-poll-routine';
import { mapWithConcurrency } from '../gym/concurrency';

export const PR_DELIVERY_AUDIT_MAX = 100;
const HISTORY_MAX = 100;
const UPSTREAM_HEADS_MAX = 100;
const terminal = new Set(['done', 'resolved', 'closed']);
const exec = promisify(execFile);
const sha = /^[0-9a-f]{40}$/;

export const prDeliveryAuditScopeSchema = z.object({
  ruleIds: z.array(z.string().uuid()).min(1).max(20),
}).strict();
export const prDeliveryAuditResultSchema = z.object({
  verdict: z.enum(['pass', 'fail', 'unknown']),
  complete: z.boolean(),
  population: z.number(),
  checked: z.number(),
  pending: z.number(),
  ruleIds: z.array(z.string()),
  missingRuleIds: z.array(z.string()),
  rows: z.array(z.object({
    id: z.string(), harness: z.string(), ruleId: z.string(),
    verdict: z.enum(['pass', 'fail', 'unknown', 'pending']),
    reason: z.string(), upstreamSha: z.string().optional(), fixSha: z.string().optional(),
    prUrl: z.string().optional(),
  })),
});
export type PrDeliveryAudit = z.infer<typeof prDeliveryAuditResultSchema>;
export interface PrDeliveryAuditRow {
  id: string; harness: string; ruleId: string; state: string; authority: string | null;
  payload: Record<string, unknown>;
}
export type AuditGit = (root: string, args: string[]) => Promise<{ code: number; stdout: string }>;
export const auditGit: AuditGit = async (root, args) => {
  try {
    const result = await exec('git', ['-C', root, ...args], { timeout: 5000, maxBuffer: 1024 * 1024 });
    return { code: 0, stdout: result.stdout.trim() };
  } catch (error) {
    const e = error as { code?: unknown; stdout?: string };
    return { code: typeof e.code === 'number' ? e.code : -1, stdout: e.stdout?.trim() ?? '' };
  }
};

/** Bounded read of the whole named cohort, including disabled and direct-delivery rules. */
export async function loadPrDeliveryAuditPopulation(
  workspaceId: string, ruleIds: string[], sql: Sql = getOrgPg().sql,
): Promise<{ rows: PrDeliveryAuditRow[]; missingRuleIds: string[]; total: number }> {
  const rules = await sql<{ id: string }[]>`
    SELECT id::text FROM harness_shared.admission_rules
     WHERE workspace_id = ${workspaceId} AND id = ANY(${ruleIds}::uuid[])`;
  const found = new Set(rules.map(r => r.id));
  const rows = await sql<{
    id: string; harness: string; rule_id: string; state: string; authority: string | null;
    payload: Record<string, unknown>; total: string;
  }[]>`
    SELECT a.work_item_id AS id, a.harness_slug AS harness, a.rule_id::text,
           w.status AS state, w.authority, w.payload, count(*) OVER ()::text AS total
      FROM harness_shared.work_admissions a
      LEFT JOIN harness_shared.work_items w ON w.workspace_id = a.workspace_id
       AND w.feature_id = a.work_item_id AND w.harness_slug = a.harness_slug
     WHERE a.workspace_id = ${workspaceId} AND a.rule_id = ANY(${ruleIds}::uuid[])
     ORDER BY a.created_at, a.id LIMIT ${PR_DELIVERY_AUDIT_MAX}`;
  return { missingRuleIds: ruleIds.filter(id => !found.has(id)), total: Number(rows[0]?.total ?? 0),
    rows: rows.map(r => ({ id: r.id, harness: r.harness, ruleId: r.rule_id,
      state: r.state, authority: r.authority, payload: r.payload })) };
}

/** Read-only Git: inspect fresh upstream heads and the working copy's already-fetched objects. */
export async function inspectPrDeliveryRow(
  row: PrDeliveryAuditRow, project: ProjectEntry | undefined,
  deps: { git?: AuditGit; host: Pick<PrHost, 'getPr'> | null; blobs?: typeof completionHeadBlobMap },
): Promise<PrDeliveryAudit['rows'][number]> {
  const identity = { id: row.id, harness: row.harness, ruleId: row.ruleId };
  const answer = (verdict: PrDeliveryAudit['rows'][number]['verdict'], reason: string,
    evidence: Partial<PrDeliveryAudit['rows'][number]> = {}) => ({ ...identity, verdict, reason, ...evidence });
  if (!row.state || !row.payload) return answer('unknown', 'The admitted work item could not be resolved.');
  if (!terminal.has(row.state)) return answer('pending', 'No terminal fix is claimed yet.');
  if (row.authority !== 'committed') return answer('unknown', 'The fix completion is not committed.');
  const evidence = row.payload[TERMINAL_COMPLETION_EVIDENCE_KEY] as Record<string, unknown> | undefined;
  const parsed = CompletionSettlementManifestSchema.safeParse(evidence?.settlementManifest);
  if (!parsed.success) return answer('unknown', 'No valid completion content receipt.');
  const manifest = parsed.data;
  if (!project?.path || !project.github_remote)
    return answer('unknown', 'The upstream repository is missing.');
  const entries = manifest.contentIdentity;
  if (manifest.residualPaths?.length || manifest.repositoryRoot !== project.path
    || manifest.normalizedPaths.some(path => !entries.some(e => e.path === path))
    || entries.some(e => (e.repositoryRoot ?? manifest.repositoryRoot) !== project.path
      || (!e.deletion && !e.workingTreeBlobSha)))
    return answer('unknown', 'Incomplete or cross-repository completion content receipt.');
  const git = deps.git ?? auditGit;
  // A repository's default branch need not be the standing PR's base, and a
  // direct fix can land on another upstream head. Inspect the actual heads;
  // the fixing pot is required to publish its unreviewed work to its fork.
  const remoteHeads = await git(project.path, ['ls-remote', '--exit-code', '--heads', project.github_remote]);
  const tips = remoteHeads.stdout.split('\n').filter(Boolean).map(line => {
    const [commit = '', ref = ''] = line.split(/\s+/);
    return { sha: commit, branch: ref.startsWith('refs/heads/') ? ref.slice(11) : '' };
  });
  if (remoteHeads.code !== 0 || !tips.length
    || tips.some(t => !sha.test(t.sha ?? '') || !t.branch))
    return answer('unknown', 'Fresh upstream heads are unavailable.');
  if (tips.length > UPSTREAM_HEADS_MAX)
    return answer('unknown', 'The upstream branch census is incomplete.');
  let upstreamSha = tips.find(t => t.branch === project.github_default_branch)?.sha ?? tips[0]!.sha;
  const link = row.payload.standingPr as Record<string, unknown> | undefined;
  const url = typeof link?.url === 'string' ? link.url : '';
  const urlMatch = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/([1-9]\d*)$/.exec(url);
  const validReceipt = !!urlMatch && link?.schemaVersion === 'admission-standing-pr-v1'
    && link.number === Number(urlMatch[2]) && sha.test(String(link.testedSha)) && sha.test(String(link.targetSha));
  const paths = entries.map(e => e.path);
  const read = deps.blobs ?? completionHeadBlobMap;
  const matches = async (commit: string): Promise<boolean | null> => {
    const blobs = await read(project.path, commit, paths);
    if (!blobs || entries.some(e => !blobs.get(e.path) || blobs.get(e.path)?.status === 'unresolvable')) return null;
    return entries.every(e => {
      const actual = blobs.get(e.path);
      return e.deletion ? actual?.status === 'absent'
        : actual?.status === 'resolved' && actual.sha === e.workingTreeBlobSha;
    });
  };
  // A matching current upstream tree already proves a bypass when no PR receipt
  // exists. Do not pay for history (or let an unrelated unreadable tree hide that
  // proof) after the falsifier has its answer. PR-backed rows still need the full
  // first-parent census below to exclude an earlier direct push.
  if (!validReceipt) {
    for (const tip of tips) {
      const match = await matches(tip.sha);
      if (match === null) return answer('unknown', 'An upstream tree could not be read.', { upstreamSha });
      if (match) return answer('fail', 'Fix reached upstream without a valid standing PR receipt.',
        { upstreamSha: tip.sha, fixSha: tip.sha });
    }
  }
  // Inspect first-parent history too: a later change/revert must not hide a direct
  // push. A settlement baseline can be the PR head; generic ancestry would also
  // reach it through a merge's second parent, without it ever being an upstream
  // target commit. Let the actual first-parent census decide, without injecting
  // or excluding that baseline.
  const history = await git(project.path, ['log', '--first-parent', '--format=%H', `--max-count=${HISTORY_MAX + 1}`,
    ...tips.map(t => t.sha), '--', ...paths]);
  if (history.code !== 0) return answer('unknown', 'Upstream objects are not available in the maintained working copy.', { upstreamSha });
  const commits = [...new Set([...tips.map(t => t.sha), ...history.stdout.split('\n').filter(Boolean)])];
  // History tree reads are independent. Keep the mapper bounded so a large
  // first-parent census cannot fan out unbounded Git subprocesses, while
  // avoiding a serial 100-commit × blob-read deadline on the API path.
  const historyMatches = await mapWithConcurrency(
    commits.slice(0, HISTORY_MAX), 4,
    async (commit) => ({ commit, match: await matches(commit) }),
  );
  let fixSha: string | undefined;
  const matchingCommits: string[] = [];
  for (const { commit, match } of historyMatches) {
    if (match === null) return answer('unknown', 'An upstream tree could not be read.', { upstreamSha });
    if (match) {
      if (!validReceipt) return answer('fail', 'Fix reached upstream without a valid standing PR receipt.',
        { upstreamSha, fixSha: commit });
      fixSha ??= commit; matchingCommits.push(commit);
    }
  }
  if (!fixSha) {
    // A shallow or capped history cannot establish absence.
    const shallow = await git(project.path, ['rev-parse', '--is-shallow-repository']);
    if (commits.length > HISTORY_MAX || shallow.code !== 0 || shallow.stdout !== 'false')
      return answer('unknown', 'The upstream history census is incomplete.', { upstreamSha });
    return answer('pass', 'The recorded fix has not reached upstream.', { upstreamSha });
  }
  upstreamSha = tips.find(t => matchingCommits.includes(t.sha))?.sha ?? upstreamSha;
  const proof = { upstreamSha, fixSha };
  if (!urlMatch || link?.schemaVersion !== 'admission-standing-pr-v1'
    || link.number !== Number(urlMatch[2]) || !sha.test(String(link.testedSha)) || !sha.test(String(link.targetSha)))
    return answer('fail', 'Fix reached upstream without a valid standing PR receipt.', proof);
  const remote = normalizeRemote(project.github_remote);
  if (remote !== `github.com/${urlMatch[1]}`) return answer('fail', 'The PR belongs to another upstream.', { ...proof, prUrl: url });
  if (!deps.host) return answer('unknown', 'PR host authentication is unavailable.', { ...proof, prUrl: url });
  const fetched = await deps.host.getPr({ remote, number: Number(urlMatch[2]) });
  if (!fetched.ok) return answer('unknown', `PR host read failed: ${fetched.error.kind}.`, { ...proof, prUrl: url });
  const pr = fetched.data;
  const fork = normalizeRemote(project.fork_remote);
  const targetTip = tips.find(t => t.branch === pr.base_ref);
  if (pr.state !== 'merged' || pr.head_ref !== STANDING_PR_BRANCH || pr.is_draft
    || pr.head_sha !== link.testedSha || !sha.test(pr.merge_commit_sha ?? '')
    || !targetTip || pr.url !== url
    || !fork || pr.head_repo !== fork.replace(/^github\.com\//, ''))
    return answer('fail', 'Fix reached upstream without the matching merged standing PR.', { ...proof, prUrl: url });
  const [headMatches, baseMatches, mergeMatches, ancestor] = await Promise.all([
    matches(String(link.testedSha)), matches(String(link.targetSha)), matches(pr.merge_commit_sha!),
    git(project.path, ['merge-base', '--is-ancestor', pr.merge_commit_sha!, targetTip.sha]),
  ]);
  if ([headMatches, baseMatches, mergeMatches].includes(null) || ![0, 1].includes(ancestor.code))
    return answer('unknown', 'Merged PR content or ancestry could not be verified.', { ...proof, prUrl: url });
  if (!headMatches || baseMatches || !mergeMatches || ancestor.code !== 0)
    return answer('fail', 'The merged PR does not introduce this fix into the actual upstream history.', { ...proof, prUrl: url });
  for (const commit of matchingCommits) {
    const introduced = await git(project.path, ['merge-base', '--is-ancestor', pr.merge_commit_sha!, commit]);
    if (![0, 1].includes(introduced.code))
      return answer('unknown', 'First-parent fix ancestry could not be verified.', { ...proof, prUrl: url });
    if (introduced.code === 1)
      return answer('fail', 'The fix was already on upstream before this standing PR merged.', { ...proof, prUrl: url });
  }
  if (commits.length > HISTORY_MAX)
    return answer('unknown', 'The upstream history census is incomplete.', { ...proof, prUrl: url });
  return answer('pass', 'Fix reached upstream through the matching merged standing PR.', { ...proof, prUrl: url });
}

export async function auditPrDelivery(
  workspaceId: string, scope: z.infer<typeof prDeliveryAuditScopeSchema>,
  deps: { population?: typeof loadPrDeliveryAuditPopulation;
    projects?: (workspaceId: string) => Promise<ProjectEntry[]>;
    host?: Pick<PrHost, 'getPr'> | null; git?: AuditGit; blobs?: typeof completionHeadBlobMap } = {},
): Promise<PrDeliveryAudit> {
  const ruleIds = [...new Set(prDeliveryAuditScopeSchema.parse(scope).ruleIds)];
  const population = await (deps.population ?? loadPrDeliveryAuditPopulation)(workspaceId, ruleIds);
  const projects = await (deps.projects ?? (async ws => (await loadHarnessRegistry(ws)).projects))(workspaceId);
  // Reuse the existing bounded mapper: independent rows need not add their Git
  // and network latencies serially to the tool's read deadline. Create auth once.
  const host = deps.host !== undefined ? deps.host
    : population.rows.some(row => terminal.has(row.state) && row.payload?.standingPr)
      ? await createGitHubPrHost() : null;
  const rows = await mapWithConcurrency(population.rows, 4, async (row): Promise<PrDeliveryAudit['rows'][number]> => {
    try {
      return await inspectPrDeliveryRow(row, projects.find(p => p.slug === row.harness),
        { host, git: deps.git, blobs: deps.blobs });
    } catch (error) {
      return { id: row.id, harness: row.harness, ruleId: row.ruleId, verdict: 'unknown',
        reason: error instanceof Error ? error.message : String(error) };
    }
  });
  const complete = population.missingRuleIds.length === 0 && population.total === rows.length;
  return { verdict: rows.some(r => r.verdict === 'fail') ? 'fail'
    : !complete || !rows.length || rows.some(r => r.verdict === 'unknown') ? 'unknown' : 'pass',
    complete, population: population.total, checked: rows.filter(r => r.verdict !== 'pending').length,
    pending: rows.filter(r => r.verdict === 'pending').length, ruleIds,
    missingRuleIds: population.missingRuleIds, rows };
}
