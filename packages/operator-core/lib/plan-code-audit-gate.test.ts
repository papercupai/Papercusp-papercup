/**
 * plan-code-audit-gate.test.ts — plan-item completion + per-item audit freshness
 * (P-004/P-005).
 *
 * The rubric/vetting family has a separate suite. These tests pin the earlier
 * code-truth family: a narrow audit pass must not erase older item evidence, and
 * only the items whose requirement or cited bytes moved are sent back for audit.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { FLAGS } from '@papercusp/flags';
import { getFlag } from '@papercusp/flags/server';
import { getOrgPg } from '@papercusp/db-org';
import { evaluatePlanAcceptanceGate } from './plan-acceptance-gate';
import { getAcceptanceRubricsForPlan } from './rubrics';
import { readAndEvaluateAcceptanceBarLifecycle } from './acceptance-bar-lifecycle-evaluator';
import { listSpecClauses, type SpecClauseRevision } from './agent-tools/plans/spec-clauses-store';
import {
  getEffectiveItemAudits,
  getLatestActivationAudit,
  getLatestPlanAudit,
  getPlanItemStatuses,
  gitBlobSha,
  planItemTextHash,
  repoCitationContextForHarness,
  repoCitationDeps,
  type ActivationAuditMapping,
  type AuditItemEntry,
  type EffectiveItemAudit,
  type PlanAudit,
} from './plan-audits';

vi.mock('@papercusp/flags/server', () => ({ getFlag: vi.fn() }));
// Git-backed fixture assertions must not start the operator's shared sidecar.
vi.mock('./fleet/git-via-sidecar', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./fleet/git-via-sidecar')>()),
  gitSidecarEnabled: () => false,
}));
vi.mock('@papercusp/db-org', async (orig) => ({ ...(await orig<typeof import('@papercusp/db-org')>()), getOrgPg: vi.fn() }));
vi.mock('./workspace-registry', () => ({ activeWorkspaceId: () => 'test-ws' }));
vi.mock('./rubrics', () => ({
  getAcceptanceRubricsForPlan: vi.fn(),
  getRubric: vi.fn(),
  getRubricPlanRevision: vi.fn(),
  // EI-21827040531672903: the gate reads the revision through the ok/failed-aware
  // reader now. This suite's subject is the code-truth family, so the default is a
  // SUCCESSFUL read of an unversioned rubric — the shape that leaves the vetting
  // block's behaviour exactly as it was before that change.
  readRubricPlanRevision: vi.fn(async () => ({ ok: true, revision: null })),
  META_ACCEPTANCE_RUBRIC_ID: 'meta-acceptance-rubric',
}));
vi.mock('./scorecards', () => ({ listScorecards: vi.fn() }));
vi.mock('./acceptance-bar-lifecycle-evaluator', () => ({ readAndEvaluateAcceptanceBarLifecycle: vi.fn() }));
// These later doors have their own suites; a positive harness identity below
// must not make this code-truth regression depend on an unrelated review record.
vi.mock('./blind-review-gate', () => ({ evaluateBlindReviewGate: vi.fn(async () => ({
  satisfied: true, applicable: false, acceptedReviewIds: [], rejectedReviews: [], undispositionedGaps: [],
})) }));
vi.mock('./independent-verification-gate', () => ({ evaluateIndependentVerificationGate: vi.fn(async () => ({
  satisfied: true, applicable: false, inScope: 0, gaps: [],
})) }));
vi.mock('./agent-tools/plans/spec-clauses-store', async (orig) => ({
  ...(await orig<typeof import('./agent-tools/plans/spec-clauses-store')>()), listSpecClauses: vi.fn(),
}));
vi.mock('./plan-audits', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./plan-audits')>();
  return {
    ...actual,
    getEffectiveItemAudits: vi.fn(),
    getLatestActivationAudit: vi.fn(),
    getLatestPlanAudit: vi.fn(),
    getPlanItemStatuses: vi.fn(),
    repoCitationContextForHarness: vi.fn(),
  };
});

const mockFlag = vi.mocked(getFlag);
const mockPg = vi.mocked(getOrgPg);
const mockRubric = vi.mocked(getAcceptanceRubricsForPlan);
const mockLatestAudit = vi.mocked(getLatestPlanAudit);
const mockEffectiveAudits = vi.mocked(getEffectiveItemAudits);
const mockPlanItems = vi.mocked(getPlanItemStatuses);
const mockCitationContext = vi.mocked(repoCitationContextForHarness);
const mockActivationAudit = vi.mocked(getLatestActivationAudit);

const PLAN = 'some-plan-2026-08-13';
let files: Map<string, string>;

const sqlReturning = (rows: unknown[]) => {
  const sql = (() => Promise.resolve(rows)) as unknown as ReturnType<typeof getOrgPg>['sql'];
  return { sql } as ReturnType<typeof getOrgPg>;
};

const audit = (over: Partial<PlanAudit> = {}): PlanAudit => ({
  planSlug: PLAN,
  harnessSlug: 'papercusp',
  auditSeq: 2,
  createdBy: 'su-implementer',
  createdAt: '2026-08-13T12:00:00.000Z',
  auditKind: 'completion',
  auditedSha: 'head-2',
  activation: null,
  auditedPlanRevision: null,
  items: [],
  findings: [],
  summary: null,
  ...over,
});

const effective = (input: {
  itemId: string;
  itemText: string;
  path?: string;
  body?: string;
  auditSeq?: number;
  status?: AuditItemEntry['verdict'];
}): EffectiveItemAudit => {
  const path = input.path ?? `src/${input.itemId.toLowerCase().replace('-', '_')}.ts`;
  const body = input.body ?? files.get(path) ?? `export const ${input.itemId.replace('-', '_')} = true;\n`;
  return {
    auditSeq: input.auditSeq ?? 1,
    entry: {
      itemId: input.itemId,
      verdict: input.status ?? 'implemented',
      citations: [{ kind: 'code', path, blobSha: gitBlobSha(body) }],
      auditedSha: `head-${input.auditSeq ?? 1}`,
      auditedAt: '2026-08-13T11:00:00.000Z',
      itemTextHash: planItemTextHash(input.itemText),
    },
  };
};

beforeEach(() => {
  vi.resetAllMocks();
  files = new Map([
    ['src/p_001.ts', 'export const P_001 = true;\n'],
    ['src/p_002.ts', 'export const P_002 = true;\n'],
  ]);

  // Isolate the code-audit family: audit ON, item/rubric/vetting gates OFF.
  mockFlag.mockImplementation(async (flag) => flag === FLAGS.PLAN_CODE_AUDIT_GATE);
  mockPg.mockReturnValue(sqlReturning([{ plan_slug: PLAN, template: null, template_slug: null }]));
  mockLatestAudit.mockResolvedValue(audit());
  mockEffectiveAudits.mockResolvedValue([]);
  mockPlanItems.mockResolvedValue([]);
  vi.mocked(readAndEvaluateAcceptanceBarLifecycle).mockResolvedValue({
    phase: 'ship', applicable: false, satisfied: true, codes: [], blockingBars: [], contractCodes: [], codeAttribution: [], nextRepair: null, staleGradingScorecardId: null, message: null,
  });
  // P-014 default: no activation audit, so the requirement-realization join is
  // inert. Every pre-P-014 case therefore keeps its original meaning.
  mockActivationAudit.mockResolvedValue(null);
  vi.mocked(listSpecClauses).mockResolvedValue([]);
  mockCitationContext.mockImplementation(async () => ({
    repoRoot: '/repo',
    rootSource: 'registry' as const,
    deps: {
      statFile: (rel) => (files.has(rel) ? { isFile: true } : null),
      readFile: (rel) => files.get(rel) ?? null,
      blobSha: (rel) => {
        const body = files.get(rel);
        return body == null ? null : gitBlobSha(body);
      },
    },
  }));
});

describe('evaluatePlanAcceptanceGate — plan-item completion', () => {
  it.each(['todo', 'wip', 'blocked', 'needs-human'])(
    "refuses an unfinished item in status '%s' before reading the audit or rubric families",
    async (status) => {
      mockFlag.mockImplementation(async (flag) => flag === FLAGS.PLAN_ITEM_COMPLETION_GATE);
      mockPlanItems.mockResolvedValue([{ itemId: 'P-001', status, itemText: 'unfinished requirement' }]);

      const verdict = await evaluatePlanAcceptanceGate(PLAN);

      expect(verdict).toMatchObject({ satisfied: false, code: 'plan_items_unfinished' });
      expect(verdict.message).toContain(`P-001 (${status})`);
      expect(verdict.message).toContain("status:'dropped'");
      expect(mockLatestAudit).not.toHaveBeenCalled();
      expect(mockRubric).not.toHaveBeenCalled();
    },
  );

  it.each(['done', 'dropped'])("treats terminal status '%s' as complete", async (status) => {
    mockFlag.mockImplementation(async (flag) => flag === FLAGS.PLAN_ITEM_COMPLETION_GATE);
    mockPlanItems.mockResolvedValue([{ itemId: 'P-001', status, itemText: 'terminal requirement' }]);

    const verdict = await evaluatePlanAcceptanceGate(PLAN);

    expect(verdict).toMatchObject({ satisfied: true, skipped: 'flag-off' });
    expect(mockLatestAudit).not.toHaveBeenCalled();
    expect(mockRubric).not.toHaveBeenCalled();
  });

  // WI-10005167: plan_items is keyed per (harness, slug), so the gate must read the items of
  // the plan row it selected, not every harness's plan that shares the slug.
  it("reads plan items scoped to the selected plan row's own harness", async () => {
    mockFlag.mockImplementation(async (flag) => flag === FLAGS.PLAN_ITEM_COMPLETION_GATE);
    mockPg.mockReturnValue(sqlReturning([{ plan_slug: PLAN, harness_slug: 'email', template: null, template_slug: null }]));
    mockPlanItems.mockResolvedValue([{ itemId: 'P-001', status: 'done', itemText: 'terminal requirement' }]);

    await evaluatePlanAcceptanceGate(PLAN);

    expect(mockPlanItems).toHaveBeenCalledWith(PLAN, { harnessSlug: 'email' });
  });

  it('keeps the item family independently killable without reading plan-item state', async () => {
    mockFlag.mockResolvedValue(false);
    mockPlanItems.mockResolvedValue([{ itemId: 'P-001', status: 'todo', itemText: 'unfinished requirement' }]);

    const verdict = await evaluatePlanAcceptanceGate(PLAN);

    expect(verdict).toMatchObject({ satisfied: true, skipped: 'flag-off' });
    expect(mockPlanItems).not.toHaveBeenCalled();
  });

  it('records a reasoned force past unfinished items when later gate families are off', async () => {
    mockFlag.mockImplementation(async (flag) => flag === FLAGS.PLAN_ITEM_COMPLETION_GATE);
    mockPlanItems.mockResolvedValue([{ itemId: 'P-001', status: 'blocked', itemText: 'blocked requirement' }]);

    const verdict = await evaluatePlanAcceptanceGate(PLAN, {
      force: { reason: 'documented release exception' },
    });

    expect(verdict).toMatchObject({
      satisfied: true,
      skipped: 'flag-off',
      forcedPast: {
        reason: 'documented release exception',
        checks: ['plan_items_unfinished'],
      },
    });
  });

  it('does not let an item-family force waive the independent rubric family', async () => {
    mockFlag.mockImplementation(
      async (flag) => flag === FLAGS.PLAN_ITEM_COMPLETION_GATE || flag === FLAGS.ACCEPTANCE_RUBRIC_COMPLETION_GATE,
    );
    mockPlanItems.mockResolvedValue([{ itemId: 'P-001', status: 'needs-human', itemText: 'unfinished requirement' }]);
    mockRubric.mockResolvedValue([]);

    const verdict = await evaluatePlanAcceptanceGate(PLAN, {
      force: { reason: 'waive code-truth checks only' },
    });

    expect(verdict).toMatchObject({ satisfied: false, code: 'acceptance_rubric_missing' });
  });
});

describe('evaluatePlanAcceptanceGate — per-item code audit freshness', () => {
  it('treats partial and missing audit verdicts as record-only when terminality and evidence are current', async () => {
    const partial = effective({ itemId: 'P-001', itemText: 'first requirement', status: 'partial' });
    const missing = effective({ itemId: 'P-002', itemText: 'second requirement', status: 'missing' });
    mockLatestAudit.mockResolvedValue(audit({ items: [partial.entry, missing.entry] }));
    mockEffectiveAudits.mockResolvedValue([partial, missing]);
    mockPlanItems.mockResolvedValue([
      { itemId: 'P-001', status: 'done', itemText: 'first requirement' },
      { itemId: 'P-002', status: 'done', itemText: 'second requirement' },
    ]);

    const verdict = await evaluatePlanAcceptanceGate(PLAN);

    expect(verdict).toMatchObject({ satisfied: true, skipped: 'flag-off' });
    expect(mockRubric).not.toHaveBeenCalled();
  });

  it('folds effective entries across partial passes instead of treating the latest pass as a snapshot', async () => {
    const p1 = effective({ itemId: 'P-001', itemText: 'first requirement', auditSeq: 1 });
    const p2 = effective({ itemId: 'P-002', itemText: 'second requirement', auditSeq: 2 });
    mockLatestAudit.mockResolvedValue(audit({ items: [p2.entry] }));
    mockEffectiveAudits.mockResolvedValue([p2, p1]);
    mockPlanItems.mockResolvedValue([
      { itemId: 'P-001', status: 'done', itemText: 'first requirement' },
      { itemId: 'P-002', status: 'done', itemText: 'second requirement' },
    ]);

    const verdict = await evaluatePlanAcceptanceGate(PLAN);

    expect(verdict).toMatchObject({ satisfied: true, skipped: 'flag-off' });
    expect(mockRubric).not.toHaveBeenCalled();
  });

  it('names only a new/uncovered item and teaches that every other item carries forward', async () => {
    const p1 = effective({ itemId: 'P-001', itemText: 'first requirement' });
    mockEffectiveAudits.mockResolvedValue([p1]);
    mockPlanItems.mockResolvedValue([
      { itemId: 'P-001', status: 'done', itemText: 'first requirement' },
      { itemId: 'P-002', status: 'done', itemText: 'new requirement' },
    ]);

    const verdict = await evaluatePlanAcceptanceGate(PLAN);

    expect(verdict).toMatchObject({ satisfied: false, code: 'audit_coverage_stale' });
    expect(verdict.message).toContain('P-002: no audit entry');
    expect(verdict.message).not.toContain('P-001:');
    expect(verdict.message).toContain('ONLY the listed items');
    expect(verdict.message).toContain('Every unlisted item carries forward');
    expect(mockRubric).not.toHaveBeenCalled();
  });

  it('marks only an item whose requirement text changed', async () => {
    mockEffectiveAudits.mockResolvedValue([effective({ itemId: 'P-001', itemText: 'old requirement', auditSeq: 1 })]);
    mockPlanItems.mockResolvedValue([{ itemId: 'P-001', status: 'done', itemText: 'new requirement' }]);

    const verdict = await evaluatePlanAcceptanceGate(PLAN);

    expect(verdict).toMatchObject({ satisfied: false, code: 'audit_coverage_stale' });
    expect(verdict.message).toContain('P-001: item text changed since audit #1');
  });

  it('ignores a mutable set-status reflection note when checking item-text freshness', async () => {
    const p1 = effective({ itemId: 'P-001', itemText: 'first requirement', auditSeq: 1 });
    mockEffectiveAudits.mockResolvedValue([p1]);
    mockPlanItems.mockResolvedValue([
      {
        itemId: 'P-001',
        status: 'done',
        itemText: 'first requirement — note: reflected from EI-21907088033648683',
      },
    ]);

    const verdict = await evaluatePlanAcceptanceGate(PLAN);

    expect(verdict).toMatchObject({ satisfied: true, skipped: 'flag-off' });
    expect(verdict.code).not.toBe('audit_coverage_stale');
  });

  it('accepts a legacy raw item-text hash after the note-normalization change', async () => {
    const itemText = 'first requirement — note: reflected from EI-21907088033648683';
    const p1 = effective({ itemId: 'P-001', itemText: 'first requirement', auditSeq: 1 });
    p1.entry.itemTextHash = createHash('sha256').update(itemText).digest('hex');
    mockEffectiveAudits.mockResolvedValue([p1]);
    mockPlanItems.mockResolvedValue([{ itemId: 'P-001', status: 'done', itemText }]);

    const verdict = await evaluatePlanAcceptanceGate(PLAN);

    expect(verdict).toMatchObject({ satisfied: true, skipped: 'flag-off' });
    expect(verdict.code).not.toBe('audit_coverage_stale');
  });

  it('marks a resolving citation stale when its current blob differs from the audited blob', async () => {
    const p1 = effective({
      itemId: 'P-001',
      itemText: 'first requirement',
      path: 'src/p_001.ts',
      body: files.get('src/p_001.ts'),
      auditSeq: 1,
    });
    files.set('src/p_001.ts', 'export const P_001 = "rewritten";\n');
    mockEffectiveAudits.mockResolvedValue([p1]);
    mockPlanItems.mockResolvedValue([{ itemId: 'P-001', status: 'done', itemText: 'first requirement' }]);

    const verdict = await evaluatePlanAcceptanceGate(PLAN);

    expect(verdict).toMatchObject({ satisfied: false, code: 'audit_coverage_stale' });
    expect(verdict.message).toContain('P-001: src/p_001.ts changed since audit #1');
  });

  it('refuses a resolved citation without its audit-time fingerprint and names the audit sequence', async () => {
    const p1 = effective({ itemId: 'P-001', itemText: 'first requirement', auditSeq: 7 });
    mockEffectiveAudits.mockResolvedValue([p1]);
    mockPlanItems.mockResolvedValue([{ itemId: 'P-001', status: 'done', itemText: 'first requirement' }]);

    expect(await evaluatePlanAcceptanceGate(PLAN)).toMatchObject({ satisfied: true });

    delete p1.entry.citations[0].blobSha;
    const verdict = await evaluatePlanAcceptanceGate(PLAN);

    expect(verdict).toMatchObject({ satisfied: false, code: 'audit_coverage_stale' });
    expect(verdict.message).toContain('P-001: src/p_001.ts has no audit-time blob fingerprint (audit #7)');
  });

  // proof-freshness-pinned-candidate-2026-10-06 P-019 (D-001): with a real repository the
  // gate measures cited blobs at the committed HEAD (M), so a peer's uncommitted edit no
  // longer stales a shipped audit, while committing that edit does.
  it('measures cited blobs at the committed HEAD: uncommitted edits do not stale, commits do', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-gate-measure-'));
    const git = (...args: string[]) =>
      execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const cited = path.join(root, 'src', 'p_001.ts');
    const audited = 'export const P_001 = true;\n';
    try {
      fs.mkdirSync(path.dirname(cited), { recursive: true });
      fs.writeFileSync(cited, audited);
      git('init', '-q');
      git('config', 'user.email', 'gate-test@example.com');
      git('config', 'user.name', 'Gate Test');
      git('add', '--', 'src/p_001.ts');
      git('commit', '-qm', 'audited bytes');
      mockCitationContext.mockImplementation(async () => ({
        repoRoot: root,
        rootSource: 'registry' as const,
        deps: repoCitationDeps(root),
      }));
      mockEffectiveAudits.mockResolvedValue([
        effective({ itemId: 'P-001', itemText: 'first requirement', path: 'src/p_001.ts', body: audited }),
      ]);
      mockPlanItems.mockResolvedValue([{ itemId: 'P-001', status: 'done', itemText: 'first requirement' }]);

      fs.writeFileSync(cited, 'export const P_001 = true; // peer, uncommitted\n');
      const uncommitted = await evaluatePlanAcceptanceGate(PLAN);
      expect(uncommitted.code).not.toBe('audit_coverage_stale');
      expect(uncommitted).toMatchObject({ satisfied: true });

      git('commit', '-qam', 'peer commits the edit');
      const head = git('rev-parse', 'HEAD').trim();
      const committed = await evaluatePlanAcceptanceGate(PLAN);
      expect(committed).toMatchObject({ satisfied: false, code: 'audit_coverage_stale' });
      expect(committed.message).toContain(`P-001: src/p_001.ts changed since audit #1 at commit ${head.slice(0, 12)}`);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps path-backed doc citations non-verifying but stale after a committed rewrite', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-gate-doc-measure-'));
    const git = (...args: string[]) =>
      execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const citedDoc = path.join(root, 'docs', 'guide.md');
    const auditedDoc = '# Audited guide\n';
    try {
      fs.mkdirSync(path.dirname(citedDoc), { recursive: true });
      fs.writeFileSync(citedDoc, auditedDoc);
      git('init', '-q');
      git('config', 'user.email', 'gate-test@example.com');
      git('config', 'user.name', 'Gate Test');
      git('add', '--', 'docs/guide.md');
      git('commit', '-qm', 'audited guide');
      const auditedSha = git('rev-parse', 'HEAD').trim();

      const entry: EffectiveItemAudit = {
        auditSeq: 1,
        entry: {
          itemId: 'P-001',
          verdict: 'not-code',
          note: 'This item delivers a guide.',
          citations: [{ kind: 'doc', path: 'docs/guide.md', blobSha: gitBlobSha(auditedDoc) }],
          auditedSha,
          auditedAt: '2026-08-13T11:00:00.000Z',
          itemTextHash: planItemTextHash('publish the guide'),
        },
      };
      mockCitationContext.mockResolvedValue({
        repoRoot: root,
        rootSource: 'registry',
        deps: repoCitationDeps(root),
      });
      mockEffectiveAudits.mockResolvedValue([entry]);
      mockPlanItems.mockResolvedValue([{ itemId: 'P-001', status: 'done', itemText: 'publish the guide' }]);

      fs.writeFileSync(citedDoc, '# Peer edit, not committed\n');
      const uncommitted = await evaluatePlanAcceptanceGate(PLAN);
      expect(uncommitted).toMatchObject({ satisfied: true });

      git('commit', '-qam', 'publish edited guide');
      const head = git('rev-parse', 'HEAD').trim();
      const committed = await evaluatePlanAcceptanceGate(PLAN);
      expect(committed).toMatchObject({ satisfied: false, code: 'audit_coverage_stale' });
      expect(committed.message).toContain(
        `P-001: docs/guide.md changed since audit #1 at commit ${head.slice(0, 12)}`,
      );
      expect(mockCitationContext).toHaveBeenCalledWith('papercusp', expect.any(Array));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps a deleted/broken path in audit_citations_unresolved rather than calling it blob drift', async () => {
    const p1 = effective({ itemId: 'P-001', itemText: 'first requirement', path: 'src/p_001.ts' });
    files.delete('src/p_001.ts');
    mockEffectiveAudits.mockResolvedValue([p1]);
    mockPlanItems.mockResolvedValue([{ itemId: 'P-001', status: 'done', itemText: 'first requirement' }]);

    const verdict = await evaluatePlanAcceptanceGate(PLAN);

    expect(verdict).toMatchObject({ satisfied: false, code: 'audit_citations_unresolved' });
    expect(verdict.message).toContain('P-001 (audit #1) → src/p_001.ts (file_not_found)');
    expect(verdict.message).toContain('ONLY the listed items');
  });

  it('treats a reopened item as stale even when its text and evidence are unchanged', async () => {
    const p1 = effective({ itemId: 'P-001', itemText: 'first requirement', auditSeq: 1 });
    mockEffectiveAudits.mockResolvedValue([p1]);
    mockPlanItems.mockResolvedValue([{ itemId: 'P-001', status: 'wip', itemText: 'first requirement' }]);

    const verdict = await evaluatePlanAcceptanceGate(PLAN);

    expect(verdict).toMatchObject({ satisfied: false, code: 'audit_coverage_stale' });
    expect(verdict.message).toContain("P-001: status 'wip' is unfinished/reopened since audit #1");
  });

  it('does not demand a source root for an explicitly non-source item with no code/test citation', async () => {
    const entry: EffectiveItemAudit = {
      auditSeq: 1,
      entry: {
        itemId: 'P-001',
        verdict: 'not-code',
        citations: [{ kind: 'doc', ref: '/internal/docs/demo', reason: 'the deliverable is a runbook' }],
        auditedSha: 'head-1',
        auditedAt: '2026-08-13T11:00:00.000Z',
        itemTextHash: planItemTextHash('publish the runbook'),
      },
    };
    mockEffectiveAudits.mockResolvedValue([entry]);
    mockPlanItems.mockResolvedValue([{ itemId: 'P-001', status: 'done', itemText: 'publish the runbook' }]);
    mockCitationContext.mockResolvedValue(null);

    const verdict = await evaluatePlanAcceptanceGate(PLAN);

    expect(verdict).toMatchObject({ satisfied: true, skipped: 'flag-off' });
    expect(mockCitationContext).not.toHaveBeenCalled();
  });

  it('force records both stale coverage and unresolved citations in refusal order', async () => {
    const p1 = effective({ itemId: 'P-001', itemText: 'old requirement', path: 'src/p_001.ts' });
    files.delete('src/p_001.ts');
    mockEffectiveAudits.mockResolvedValue([p1]);
    mockPlanItems.mockResolvedValue([{ itemId: 'P-001', status: 'done', itemText: 'new requirement' }]);

    const verdict = await evaluatePlanAcceptanceGate(PLAN, { force: { reason: 'release recovery' } });

    expect(verdict).toMatchObject({
      satisfied: true,
      skipped: 'flag-off',
      forcedPast: {
        reason: 'release recovery',
        // P-004 (D-009): the item's only code citation no longer resolves, so it also has no
        // resolving code evidence, and force records that third waived check too.
        checks: ['audit_coverage_stale', 'audit_citations_unresolved', 'code_deliverable_unverified'],
      },
    });
  });
});

/**
 * P-014 — the activation↔completion JOIN, at the gate level. The pure rules live in
 * plan-requirement-realization.test.ts; these cases prove the WIRING: that the gate
 * actually reads the activation audit, that a violation reaches the caller as
 * `requirement_unrealized`, including when a caller tries to force a shipment.
 */
describe('requirement_unrealized (the activation↔completion join)', () => {
  /** A covered mapping routed at P-001. */
  const activationAudit = (mappings: ActivationAuditMapping[]): PlanAudit =>
    audit({
      auditKind: 'activation',
      activation: {
        sourceRanges: [],
        mappings,
        repairedOmissions: [],
        rejectedOrSuperseded: [],
        unresolvedBlockers: [],
      },
    });

  const coveredAtP001 = (over: Partial<ActivationAuditMapping> = {}): ActivationAuditMapping => ({
    id: 'M-001',
    sourceRefs: ['session_turn:owner:s1:4'],
    requirement: 'the ship gate must read the activation audit',
    planTargets: ['P-001'],
    disposition: 'covered',
    ...over,
  });

  /** P-001, audited but with a doc citation only — explicitly NOT verification (D-008). */
  const docOnlyP001 = (): EffectiveItemAudit => ({
    auditSeq: 1,
    entry: {
      itemId: 'P-001',
      verdict: 'implemented',
      citations: [{ kind: 'doc', ref: 'internal/docs/x', reason: 'design note' }],
      auditedSha: 'head-1',
      auditedAt: '2026-08-13T11:00:00.000Z',
      itemTextHash: planItemTextHash('first requirement'),
    },
  });

  const itemDone = () => [{ itemId: 'P-001', status: 'done', itemText: 'first requirement' }];

  const exemption = (over: Partial<SpecClauseRevision> = {}): SpecClauseRevision => ({
    planSlug: PLAN, specId: 'P-001-consolidation-exempt', planItemId: 'P-001',
    sourceValId: null, sourceBar: null, currentRevision: 1, revision: 1,
    behavior: 'Each legacy request is disposed or assigned to a named owner.',
    behaviorClass: 'non-automated', lifecycleStatus: 'exempt',
    requiredEvidence: [], requiredTestLayers: [], mutationRequired: false, falsifier: null,
    exemption: { justification: 'Ledger bookkeeping changes no product behavior.', provenance: 'owner directive 1691' },
    supersedes: null, contentHash: 'a'.repeat(64), createdBy: 'author', createdAt: '2026-10-11T00:00:00Z',
    acceptedBy: null, acceptedAt: null, acceptanceRef: null, ...over,
  });

  it.each(['current', 'missing', 'read failure', 'behavioral sibling'])(
    'joins explicit inventory scope into the real ship gate: %s', async (scope) => {
      const entry = docOnlyP001();
      entry.entry.verdict = 'not-code';
      entry.entry.note = 'Verified the completed census against its exact completion record.';
      mockEffectiveAudits.mockResolvedValue([entry]);
      mockPlanItems.mockResolvedValue(itemDone());
      mockActivationAudit.mockResolvedValue(activationAudit([coveredAtP001()]));
      mockPg.mockReturnValue(sqlReturning([{ plan_slug: PLAN, harness_slug: 'papercusp', template: null, template_slug: null }]));
      if (scope === 'read failure') vi.mocked(listSpecClauses).mockRejectedValue(new Error('clause read unavailable'));
      else vi.mocked(listSpecClauses).mockResolvedValue(scope === 'missing' ? [] : [
        exemption(), ...(scope === 'behavioral sibling' ? [exemption({ specId: 'product-behavior', lifecycleStatus: 'active' })] : []),
      ]);
      const verdict = await evaluatePlanAcceptanceGate(PLAN);
      expect(verdict).toMatchObject(scope === 'current'
        ? { satisfied: true, skipped: 'flag-off' }
        : { satisfied: false, code: 'requirement_unrealized' });
      expect(listSpecClauses).toHaveBeenCalledWith({
        planSlug: PLAN, harnessSlug: 'papercusp', workspaceId: 'test-ws', planItemIds: ['P-001'],
      });
    },
  );

  it('joins current BAR proof into a reasoned non-code audit without treating the doc as code', async () => {
    const entry = docOnlyP001();
    entry.entry.verdict = 'not-code';
    entry.entry.note = 'This item verifies an operational outcome.';
    mockEffectiveAudits.mockResolvedValue([entry]);
    mockPlanItems.mockResolvedValue(itemDone());
    mockActivationAudit.mockResolvedValue(activationAudit([coveredAtP001()]));
    mockFlag.mockImplementation(async flag => flag === FLAGS.PLAN_CODE_AUDIT_GATE || flag === FLAGS.ACCEPTANCE_RUBRIC_COMPLETION_GATE);
    vi.mocked(readAndEvaluateAcceptanceBarLifecycle).mockResolvedValue({
      phase: 'ship', applicable: true, satisfied: true, codes: [], blockingBars: [], contractCodes: [], codeAttribution: [], nextRepair: null, staleGradingScorecardId: null, message: null,
      nonCodeItemProofs: [{ planItemId: 'P-001', barKeys: ['R-1'], evidenceRefs: ['probe:current'] }],
    });
    const current = [{ evidenceKind: 'operational' as const, evidenceRef: 'probe:current', sourceFingerprint: 'now' }];
    mockRubric.mockResolvedValue([]);
    const verdict = await evaluatePlanAcceptanceGate(PLAN, { current });
    expect(verdict.code).toBe('acceptance_rubric_missing');
    expect(readAndEvaluateAcceptanceBarLifecycle).toHaveBeenCalledWith(PLAN, 'ship', { expectedApplicable: false, current });
    expect(entry.entry.citations[0]!.kind).toBe('doc');
  });

  it('refuses when a covered requirement reached an item with no verifying citation', async () => {
    mockEffectiveAudits.mockResolvedValue([docOnlyP001()]);
    mockPlanItems.mockResolvedValue(itemDone());
    mockActivationAudit.mockResolvedValue(activationAudit([coveredAtP001()]));

    const verdict = await evaluatePlanAcceptanceGate(PLAN);

    expect(verdict).toMatchObject({ satisfied: false, code: 'requirement_unrealized' });
    expect(verdict.message).toContain('M-001');
    expect(verdict.message).toContain('P-001');
  });

  it('passes once that same item carries a verifying code citation', async () => {
    mockEffectiveAudits.mockResolvedValue([effective({ itemId: 'P-001', itemText: 'first requirement' })]);
    mockPlanItems.mockResolvedValue(itemDone());
    mockActivationAudit.mockResolvedValue(activationAudit([coveredAtP001()]));

    const verdict = await evaluatePlanAcceptanceGate(PLAN);

    expect(verdict.code).not.toBe('requirement_unrealized');
  });

  it('does not refuse for a requirement routed to a DECISION — decisions carry no item audit', async () => {
    mockEffectiveAudits.mockResolvedValue([]);
    mockPlanItems.mockResolvedValue([]);
    mockActivationAudit.mockResolvedValue(activationAudit([coveredAtP001({ planTargets: ['D-004'] })]));

    const verdict = await evaluatePlanAcceptanceGate(PLAN);

    expect(verdict.code).not.toBe('requirement_unrealized');
  });

  it('does not refuse for a rejected/open disposition — they claim no absorption', async () => {
    mockEffectiveAudits.mockResolvedValue([]);
    mockPlanItems.mockResolvedValue([]);
    mockActivationAudit.mockResolvedValue(
      activationAudit([coveredAtP001({ disposition: 'rejected' }), coveredAtP001({ id: 'M-002', disposition: 'open' })]),
    );

    const verdict = await evaluatePlanAcceptanceGate(PLAN);

    expect(verdict.code).not.toBe('requirement_unrealized');
  });

  it('refuses an unrealized requirement even when a leader calls it a future seam and forces shipment', async () => {
    mockEffectiveAudits.mockResolvedValue([docOnlyP001()]);
    mockPlanItems.mockResolvedValue(itemDone());
    mockActivationAudit.mockResolvedValue(activationAudit([coveredAtP001()]));

    const verdict = await evaluatePlanAcceptanceGate(PLAN, {
      force: { reason: 'D-045: the required capability is a tested seam; a follow-on plan will supply its consumer' },
    });

    expect(verdict).toMatchObject({ satisfied: false, code: 'requirement_unrealized' });
    expect(verdict.forcedPast).toBeUndefined();
    expect(verdict.message).not.toContain('To ship anyway');
  });
});
