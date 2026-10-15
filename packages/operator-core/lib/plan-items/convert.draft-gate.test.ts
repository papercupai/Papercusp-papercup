/**
 * WI-10008137: convertPlanItem is the one door every pickup path shares
 * (plan_items:convert, plan_items:claim's auto-convert, coord:declare-intent's
 * auto-convert, plans:set-status' claim conversion). It must consult the draft-plan
 * item-start gate BEFORE taking the plan-item lease, so a refused pickup on an
 * unaudited draft plan leaves no claim behind. The gate's own decision logic is
 * covered by agent-tools/plans/draft-item-start-gate.test.ts; this suite pins the
 * wiring: order, arguments, refusal shape, and fail-open on a lookup error.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../work-items', () => ({
  getWorkItem: vi.fn(),
  ISSUE_FAMILY_KINDS: ['bug', 'change', 'task'],
  createWorkItem: vi.fn(),
  claimWorkItem: vi.fn(),
  releaseWorkItem: vi.fn(),
  linkWorkItem: vi.fn(),
  isWorkItemKind: () => true,
  isClaimHoldParked: () => false,
}));
vi.mock('../agent-tools/plans/source', () => ({ readPlanBySlug: vi.fn() }));
vi.mock('./liveness', () => ({ claimPlanItem: vi.fn() }));
vi.mock('./compile-brief', () => ({ compilePlanItemBrief: vi.fn(), decisionsForItem: vi.fn() }));
vi.mock('../agent-tools/plans/draft-item-start-gate', () => ({ checkDraftItemStartGateLive: vi.fn() }));

const { convertPlanItem } = await import('./convert');
const { readPlanBySlug } = await import('../agent-tools/plans/source');
const { claimPlanItem } = await import('./liveness');
const { checkDraftItemStartGateLive } = await import('../agent-tools/plans/draft-item-start-gate');

const readPlanM = readPlanBySlug as unknown as ReturnType<typeof vi.fn>;
const claimM = claimPlanItem as unknown as ReturnType<typeof vi.fn>;
const gateM = checkDraftItemStartGateLive as unknown as ReturnType<typeof vi.fn>;

const DRAFT_BODY = '---\nstatus: draft\n---\n# Plan\n\n## Phase 1\n\n- **P-001** `todo` Build it\n';

function planRead(content: string | undefined) {
  return {
    parsed: { items: [] },
    archived: false,
    row: { items: [{ id: 'P-001', status: 'todo', text: 'Build it' }], ...(content === undefined ? {} : { content }) },
  };
}

const opts = {
  workspaceId: 'ws-1',
  harnessSlug: 'h-1',
  planSlug: 'draft-plan',
  itemId: 'P-001',
  owner: 'su-test',
  ownerLabel: 'su · test',
  ownerUser: 'user-test',
};

/** A claim refusal ends the convert right after the lease step, so the test never needs the mint path. */
const LEASE_CONFLICT = { status: 'conflict', conflict: { claimId: 'other', owner: 'su-peer' } };

describe('convertPlanItem — draft-plan item-start gate (WI-10008137)', () => {
  beforeEach(() => {
    readPlanM.mockReset();
    claimM.mockReset();
    gateM.mockReset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('refuses with activation_audit_required and never takes the lease when the gate refuses', async () => {
    readPlanM.mockResolvedValue(planRead(DRAFT_BODY));
    gateM.mockResolvedValue({
      ok: false,
      slug: 'draft-plan',
      itemId: 'P-001',
      error: 'activation_audit_required',
      gateCode: 'conversation_audit_required',
      hint: "Plan 'draft-plan' is a draft with no activation audit",
    });

    const result = await convertPlanItem(opts);

    expect(result).toEqual({
      status: 'refused',
      code: 'activation_audit_required',
      reason: "Plan 'draft-plan' is a draft with no activation audit",
    });
    expect(claimM).not.toHaveBeenCalled();
  });

  it('passes the plan body it already read, the scope, and a wip start to the gate', async () => {
    readPlanM.mockResolvedValue(planRead(DRAFT_BODY));
    gateM.mockResolvedValue(null);
    claimM.mockResolvedValue(LEASE_CONFLICT);

    await convertPlanItem(opts);

    expect(gateM).toHaveBeenCalledTimes(1);
    expect(gateM).toHaveBeenCalledWith({
      workspaceId: 'ws-1',
      harnessSlug: 'h-1',
      slug: 'draft-plan',
      itemId: 'P-001',
      toStatus: 'wip',
      planContent: DRAFT_BODY,
    });
  });

  it('proceeds to the lease when the gate passes', async () => {
    readPlanM.mockResolvedValue(planRead(DRAFT_BODY));
    gateM.mockResolvedValue(null);
    claimM.mockResolvedValue(LEASE_CONFLICT);

    const result = await convertPlanItem(opts);

    expect(claimM).toHaveBeenCalledTimes(1);
    expect(result).toEqual(LEASE_CONFLICT);
  });

  it('hands the gate null (never a re-read) when the plan row carries no body', async () => {
    readPlanM.mockResolvedValue(planRead(undefined));
    gateM.mockResolvedValue(null);
    claimM.mockResolvedValue(LEASE_CONFLICT);

    await convertPlanItem(opts);

    expect(gateM.mock.calls[0]?.[0]).toMatchObject({ planContent: null });
  });

  it('fails OPEN on a gate lookup error: logs and still takes the lease', async () => {
    readPlanM.mockResolvedValue(planRead(DRAFT_BODY));
    gateM.mockRejectedValue(new Error('db unavailable'));
    claimM.mockResolvedValue(LEASE_CONFLICT);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await convertPlanItem(opts);

    expect(result).toEqual(LEASE_CONFLICT);
    expect(claimM).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('draft item-start gate skipped for draft-plan#P-001'));
  });

  it('does not consult the gate for an item that is already done (the existing refusal wins)', async () => {
    readPlanM.mockResolvedValue({
      parsed: { items: [] },
      archived: false,
      row: { items: [{ id: 'P-001', status: 'done', text: 'Build it' }], content: DRAFT_BODY },
    });

    const result = await convertPlanItem(opts);

    expect(result).toMatchObject({ status: 'refused', reason: 'plan item P-001 is already done' });
    expect(gateM).not.toHaveBeenCalled();
    expect(claimM).not.toHaveBeenCalled();
  });
});
