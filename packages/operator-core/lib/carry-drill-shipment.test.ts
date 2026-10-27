import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { CARRY_SHIPMENT_PLAN, CARRY_SHIPMENT_SOURCE_PATHS, measureCarryDrillShipment, type CarryShipmentReceipts } from './carry-drill-shipment';
import { reportBodySha256 } from './report-library';
import type { ColdBootDrillHostEvent, measureCarryDrillLifecycle } from './cold-boot-drill-live';
import { mockResolvedTyped } from './testing/typed-mock';

const checkout = vi.hoisted(() => ({ root: '' }));
const authority = vi.hoisted(() => ({ root: '',
  items: [{ itemId: 'P-001', status: 'done' }, { itemId: 'P-002', status: 'wip' }, { itemId: 'P-003', status: 'dropped' }],
  audits: [] as Array<{ auditSeq: number; entry: { itemId: string; citations: Array<{ path: string }> } }>,
  changed: [] as Array<{ itemId: string; workItemId: string; path: string; source: string }>,
  readFiles: vi.fn(),
}));
vi.mock('@papercusp/db-org', async importOriginal => ({
  ...await importOriginal<typeof import('@papercusp/db-org')>(),
  withWorkspace: async (_workspace: string, work: () => unknown) => work(),
}));
vi.mock('./harness-registry', () => ({ loadHarnessRegistry: async () => ({}), resolveHarnessContentPath: () => authority.root }));
vi.mock('./plan-audits', () => ({
  getPlanItemStatuses: async () => authority.items, getEffectiveItemAudits: async () => authority.audits,
}));
vi.mock('./agent-tools/plans/audit-derived-citations', () => ({ readAttributedAuditFiles: authority.readFiles }));
vi.mock('./module-repo-root', async importOriginal => {
  const original = await importOriginal<typeof import('./module-repo-root')>();
  return { ...original, moduleRepoRoot: (url: string) =>
    checkout.root && url.endsWith('/carry-drill-shipment.ts') ? checkout.root : original.moduleRepoRoot(url) };
});

const sha = 'a'.repeat(40), at = (second: number) => `2026-10-22T00:00:${String(second).padStart(2,'0')}.000Z`;
const input = { workspaceId: 'workspace', harnessSlug: 'papercusp', planSlug: CARRY_SHIPMENT_PLAN,
  ownerId: 'su-test', drillId: 'drill-test', deploymentId: '42', reportId: 'rpt-test', windowStart: at(0), windowEnd: at(59) };
function nativeEvidence() {
  const call = (tool: string, op: string, second: number) => ({ id: String(second), tool, status: 'ok', at: at(second),
    durationMs: 1000, args: { op, drillId: input.drillId } as Record<string, unknown>,
    servingHost: 'port-3070', servingProcess: 'linux:boot:123', servingSha: sha.slice(0,10),
    metadata: {} as Record<string, unknown> });
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
  Object.assign(receipts.invocations[4], { metadata: { reportReadbacks: [{
    id: input.reportId, bodySha256: reportBodySha256(receipts.report!.body),
    bodyBytes: Buffer.byteLength(receipts.report!.body), visibility: 'owner', publishedAt: at(8),
  }] } });
  const metadata = receipts.invocations[4].metadata!;
  metadata.reportResultDelivery = { version: 1, deliveredAt: at(9), inline: metadata.reportReadbacks };
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
      (h.receipts.invocations[4].metadata!.reportResultDelivery as { deliveredAt: string }).deliveredAt = h.receipts.invocations[4].at;
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
  it.each(['missing', 'soft-failure', 'not-found', 'foreign-id', 'partial-body', 'partial-bytes', 'wrong-visibility', 'wrong-edition'])(
    'does not equate dispatch success with complete report readback: %s', async defect => {
      const h = nativeEvidence();
      const metadata = (h.receipts.invocations[4] as unknown as { metadata: Record<string, unknown> }).metadata;
      const readback = (metadata.reportReadbacks as Array<Record<string, unknown>>)[0];
      if (defect === 'missing') delete metadata.reportReadbacks;
      if (defect === 'soft-failure') metadata.resultOutcome = 'soft-failure';
      if (defect === 'not-found') metadata.reportReadbacks = [];
      if (defect === 'foreign-id') readback.id = 'rpt-foreign';
      if (defect === 'partial-body') readback.bodySha256 = reportBodySha256(h.receipts.report!.body.slice(0, 8));
      if (defect === 'partial-bytes') readback.bodyBytes = 8;
      if (defect === 'wrong-visibility') readback.visibility = 'pot';
      if (defect === 'wrong-edition') readback.publishedAt = at(7);
      expect((await measureCarryDrillShipment(input, h.deps)).verdict).not.toBe('pass');
    });
  it.each(['missing-final-receipt', 'truncated', 'spill-unread', 'spill-gap', 'spill-after-cleanup'])(
    'does not accept a full handler readback with incomplete final delivery: %s', async defect => {
      const h = nativeEvidence(), metadata = h.receipts.invocations[4].metadata!;
      const spill = { uri: 'papercusp://scratch/ws/reports:get/run/result.spill', sha256: 'b'.repeat(64),
        bytes: 10, reports: metadata.reportReadbacks };
      metadata.reportResultDelivery = { version: 1, deliveredAt: at(9), inline: [],
        ...(defect.startsWith('spill-') ? { spill } : {}) };
      if (defect === 'missing-final-receipt') delete metadata.reportResultDelivery;
      if (defect === 'spill-gap' || defect === 'spill-after-cleanup') {
        h.receipts.invocations.push({ ...h.receipts.invocations[4], tool: 'capability:read', id: 'page', at: at(9),
          metadata: { scratchResultDelivery: { version: 1, deliveredAt: at(defect === 'spill-gap' ? 9 : 10),
            uri: spill.uri, sha256: spill.sha256, totalBytes: 10, offset: 0, bytes: defect === 'spill-gap' ? 9 : 10 } } });
      }
      expect((await measureCarryDrillShipment(input, h.deps)).verdict).not.toBe('pass');
    });
  it('accepts a complete spill only after its matching pages finish before cleanup', async () => {
    const h = nativeEvidence(), metadata = h.receipts.invocations[4].metadata!;
    const spill = { uri: 'papercusp://scratch/ws/reports:get/run/result.spill', sha256: 'b'.repeat(64),
      bytes: 10, reports: metadata.reportReadbacks };
    metadata.reportResultDelivery = { version: 1, deliveredAt: at(9), inline: [], spill };
    for (const offset of [5, 0]) h.receipts.invocations.push({ ...h.receipts.invocations[4], tool: 'capability:read',
      id: `page-${offset}`, at: at(9), metadata: { scratchResultDelivery: { version: 1, deliveredAt: at(9),
        uri: spill.uri, sha256: spill.sha256, totalBytes: 10, offset, bytes: 5 } } });
    expect((await measureCarryDrillShipment(input, h.deps)).verdict).toBe('pass');
  });
});

describe('carry shipment compares the independent canonical source population', () => {
  const roots: string[] = [];
  afterEach(() => {
    checkout.root = '';
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });
  function repositories() {
    const root = mkdtempSync(join(tmpdir(), 'carry-shipment-source-'));
    roots.push(root);
    const canonical = join(root, 'canonical'), deployed = join(root, 'deployed');
    const extra = 'packages/operator-core/lib/carry-note.ts';
    const paths = [...CARRY_SHIPMENT_SOURCE_PATHS, extra];
    mkdirSync(canonical);
    const git = (cwd: string, ...args: string[]) => execFileSync('git', args,
      { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    git(canonical, 'init', '-q');
    git(canonical, 'config', 'user.email', 'fixture@example.test');
    git(canonical, 'config', 'user.name', 'Fixture');
    for (const path of paths) { mkdirSync(dirname(join(canonical, path)), { recursive: true }); writeFileSync(join(canonical, path), 'initial\n'); }
    git(canonical, 'add', '.'); git(canonical, 'commit', '-qm', 'initial');
    const deployedSha = git(canonical, 'rev-parse', 'HEAD');
    git(root, 'clone', '-q', canonical, deployed);
    checkout.root = deployed;
    const h = nativeEvidence();
    h.receipts.deployment!.detail.fullTargetSha = deployedSha;
    h.receipts.promotions[0].detail.candidate = deployedSha;
    for (const call of h.receipts.invocations) call.servingSha = deployedSha.slice(0, 10);
    h.receipts.report!.body = `${input.ownerId} ${input.drillId} ${deployedSha}`;
    Object.assign(h.receipts.invocations[4], { metadata: { reportReadbacks: [{
      id: input.reportId, bodySha256: reportBodySha256(h.receipts.report!.body),
      bodyBytes: Buffer.byteLength(h.receipts.report!.body), visibility: 'owner', publishedAt: at(8),
    }] } });
    const metadata = h.receipts.invocations[4].metadata!;
    metadata.reportResultDelivery = { version: 1, deliveredAt: at(9), inline: metadata.reportReadbacks };
    const source = { root: canonical, reviewedPaths: paths, changedPaths: paths };
    const deps = { ...h.deps, containsSource: undefined, sourceAuthority: async () => source };
    return { canonical, extra, git, h, source, deps };
  }
  it('rejects canonical carry changes even when the evaluator and deployed checkout agree with themselves', async () => {
    const f = repositories();
    expect(await measureCarryDrillShipment(input, f.deps)).toMatchObject({ verdict: 'pass',
      source: { canonicalRoot: f.canonical, canonicalCommit: f.git(f.canonical, 'rev-parse', 'HEAD'),
        paths: expect.arrayContaining([f.extra]) } });
    writeFileSync(join(f.canonical, f.extra), 'new carry behavior\n');
    f.git(f.canonical, 'add', '.'); f.git(f.canonical, 'commit', '-qm', 'carry change');
    expect((await measureCarryDrillShipment(input, f.deps)).verdict).toBe('fail');
  });
  it.each(['unreviewed-change', 'dirty-source', 'missing-source'])(
    'keeps incomplete canonical population evidence non-pass: %s', async defect => {
      const f = repositories();
      if (defect === 'unreviewed-change') f.source.reviewedPaths = f.source.reviewedPaths.filter(p => p !== f.extra);
      if (defect === 'dirty-source') writeFileSync(join(f.canonical, f.extra), 'uncommitted carry change\n');
      if (defect === 'missing-source') f.source.reviewedPaths.push('packages/operator-core/lib/missing-carry.ts');
      expect((await measureCarryDrillShipment(input, f.deps)).verdict).not.toBe('pass');
    });
  it.each(['complete', 'missing-audit', 'omitted-attributed-path', 'at-ceiling', 'below-ceiling'])(
    'uses production audit and attribution acquisition for %s', async defect => {
      const f = repositories();
      authority.root = f.canonical;
      authority.audits = ['P-001', 'P-002'].map((itemId, index) => ({ auditSeq: index + 1,
        entry: { itemId, citations: f.source.reviewedPaths.filter(path =>
          defect !== 'omitted-attributed-path' || path !== f.extra).map(path => ({ path })) } }));
      if (defect === 'missing-audit') authority.audits.pop();
      const changed = f.source.changedPaths.map(path => ({ itemId: 'P-001', workItemId: 'WI-test', path, source: 'edit' }));
      authority.changed = defect.endsWith('ceiling')
        ? Array.from({ length: defect === 'at-ceiling' ? 5000 : 4999 }, () => changed[0]) : changed;
      authority.readFiles.mockReset().mockImplementation(async () => authority.changed);
      // Do not inject sourceAuthority: exercise readCarrySourceAuthority and its real population joins.
      const result = await measureCarryDrillShipment(input, { ...f.deps, sourceAuthority: undefined });
      expect(result.verdict).toBe(['complete', 'below-ceiling'].includes(defect) ? 'pass' : 'unknown');
      if (defect !== 'missing-audit') expect(authority.readFiles).toHaveBeenCalledWith(expect.objectContaining({
        workspaceId: input.workspaceId, harnessSlug: input.harnessSlug, planSlug: input.planSlug, itemIds: ['P-001', 'P-002'],
      }));
      else expect(authority.readFiles).not.toHaveBeenCalled();
      if (result.verdict === 'pass') expect(result.source?.auditedItems).toEqual([
        { itemId: 'P-001', auditSeq: 1 }, { itemId: 'P-002', auditSeq: 2 },
      ]);
    });
});
