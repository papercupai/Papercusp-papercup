import { describe, expect, it, vi } from 'vitest';
import { CARRY_SHIPMENT_PLAN, measureCarryDrillShipment, type CarryShipmentReceipts } from './carry-drill-shipment';
import type { ColdBootDrillHostEvent, measureCarryDrillLifecycle } from './cold-boot-drill-live';
import { mockResolvedTyped } from './testing/typed-mock';

const sha = 'a'.repeat(40), at = (second: number) => `2026-10-22T00:00:${String(second).padStart(2,'0')}.000Z`;
const input = { workspaceId: 'workspace', harnessSlug: 'papercusp', planSlug: CARRY_SHIPMENT_PLAN,
  ownerId: 'su-test', drillId: 'drill-test', deploymentId: '42', reportId: 'rpt-test', windowStart: at(0), windowEnd: at(59) };
function nativeEvidence() {
  const call = (tool: string, op: string, second: number) => ({ id: String(second), tool, status: 'ok', at: at(second),
    durationMs: 1000, args: { op, drillId: input.drillId } as Record<string, unknown>,
    servingHost: 'port-3070', servingProcess: 'linux:boot:123', servingSha: sha.slice(0,10) });
  const receipts: CarryShipmentReceipts = {
    deployment: { id: '42', kind: 'deploy', status: 'ok', at: at(2), detail: { fullTargetSha: sha } },
    promotions: [{ id: '41', kind: 'green_checkpoint', status: 'advanced', at: at(1), detail: { candidate: sha } }],
    invocations: [call('session:carry-drill','start',3),call('session:carry-drill','grade',5),
      call('session:carry-drill','verify',6),call('session:carry-drill','report',7),
      { ...call('reports:get','',9), args: { id: input.reportId } }, call('session:end','',10)],
    report: { id: input.reportId, subjectKind: 'plan', subjectRef: input.planSlug, visibility: 'owner', at: at(8),
      body: `${input.ownerId} ${input.drillId} ${sha}` },
  };
  const host: ColdBootDrillHostEvent[] = [{ kind: 'shutdown-accepted', ts: at(11) }, { kind: 'host-teardown', ts: at(12) }];
  const deps = {
    lifecycle: vi.fn<typeof measureCarryDrillLifecycle>(async () => ({ verdict: 'pass', reason: 'native', scope: 'selected-codex-interactive-drill',
      ownerId: input.ownerId, drillId: input.drillId, requestedAt: at(3) })),
    receipts: vi.fn(async () => receipts), containsSource: vi.fn(async (): Promise<boolean | null> => true),
    hostEvents: vi.fn(async () => host), hostGone: vi.fn(async () => true),
  };
  return { receipts, host, deps };
}

describe('objective carry shipment joins native existing receipts', () => {
  it('proves deployed identity, green containment, report readback and cleanup after host exit', async () => {
    const h = nativeEvidence(), measured = await measureCarryDrillShipment(input,h.deps);
    expect(measured).toMatchObject({ verdict: 'pass', deployedSha: sha, reportId: input.reportId });
    expect(h.deps.containsSource).toHaveBeenCalledWith(sha);
    expect(measured.evidenceRefs).toContain('pipeline-event:42');
  });
  it.each(['wrong-build','staging','process-skew','source-missing','failed-deploy','foreign-report','no-owner-visibility',
    'duplicate-grade','live-host','report-before-drill','cleanup-outside-window'])(
    'contradicts %s instead of accepting lifecycle-only success', async defect => {
      const h = nativeEvidence();
      if (defect === 'wrong-build') h.receipts.invocations[0].servingSha = 'b'.repeat(10);
      if (defect === 'staging') h.receipts.invocations[0].servingHost = 'port-3170';
      if (defect === 'process-skew') h.receipts.invocations[2].servingProcess = 'other-process';
      if (defect === 'source-missing') h.deps.containsSource.mockResolvedValue(false);
      if (defect === 'failed-deploy') h.receipts.deployment!.status = 'error';
      if (defect === 'foreign-report') h.receipts.report!.subjectRef = 'foreign';
      if (defect === 'no-owner-visibility') h.receipts.report!.visibility = 'pot';
      if (defect === 'duplicate-grade') h.receipts.invocations.push({ ...h.receipts.invocations[1] });
      if (defect === 'live-host') h.deps.hostGone.mockResolvedValue(false);
      if (defect === 'report-before-drill') h.receipts.report!.at = at(4);
      if (defect === 'cleanup-outside-window') h.host[1].ts = '2026-10-23T00:00:00Z';
      expect((await measureCarryDrillShipment(input,h.deps)).verdict).toBe('fail');
    });
  it.each(['no-green','no-report','no-readback','no-cleanup-call','no-shutdown','no-teardown','source-unknown',
    'no-serving-identity','foreign-start','unreadable'])(
    'keeps %s evidence non-pass', async defect => {
      const h = nativeEvidence();
      if (defect === 'no-green') h.receipts.promotions = [];
      if (defect === 'no-report') h.receipts.report = null;
      if (defect === 'no-readback') h.receipts.invocations.splice(4,1);
      if (defect === 'no-cleanup-call') h.receipts.invocations.pop();
      if (defect === 'no-shutdown') h.host.shift();
      if (defect === 'no-teardown') h.host.pop();
      if (defect === 'source-unknown') h.deps.containsSource.mockResolvedValue(null);
      if (defect === 'no-serving-identity') h.receipts.invocations[0].servingProcess = null;
      if (defect === 'foreign-start') h.receipts.invocations[0].at = at(7);
      if (defect === 'unreadable') h.deps.receipts.mockRejectedValue(new Error('ledger unavailable'));
      expect((await measureCarryDrillShipment(input,h.deps)).verdict).not.toBe('pass');
    });
  it('never reads shipment state when the lifecycle cannot pass', async () => {
    const h = nativeEvidence();
    mockResolvedTyped(h.deps.lifecycle, { verdict: 'fail', reason: 'drop', scope: 'selected-codex-interactive-drill',
      ownerId: input.ownerId, drillId: input.drillId, requestedAt: at(3) });
    expect((await measureCarryDrillShipment(input,h.deps)).verdict).toBe('fail');
    expect(h.deps.receipts).not.toHaveBeenCalled();
  });
  it.each(['after-cleanup', 'during-cleanup', 'cleanup-before-publication'])(
    'rejects report readback ordering: %s', async defect => {
      const h = nativeEvidence();
      if (defect === 'after-cleanup') h.receipts.invocations[4].at = at(13);
      if (defect === 'during-cleanup') h.receipts.invocations[4].at = '2026-10-22T00:00:09.500Z';
      if (defect === 'cleanup-before-publication') h.receipts.invocations[5].durationMs = 3000;
      expect(await measureCarryDrillShipment(input, h.deps)).toMatchObject({ verdict: 'fail' });
    });
  it('retains a completed pre-cleanup readback when another read occurs afterward', async () => {
    const h = nativeEvidence();
    h.receipts.invocations.push({ ...h.receipts.invocations[4], id: '13', at: at(13) });
    expect((await measureCarryDrillShipment(input, h.deps)).verdict).toBe('pass');
  });
  it('accepts only the actually advanced prefix, not a red candidate tip', async () => {
    const h = nativeEvidence();
    h.receipts.promotions[0] = { ...h.receipts.promotions[0], status: 'advanced-prefix', detail: { candidate: 'b'.repeat(40), advancedTo: sha } };
    expect((await measureCarryDrillShipment(input,h.deps)).verdict).toBe('pass');
    delete h.receipts.promotions[0].detail.advancedTo;
    expect((await measureCarryDrillShipment(input,h.deps)).verdict).toBe('unknown');
  });
  it('uses invocation settle-time minus measured duration, including short stored promotion SHAs', async () => {
    const h = nativeEvidence();
    h.receipts.invocations[0].at = at(4);
    h.receipts.invocations[0].durationMs = 1000;
    h.receipts.promotions[0].detail.candidate = sha.slice(0,12);
    expect((await measureCarryDrillShipment(input,h.deps)).verdict).toBe('pass');
  });
});
