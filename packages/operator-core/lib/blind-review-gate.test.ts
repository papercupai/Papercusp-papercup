/**
 * evaluateBlindReviewGate decision logic (verification-system-improvements-2026-10-10
 * P-006, D-039) against an injected SQL fake. The real SQL, the real awaiting-acceptance
 * writers and the real ship handler are exercised by
 * plan-acceptance-gate-blind-review.integration.test.ts.
 */
import { describe, expect, it } from 'vitest';
import {
  BLIND_REVIEW_REQUIRED_AFTER,
  evaluateBlindReviewGate,
  recordBlindReview,
  type BlindReviewGateDeps,
} from './blind-review-gate';

const SLUG = 'demo-plan';
const AFTER = new Date(Date.parse(BLIND_REVIEW_REQUIRED_AFTER) + 3_600_000);
const BEFORE = new Date(Date.parse(BLIND_REVIEW_REQUIRED_AFTER) - 3_600_000);

const BODY = `---
title: Demo
slug: ${SLUG}
status: active
---

## Items

- **P-001** \`done\` Export invoices as CSV.
- **P-002** \`dropped\` Abandoned idea.

## Decisions

### D-001 — Offline export is an accepted risk
Date: 2026-10-11
Accepted risk.
`;

interface Review {
  id: number;
  record_kind: 'review' | 'disposition';
  activation_audit_seq: number;
  gaps?: Array<{ id: string; text: string }>;
  dispositions?: Array<{ reviewId: number; gapId: string; itemId?: string; acceptedRiskDecisionId?: string }>;
  created_by: string;
}

function fakeSql(opts: {
  createdAt?: Date | null;
  activationSeq?: number | null;
  reviews?: Review[];
  reads?: Record<string, string>;
  throwOn?: 'plan' | 'ledger';
}): BlindReviewGateDeps['sql'] {
  const fn = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?');
    if (text.includes('harness_plans')) {
      if (opts.throwOn === 'plan') throw new Error('connection refused');
      return [{ harness_slug: 'h', created_at: opts.createdAt === undefined ? AFTER : opts.createdAt, owner: 'su-owner', content: BODY }];
    }
    if (text.includes('plan_audits')) {
      return opts.activationSeq ? [{ audit_seq: opts.activationSeq, activation: { mappings: [] } }] : [];
    }
    if (text.includes('plan_blind_reviews')) {
      return (opts.reviews ?? []).map((r) => ({ gaps: [], dispositions: [], created_at: AFTER, ...r }));
    }
    if (text.includes('tool_invocations')) {
      if (opts.throwOn === 'ledger') throw new Error('ledger timeout');
      const tool = opts.reads?.[values[0] as string];
      return tool ? [{ tool_name: tool, invoked_at: BEFORE }] : [];
    }
    throw new Error(`unexpected query: ${text}`);
  };
  return fn as unknown as BlindReviewGateDeps['sql'];
}

const deps = (sql: BlindReviewGateDeps['sql'], related: string[] = []): BlindReviewGateDeps => ({
  sql,
  resolveImplementers: async () => ['su-implementer'],
  lineageRelated: async (a, b) => related.includes(a) && b === 'su-implementer',
});

const evaluate = (sql: BlindReviewGateDeps['sql'], related?: string[]) =>
  evaluateBlindReviewGate({ planSlug: SLUG, harnessSlug: 'h', workspaceId: 'ws' }, deps(sql, related));

const review = (id: number, by: string, seq = 3, gaps: Review['gaps'] = []): Review =>
  ({ id, record_kind: 'review', activation_audit_seq: seq, gaps, created_by: by });

function recordingSql() {
  const rows: Array<Record<string, unknown>> = [];
  let inserts = 0;
  const fn = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?');
    if (text.includes('harness_plans')) {
      return [{ harness_slug: 'h', created_at: AFTER, owner: 'su-owner', content: BODY }];
    }
    if (text.includes('plan_audits')) {
      return [{ audit_seq: 3, activation: { mappings: [] } }];
    }
    if (text.includes('SELECT id, activation_audit_seq, gaps')) {
      return rows.filter((row) => row.workspace_id === values[0] && row.idempotency_key === values[1]);
    }
    if (text.includes('INSERT INTO harness_shared.plan_blind_reviews')) {
      inserts++;
      const [workspaceId, harnessSlug, planSlug, activationAuditSeq, gaps, summary, createdBy, idempotencyKey] = values;
      const existing = rows.find((row) => row.workspace_id === workspaceId && row.idempotency_key === idempotencyKey);
      if (existing) return [];
      const row = {
        id: rows.length + 1,
        workspace_id: workspaceId,
        harness_slug: harnessSlug,
        plan_slug: planSlug,
        activation_audit_seq: activationAuditSeq,
        gaps,
        summary,
        created_by: createdBy,
        idempotency_key: idempotencyKey,
      };
      rows.push(row);
      return [{ id: row.id }];
    }
    if (text.includes('plan_blind_reviews')) return rows;
    throw new Error(`unexpected query: ${text}`);
  };
  const sql = fn as unknown as NonNullable<BlindReviewGateDeps['sql']>;
  (sql as unknown as { json: (value: unknown) => unknown }).json = (value) => value;
  return { sql, rows, get inserts() { return inserts; } };
}

describe('evaluateBlindReviewGate', () => {
  it('fails closed with blind_review_unavailable when a read throws', async () => {
    const v = await evaluate(fakeSql({ throwOn: 'plan' }));
    expect(v).toMatchObject({ satisfied: false, applicable: true, code: 'blind_review_unavailable' });
    expect(v.readFailure).toContain('connection refused');
    const ledger = await evaluate(fakeSql({ activationSeq: 3, reviews: [review(1, 'su-blind')], throwOn: 'ledger' }));
    expect(ledger.code).toBe('blind_review_unavailable');
  });

  it('is not applicable to a pre-cohort plan with no review, nor to a plan with no activation audit', async () => {
    expect(await evaluate(fakeSql({ createdAt: BEFORE, activationSeq: 3 }))).toMatchObject({ satisfied: true, applicable: false, notApplicableReason: 'pre-cohort' });
    expect(await evaluate(fakeSql({ activationSeq: null }))).toMatchObject({ satisfied: true, applicable: false, notApplicableReason: 'no-activation-audit' });
  });

  it('an unreadable plan age is IN the cohort (fail closed)', async () => {
    expect((await evaluate(fakeSql({ createdAt: null, activationSeq: 3 }))).code).toBe('blind_review_missing');
  });

  it('a pre-cohort plan that records a review opts in', async () => {
    const v = await evaluate(fakeSql({ createdAt: BEFORE, activationSeq: 3, reviews: [review(1, 'su-implementer')] }));
    expect(v.code).toBe('blind_review_missing');
  });

  it('refuses blind_review_missing with no review, or only a review of an older activation audit', async () => {
    expect((await evaluate(fakeSql({ activationSeq: 3 }))).code).toBe('blind_review_missing');
    const stale = await evaluate(fakeSql({ activationSeq: 4, reviews: [review(1, 'su-blind', 3)] }));
    expect(stale).toMatchObject({ code: 'blind_review_missing', activationAuditSeq: 4 });
  });

  it('does not count a review by the owner, an implementer, or their lineage', async () => {
    const v = await evaluate(fakeSql({ activationSeq: 3, reviews: [review(1, 'su-owner'), review(2, 'su-implementer'), review(3, 'su-fork')] }), ['su-fork']);
    expect(v.code).toBe('blind_review_missing');
    expect(v.rejectedReviews.map((r) => [r.reviewId, r.reason])).toEqual([
      [1, 'owner-or-implementer'], [2, 'owner-or-implementer'], [3, 'lineage-related'],
    ]);
  });

  it('does not count a review whose reviewer read the plan artifacts before posting', async () => {
    const v = await evaluate(fakeSql({ activationSeq: 3, reviews: [review(1, 'su-peeker')], reads: { 'su-peeker': 'plans:get' } }));
    expect(v.code).toBe('blind_review_missing');
    expect(v.rejectedReviews[0]).toMatchObject({ reason: 'read-plan-artifacts' });
    expect(v.rejectedReviews[0]!.detail).toContain('plans:get');
  });

  it('requires every gap of a counted review to reach a non-dropped item or an existing Decision', async () => {
    const gaps = [{ id: 'G-1', text: 'offline' }, { id: 'G-2', text: 'pdf' }, { id: 'G-3', text: 'zip' }];
    const base = [review(1, 'su-blind', 3, gaps)];
    const none = await evaluate(fakeSql({ activationSeq: 3, reviews: base }));
    expect(none.code).toBe('blind_review_gap_undispositioned');
    expect(none.undispositionedGaps.map((g) => g.gapId)).toEqual(['G-1', 'G-2', 'G-3']);

    const partial = await evaluate(fakeSql({ activationSeq: 3, reviews: [...base, {
      id: 2, record_kind: 'disposition', activation_audit_seq: 3, created_by: 'su-implementer',
      dispositions: [
        { reviewId: 1, gapId: 'G-1', acceptedRiskDecisionId: 'D-001' },
        { reviewId: 1, gapId: 'G-2', itemId: 'P-002' }, // dropped item: does not carry a gap
        { reviewId: 1, gapId: 'G-3', acceptedRiskDecisionId: 'D-009' }, // no such decision
      ],
    }] }));
    expect(partial.undispositionedGaps.map((g) => g.gapId)).toEqual(['G-2', 'G-3']);

    const full = await evaluate(fakeSql({ activationSeq: 3, reviews: [...base, {
      id: 2, record_kind: 'disposition', activation_audit_seq: 3, created_by: 'su-implementer',
      dispositions: [
        { reviewId: 1, gapId: 'G-1', acceptedRiskDecisionId: 'D-001' },
        { reviewId: 1, gapId: 'G-2', itemId: 'P-001' },
        { reviewId: 1, gapId: 'G-3', itemId: 'P-001' },
      ],
    }] }));
    expect(full).toMatchObject({ satisfied: true, applicable: true, acceptedReviewIds: [1] });
  });

  it('a counted review with no gaps satisfies the door', async () => {
    expect(await evaluate(fakeSql({ activationSeq: 3, reviews: [review(1, 'su-blind')] }))).toMatchObject({ satisfied: true, acceptedReviewIds: [1] });
  });
});

describe('recordBlindReview idempotency', () => {
  it('returns the original review for identical retries and refuses a changed retry', async () => {
    const fixture = recordingSql();
    const input = {
      workspaceId: 'ws',
      planSlug: SLUG,
      harnessSlug: 'h',
      createdBy: 'su-blind-reviewer',
      gaps: [{ text: 'CSV export omits the invoice currency.' }],
      activationAuditSeq: 3,
    };

    const first = await recordBlindReview(input, { sql: fixture.sql });
    const retry = await recordBlindReview(input, { sql: fixture.sql });
    expect(first).toEqual({ ok: true, id: 1, activationAuditSeq: 3, gapIds: ['G-1'] });
    expect(retry).toEqual(first);
    expect(fixture.inserts).toBe(1);

    const changed = await recordBlindReview({ ...input, gaps: [{ text: 'A different report.' }] }, { sql: fixture.sql });
    expect(changed).toMatchObject({ ok: false, code: 'idempotency_conflict' });
    expect(fixture.inserts).toBe(1);
  });
});
