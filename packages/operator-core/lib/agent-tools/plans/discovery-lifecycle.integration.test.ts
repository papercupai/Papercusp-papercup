/** The motivating draft stays untouched; these are private, versioned copies. */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deriveIndexFromContent } from './derive-index';
import { writePlanIndexRows } from './plan-index-rows';
import { readPlanLineNodes, writePlanLineNodes } from './plan-line-graph';
import { seedPlan, setupPlanPgFixture, type PlanPgFixture } from './__tests__/_pg-tool-fixture';
import { checkDraftItemStartGate } from './draft-item-start-gate';
import { discoveryDeclarationSchema, type DiscoveryDeclaration } from './plan-declarations';
import { resolveDiscoveryAuditContext } from './plan-declaration-resolvers';
import { recordCurrentDiscoveryAudit, withCurrentDiscovery } from '../../plan-audits';
import { persistResearchBatch } from '../../code-intelligence/research-trail';
import { getFeedbackCore, type GetFeedbackDeps, type GetFeedbackRequest } from '../../consult/get-feedback-core';
import { BAR_CRITIQUE_POLICY } from '../../consult/selection-policies';

// Verbatim P-001, read from the original plan's canonical revision 3.
const ORIGINAL_CENSUS = 'Establish the existing-behavior and prior-work census. Re-read WI-6554700010030941 and associated plans; identify reused implementations and unresolved gaps. Bind baseline/check procedures to existing rubric/results records, with full manifests and source/runtime identity. Measure proof selection plus actual child consumption, retained work after interruption, optional lock occupancy and candidate completion phases. Before edits, resolve graph impact/similarity and current-build test routes.';
const OWNER = 'su-discovery-lifecycle-fixture';
let fx: PlanPgFixture;
let root: string;
let sequence = 0;
let harness: string;
let slug: string;
let content: string;
const input = () => ({ workspaceId: fx.workspaceId, harnessSlug: harness, planSlug: slug, createdBy: OWNER });
const resolver: NonNullable<Parameters<typeof recordCurrentDiscoveryAudit>[1]>['context'] =
  (draft, previous, prior, historicalTargets) => resolveDiscoveryAuditContext(draft, previous, {
    repoRoot: root, workspaceId: fx.workspaceId, sql: fx.admin, harnessSlug: harness,
    ownerId: OWNER, planSlug: slug, prior, historicalTargets,
  });
const questions: DiscoveryDeclaration['questions'] = [
  { id: 'Q-1', kind: 'current-behavior', question: 'What proof warming already exists?',
    stopCondition: 'Read the current cache and its consumer.', outcome: 'unresolved' },
  { id: 'Q-2', kind: 'gap', question: 'What required behavior is still missing?',
    stopCondition: 'Compare the existing consumer with the requested retained proof.', outcome: 'unresolved' },
  { id: 'Q-3', kind: 'feasibility', question: 'Can the existing cache serve the missing caller?',
    stopCondition: 'Trace its key and lifetime contract at the caller.', outcome: 'unresolved' },
];
const pending: DiscoveryDeclaration = { questions, findings: [], notApplicable: null };
function plan(declaration: DiscoveryDeclaration, reconciled = false) {
  return `---\nslug: ${slug}\nstatus: draft\n---\n# Proof warming fixture\n\n## Phase 1\n\n` +
    (reconciled
      ? '- **P-002** `todo` Reuse the existing keyed cache at the missing child-consumption caller\n'
      : `- **P-001** \`todo\` ${ORIGINAL_CENSUS}\n`) +
    `\n## Discovery\n\n\`\`\`discovery\n${JSON.stringify(declaration)}\n\`\`\`\n`;
}
async function revision(next: string) {
  content = next;
  await seedPlan(fx.admin, fx.workspaceId, harness, slug, next);
  const hash = createHash('sha256').update(next).digest('hex');
  await fx.admin.begin(async tx => {
    const scope = { workspaceId: fx.workspaceId, harnessSlug: harness, planSlug: slug };
    const index = deriveIndexFromContent(next);
    const previous = await readPlanLineNodes(tx as never, { ...scope, slug });
    await writePlanIndexRows(tx as never, scope, index);
    await writePlanLineNodes(tx as never, { ...scope, slug }, previous, index.items);
    await tx`UPDATE harness_shared.harness_plans SET content_hash=${hash},version=version+1
      WHERE workspace_id=${fx.workspaceId} AND harness_slug=${harness} AND plan_slug=${slug}`;
    await tx`INSERT INTO harness_shared.plan_revisions
      (workspace_id,harness_slug,plan_slug,seq,content_hash,content_snapshot,rationale,author_kind,author_id,session_id,session_kind,created_at)
      SELECT ${fx.workspaceId},${harness},${slug},COALESCE(MAX(seq),0)+1,${hash},${next},
        'isolated original-failure fixture','agent',${OWNER},'fixture','codex',${Date.now()}
      FROM harness_shared.plan_revisions WHERE workspace_id=${fx.workspaceId} AND harness_slug=${harness} AND plan_slug=${slug}`;
  });
}
const finalized = () => recordCurrentDiscoveryAudit(input(), { context: resolver });
const current = () => withCurrentDiscovery(input(), async () => undefined, { context: resolver });
function revisedFindings(): DiscoveryDeclaration {
  return { questions: questions.map(question => ({ ...question, outcome: 'answered' })), notApplicable: null,
    findings: [{ id: 'F-1', questions: questions.map(question => question.id),
      conclusion: 'The keyed cache already warms and retains proof; only the child-consumption caller is missing.',
      evidenceRefs: ['source:proof-cache.ts'], dispositions: [
        { target: 'P-001', decision: 'remove', reason: 'The census is performed; remove duplicate implementation discovery.' },
        { target: 'P-002', decision: 'reuse', reason: 'Reuse the existing key/lifetime contract at the missing caller.' },
      ] }],
  };
}
function reviewDeps() {
  const route = vi.fn(async () => { throw new Error('REVIEW_ROUTING_ADMITTED'); });
  const open = vi.fn(async () => { throw new Error('UNEXPECTED_CONVERSATION'); });
  const deps = { getSql: () => fx.admin, route, open,
    withCurrentDiscovery: ((request, accept) => withCurrentDiscovery(request, accept, { context: resolver })) as NonNullable<GetFeedbackDeps['withCurrentDiscovery']>,
  } as unknown as GetFeedbackDeps;
  const request: GetFeedbackRequest = { workspaceId: fx.workspaceId, requesterId: OWNER,
    policy: BAR_CRITIQUE_POLICY, originTaskRef: slug, harnessSlug: harness, allowDispatch: true,
    question: 'Review the full BARs and reconciled current draft against original owner intent; do not defer the census into implementation.' };
  return { route, open, attempt: () => getFeedbackCore(request, deps) };
}
async function startAttempt(itemId = 'P-001') {
  return checkDraftItemStartGate({ slug, itemId, toStatus: 'wip', readPlanContent: async () => content,
    evaluateDiscovery: async () => { const result = await current(); return result.ok ? { ok: true as const }
      : { ok: false as const, error: result.error, nextAction: 'nextAction' in result ? result.nextAction : undefined }; },
    // Existing activation/authority checks are separately covered; this isolates discovery.
    evaluateGate: async () => ({ satisfied: true }), hasCoveringWorkItem: async () => false });
}
beforeAll(async () => {
  fx = await setupPlanPgFixture({ isolated: true });
  await fx.admin.unsafe(await readFile(fileURLToPath(new URL(
    '../../../../../libs/papercusp/libs/db/sql/1619-plan-discovery-audits.sql', import.meta.url)), 'utf8'));
  root = await mkdtemp(join(tmpdir(), 'discovery-lifecycle-'));
}, 120_000);
afterAll(async () => { await fx?.dispose(); if (root) await rm(root, { recursive: true, force: true }); });
beforeEach(async () => {
  harness = `zzz-discovery-lifecycle-${++sequence}`;
  slug = `proof-warming-discovery-${sequence}`;
  await writeFile(join(root, 'proof-cache.ts'), 'export const retainedProofCache = new Map();\n');
  await persistResearchBatch({ workspace: fx.workspaceId, owner: OWNER, harness, client: 'codex', calls: [] },
    [{ kind: 'path', requested: 'proof-cache.ts', path: 'proof-cache.ts', seenAt: Date.now() }]);
  await revision(plan(pending));
});

describe('original proof-warming discovery before review and implementation', () => {
  it('refuses the exact deferred census and a falsely asserted ready record before routing/opening/starting', async () => {
    const review = reviewDeps();
    for (const declaration of [pending, { ...pending, questions: questions.map(question => ({ ...question, outcome: 'answered' as const })) }]) {
      await revision(plan(declaration));
      expect(await finalized()).toMatchObject({ ok: true, discovery: { readiness: { ready: false } } });
      expect(await review.attempt()).toMatchObject({ error: 'discovery_not_ready' });
      expect(await startAttempt()).toMatchObject({ error: 'discovery_not_ready' });
    }
    expect(discoveryDeclarationSchema.safeParse({ ...pending, ready: true }).success).toBe(false);
    expect(review.route).not.toHaveBeenCalled();
    expect(review.open).not.toHaveBeenCalled();
    const [{ count }] = await fx.admin`SELECT count(*)::int AS count FROM harness_shared.consult_state
      WHERE workspace_id=${fx.workspaceId} AND origin_task_ref=${slug}`;
    expect(count).toBe(0);
  });

  it('incorporates actual source findings, removes duplicate census work, then admits the corrected revision', async () => {
    await finalized();
    await revision(plan(revisedFindings(), true));
    expect(await startAttempt('P-002')).toMatchObject({ error: 'discovery_not_ready' });
    const result = await finalized();
    expect(result).toMatchObject({ ok: true, discovery: { readiness: { ready: true } } });
    expect(await startAttempt('P-002')).toBeNull();
    const review = reviewDeps();
    await expect(review.attempt()).rejects.toThrow('REVIEW_ROUTING_ADMITTED');
    expect(review.route).toHaveBeenCalledOnce();
    const accepted = await withCurrentDiscovery(input(), async (_tx, subject) => subject.content, { context: resolver });
    expect(accepted).toMatchObject({ ok: true, result: content });
    // A plain replay models a restarted caller; it reads canonical state again.
    expect(await current()).toMatchObject({ ok: true });
  });

  it('uses current source fallback, retains provenance after trail GC, and refuses relevant source mutation', async () => {
    await revision(plan(revisedFindings(), true));
    expect(await finalized()).toMatchObject({ ok: true, discovery: { readiness: { ready: true } } });
    await fx.admin`DELETE FROM harness_shared.code_intel_research_trails
      WHERE workspace_id=${fx.workspaceId} AND owner_id=${OWNER} AND harness_slug=${harness}`;
    expect(await current()).toMatchObject({ ok: true });
    await writeFile(join(root, 'proof-cache.ts'), 'export const retainedProofCache = null;\n');
    const review = reviewDeps();
    expect(await review.attempt()).toMatchObject({ error: 'discovery_not_ready' });
    expect(review.route).not.toHaveBeenCalled();
    expect(await startAttempt('P-002')).toMatchObject({ error: 'discovery_not_ready' });
  });

  it('measures confined current source without optional client research capture and keeps missing authority unknown', async () => {
    await fx.admin`DELETE FROM harness_shared.code_intel_research_trails
      WHERE workspace_id=${fx.workspaceId} AND owner_id=${OWNER} AND harness_slug=${harness}`;
    await revision(plan(revisedFindings(), true));
    expect(await finalized()).toMatchObject({ ok: true, discovery: { readiness: { ready: true } } });
    const unavailable = (draft: string, previous: string | null, prior?: Parameters<typeof resolveDiscoveryAuditContext>[2]['prior']) =>
      resolveDiscoveryAuditContext(draft, previous, { repoRoot: null, workspaceId: fx.workspaceId,
        sql: fx.admin, harnessSlug: harness, ownerId: OWNER, planSlug: slug, prior });
    expect(await withCurrentDiscovery(input(), async () => 'must not run', { context: unavailable }))
      .toMatchObject({ ok: false, discovery: { readiness: { state: 'unknown' } } });
    const outside = revisedFindings();
    outside.findings[0]!.evidenceRefs = ['source:../proof-cache.ts'];
    await revision(plan(outside, true));
    expect(await finalized()).toMatchObject({ ok: true, discovery: { readiness: { ready: false, state: 'unknown' } } });
  });

  it('supports evidence-backed no-change and a bounded nonblocking implementation experiment without copied facts', async () => {
    const declaration: DiscoveryDeclaration = { notApplicable: 'Current source establishes this general review; no material unknowns remain.',
      questions: [], findings: [{ id: 'F-1', questions: [], conclusion: 'Keep the evidenced existing scope unchanged.',
        evidenceRefs: ['source:proof-cache.ts'], dispositions: [{ target: 'P-001', decision: 'unchanged', reason: 'Current behavior supports the scope.' }] }] };
    await revision(plan(declaration));
    expect(await finalized()).toMatchObject({ ok: true, discovery: { readiness: { ready: true } } });
    const experiment = revisedFindings();
    experiment.questions[2] = { ...experiment.questions[2]!, outcome: 'experiment',
      rationale: 'Implementation timing cannot invalidate the demonstrated cache reuse or scope.',
      bounds: 'Measure one caller within one retained-proof lifetime; stop if its existing contract changes.' };
    await revision(plan(experiment, true));
    expect(await finalized()).toMatchObject({ ok: true, discovery: { readiness: { ready: true } } });
    expect(discoveryDeclarationSchema.safeParse({ ...experiment, fingerprint: 'copied', ready: true }).success).toBe(false);
  });

  it('batches multiple findings into one idempotent persistence operation across retries, concurrency and cosmetic edits', async () => {
    const declaration = revisedFindings();
    const finding = declaration.findings[0]!;
    declaration.findings = [{ ...finding, dispositions: [finding.dispositions[0]!] },
      { ...finding, id: 'F-2', dispositions: [finding.dispositions[1]!] }];
    await revision(plan(declaration, true));
    const results = await Promise.all([finalized(), finalized()]);
    expect(results.some(result => result.ok && result.discovery.readiness.ready), JSON.stringify(results)).toBe(true);
    for (const result of results) {
      if (result.ok) expect(result.discovery.readiness.ready).toBe(true);
      else expect(result.error).toBe('plan_busy');
    }
    // The writer deliberately refuses contended try-locks. Replaying the same
    // operation must reuse the winning audit without a second authored record.
    expect(await finalized()).toMatchObject({ ok: true, reused: true, discovery: { readiness: { ready: true } } });
    await revision(content.replace('# Proof warming fixture', '# Proof warming fixture   ') + '\n## Now\nBookkeeping only.\n');
    expect(await finalized()).toMatchObject({ ok: true, reused: true });
    const [{ count }] = await fx.admin`SELECT count(*)::int AS count FROM harness_shared.plan_audits
      WHERE workspace_id=${fx.workspaceId} AND harness_slug=${harness} AND plan_slug=${slug} AND audit_kind='discovery'`;
    expect(count).toBe(1);
  });
});
