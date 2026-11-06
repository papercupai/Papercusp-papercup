import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getLatestActivationAudit, getLatestPlanAudit, recordCurrentDiscoveryAudit, recordCurrentActivationAudit,
  discoverySubjectSnapshot, withCurrentDiscovery, type DiscoveryAuditContext } from './plan-audits';
import { resolveDiscoveryAuditContext } from './agent-tools/plans/plan-declaration-resolvers';
import { persistResearchBatch } from './code-intelligence/research-trail';
import { resolveSpecQualityPlanSubject, specQualitySubjectRef } from './agent-tools/plans/spec-quality';
import { deriveIndexFromContent } from './agent-tools/plans/derive-index';
import { writePlanIndexRows } from './agent-tools/plans/plan-index-rows';
import { readPlanLineNodes, writePlanLineNodes } from './agent-tools/plans/plan-line-graph';
import { parseRequirementBars, parseBarMappings } from './acceptance-bar-seed';
import { checkDraftItemStartGate } from './agent-tools/plans/draft-item-start-gate';
import { seedPlan, setupPlanPgFixture, type PlanPgFixture } from './agent-tools/plans/__tests__/_pg-tool-fixture';

let harness = 'zzz-discovery-audit';
let fixtureCase = 0;
let slug = 'discovery-audit-fixture';
let fx: PlanPgFixture;
const declaration = {
  questions: [], notApplicable: 'The existing helper already establishes the small change; no material unknowns remain.',
  findings: [{ id: 'F-1', questions: [], conclusion: 'Reuse the existing helper at the missing caller.',
    evidenceRefs: ['source:helper.ts'], dispositions: [{ target: 'P-001', decision: 'reuse', reason: 'Current source covers the implementation.' }] }],
};
const draftTemplate = `---\nslug: discovery-audit-fixture\nstatus: draft\n---\n# Draft\n\n## Now\nDraft\n\n## Phase 1\n\n- **P-001** \`todo\` Wire the existing helper\n\n## Discovery\n\n\`\`\`discovery\n${JSON.stringify(declaration)}\n\`\`\`\n`;
let draft = draftTemplate;
const context = async (): Promise<DiscoveryAuditContext> => ({
  targets: [{ ref: 'P-001', change: 'proposed' }],
  evidence: [{ ref: 'source:helper.ts', state: 'current', usable: true, fingerprint: 'a'.repeat(64) }],
});
const input = () => ({ workspaceId: fx.workspaceId, harnessSlug: harness, planSlug: slug, createdBy: 'su-discovery-test' });
async function revision(content = draft) {
  const hash = createHash('sha256').update(content).digest('hex');
  await seedPlan(fx.admin, fx.workspaceId, harness, slug, content);
  await fx.admin.begin(async tx => {
  const scope = { workspaceId: fx.workspaceId, harnessSlug: harness, planSlug: slug };
  const index = deriveIndexFromContent(content);
  const previous = await readPlanLineNodes(tx as never, { ...scope, slug });
  await writePlanIndexRows(tx as never, scope, index);
  await writePlanLineNodes(tx as never, { ...scope, slug }, previous, index.items);
  await tx`UPDATE harness_shared.harness_plans SET content_hash=${hash}, version=version+1
    WHERE workspace_id=${fx.workspaceId} AND harness_slug=${harness} AND plan_slug=${slug}`;
  await tx`INSERT INTO harness_shared.plan_revisions
    (workspace_id,harness_slug,plan_slug,seq,content_hash,content_snapshot,rationale,author_kind,author_id,session_id,session_kind,created_at)
    SELECT ${fx.workspaceId},${harness},${slug},COALESCE(MAX(seq),0)+1,${hash},${content},'discovery fixture','agent','su-test','test','codex',${Date.now()}
    FROM harness_shared.plan_revisions WHERE workspace_id=${fx.workspaceId} AND harness_slug=${harness} AND plan_slug=${slug}`;
  });
}
beforeAll(async () => {
  fx = await setupPlanPgFixture({ isolated: true });
  // Exercise the migration itself, including on a baseline that predates it.
  const migration = await readFile(fileURLToPath(new URL('../../../libs/papercusp/libs/db/sql/1619-plan-discovery-audits.sql', import.meta.url)), 'utf8');
  await fx.admin.unsafe(migration);
}, 120_000);
afterAll(async () => { await fx?.dispose(); });
beforeEach(async () => {
  // Activation creates immutable clause history. Keep each case's namespace
  // separate; the isolated database's owned teardown removes the whole fixture.
  harness = `zzz-discovery-audit-${++fixtureCase}`;
  // Subject resolution hashes the slug and refuses ambiguous registrations.
  slug = `discovery-audit-fixture-${fixtureCase}`;
  draft = draftTemplate.replace('slug: discovery-audit-fixture', `slug: ${slug}`);
  await revision();
});

it('refuses a new implementation item before finalization, admits reconciled discovery, and preserves running work', async () => {
  let accepted = 0;
  const evaluateDiscovery = async () => {
    const result = await withCurrentDiscovery(input(), async () => undefined, { context });
    return result.ok ? { ok: true as const } : { ok: false as const, error: result.error,
      nextAction: 'nextAction' in result ? result.nextAction : undefined };
  };
  const attempt = async (content = draft) => {
    const refusal = await checkDraftItemStartGate({ slug, itemId: 'P-001', toStatus: 'wip',
      readPlanContent: async () => content, evaluateDiscovery,
      evaluateGate: async () => ({ satisfied: true }), hasCoveringWorkItem: async () => true });
    if (!refusal) accepted++;
    return refusal;
  };
  expect(await attempt()).toMatchObject({ error: 'discovery_not_ready' });
  expect(accepted).toBe(0);
  expect(await recordCurrentDiscoveryAudit(input(), { context })).toMatchObject({ ok: true });
  expect(await attempt()).toBeNull();
  expect(accepted).toBe(1);
  const changed = draft.replace('Wire the existing helper', 'Replace the helper with new behavior');
  await revision(changed);
  expect(await attempt(changed)).toMatchObject({ error: 'discovery_not_ready' });
  expect(accepted).toBe(1);
  expect(await attempt(changed.replace('`todo`', '`wip`'))).toBeNull();
  expect(accepted).toBe(2);
});

describe('discovery uses existing revision and audit authorities', () => {
  const activation = () => ({ ...input(), classRef: 'plan-class-feature-ship' as const, activation: {
    sourceRanges: [], mappings: [], repairedOmissions: [], rejectedOrSuperseded: [], unresolvedBlockers: [],
  } });
  it('resolves the existing spec-quality subject to its registered plan, independently of reviewer home', async () => {
    const ref = specQualitySubjectRef(slug, 'plan-class-feature-ship', 'a'.repeat(64));
    expect(await resolveSpecQualityPlanSubject(fx.workspaceId, ref)).toEqual({ planSlug: slug, harnessSlug: harness });
    expect(await resolveSpecQualityPlanSubject(fx.workspaceId, ref.replace(/.$/, 'x'))).toBeNull();
    expect(await resolveSpecQualityPlanSubject('different-workspace', ref)).toBeNull();
  });
  it('refuses direct activation before finalization, with no audit or repair writes', async () => {
    const [{ count: before }] = await fx.admin`SELECT count(*)::int AS count FROM harness_shared.work_items WHERE workspace_id=${fx.workspaceId}`;
    expect(await recordCurrentActivationAudit({ ...activation(), activation: { ...activation().activation,
      unresolvedBlockers: ['must not file a repair before discovery'] } }, { context }))
      .toMatchObject({ ok: false, error: 'discovery_not_ready' });
    const [{ count: after }] = await fx.admin`SELECT count(*)::int AS count FROM harness_shared.work_items WHERE workspace_id=${fx.workspaceId}`;
    expect(after).toBe(before);
    expect(await getLatestActivationAudit(slug, { workspaceId: fx.workspaceId, harnessSlug: harness })).toBeNull();
  });
  it('admits finalized current discovery to the real activation writer and refuses a changed target', async () => {
    // The positive control must satisfy the existing BAR seed contract too.
    const requirement = {
      intent: { request: 'Keep the existing helper behavior.', sourceRefs: ['session_turn:fixture'] },
      acceptance: { condition: 'The admitted audit retains the helper contract.',
        falsifier: 'A changed helper contract is admitted without reconciliation.', evidencePlane: 'tree',
        requiredScope: ['P-001'], requiredTestLayers: ['integration'] },
      verification: { method: 'Exercise the canonical discovery and activation writers.',
        check: { kind: 'tests', files: ['packages/operator-core/lib/plan-discovery.integration.test.ts'] } },
    };
    const reviewPlan = draft + '\n## Requirements\n\n**R-1 — Helper contract.**\n```requirement\n' +
      JSON.stringify(requirement) + '\n```\n\n## Design\n\n### Bar-to-work map for this plan\n\n' +
      '| bar | implementing plan items | evidence plane |\n|---|---|---|\n| R-1 | P-001 | tree |\n';
    await revision(reviewPlan);
    expect(parseRequirementBars(reviewPlan)).toMatchObject({ ok: true });
    expect(parseBarMappings(reviewPlan, new Set(['R-1']))).toMatchObject({ ok: true });
    const [prerequisites] = await fx.admin`SELECT
      EXISTS (SELECT 1 FROM harness_shared.plan_items WHERE workspace_id=${fx.workspaceId}
        AND harness_slug=${harness} AND plan_slug=${slug} AND item_id='P-001') AS item,
      EXISTS (SELECT 1 FROM harness_shared.plan_revisions WHERE workspace_id=${fx.workspaceId}
        AND harness_slug=${harness} AND plan_slug=${slug} AND content_snapshot=${reviewPlan}) AS revision`;
    expect(prerequisites).toEqual({ item: true, revision: true });
    expect(await recordCurrentDiscoveryAudit(input(), { context })).toMatchObject({ ok: true, discovery: { readiness: { ready: true } } });
    const accepted = await recordCurrentActivationAudit(activation(), { context });
    expect(accepted, JSON.stringify(accepted)).toMatchObject({ ok: true, audit: { auditKind: 'activation' } });
    const before = await getLatestActivationAudit(slug, { workspaceId: fx.workspaceId, harnessSlug: harness });
    await revision(reviewPlan.replace('Wire the existing helper', 'Replace the helper with a different service'));
    expect(await recordCurrentActivationAudit(activation(), { context })).toMatchObject({ ok: false, error: 'discovery_not_ready' });
    expect((await getLatestActivationAudit(slug, { workspaceId: fx.workspaceId, harnessSlug: harness }))?.auditSeq).toBe(before?.auditSeq);
  });
  it('keeps canonical identities for legacy prose requirements as well as structured BARs', () => {
    const plan = draft + '\n## Requirements\n\n**R-1 — Existing behavior.** Preserve the helper behavior.\n';
    expect(discoverySubjectSnapshot(plan)['R-1']).toMatch(/^[a-f0-9]{64}$/);
    expect(discoverySubjectSnapshot(plan.replace('Preserve the helper behavior.', 'Replace the helper behavior.'))['R-1'])
      .not.toBe(discoverySubjectSnapshot(plan)['R-1']);
  });
  it('persists one typed assessment, round-trips questions, and never substitutes for activation/completion', async () => {
    const result = await recordCurrentDiscoveryAudit(input(), { context });
    expect(result).toMatchObject({ ok: true, reused: false, discovery: { readiness: { ready: true } }, audit: { auditKind: 'discovery', items: [], activation: null } });
    const [row] = await fx.admin`SELECT content,discovery FROM harness_shared.harness_plans p
      JOIN harness_shared.plan_audits a USING(workspace_id,harness_slug,plan_slug)
      WHERE p.workspace_id=${fx.workspaceId} AND p.harness_slug=${harness} AND p.plan_slug=${slug}`;
    expect(row.content).toBe(draft);
    expect(row.discovery.evidence[0].fingerprint).toBe('a'.repeat(64));
    expect(await getLatestActivationAudit(slug, { workspaceId: fx.workspaceId, harnessSlug: harness })).toBeNull();
    expect(await getLatestPlanAudit(slug, { workspaceId: fx.workspaceId, harnessSlug: harness })).toBeNull();
  });
  it('reuses identical and cosmetic state with original provenance and no second write', async () => {
    const first = await recordCurrentDiscoveryAudit(input(), { context });
    const again = await recordCurrentDiscoveryAudit(input(), { context });
    expect(again).toMatchObject({ ok: true, reused: true, audit: { auditSeq: first.ok && 'audit' in first ? first.audit?.auditSeq : -1 } });
    await revision(draft.replace('## Now\nDraft', '## Now\nChanged bookkeeping').replace('Wire the existing helper', 'Wire   the existing helper'));
    expect(discoverySubjectSnapshot(draft)).toEqual(discoverySubjectSnapshot(draft.replace('Wire the existing helper', 'Wire   the existing helper')));
    expect(await recordCurrentDiscoveryAudit(input(), { context })).toMatchObject({ ok: true, reused: true });
    const [{ count }] = await fx.admin`SELECT count(*)::int AS count FROM harness_shared.plan_audits WHERE workspace_id=${fx.workspaceId} AND harness_slug=${harness} AND plan_slug=${slug}`;
    expect(count).toBe(1);
  });
  it('previews without writes and stores honest non-ready results without inventing approval', async () => {
    expect(await recordCurrentDiscoveryAudit({ ...input(), dryRun: true }, { context })).toMatchObject({ ok: true, preview: true });
    const unknown = async () => ({ ...await context(), evidence: [] });
    expect(await recordCurrentDiscoveryAudit(input(), { context: unknown })).toMatchObject({ ok: true, discovery: { readiness: { ready: false, state: 'unknown' } } });
    const [{ count }] = await fx.admin`SELECT count(*)::int AS count FROM harness_shared.plan_audits WHERE workspace_id=${fx.workspaceId} AND harness_slug=${harness} AND plan_slug=${slug}`;
    expect(count).toBe(1);
  });
  it('refuses moved evidence at the accepting boundary with zero audit effects', async () => {
    let calls = 0;
    const moving = async () => { const value = await context(); value.evidence[0]!.fingerprint = String(++calls); return value; };
    expect(await recordCurrentDiscoveryAudit(input(), { context: moving })).toMatchObject({ ok: false, error: 'discovery_subject_moved' });
    const [{ count }] = await fx.admin`SELECT count(*)::int AS count FROM harness_shared.plan_audits WHERE workspace_id=${fx.workspaceId} AND harness_slug=${harness} AND plan_slug=${slug}`;
    expect(count).toBe(0);
  });
  it('refuses a missing matching revision rather than attaching stale provenance', async () => {
    await fx.admin`UPDATE harness_shared.harness_plans SET content=content || E'\nchanged' WHERE workspace_id=${fx.workspaceId} AND harness_slug=${harness} AND plan_slug=${slug}`;
    expect(await recordCurrentDiscoveryAudit(input(), { context })).toMatchObject({ ok: false, error: 'plan_revision_unavailable' });
  });
  it('reopens only the affected finding and cannot launder changed evidence through repeated finalization', async () => {
    let fingerprint = 'a'.repeat(64);
    const measured = async () => ({ ...await context(), evidence: [{ ...((await context()).evidence[0]!), fingerprint }] });
    await recordCurrentDiscoveryAudit(input(), { context: measured });
    fingerprint = 'b'.repeat(64);
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(await recordCurrentDiscoveryAudit(input(), { context: measured })).toMatchObject({ ok: true,
        discovery: { readiness: { ready: false, blockers: [expect.objectContaining({ path: 'findings.F-1' })] } } });
    }
    let effects = 0;
    expect(await withCurrentDiscovery(input(), async () => ++effects, { context: measured })).toMatchObject({ ok: false, error: 'discovery_not_ready' });
    expect(effects).toBe(0);
    fingerprint = 'a'.repeat(64);
    expect(await recordCurrentDiscoveryAudit(input(), { context: measured })).toMatchObject({ ok: true, reused: true });
    expect(await withCurrentDiscovery(input(), async () => 'original observed basis', { context: measured })).toMatchObject({ ok: true });
    fingerprint = 'b'.repeat(64);
    await revision(draft.replace('Reuse the existing helper at the missing caller.', 'The changed helper still covers the caller; adopt its new argument contract.'));
    expect(await recordCurrentDiscoveryAudit(input(), { context: measured })).toMatchObject({ ok: true, discovery: { readiness: { ready: true } } });
    expect(await withCurrentDiscovery(input(), async () => ++effects, { context: measured })).toMatchObject({ ok: true, result: 1 });
  });
  it('retains applicable provenance across unrelated edits but refuses changed target semantics without a new judgment', async () => {
    await recordCurrentDiscoveryAudit(input(), { context });
    await revision(draft + '\n## Notes\nUnrelated operational note.\n');
    expect(await withCurrentDiscovery(input(), async (_tx, subject) => subject.version, { context })).toMatchObject({ ok: true });
    await revision(draft.replace('Wire the existing helper', 'Replace the helper with a new behavior'));
    expect(await withCurrentDiscovery(input(), async () => 'must not run', { context })).toMatchObject({ ok: false,
      discovery: { readiness: { blockers: [expect.objectContaining({ code: 'discovery_change_unsupported', path: 'findings.F-1' })] } } });
  });
  it('reopens affected questions while preserving a separate finding and its original evidence basis', async () => {
    const scoped = { notApplicable: null, questions: [
      { id: 'Q-1', kind: 'current-behavior', question: 'What already works?', stopCondition: 'Read the helper.', outcome: 'answered' },
      { id: 'Q-2', kind: 'gap', question: 'Where is the caller gap?', stopCondition: 'Trace the caller.', outcome: 'answered' },
      { id: 'Q-3', kind: 'feasibility', question: 'Does the second helper cover the other caller?', stopCondition: 'Read the second helper.', outcome: 'answered' },
    ], findings: [
      { ...declaration.findings[0], questions: ['Q-1', 'Q-2'] },
      { id: 'F-2', questions: ['Q-3'], conclusion: 'The separate helper covers the second caller.', evidenceRefs: ['source:other.ts'],
        dispositions: [{ target: 'P-002', decision: 'reuse', reason: 'The current second helper covers it.' }] },
    ] };
    await revision(draft.replace(JSON.stringify(declaration), JSON.stringify(scoped)) + '\n- **P-002** `todo` Wire the second helper\n');
    let changed = false;
    const scopedContext = async (): Promise<DiscoveryAuditContext> => ({ targets: [
      { ref: 'P-001', change: 'proposed' }, { ref: 'P-002', change: 'proposed' }], evidence: [
      { ref: 'source:helper.ts', state: 'current', usable: true, fingerprint: changed ? 'b' : 'a' },
      { ref: 'source:other.ts', state: 'current', usable: true, fingerprint: 'other' },
    ] });
    const first = await recordCurrentDiscoveryAudit(input(), { context: scopedContext });
    const reordered = { ...scoped, questions: [...scoped.questions].reverse(), findings: [...scoped.findings]
      .reverse().map(finding => ({ ...finding, questions: [...finding.questions].reverse() })) };
    await revision(draft.replace(JSON.stringify(declaration), JSON.stringify(reordered)) + '\n- **P-002** `todo` Wire the second helper\n');
    expect(await recordCurrentDiscoveryAudit(input(), { context: scopedContext })).toMatchObject({ ok: true, reused: true });
    changed = true;
    const stale = await recordCurrentDiscoveryAudit(input(), { context: scopedContext });
    expect(stale).toMatchObject({ ok: true, discovery: { readiness: { ready: false, reopenedQuestions: ['Q-1', 'Q-2'] } } });
    if (!first.ok || !stale.ok) throw new Error('fixture finalization failed');
    expect(stale.discovery.findings?.['F-2']).toEqual(first.discovery.findings?.['F-2']);
  });
  it('requires finalization and refuses evidence moving immediately before an accepting effect', async () => {
    let accepted = 0;
    expect(await withCurrentDiscovery(input(), async () => ++accepted, { context })).toMatchObject({ ok: false, error: 'discovery_not_ready' });
    await recordCurrentDiscoveryAudit(input(), { context });
    let reads = 0;
    const moving = async () => { const value = await context(); if (++reads === 2) value.evidence[0]!.fingerprint = 'b'.repeat(64); return value; };
    expect(await withCurrentDiscovery(input(), async () => ++accepted, { context: moving })).toMatchObject({ ok: false, error: 'discovery_subject_moved' });
    expect(accepted).toBe(0);
  });
  it('retains source observations after trail expiry and rechecks current bytes instead of trusting a stale graph', async () => {
    const root = await mkdtemp(join(tmpdir(), 'discovery-source-'));
    try {
      await writeFile(join(root, 'helper.ts'), 'export const helper = 1;\n');
      await persistResearchBatch({ workspace: fx.workspaceId, owner: input().createdBy, harness, client: 'codex', calls: [] },
        [{ kind: 'path', requested: 'helper.ts', path: 'helper.ts', seenAt: Date.now() }]);
      const resolver: NonNullable<Parameters<typeof recordCurrentDiscoveryAudit>[1]>['context'] = (content, previous, prior, historicalTargets) =>
        resolveDiscoveryAuditContext(content, previous, { repoRoot: root, workspaceId: fx.workspaceId, sql: fx.admin,
          harnessSlug: harness, ownerId: input().createdBy, planSlug: slug, prior, historicalTargets });
      expect(await recordCurrentDiscoveryAudit(input(), { context: resolver })).toMatchObject({ ok: true, discovery: { readiness: { ready: true } } });
      await fx.admin`DELETE FROM harness_shared.code_intel_research_trails WHERE workspace_id=${fx.workspaceId} AND owner_id=${input().createdBy} AND harness_slug=${harness}`;
      expect(await withCurrentDiscovery(input(), async () => 'retained source', { context: resolver })).toMatchObject({ ok: true, result: 'retained source' });
      await writeFile(join(root, 'helper.ts'), 'export const helper = 2;\n');
      expect(await withCurrentDiscovery(input(), async () => 'must not run', { context: resolver })).toMatchObject({ ok: false, discovery: { readiness: { ready: false } } });
      // Removing the source is unknown; an old graph/trail cannot establish absence.
      await rm(join(root, 'helper.ts'));
      expect(await withCurrentDiscovery(input(), async () => 'must not run', { context: resolver })).toMatchObject({ ok: false, discovery: { readiness: { state: 'unknown' } } });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('resolves removals from earlier canonical revisions across intermediate bookkeeping edits', async () => {
    await revision(draft + '\n- **P-002** `todo` Speculative duplicate work\n');
    await revision(draft + '\n## Notes\nDuplicate removed.\n');
    const removed = JSON.parse(JSON.stringify(declaration));
    removed.findings[0].dispositions.push({ target: 'P-002', decision: 'remove', reason: 'The existing helper makes this work unnecessary.' });
    await revision(draft.replace(JSON.stringify(declaration), JSON.stringify(removed)));
    const selected = async (content: string, _previous: string | null, _prior?: unknown, historical?: Record<string, string>): Promise<DiscoveryAuditContext> => ({
      ...await context(), targets: [{ ref: 'P-001', change: 'proposed' },
        ...(historical?.['P-002'] ? [{ ref: 'P-002', change: 'removed' as const }] : [])],
    });
    expect(await recordCurrentDiscoveryAudit(input(), { context: selected })).toMatchObject({ ok: true, discovery: { removedTargets: ['P-002'], readiness: { ready: true } } });
    await revision(draft.replace(JSON.stringify(declaration), JSON.stringify(removed)) + '\n## Notes\nLater bookkeeping.\n');
    expect(await withCurrentDiscovery(input(), async () => 'recorded removal', { context: selected })).toMatchObject({ ok: true });
  });
});
