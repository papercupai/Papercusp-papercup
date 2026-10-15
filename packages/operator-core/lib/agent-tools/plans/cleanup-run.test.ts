import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  getFlag: vi.fn(),
  getActiveRun: vi.fn(),
  getRun: vi.fn(),
  setRunPhase: vi.fn(),
  failRunIfExecuting: vi.fn(),
  recordRunHeartbeat: vi.fn(),
  settleRunPhase: vi.fn(),
  notifyPlanCleanupRunChanged: vi.fn(),
  gatherCleanupInputs: vi.fn(),
  scanForCleanupFindings: vi.fn(),
  getRunFindings: vi.fn(),
  seedFindings: vi.fn(),
  executeCleanupFindingAction: vi.fn(),
  reportFindingOutcomes: vi.fn(),
  inProcessCall: vi.fn(),
  innerCall: vi.fn(),
  dispatchCleanupFindingAction: vi.fn(),
}));

vi.mock('@papercusp/flags/server', () => ({ getFlag: h.getFlag }));
vi.mock('../../attention/bulk-run-store', () => ({
  getActiveRun: h.getActiveRun,
  getRun: h.getRun,
  setRunPhase: h.setRunPhase,
  failRunIfExecuting: h.failRunIfExecuting,
  recordRunHeartbeat: h.recordRunHeartbeat,
  settleRunPhase: h.settleRunPhase,
}));
vi.mock('../../attention/bulk-run-sync', () => ({
  notifyPlanCleanupRunChanged: h.notifyPlanCleanupRunChanged,
}));
vi.mock('../../plan-cleanup/gather', () => ({ gatherCleanupInputs: h.gatherCleanupInputs }));
vi.mock('../../plan-cleanup/scanner', () => ({ scanForCleanupFindings: h.scanForCleanupFindings }));
vi.mock('../../plan-cleanup/run-store', () => ({
  getRunFindings: h.getRunFindings,
  seedFindings: h.seedFindings,
  executeCleanupFindingAction: h.executeCleanupFindingAction,
  reportFindingOutcomes: h.reportFindingOutcomes,
}));
vi.mock('../../plan-cleanup/action-dispatch', () => ({
  dispatchCleanupFindingAction: h.dispatchCleanupFindingAction,
}));
vi.mock('../_compound-dispatch', () => ({ inProcessCall: h.inProcessCall }));
vi.mock('../coordination/identity', () => ({
  resolveAgentIdentity: () => ({ ownerId: 'su-resolver' }),
}));

import { cleanupAct, cleanupManifest, cleanupReport } from './cleanup-run';
import { buildCleanupResolverBrief } from '../../plan-cleanup/resolver-brief';

function body(result: unknown): Record<string, unknown> {
  const text = (result as { content?: Array<{ text?: string }> })?.content?.[0]?.text;
  if (typeof text !== 'string') throw new Error(`not a tool result: ${JSON.stringify(result)}`);
  return JSON.parse(text) as Record<string, unknown>;
}

const run = {
  runId: 'cleanup-1',
  workspaceId: 'ws-1',
  harnessSlug: 'papercusp',
  phase: 'running',
  runKind: 'plan-cleanup',
  seedRefs: ['plan-a'],
  totalItems: 1,
  autoResolved: 0,
  recommended: 0,
  skipped: 0,
  failed: 0,
};

const finding = {
  findingId: 'flip-to-done:papercusp/plan-a#P-001',
  kind: 'flip-to-done',
  workspaceId: run.workspaceId,
  harnessSlug: run.harnessSlug,
  planSlug: 'plan-a',
  itemId: 'P-001',
  target: 'plan-a#P-001',
  from: 'wip',
  to: 'done',
  confidence: 'provable',
  autoApply: true,
  autoApplyBlockedBy: null,
  evidence: [{ kind: 'work-item', ref: 'WI-1', note: 'done with completion' }],
};

const stored = {
  ...finding,
  position: 0,
  outcome: 'pending',
  error: null,
  decidedAt: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  h.getFlag.mockResolvedValue(true);
  h.getRun.mockResolvedValue(run);
  h.recordRunHeartbeat.mockResolvedValue(run);
  h.failRunIfExecuting.mockResolvedValue({ ...run, phase: 'failed' });
  h.getActiveRun.mockResolvedValue(run);
  h.gatherCleanupInputs.mockResolvedValue({ plans: [], linkedWorkItems: [], claims: [] });
  h.scanForCleanupFindings.mockReturnValue([finding]);
  h.getRunFindings.mockResolvedValue([stored]);
  h.seedFindings.mockResolvedValue({ findings: [stored], refused: null });
  h.inProcessCall.mockReturnValue(h.innerCall);
  h.dispatchCleanupFindingAction.mockResolvedValue({ ok: true });
  h.notifyPlanCleanupRunChanged.mockResolvedValue(undefined);
  h.reportFindingOutcomes.mockResolvedValue({ updated: [], missing: [], run, refused: null });
});

describe('plans:cleanup-manifest', () => {
  it('seeds an empty run snapshot and joins the current auto-apply verdict', async () => {
    h.getRunFindings.mockResolvedValueOnce([]).mockResolvedValueOnce([stored]);
    const result = body(
      await cleanupManifest.handler({ runId: run.runId, includeReported: false }, {} as never),
    );
    expect(h.seedFindings).toHaveBeenCalledWith({
      runId: run.runId,
      findings: [finding],
      resolverOwner: 'su-resolver',
      workspaceId: run.workspaceId,
    });
    expect(result).toMatchObject({
      ok: true,
      stopped: false,
      findings: [
        expect.objectContaining({
          findingId: finding.findingId,
          autoApply: true,
          autoApplyBlockedBy: null,
          current: true,
        }),
      ],
    });
  });

  it('revokes authority when the kill switch is off without hiding the manifest', async () => {
    h.getFlag.mockResolvedValue(false);
    const result = body(
      await cleanupManifest.handler({ runId: run.runId, includeReported: false }, {} as never),
    );
    expect(result).toMatchObject({ ok: true, featureDisabled: true, stopped: true });
  });

  it('marks only findings missing from the current scan as stale', async () => {
    h.scanForCleanupFindings.mockReturnValue([]);
    const result = body(
      await cleanupManifest.handler({ runId: run.runId, includeReported: false }, {} as never),
    );
    expect(result).toMatchObject({
      ok: true,
      findings: [
        expect.objectContaining({
          findingId: finding.findingId,
          autoApply: false,
          autoApplyBlockedBy: 'stale-finding',
          current: false,
        }),
      ],
    });
  });

  it('applies the run confidence policy to the manifest verdict that cleanup-act enforces', async () => {
    const policyRun = {
      ...run,
      automationPolicy: { mode: 'review-all', minConfidence: 'high' },
    };
    h.getRun.mockResolvedValue(policyRun);
    h.recordRunHeartbeat.mockResolvedValue(policyRun);

    const manifest = body(
      await cleanupManifest.handler({ runId: run.runId, includeReported: false }, {} as never),
    );
    expect(manifest).toMatchObject({
      findings: [
        expect.objectContaining({
          findingId: finding.findingId,
          current: true,
          autoApply: false,
          autoApplyBlockedBy: 'review-all',
        }),
      ],
    });

    const action = body(
      await cleanupAct.handler(
        { runId: run.runId, findingId: finding.findingId, rationale: 'The linked work is complete.' },
        { workspaceId: run.workspaceId } as never,
      ),
    );
    expect(action).toMatchObject({
      ok: false,
      refused: 'confidence_policy',
      reason: 'review-all',
    });
    expect(h.executeCleanupFindingAction).not.toHaveBeenCalled();
    expect(h.dispatchCleanupFindingAction).not.toHaveBeenCalled();
  });
});

describe('plans:cleanup-act', () => {
  it('uses the same risk grant in the manifest and locked action for archive candidates', async () => {
    const archive = { ...finding, findingId: 'archive-candidate:papercusp/plan-a', itemId: null, kind: 'archive-candidate', confidence: 'recommended',
      autoApply: false, autoApplyBlockedBy: 'judgment-call' };
    const policy = { mode: 'safe-high', level: 'L2', minConfidence: 'medium',
      riskLevels: { low: 'automatic', medium: 'automatic', high: 'automatic' } };
    h.getRun.mockResolvedValue({ ...run, automationPolicy: policy });
    h.recordRunHeartbeat.mockResolvedValue({ ...run, automationPolicy: policy });
    h.scanForCleanupFindings.mockReturnValue([archive]);
    h.getRunFindings.mockResolvedValue([{ ...archive, outcome: 'pending' }]);
    h.executeCleanupFindingAction.mockImplementation(async (input) => ({
      actionResult: await input.execute({ ...stored, ...archive }),
      finding: { ...stored, ...archive, outcome: 'auto_applied' }, run, refused: null,
    }));
    const manifest = body(await cleanupManifest.handler({ runId: run.runId }, {} as never));
    expect((manifest.findings as Array<Record<string, unknown>>)[0]).toMatchObject({ risk: 'medium', autoApply: true, autoApplyBlockedBy: null });
    const result = body(await cleanupAct.handler({ runId: run.runId, findingId: archive.findingId, rationale: 'All ledger items terminal; no active holds.' }, {} as never));
    expect(result).toMatchObject({ ok: true, outcome: 'auto_applied', actionDispatched: true });
    expect(h.dispatchCleanupFindingAction).toHaveBeenCalledWith(expect.objectContaining({ finding: archive }));
  });

  it('re-verifies and dispatches inside the store authority callback', async () => {
    h.executeCleanupFindingAction.mockImplementation(async (input: {
      execute: (locked: typeof stored) => Promise<unknown>;
    }) => {
      const actionResult = await input.execute(stored);
      return {
        actionResult,
        finding: { ...stored, outcome: 'auto_applied' },
        run: { ...run, autoResolved: 1 },
        refused: null,
      };
    });
    const result = body(
      await cleanupAct.handler(
        { runId: run.runId, findingId: finding.findingId, rationale: 'The linked work is complete.' },
        { workspaceId: run.workspaceId } as never,
      ),
    );
    expect(h.dispatchCleanupFindingAction).toHaveBeenCalledWith({
      run,
      finding,
      call: h.innerCall,
    });
    expect(h.executeCleanupFindingAction).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: run.runId,
        findingId: finding.findingId,
        rationale: 'The linked work is complete.',
        resolverOwner: 'su-resolver',
        workspaceId: run.workspaceId,
      }),
    );
    expect(result).toMatchObject({ ok: true, actionDispatched: true, outcome: 'auto_applied' });
  });

  it('does not enter dispatch when Stop already revoked authority', async () => {
    h.executeCleanupFindingAction.mockResolvedValue({
      actionResult: null,
      finding: null,
      run: { ...run, phase: 'review' },
      refused: { reason: 'run_authority_revoked', phase: 'review' },
    });
    const result = body(
      await cleanupAct.handler(
        { runId: run.runId, findingId: finding.findingId, rationale: 'Evidence is terminal.' },
        { workspaceId: run.workspaceId } as never,
      ),
    );
    expect(h.dispatchCleanupFindingAction).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      ok: false,
      refused: 'run_authority_revoked',
      actionDispatched: false,
    });
  });
});

describe('plans:cleanup-report rails', () => {
  it('cannot represent auto_applied and requires reasons for non-action outcomes', () => {
    expect(
      cleanupReport.args.safeParse({
        runId: run.runId,
        items: [{ findingId: finding.findingId, outcome: 'auto_applied', rationale: 'done' }],
      }).success,
    ).toBe(false);
    expect(
      cleanupReport.args.safeParse({
        runId: run.runId,
        items: [{ findingId: finding.findingId, outcome: 'recommended' }],
      }).success,
    ).toBe(false);
    expect(
      cleanupReport.args.safeParse({
        runId: run.runId,
        items: [{ findingId: finding.findingId, outcome: 'failed' }],
      }).success,
    ).toBe(false);
  });
});

describe('cleanup resolver brief', () => {
  it('pins the authoritative action and stopping contract', () => {
    const brief = buildCleanupResolverBrief(run.runId, run.seedRefs);
    expect(brief).toContain(`plans:cleanup-manifest { runId: "${run.runId}" }`);
    expect(brief).toContain('plans:cleanup-act is intentionally one action per call');
    expect(brief).toContain('hold the SAME run-row lock');
    expect(brief).toContain('When stopped:true, halt immediately');
  });
});
