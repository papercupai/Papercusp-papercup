/**
 * RSR-P-008-A (review-system-rework-reduction-2026-09-23): a review-tool refusal
 * lists every invalid field of the request in one response. Falsifier: a request
 * with two invalid fields gets a refusal naming only one. Probe: send a two-defect
 * request to each review tool.
 *
 * The refusal is asserted exactly as a caller receives it — `validateSync` +
 * `formatIssues`, the pair the tool dispatch uses — not as raw zod issues. That
 * matters: the dispatch expands an `invalid_union` into its field-level branch,
 * so a raw `safeParse` under-reports what the caller actually sees.
 *
 * Each request pairs a SHAPE defect (a wrong-typed field) with, wherever the tool
 * has one, a COMBINATION defect enforced by an object-level refinement. zod v4
 * skips such refinements while the shape has issues, which is how these tools
 * used to answer one field per round-trip (fixed by refineEvenWithShapeIssues).
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { formatIssues, validateSync } from '@papercusp/tooldef';

import { refineEvenWithShapeIssues } from './_refine-with-shape-issues';
import rubricsAmend from './rubrics/amend';
import rubricsPropose from './rubrics/propose';
import plansSetSpecs from './plans/set-specs';
import plansBindSpecEvidence from './plans/bind-spec-evidence';
import plansAudit from './plans/audit';
import plansEvaluateSpecTestAdequacy from './plans/evaluate-spec-test-adequacy';
import plansCertifySpecClauses from './plans/certify-spec-clauses';
import plansGetSpecEvidence from './plans/get-spec-evidence';
import scorecardsEmit from './scorecards/emit';
import scorecardsEvaluate from './scorecards/evaluate';
import consultGetFeedback from './consult/get-feedback';
import workItemsComplete from './work_items/complete';
import rubricsGet from './rubrics/get';
import { isFullDetail } from './_review-read-detail';

/** What the caller receives for `request`, or null when it is accepted. */
function refusalFor(schema: unknown, request: unknown): string | null {
  const result = validateSync(schema as Parameters<typeof validateSync>[0], request);
  return result.ok ? null : formatIssues(result.issues, request);
}

/** The probe: the refusal must mention every defect. */
function missingFromRefusal(schema: unknown, request: unknown, defects: string[]): string[] {
  const refusal = refusalFor(schema, request);
  if (refusal === null) return [...defects];
  return defects.filter((defect) => !refusal.includes(defect));
}

type Case = { tool: { name: string; args: unknown }; request: Record<string, unknown>; defects: string[] };

const CASES: Case[] = [
  { tool: rubricsAmend, request: { rubricRef: 42 }, defects: ['rubricRef', 'nothing to amend'] },
  {
    tool: rubricsPropose,
    request: { rubricRef: 'r', characteristic: 'c', title: 42, criteria: [], kind: 'acceptance', releaseGating: true },
    defects: ['title', 'releaseGating'],
  },
  { tool: plansSetSpecs, request: { slug: 42 }, defects: ['slug', 'exactly one of `spec` or `items`'] },
  { tool: plansBindSpecEvidence, request: { slug: 42 }, defects: ['slug', 'exactly one of binding, items or retract'] },
  // classRef may be omitted at activation since P-003 (it is derived), so the second defect
  // is an invalid class rather than a missing one.
  { tool: plansAudit, request: { slug: 42, phase: 'activation', classRef: 'not-a-class' }, defects: ['slug', 'classRef'] },
  {
    tool: plansEvaluateSpecTestAdequacy,
    request: { slug: 42, classRef: 'plan-class-feature-ship', specRevision: 3 },
    defects: ['slug', 'specRevision'],
  },
  { tool: plansCertifySpecClauses, request: { slug: 42, classRef: 42 }, defects: ['slug', 'classRef'] },
  { tool: plansGetSpecEvidence, request: { slug: 42, limit: 'x' }, defects: ['slug', 'limit'] },
  { tool: scorecardsEmit, request: { rubricRef: 42, ratings: 'x' }, defects: ['rubricRef', 'ratings'] },
  { tool: scorecardsEvaluate, request: { rubricRef: 42, ratings: 'x' }, defects: ['rubricRef', 'ratings'] },
  { tool: consultGetFeedback, request: { question: 42, max_agents: 'x' }, defects: ['question', 'max_agents'] },
  {
    tool: workItemsComplete,
    request: {
      id: 'WI-1',
      state: 'done',
      assumptions: 'none',
      completion: {
        summary: 's',
        testsRun: [],
        testResult: 't',
        verifiedHow: 'v',
        filesChanged: ['a file (described in prose), not a path'],
        rootCauseVerification: { contractVersion: 2 },
      },
    },
    defects: ['filesChanged', 'rootCauseVerification'],
  },
];

describe('RSR-P-008-A: one refusal names every invalid field', () => {
  it.each([rubricsGet, plansGetSpecEvidence, plansEvaluateSpecTestAdequacy].map((tool) => [tool.name, tool] as const))('%s accepts both detail conventions without accepting malformed detail', (_name, tool) => {
    const base = tool.name === 'rubrics:get' ? { rubricRef: 'r' } : { slug: 'plan-a' };
    for (const [alias, canonical] of [[true, 'full'], [false, 'summary']] as const) {
      const aliased = validateSync(tool.args as never, { ...base, detail: alias });
      const named = validateSync(tool.args as never, { ...base, detail: canonical });
      expect(aliased.ok).toBe(true);
      expect(named.ok).toBe(true);
      expect(isFullDetail(tool.args.parse({ ...base, detail: alias }).detail)).toBe(isFullDetail(tool.args.parse({ ...base, detail: canonical }).detail));
    }
    expect(refusalFor(tool.args, { ...base, detail: 3 })).toContain('detail');
  });

  it.each(CASES.map((c) => [c.tool.name, c] as const))('%s names both defects of a two-defect request', (_, c) => {
    expect(missingFromRefusal(c.tool.args, c.request, c.defects)).toEqual([]);
  });

  it('covers every review tool in the P-008 invalid-input census', () => {
    expect(CASES.map((c) => c.tool.name).sort()).toEqual(
      [
        'consult:get_feedback',
        'plans:audit',
        'plans:bind-spec-evidence',
        'plans:certify-spec-clauses',
        'plans:evaluate-spec-test-adequacy',
        'plans:get-spec-evidence',
        'plans:set-specs',
        'rubrics:amend',
        'rubrics:propose',
        'scorecards:emit',
        'scorecards:evaluate',
        'work_items:complete',
      ].sort(),
    );
  });
});

describe('falsifiability control — the probe catches a one-field-per-round-trip schema', () => {
  // Kept permanently in the file (never a mutation of production code on this
  // swept tree): the SAME rule written the pre-fix way, and with the helper.
  const base = z.object({ slug: z.string(), spec: z.string().optional(), items: z.array(z.string()).optional() });
  const rule = (args: { spec?: string; items?: string[] }, ctx: z.RefinementCtx) => {
    if (Boolean(args.spec) === Boolean(args.items)) {
      ctx.addIssue({ code: 'custom', path: [], message: 'pass exactly one of spec or items' });
    }
  };
  const defects = ['slug', 'exactly one of spec or items'];

  it('WRONG — a plain superRefine drops the combination defect and the probe says so', () => {
    expect(missingFromRefusal(base.superRefine(rule), { slug: 42 }, defects)).toEqual(['exactly one of spec or items']);
  });

  it('CALIBRATION — the helper reports both', () => {
    expect(missingFromRefusal(refineEvenWithShapeIssues(base, rule), { slug: 42 }, defects)).toEqual([]);
  });

  it('the helper still refuses a well-shaped request on the rule alone, exactly once', () => {
    const refusal = refusalFor(refineEvenWithShapeIssues(base, rule), { slug: 'ok' });
    expect(refusal?.match(/exactly one of spec or items/g)).toHaveLength(1);
  });

  it('a refinement that throws on malformed input cannot crash the refusal', () => {
    const fragile = refineEvenWithShapeIssues(base, (args, ctx) => {
      if (args.slug.toUpperCase() === 'X') ctx.addIssue({ code: 'custom', path: ['slug'], message: 'no X' });
    });
    expect(refusalFor(fragile, { slug: 42 })).toContain('slug');
  });
});
