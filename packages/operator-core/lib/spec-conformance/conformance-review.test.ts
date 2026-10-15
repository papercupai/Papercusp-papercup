/**
 * R-21 (spec-driven-tooling-integration-2026-10-05 P-030): conformance reviews are independent.
 * Falsifier: a plan implementer closes that plan's conformance-review work-item done.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  CONFORMANCE_REVIEW_ACTION,
  CONFORMANCE_REVIEW_IMPLEMENTER_REFUSAL,
  conformanceReviewClosureRefusal,
  conformanceReviewConditionKey,
  conformanceReviewFromPayload,
  fileConformanceReview,
  implementerConflicts,
  runConformanceReviewAction,
  type ConformanceReviewClosureDeps,
  type ConformanceReviewRecord,
  type FileConformanceReviewDeps,
  type ReviewFiling,
} from './conformance-review';
import { getSystemActionEntry, type SystemActionCtx } from '../harness/routines/system-actions';

const review = (excluded: string[] = ['su-builder']): ConformanceReviewRecord => ({
  planSlug: 'plan-a',
  harnessSlug: 'papercusp',
  excludedImplementers: excluded,
  filedAt: '2026-10-14T00:00:00.000Z',
});

const closureDeps = (opts: {
  current?: string[];
  lineage?: Record<string, string[]>;
  failImplementers?: boolean;
} = {}): ConformanceReviewClosureDeps => ({
  resolveImplementers: async () => {
    if (opts.failImplementers) throw new Error('acceptance_lineage_unreadable: boom');
    return opts.current ?? [];
  },
  lineageOf: async (id) => new Set([id, ...(opts.lineage?.[id] ?? [])]),
});

describe('conformanceReviewFromPayload', () => {
  it('reads the review record and normalises the excluded set', () => {
    const rec = conformanceReviewFromPayload({
      specConformanceReview: { planSlug: ' plan-a ', harnessSlug: 'papercusp', excludedImplementers: ['b', ' a ', 'b', 7], filedAt: 'x' },
    });
    expect(rec).toEqual({ planSlug: 'plan-a', harnessSlug: 'papercusp', excludedImplementers: ['a', 'b'], filedAt: 'x' });
  });

  it('is null for a work-item that is not a conformance review', () => {
    expect(conformanceReviewFromPayload(null)).toBeNull();
    expect(conformanceReviewFromPayload({ specConformance: { planSlug: 'plan-a' } })).toBeNull();
    expect(conformanceReviewFromPayload({ specConformanceReview: { planSlug: '', harnessSlug: 'h' } })).toBeNull();
    expect(conformanceReviewFromPayload({ specConformanceReview: [] })).toBeNull();
  });
});

describe('conformanceReviewClosureRefusal — the falsifier', () => {
  it('refuses a plan implementer closing the review', async () => {
    const out = await conformanceReviewClosureRefusal({ itemId: 'WI-1', review: review(['su-builder']), closer: 'su-builder' }, closureDeps());
    expect(out).toMatchObject({ code: CONFORMANCE_REVIEW_IMPLEMENTER_REFUSAL, reason: 'implementer', conflicts: ['su-builder'], planSlug: 'plan-a' });
    expect(out?.error).toContain(CONFORMANCE_REVIEW_IMPLEMENTER_REFUSAL);
  });

  it('refuses a closer in an implementer\'s spawn/rebind lineage', async () => {
    const out = await conformanceReviewClosureRefusal(
      { itemId: 'WI-1', review: review(['su-builder']), closer: 'su-child' },
      closureDeps({ lineage: { 'su-child': ['su-builder'] } }),
    );
    expect(out).toMatchObject({ reason: 'implementer', conflicts: ['su-builder'] });
  });

  it('refuses an implementer who joined the plan after the review was filed', async () => {
    const out = await conformanceReviewClosureRefusal(
      { itemId: 'WI-1', review: review([]), closer: 'su-late' },
      closureDeps({ current: ['su-late'] }),
    );
    expect(out).toMatchObject({ reason: 'implementer', conflicts: ['su-late'] });
  });

  it('lets an independent reviewer close', async () => {
    const out = await conformanceReviewClosureRefusal(
      { itemId: 'WI-1', review: review(['su-builder']), closer: 'su-reviewer' },
      closureDeps({ current: ['su-builder', 'su-other'], lineage: { 'su-reviewer': ['su-sibling-parent'] } }),
    );
    expect(out).toBeNull();
  });

  it('fails closed on an unattributed closer', async () => {
    const out = await conformanceReviewClosureRefusal({ itemId: 'WI-1', review: review(), closer: '  ' }, closureDeps());
    expect(out).toMatchObject({ reason: 'unattributed-closer', conflicts: [] });
  });

  it('fails closed when the implementer population cannot be read', async () => {
    const out = await conformanceReviewClosureRefusal(
      { itemId: 'WI-1', review: review(), closer: 'su-reviewer' },
      closureDeps({ failImplementers: true }),
    );
    expect(out).toMatchObject({ reason: 'population-unreadable', conflicts: [] });
    expect(out?.error).toContain('acceptance_lineage_unreadable');
  });

  it('counts the closer itself even when the lineage read omits it', async () => {
    const deps: ConformanceReviewClosureDeps = { resolveImplementers: async () => [], lineageOf: async () => new Set() };
    const out = await conformanceReviewClosureRefusal({ itemId: 'WI-1', review: review(['su-builder']), closer: 'su-builder' }, deps);
    expect(out?.conflicts).toEqual(['su-builder']);
  });
});

describe('implementerConflicts', () => {
  it('is the sorted intersection of lineage and excluded set', () => {
    expect(implementerConflicts(new Set(['c', 'a', 'z']), ['a', 'b', 'c', ' a '])).toEqual(['a', 'c']);
    expect(implementerConflicts(new Set(['x']), ['a'])).toEqual([]);
  });
});

describe('fileConformanceReview', () => {
  const filingDeps = (implementers: string[] | Error) => {
    const filings: ReviewFiling[] = [];
    const deps: FileConformanceReviewDeps = {
      resolveImplementers: async () => {
        if (implementers instanceof Error) throw implementers;
        return implementers;
      },
      upsertReview: async (filing) => {
        filings.push(filing);
        return { id: 'WI-9', created: filings.length === 1 };
      },
      now: () => '2026-10-14T12:00:00.000Z',
    };
    return { deps, filings };
  };

  it('files one review per plan under a stable dedup key, recording the excluded implementers', async () => {
    const { deps, filings } = filingDeps(['su-b', 'su-a', 'su-b', ' ']);
    const first = await fileConformanceReview({ planSlug: 'plan-a', harnessSlug: 'papercusp' }, deps);
    const second = await fileConformanceReview({ planSlug: 'plan-a', harnessSlug: 'papercusp' }, deps);
    expect(first).toEqual({ id: 'WI-9', created: true, excludedImplementers: ['su-a', 'su-b'] });
    expect(second.created).toBe(false);
    expect(filings.map((f) => f.conditionKey)).toEqual([
      conformanceReviewConditionKey('papercusp', 'plan-a'),
      conformanceReviewConditionKey('papercusp', 'plan-a'),
    ]);
    expect(filings[0].record).toEqual({ planSlug: 'plan-a', harnessSlug: 'papercusp', excludedImplementers: ['su-a', 'su-b'], filedAt: '2026-10-14T12:00:00.000Z' });
    expect(filings[0].summary).toContain('su-a, su-b');
    expect(conformanceReviewConditionKey('papercusp', 'plan-a')).not.toBe(conformanceReviewConditionKey('papercusp', 'plan-b'));
  });

  it('files nothing when the implementer population is unreadable', async () => {
    const { deps, filings } = filingDeps(new Error('unreadable'));
    await expect(fileConformanceReview({ planSlug: 'plan-a', harnessSlug: 'papercusp' }, deps)).rejects.toThrow('unreadable');
    expect(filings).toHaveLength(0);
  });

  it('requires a plan', async () => {
    const { deps } = filingDeps([]);
    await expect(fileConformanceReview({ planSlug: ' ', harnessSlug: 'papercusp' }, deps)).rejects.toThrow('spec_conformance_review_plan_required');
  });
});

describe('system:spec-conformance-review action', () => {
  const ctx = (payloadTemplate: Record<string, unknown> | null): SystemActionCtx => ({
    installSlug: 'install-h',
    workspaceId: 'ws',
    triggerConfig: {},
    payloadTemplate,
  });

  it('is registered plan-schedulable and on-demand', () => {
    const entry = getSystemActionEntry(CONFORMANCE_REVIEW_ACTION);
    expect(entry?.planSchedulable).toBe(true);
    expect(entry?.scheduling).toBe('on-demand');
  });

  it('files for input.planSlug in the payload harness and reports diagnostics', async () => {
    const upsertReview = vi.fn(async (_filing: unknown) => ({ id: 'WI-5', created: true }));
    const out = await runConformanceReviewAction(
      ctx({ templateSlug: 't', harnessSlug: 'papercusp', input: { planSlug: 'plan-a' } }),
      { resolveImplementers: async () => ['su-x'], upsertReview },
    );
    expect(upsertReview).toHaveBeenCalledTimes(1);
    expect(upsertReview.mock.calls[0][0]).toMatchObject({ conditionKey: 'spec-conformance-review:papercusp/plan-a' });
    expect(out.diagnostics).toEqual({
      specConformanceReview: { planSlug: 'plan-a', harnessSlug: 'papercusp', workItemId: 'WI-5', created: true, excludedImplementers: 1 },
    });
  });

  it('falls back to the install slug and refuses a missing plan', async () => {
    const upsertReview = vi.fn(async (_filing: unknown) => ({ id: 'WI-6', created: false }));
    await runConformanceReviewAction(ctx({ input: { planSlug: 'plan-b' } }), { resolveImplementers: async () => [], upsertReview });
    expect(upsertReview.mock.calls[0][0]).toMatchObject({ conditionKey: 'spec-conformance-review:install-h/plan-b' });
    await expect(runConformanceReviewAction(ctx({ input: {} }), { resolveImplementers: async () => [], upsertReview })).rejects.toThrow(
      'spec_conformance_review_plan_required',
    );
  });
});
