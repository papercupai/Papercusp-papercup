import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FLAGS } from '@papercusp/flags';
import { getFlag } from '@papercusp/flags/server';
import { getOrgPg, withWorkspace } from '@papercusp/db-org';
import setPlanStatusTool from './set-plan-status';
import { withPlanLock } from './with-plan-lock';
import { readAcceptanceBarContractSnapshot, type AcceptanceBarContractSnapshot } from '../../acceptance-bar-contract-snapshot';
import { evaluateAcceptanceBarLifecycle } from '../../acceptance-bar-lifecycle-evaluator';

vi.mock('@papercusp/flags/server', () => ({ getFlag: vi.fn() }));
vi.mock('@papercusp/db-org', async (original) => ({
  ...(await original<typeof import('@papercusp/db-org')>()),
  getOrgPg: vi.fn(),
  // Plan pin resolution uses this transaction seam, not getOrgPg().sql (WI-26610267819720289).
  withWorkspace: vi.fn(async (_workspaceId: string, callback: (tx: unknown) => unknown) =>
    callback(async () => [])),
}));
vi.mock('../../workspace-registry', () => ({ activeWorkspaceId: () => 'ws-test' }));
vi.mock('../../acceptance-bar-contract-snapshot', async (original) => ({
  ...(await original<typeof import('../../acceptance-bar-contract-snapshot')>()),
  readAcceptanceBarContractSnapshot: vi.fn(),
}));
vi.mock('./with-plan-lock', async (original) => ({
  ...(await original<typeof import('./with-plan-lock')>()), withPlanLock: vi.fn(),
}));

function contract(): AcceptanceBarContractSnapshot {
  // All earlier BAR checks, independent grading and author acceptance are green.
  // The live handler must still refuse an unmet original outcome.
  return {
    applicable: true, plan: { adoptionEpoch: 1 },
    rubric: { ratingScale: ['healthy', 'broken', 'unknown'], classRef: 'plan-class-feature-ship' },
    completeness: { problems: [] }, readiness: { nextRepair: null },
    grading: { vetting: { state: 'current' }, authorVerdict: { state: 'accepted' } },
    bars: [{ barKey: 'R-1', barHash: 'a'.repeat(64), model: 'Wallet login completes via a signed nonce.',
      falsifier: 'A real wallet cannot complete authentication.', role: 'outcome', mandatory: true,
      requiredScope: ['wallet-login'], requiredTestLayers: ['e2e'], evidencePlane: 'tree',
      passRatings: ['healthy'], provenance: { lifecycle: 'pre-implementation' },
      method: 'Exercise the wallet login entry point.', check: { kind: 'instrument', instrumentKey: 'none' },
      readiness: { codes: [] },
      proof: { state: 'current', uncertainEvidence: 0, evidencePlanes: ['tree'],
        adequacy: { state: 'fail', checks: [{ specId: 'wallet', revision: 1,
          verdict: 'fail', wouldBlock: ['correct-layer'], evidenceRefs: ['unit:wallet-core'] }] } },
      grading: { state: 'pass' },
    }],
  } as unknown as AcceptanceBarContractSnapshot;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getFlag).mockImplementation(async (flag) => flag === FLAGS.ACCEPTANCE_RUBRIC_COMPLETION_GATE);
  vi.mocked(getOrgPg).mockReturnValue({ sql: vi.fn(async () => [{
    plan_slug: 'wallet-plan', harness_slug: 'papercusp', status: 'ready', acceptance_bar_epoch: 1,
    content: '## Requirements\n**R-1 — Wallet login.** Signed nonce login must work.\n',
  }]) } as unknown as ReturnType<typeof getOrgPg>);
  vi.mocked(readAcceptanceBarContractSnapshot).mockResolvedValue(contract());
});

describe('requirement fulfillment at the actual ship door', () => {
  it.each(['shipped', 'done'] as const)('refuses %s plus generic force before any lifecycle write', async (status) => {
    const current = [{ evidenceKind: 'test' as const, evidenceRef: 'unit:wallet-core', sourceFingerprint: 'measured-head' }];
    const args = setPlanStatusTool.args.parse({ harness: 'papercusp', slug: 'wallet-plan', status, current,
      force: { reason: 'D-045: tests prove the seam; a later plan will connect the real wallet.' } });
    const result = await setPlanStatusTool.handler(args, {
      harnessSlug: 'papercusp', workspaceId: 'ws-test', ownerId: 'su-shipper', isSuperuser: true,
    } as never);
    expect(JSON.stringify(result)).toContain('acceptance_bar_contract_not_ready');
    expect(JSON.stringify(result)).toContain('bar_snapshot_proof_inadequate');
    const body = (result as { data: { results: unknown[] } }).data;
    expect(body.results[0]).toMatchObject({
      ok: false, code: 'acceptance_bar_contract_not_ready',
      acceptanceBarLifecycle: {
        phase: 'ship', codes: ['bar_snapshot_proof_inadequate'],
        blockingBars: [{ barKey: 'R-1', codes: ['bar_snapshot_proof_inadequate'] }],
      },
      repairAction: {
        kind: 'diagnostic',
        nextVerb: {
          name: 'plans:get',
          args: { slug: 'wallet-plan', harness: 'papercusp', mode: 'meta', shipReadiness: true, current },
        },
      },
    });
    expect(withPlanLock).not.toHaveBeenCalled();
    expect(withWorkspace).toHaveBeenCalledWith('ws-test', expect.any(Function));
    expect(readAcceptanceBarContractSnapshot).toHaveBeenCalledWith(
      'wallet-plan',
      {},
      { current, harnessSlug: 'papercusp' },
    );
  });

  it('requires an explicit proof level; a positive grade cannot substitute for it', () => {
    const snapshot = contract();
    snapshot.bars[0]!.requiredTestLayers = [];
    expect(evaluateAcceptanceBarLifecycle(snapshot, 'ship').codes).toContain('bar_snapshot_proof_depth_missing');
  });

  it('admits verified fulfillment through the same requirement gate', () => {
    const snapshot = contract();
    snapshot.bars[0]!.proof.adequacy = { state: 'pass', checks: [{ specId: 'wallet', revision: 1,
      verdict: 'pass', wouldBlock: [], evidenceRefs: ['e2e:wallet-login'] }] };
    expect(evaluateAcceptanceBarLifecycle(snapshot, 'ship').satisfied).toBe(true);
  });
});
