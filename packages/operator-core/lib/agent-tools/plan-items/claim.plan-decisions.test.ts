/**
 * plan_items:claim — plan-Decisions brief at CLAIM time (EI-19963837641363759).
 *
 * `plan-decisions-claim-port.ts` (agent-trap-guards-2026-07-26 P-003b) was wired at
 * scheduler:get_next / work_items:claim / work_items:claim_next — but NOT at
 * plan_items:claim, the natural verb for claiming a PLAN ITEM and the one an su
 * reaches for right after `coord:orient { planItems }` fails to claim. That gap cost
 * a real retracted finding (EI-19963837641363759): a plan's D-076 (a standing rule
 * that would have prevented the mistake) never surfaced at claim time.
 *
 * Unlike the work-item claim surfaces, `plan_items:claim` already knows the plan slug
 * from its own args ({ plan, item }) — no work-item back-pointer needed — so this pins
 * BOTH success shapes: the bare-lease path (flag OFF) and the auto-convert path (flag
 * ON, `convertPlanItem` returns converted/resumed).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../coordination/identity', () => ({
  resolveAgentIdentity: () => ({ ownerId: 'sess-A', ownerLabel: 'A' }),
  isEphemeralMcpCallIdentity: (id: string) => /^mcp-call-\d+$/.test(id),
}));
vi.mock('../plans/source', () => ({
  resolvePlanScope: vi.fn(async (opts?: { harnessSlug?: string }) => ({
    workspaceId: 'default',
    harnessSlug: opts?.harnessSlug ?? 'papercup',
  })),
}));
vi.mock('../../plan-items/agent-names', () => ({
  bestEffortOwnerUser: () => 'user-A',
  resolveAdoptedName: vi.fn(async () => 'builder-1'),
}));
vi.mock('../../plan-items/liveness', () => ({ claimPlanItem: vi.fn() }));
vi.mock('../../plan-items/convert', () => ({ convertPlanItem: vi.fn() }));
const getClaimTimeCheckpointHint = vi.fn();
vi.mock('../../work-item-checkpoint', () => ({
  getClaimTimeCheckpointHint: (...a: unknown[]) => getClaimTimeCheckpointHint(...a),
}));

const getClaimTimePlanDecisions = vi.fn();
const renderPlanDecisionsNote = vi.fn();
vi.mock('../../plan-decisions-claim-port', () => ({
  getClaimTimePlanDecisions: (...a: unknown[]) => getClaimTimePlanDecisions(...a),
  renderPlanDecisionsNote: (...a: unknown[]) => renderPlanDecisionsNote(...a),
}));
const getClaimTimePriorAttemptBrief = vi.fn();
vi.mock('../../prior-attempt-context', () => ({
  getClaimTimePriorAttemptBrief: (...a: unknown[]) => getClaimTimePriorAttemptBrief(...a),
}));

let flagOn = false;
vi.mock('@papercusp/flags/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/flags/server')>()),
  getFlag: vi.fn(async () => flagOn),
}));

import { claimPlanItem } from '../../plan-items/liveness';
import { convertPlanItem } from '../../plan-items/convert';
const claimM = vi.mocked(claimPlanItem);
const convertM = vi.mocked(convertPlanItem);
const tool = (await import('./claim')).default;

type Out = { data: any };
const body = async (args: Record<string, unknown>) => ((await tool.handler(args as never, {} as never)) as Out).data;
const one = async (args: Record<string, unknown>) => (await body(args)).results[0];

const BRIEF = {
  planSlug: 'target-plan',
  decisions: [{
    id: 'D-076', title: 'Inbound authority', snippet: 'body excerpt',
    sourcePlanSlug: 'source-plan', ref: 'source-plan#D-076', relation: 'affects',
  }],
  totalDecisions: 1,
  totalLocalDecisions: 0,
  totalAffectedDecisions: 1,
  affectedDecisions: 1,
  authorityReadFailed: false,
};
const AFFECTS_WARNING = '⚠ CROSS-PLAN AUTHORITY CONFLICT/SUPERSESSION WARNING: source-plan#D-076';

beforeEach(() => {
  vi.clearAllMocks();
  flagOn = false;
  claimM.mockImplementation(
    async (opts) => ({ status: 'claimed', claim: { itemId: opts.itemId, owner: 'sess-A' }, mode: 'availability', viaAssignment: false }) as never,
  );
  convertM.mockImplementation(
    async (opts) =>
      ({
        status: 'converted',
        claim: { itemId: opts.itemId, owner: 'sess-A' },
        mode: 'availability',
        viaAssignment: false,
        workItem: { id: 'WI-1', kind: 'change', harness: opts.harnessSlug },
      }) as never,
  );
  getClaimTimePlanDecisions.mockResolvedValue(null);
  renderPlanDecisionsNote.mockReturnValue(AFFECTS_WARNING);
  getClaimTimePriorAttemptBrief.mockResolvedValue(null);
  getClaimTimeCheckpointHint.mockResolvedValue(null);
});

describe('plan_items:claim — prior-attempt brief (P-010)', () => {
  it('surfaces the shared bounded brief on the bare plan-item claim path', async () => {
    const brief = { schemaVersion: 'prior-attempt-brief-v1', fingerprint: 'fp' };
    getClaimTimePriorAttemptBrief.mockResolvedValue(brief);
    const r = await one({ plan: 'a-plan', item: 'P-001' });
    expect(r.ok).toBe(true);
    expect(r.priorAttemptBrief).toEqual(brief);
    expect(getClaimTimePriorAttemptBrief).toHaveBeenCalledWith(expect.objectContaining({
      planSlug: 'a-plan', planItemId: 'P-001', workItemId: null,
    }));
  });
});

describe('plan_items:claim — plan-Decisions brief, bare-lease path (flag OFF)', () => {
  it('surfaces planDecisions + planDecisionsNote on a successful claim', async () => {
    getClaimTimePlanDecisions.mockResolvedValue(BRIEF);
    const r = await one({ plan: 'a-plan', item: 'P-001' });
    expect(r.ok).toBe(true);
    expect(r.planDecisions).toEqual(BRIEF.decisions);
    expect(r.planDecisionsNote).toBe(AFFECTS_WARNING);
    expect(r.enrichmentDelivery.delivered).toContain('planDecisions');
    expect(renderPlanDecisionsNote).toHaveBeenCalledWith(BRIEF);
  });

  it('passes the plan slug DIRECTLY from args — no work-item lookup needed', async () => {
    await one({ plan: 'a-plan', item: 'P-001', harness: 'papercup' });
    expect(getClaimTimePlanDecisions).toHaveBeenCalledWith(
      expect.objectContaining({ planSlug: 'a-plan', harness: 'papercup', workspaceId: 'default' }),
    );
  });

  it('omits the field entirely (not even null) when the plan has no decisions', async () => {
    getClaimTimePlanDecisions.mockResolvedValue(null);
    const r = await one({ plan: 'a-plan', item: 'P-001' });
    expect(r.ok).toBe(true);
    expect(r.planDecisions).toBeUndefined();
    expect(r.planDecisionsNote).toBeUndefined();
  });

  it('fails soft — a port error must never fail the claim itself', async () => {
    getClaimTimePlanDecisions.mockRejectedValue(new Error('pg hiccup'));
    const r = await one({ plan: 'a-plan', item: 'P-001' });
    expect(r.ok).toBe(true);
    expect(r.planDecisions).toBeUndefined();
  });

  it('does NOT fetch decisions for a refused/conflicted claim', async () => {
    claimM.mockResolvedValue({ status: 'refused', reason: 'assigned to builder-2' } as never);
    const r = await one({ plan: 'a-plan', item: 'P-001' });
    expect(r.ok).toBe(false);
    expect(getClaimTimePlanDecisions).not.toHaveBeenCalled();
    expect(r.planDecisions).toBeUndefined();
  });
});

describe('plan_items:claim — plan-Decisions brief, auto-convert path (flag ON)', () => {
  beforeEach(() => {
    flagOn = true;
  });

  it('surfaces planDecisions on a converted claim too', async () => {
    getClaimTimePlanDecisions.mockResolvedValue(BRIEF);
    const r = await one({ plan: 'a-plan', item: 'P-001' });
    expect(r.ok).toBe(true);
    expect(r.result.status).toBe('claimed');
    expect(r.convertStatus).toBe('converted');
    expect(r.planDecisions).toEqual(BRIEF.decisions);
    expect(r.planDecisionsNote).toBe(AFFECTS_WARNING);
    expect(r.enrichmentDelivery.delivered).toContain('planDecisions');
  });

  it('serializes affected-plan authority before a resumed work-item checkpoint', async () => {
    getClaimTimePlanDecisions.mockResolvedValue(BRIEF);
    getClaimTimeCheckpointHint.mockResolvedValue({ checkpoint: 'local carry prose', checkpointAgeMs: 10 });
    const r = await one({ plan: 'a-plan', item: 'P-001' });
    expect(r.checkpoint).toBe('local carry prose');
    expect(Object.keys(r).indexOf('planDecisionsNote')).toBeLessThan(Object.keys(r).indexOf('checkpoint'));
  });

  it('does NOT fetch decisions when convertPlanItem refuses/conflicts', async () => {
    convertM.mockResolvedValue({ status: 'conflict', conflict: { owner: 'sess-B' } } as never);
    const r = await one({ plan: 'a-plan', item: 'P-001' });
    expect(r.ok).toBe(false);
    expect(getClaimTimePlanDecisions).not.toHaveBeenCalled();
  });
});
