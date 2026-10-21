/**
 * plans:conformance (R-17, spec-driven-tooling-integration-2026-10-05 P-028): the
 * production wiring around the pure deviation core — owner-turn verification
 * strictness, the reserved-fence opt-in on the decision write, and arg validation.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  readPlanBySlug: vi.fn(),
  addDecisionOne: vi.fn(),
  loadConformanceReportPlans: vi.fn(),
}));

vi.mock('./source', () => ({ readPlanBySlug: mocks.readPlanBySlug }));
vi.mock('./add-decision', () => ({ addDecisionOne: mocks.addDecisionOne }));
vi.mock('../../spec-conformance/conformance-report', async (orig) => ({
  ...(await orig<typeof import('../../spec-conformance/conformance-report')>()),
  loadConformanceReportPlans: mocks.loadConformanceReportPlans,
}));
vi.mock('./_ctx-opts', () => ({ ctxToPlanSourceOpts: async () => ({ workspaceId: 'ws', harnessSlug: 'h' }) }));
vi.mock('../coordination/identity', () => ({ resolveAgentIdentity: () => ({ ownerId: 'su-test' }) }));
vi.mock('../_harness-scope', async (orig) => ({
  ...(await orig<typeof import('../_harness-scope')>()),
  harnessScopedCtx: (_harness: unknown, ctx: unknown) => ctx,
}));

import tool, { appendResultFrom, ownerTurnVerificationFrom, verifyOwnerTurnRef } from './conformance';
import type { TurnRefVerdict } from '../../turn-provenance/turn-ref';

const verdict = (over: Partial<TurnRefVerdict>): TurnRefVerdict => ({
  ref: '[turn:abcd1234@2026-10-14T10:00:00Z]',
  found: true,
  verdict: 'owner-typed',
  origin: null,
  snippet: 'yes, drop R-2',
  quote: null,
  quoteMatch: null,
  checked: true,
  ...over,
});

describe('ownerTurnVerificationFrom', () => {
  it('verifies a found owner turn', () => {
    expect(ownerTurnVerificationFrom(verdict({}))).toMatchObject({ verified: true, verdict: 'owner-typed' });
    expect(ownerTurnVerificationFrom(verdict({ verdict: 'owner-dialog' })).verified).toBe(true);
  });

  it('refuses an agent-injected turn even when it was found', () => {
    expect(ownerTurnVerificationFrom(verdict({ verdict: 'agent-injected' }))).toMatchObject({ verified: false, verdict: 'agent-injected' });
  });

  it('refuses an unknown classification (an indexed row without affirmative owner evidence)', () => {
    expect(ownerTurnVerificationFrom(verdict({ verdict: 'unknown' as TurnRefVerdict['verdict'] })).verified).toBe(false);
  });

  it('refuses a resolvable owner turn whose attached quote is not in it (EI-12890)', () => {
    expect(ownerTurnVerificationFrom(verdict({ quote: 'approve everything', quoteMatch: false })).verified).toBe(false);
  });

  it('distinguishes searched-and-absent from never-checked', () => {
    expect(ownerTurnVerificationFrom(verdict({ found: false, verdict: null, checked: true })).detail).toContain('searched');
    expect(ownerTurnVerificationFrom(verdict({ found: false, verdict: null, checked: false })).detail).toContain('could not be located');
    expect(ownerTurnVerificationFrom(undefined).verified).toBe(false);
  });
});

describe('verifyOwnerTurnRef', () => {
  it('requires exactly one [turn:…] anchor and verifies it cross-session', async () => {
    const verify = vi.fn(async () => [verdict({})]);
    expect((await verifyOwnerTurnRef('su-x', 'the owner said so', verify as never)).verified).toBe(false);
    expect(
      (await verifyOwnerTurnRef('su-x', '[turn:abcd1234@2026-10-14T10:00:00Z] [turn:efgh5678@2026-10-14T11:00:00Z]', verify as never)).verified,
    ).toBe(false);
    expect(verify).not.toHaveBeenCalled();
    const ok = await verifyOwnerTurnRef('su-x', '[turn:abcd1234@2026-10-14T10:00:00Z]', verify as never);
    expect(ok.verified).toBe(true);
    expect(verify).toHaveBeenCalledWith('su-x', expect.any(Array), { scope: 'cross-session' });
  });
});

describe('appendResultFrom', () => {
  it('maps success and failure', () => {
    expect(appendResultFrom({ ok: true, decisionId: 'D-012', ref: 'p#D-012' })).toEqual({ ok: true, decisionId: 'D-012', ref: 'p#D-012' });
    expect(appendResultFrom({ ok: false, error: 'busy', message: 'held' })).toEqual({ ok: false, error: 'busy', message: 'held' });
    expect(appendResultFrom({ ok: true })).toMatchObject({ ok: false, error: 'decision_write_failed' });
  });
});

const PLAN = [
  '---',
  'slug: p',
  'status: active',
  '---',
  '# P',
  '',
  '## Requirements',
  '',
  '**R-2 — An agent requirement.**',
  '```requirement',
  JSON.stringify({
    intent: { request: 'Do R-2.', sourceRefs: ['P-004'] },
    acceptance: { condition: 'R-2 holds.', falsifier: 'R-2 broken.' },
    verification: { method: 'Run it.', check: { kind: 'tests', files: ['x.test.ts'] } },
  }),
  '```',
  '',
  '## Decisions',
  '',
].join('\n');

const call = async (args: Record<string, unknown>) => {
  const output = (await tool.handler(args as never, { workspaceId: 'ws', harnessSlug: 'h' } as never)) as {
    data?: Record<string, unknown>;
    content?: { text: string }[];
  };
  return output.data ?? JSON.parse(output.content![0].text) as Record<string, unknown>;
};

describe('plans:conformance handler', () => {
  beforeEach(() => {
    mocks.readPlanBySlug.mockReset();
    mocks.addDecisionOne.mockReset();
    mocks.readPlanBySlug.mockResolvedValue({ row: { content: PLAN } });
    mocks.addDecisionOne.mockResolvedValue({ ok: true, decisionId: 'D-001', ref: 'p#D-001' });
  });

  it('propose-deviation writes through addDecisionOne with the reserved-fence opt-in and plan-item refs only', async () => {
    const out = await call({ op: 'propose-deviation', slug: 'p', requirement: 'R-2', reason: 'Superseded by R-3.' });
    expect(out).toMatchObject({ ok: true, op: 'propose-deviation', decisionId: 'D-001', ownerSourced: false });
    expect(mocks.addDecisionOne).toHaveBeenCalledTimes(1);
    const [input, , opts] = mocks.addDecisionOne.mock.calls[0]!;
    expect(opts).toEqual({ allowDeviationFence: true });
    expect(input.refs).toEqual([]);
    expect(input.body).toContain('```deviation');
    expect(input.body).toContain('"proposedBy": "su-test"');
  });

  it('refuses a propose without reason and an approve without proposal, writing nothing', async () => {
    expect(await call({ op: 'propose-deviation', slug: 'p', requirement: 'R-2' })).toMatchObject({ error: 'invalid_args' });
    expect(await call({ op: 'approve-deviation', slug: 'p', requirement: 'R-2' })).toMatchObject({ error: 'invalid_args' });
    expect(mocks.addDecisionOne).not.toHaveBeenCalled();
  });

  it('surfaces a missing plan as plan_not_found', async () => {
    mocks.readPlanBySlug.mockResolvedValue(null);
    expect(await call({ op: 'propose-deviation', slug: 'p', requirement: 'R-2', reason: 'x' })).toMatchObject({ ok: false, error: 'plan_not_found' });
  });

  it('refuses a deviation op without slug or requirement, writing nothing', async () => {
    expect(await call({ op: 'propose-deviation', requirement: 'R-2', reason: 'x' })).toMatchObject({ error: 'invalid_args' });
    expect(await call({ op: 'approve-deviation', slug: 'p', proposal: 'D-001' })).toMatchObject({ error: 'invalid_args' });
    expect(mocks.addDecisionOne).not.toHaveBeenCalled();
  });
});

describe("plans:conformance op:'report' (R-22)", () => {
  beforeEach(() => {
    mocks.loadConformanceReportPlans.mockReset();
    mocks.addDecisionOne.mockReset();
    mocks.loadConformanceReportPlans.mockResolvedValue([
      { planSlug: 'p', harnessSlug: 'h', status: 'active', content: PLAN },
      { planSlug: 'q', harnessSlug: 'h', status: 'active', content: '# Q\n' },
    ]);
  });

  it('censuses the loaded plans read-only, with no slug, and writes no decision', async () => {
    const out = await call({ op: 'report' });
    expect(out).toMatchObject({ ok: true, op: 'report', statuses: ['active', 'ready'] });
    expect((out.plans as unknown[]).length).toBe(2);
    expect(mocks.loadConformanceReportPlans).toHaveBeenCalledWith({ workspaceId: 'ws' });
    expect(mocks.addDecisionOne).not.toHaveBeenCalled();
  });

  it('forwards an explicit harness and statuses filter to the loader and the census', async () => {
    const out = await call({ op: 'report', harness: 'h', statuses: ['shipped'] });
    expect(mocks.loadConformanceReportPlans).toHaveBeenCalledWith({ workspaceId: 'ws', harnessSlug: 'h', statuses: ['shipped'] });
    expect(out).toMatchObject({ ok: true, statuses: ['shipped'] });
    // the census re-filters by status, so active rows from a loose loader are excluded
    expect((out.plans as unknown[]).length).toBe(0);
  });
});
