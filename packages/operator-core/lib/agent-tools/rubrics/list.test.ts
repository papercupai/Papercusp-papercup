/**
 * list.test.ts — rubrics:list summary-row truthfulness (EI-18747374149839438).
 *
 * rubrics:list returns SUMMARY rows (criteriaCount, not the full criteria array) —
 * rubrics:get is for the full body. This pins the recurrence guard that bug asked
 * for: for a rubric with N>0 criteria, the summary row (a) reports
 * criteriaCount === N and (b) never carries a bare `criteria` field a caller could
 * compute `(criteria || []).length` against and get a lying 0 — the exact failure
 * mode that nearly steered the Mug into deprecating two real, fully-authored
 * rubrics (dumb-agent-execution, stretch-discipline) as if their standard didn't
 * exist.
 *
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/rubrics/list.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../coordination/identity', () => ({ resolveAgentIdentity: () => ({ ownerId: 'me' }) }));
vi.mock('../../rubrics', () => ({ listRubricsPage: vi.fn() }));

import { listRubricsPage } from '../../rubrics';
import type { Rubric } from '../../rubrics';
const listPageM = vi.mocked(listRubricsPage);

const listTool = (await import('./list')).default;

const bodyOf = async (args: unknown) => {
  const out = (await listTool.handler(args as never, {} as never)) as { content: Array<{ text: string }> };
  return JSON.parse(out.content[0].text);
};

/** A correctly-typed `Rubric` fixture, so page results need no cast (lint:mock-cast-escape). */
const rubric = (rubricId: string, criteriaCount: number): Rubric => ({
  rubricId,
  workspaceId: 'default',
  kind: 'standard',
  gradingAuthority: 'independent',
  characteristic: 'agent-execution',
  title: rubricId,
  description: '',
  criteria: Array.from({ length: criteriaCount }, (_, i) => ({
    key: `c${i}`,
    title: `c${i}`,
    model: '',
    method: '',
    driftMarkers: '',
  })),
  ratingScale: ['healthy', 'degraded', 'broken', 'unknown'],
  methodRef: null,
  status: 'active',
  createdBy: null,
  proposedBy: null,
  ratifiedBy: null,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
});

beforeEach(() => vi.clearAllMocks());

describe('rubrics:list — judge read access', () => {
  it('allows the evidence-only judge role to discover rubric refs', () => {
    expect(listTool.agentRoles).toContain('judge');
  });
});

describe('rubrics:list — criteriaCount truthfulness', () => {
  it('a fully-authored rubric (N>0 criteria) reports criteriaCount === N, never 0', async () => {
    listPageM.mockResolvedValue({
      rubrics: [rubric('dumb-agent-execution', 6), rubric('stretch-discipline', 4)],
      hasMore: false,
      nextOffset: null,
    });
    const b = await bodyOf({});
    expect(b.ok).toBe(true);
    expect(b.rubrics.map((r: { rubricId: string; criteriaCount: number }) => [r.rubricId, r.criteriaCount])).toEqual([
      ['dumb-agent-execution', 6],
      ['stretch-discipline', 4],
    ]);
  });

  it('the summary row never carries a bare `criteria` field a caller could compute (criteria||[]).length against', async () => {
    listPageM.mockResolvedValue({ rubrics: [rubric('has-criteria', 6)], hasMore: false, nextOffset: null });
    const b = await bodyOf({});
    expect(b.rubrics[0]).not.toHaveProperty('criteria');
    // the only criteria-shaped surface on a summary row is the truthful scalar
    expect(b.rubrics[0].criteriaCount).toBe(6);
  });

  it('a genuinely criteria-less (draft) rubric still reports 0 honestly', async () => {
    listPageM.mockResolvedValue({ rubrics: [rubric('empty-draft', 0)], hasMore: false, nextOffset: null });
    const b = await bodyOf({});
    expect(b.rubrics[0].criteriaCount).toBe(0);
  });
});

describe('rubrics:list — offset pagination', () => {
  it('exposes page size and continuation metadata, and forwards the offset', async () => {
    listPageM.mockResolvedValue({
      rubrics: [rubric('page-two', 2)],
      hasMore: true,
      nextOffset: 1000,
    });

    const b = await bodyOf({ status: 'active', limit: 500, offset: 500 });

    expect(b).toMatchObject({ ok: true, count: 1, hasMore: true, nextOffset: 1000 });
    expect(b.rubrics.map((r: { rubricId: string }) => r.rubricId)).toEqual(['page-two']);
    expect(listPageM).toHaveBeenCalledWith(expect.objectContaining({ status: 'active', limit: 500, offset: 500 }));
  });

  it('accepts zero and refuses negative offsets', () => {
    expect(listTool.args.safeParse({ offset: 0 }).success).toBe(true);
    expect(listTool.args.safeParse({ offset: -1 }).success).toBe(false);
  });
});

// EI-22084090899431625 — a recurring tool-call failure: many agent sessions independently
// guessed subjectPlan/plan/harness/ref as a way to scope rubrics:list to "the acceptance
// rubric for the plan I'm working on" (harness_shared.tool_invocations shows 20+ distinct
// occurrences over ~36h). subjectPlan is now a real filter; harness stays unsupported (rubrics
// are workspace-global) and is documented as such directly on the tool.
describe('rubrics:list — subjectPlan filter (EI-22084090899431625)', () => {
  it('threads subjectPlan through to listRubrics and infers kind:"acceptance" when kind is omitted', async () => {
    listPageM.mockResolvedValue({ rubrics: [], hasMore: false, nextOffset: null });
    await bodyOf({ subjectPlan: 'my-plan-2026-09-01' });
    expect(listPageM).toHaveBeenCalledWith(
      expect.objectContaining({ subjectPlan: 'my-plan-2026-09-01', kind: 'acceptance' }),
    );
  });

  it('respects an explicit kind:"any" alongside subjectPlan instead of overriding it', async () => {
    listPageM.mockResolvedValue({ rubrics: [], hasMore: false, nextOffset: null });
    await bodyOf({ subjectPlan: 'my-plan-2026-09-01', kind: 'any' });
    expect(listPageM).toHaveBeenCalledWith(expect.objectContaining({ subjectPlan: 'my-plan-2026-09-01', kind: 'any' }));
  });

  it('omits kind from the listRubrics call when neither kind nor subjectPlan is given (preserves the default)', async () => {
    listPageM.mockResolvedValue({ rubrics: [], hasMore: false, nextOffset: null });
    await bodyOf({});
    const call = listPageM.mock.calls[0]?.[0];
    expect(call).not.toHaveProperty('kind');
  });

  it('schema: refuses subjectPlan combined with an explicit kind:"standard" — the only contradictory combination', () => {
    const parsed = listTool.args.safeParse({ subjectPlan: 'my-plan', kind: 'standard' });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues[0]?.message).toMatch(/subjectPlan filters ACCEPTANCE rubrics only/);
    }
  });

  it('schema: accepts subjectPlan with kind omitted (inference happens in the handler, not the schema)', () => {
    expect(listTool.args.safeParse({ subjectPlan: 'my-plan' }).success).toBe(true);
  });

  it('schema: still refuses an unrecognized `harness` key — rubrics are workspace-global, not harness-scoped', () => {
    const parsed = listTool.args.safeParse({ harness: 'papercusp' });
    expect(parsed.success).toBe(false);
  });
});
