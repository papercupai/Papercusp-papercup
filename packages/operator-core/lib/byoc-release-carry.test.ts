import { describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import type { TaskReleaseJournal, TaskReleaseReceipt } from './task-manager/store';
import {
  BYOC_RELEASE_MILESTONES,
  projectByocReleaseCarry,
  projectByocReleaseMilestones,
  readByocReleaseAcceptance,
  readLinkedByocReleaseCarries,
  renderByocReleaseCarry,
} from './byoc-release-carry';
import { buildCarryBrief, renderCarryBriefColdExtras, type CarryBrief } from './carry-brief';
import {
  resolveWorkspaceHostSoakPolicy,
  WORKSPACE_HOST_SOAK_ACCEPTANCE_DURATION_MS,
  WORKSPACE_HOST_SOAK_CHECKS,
} from './workspace-host/soak';
import type { WorkspaceHostSoakRecord } from './workspace-host/soak-store';

function journal(overrides: Partial<TaskReleaseJournal> = {}): TaskReleaseJournal {
  return {
    schemaVersion: 1,
    operationId: 'release-op-current',
    source: { sha: 'a'.repeat(40), gitlinks: { desktop: 'b'.repeat(40) } },
    artifactIdentity: { kind: 'papercusp-desktop-release', version: '0.0.19', channel: 'nightly' },
    credential: { generation: 'credential-7', expiresAt: '2026-09-13T00:00:00.000Z' },
    cursor: 2,
    currentStage: 'publish.multipart.initiate',
    currentState: 'unknown',
    spentOperationIds: ['request-spent-1'],
    receipts: [
      {
        sequence: 0, operationId: 'release-op-current', requestIdentity: 'request-spent-1',
        stage: 'publish.multipart.initiate', state: 'intent', inputHash: 'c'.repeat(64),
        inputIdentity: { longImmutableInput: 'x'.repeat(1600) },
        evidenceRefs: ['manifest:sha256:' + 'd'.repeat(64)],
        credentialGeneration: 'credential-7', credentialExpiresAt: '2026-09-13T00:00:00.000Z',
        recordedAt: '2026-09-12T18:00:00.000Z',
      },
      {
        sequence: 1, operationId: 'release-op-current', requestIdentity: 'request-spent-1',
        stage: 'publish.multipart.initiate', state: 'unknown', inputHash: 'c'.repeat(64),
        inputIdentity: { longImmutableInput: 'x'.repeat(1600) }, evidenceRefs: ['provider-response:lost'],
        credentialGeneration: 'credential-7', credentialExpiresAt: '2026-09-13T00:00:00.000Z',
        recordedAt: '2026-09-12T18:01:00.000Z',
      },
    ],
    ...overrides,
  };
}

const DAY = 24 * 60 * 60_000;

function completedSoak(durationMs = DAY) {
  const policy = resolveWorkspaceHostSoakPolicy({ durationMs });
  const first = Date.parse('2026-10-12T00:00:00.000Z');
  const record: WorkspaceHostSoakRecord = {
    soakId: 'soak-1', malformedRows: 0,
    envelope: { policy, releaseTaskId: 'release-task' },
    samples: Array.from({ length: durationMs / policy.intervalMs + 1 }, (_, sequence) => ({
      schemaVersion: 1, soakId: 'soak-1', sequence,
      observedAt: new Date(first + sequence * policy.intervalMs).toISOString(),
      pinned: { instanceId: 'instance-1', image: 'image-1' },
      checks: WORKSPACE_HOST_SOAK_CHECKS.map((name) => ({ name, ok: true })),
    })),
  };
  const receipts: TaskReleaseReceipt[] = BYOC_RELEASE_MILESTONES.map((milestone, sequence) => ({
    sequence, operationId: 'release-op-current', requestIdentity: `request-${sequence}`,
    stage: milestone.stages[0], state: 'committed',
    inputHash: String(sequence).repeat(64), recordedAt: record.samples.at(-1)!.observedAt,
    evidenceRefs: [`receipt:${milestone.key}`],
  }));
  const soak = receipts.find(({ stage }) => stage === 'acceptance.soak')!;
  soak.inputIdentity = { stageIdentity: { policy, bundleSha256: 'd'.repeat(64) } };
  soak.evidenceRefs = [
    'soak:soak-1', 'soak-host:workspace-1/host-1', 'soak-incarnation:instance-1',
    'soak-image:image-1', 'soak-verdict:pass',
    `soak-window:${record.samples[0]!.observedAt}/${record.samples.at(-1)!.observedAt}`,
  ];
  const source = journal({
    receipts, cursor: receipts.length, currentStage: receipts.at(-1)!.stage, currentState: 'committed',
    artifactIdentity: { bundleSha256: 'd'.repeat(64) },
  });
  return { source, soak, record };
}

describe('BYOC strict soak acceptance', () => {
  it('keeps the ordinary one-hour view but rejects it for a literal 24-hour bar', () => {
    const { source } = completedSoak(60 * 60_000);
    expect(projectByocReleaseMilestones(source).shipped).toBe(true);
    const strict = projectByocReleaseMilestones(source, { minimumSoakDurationMs: DAY });
    expect(strict.shipped).toBe(false);
    expect(strict.milestones.find(({ key }) => key === 'soak')?.status).toBe('failed');
    expect(strict.milestones.find(({ key }) => key === 'shipment')?.status).toBe('blocked');
  });

  // D-013 (byoc-delivery-acceleration-2026-09-06): the acceptance soak floor is the canonical one-hour
  // workspace-host acceptance duration. Pin the FLOOR, not only the DAY-bar mechanism: one minute short
  // of it must fail and block shipment, and exactly the floor must pass.
  it('rejects a 59-minute soak at the canonical one-hour acceptance floor and accepts exactly one hour', () => {
    const floor = { minimumSoakDurationMs: WORKSPACE_HOST_SOAK_ACCEPTANCE_DURATION_MS };
    expect(WORKSPACE_HOST_SOAK_ACCEPTANCE_DURATION_MS).toBe(60 * 60_000);
    const short = projectByocReleaseMilestones(completedSoak(59 * 60_000).source, floor);
    expect(short.shipped).toBe(false);
    expect(short.milestones.find(({ key }) => key === 'soak')?.status).toBe('failed');
    expect(short.milestones.find(({ key }) => key === 'shipment')?.status).toBe('blocked');
    expect(projectByocReleaseMilestones(completedSoak(WORKSPACE_HOST_SOAK_ACCEPTANCE_DURATION_MS).source, floor).shipped)
      .toBe(true);
  });

  it('refuses a 59-minute soak through the acceptance reader at the one-hour floor', async () => {
    const { source, record } = completedSoak(59 * 60_000);
    const sql = vi.fn(async () => [{ detail: { release: source } }]) as unknown as Sql;
    const read = vi.fn(async () => record);
    const result = await readByocReleaseAcceptance({
      taskId: 'release-task', workspaceId: 'workspace-1',
      minimumSoakDurationMs: WORKSPACE_HOST_SOAK_ACCEPTANCE_DURATION_MS,
    }, sql, read);
    expect(result?.shipped).toBe(false);
    expect(result?.milestones.find(({ key }) => key === 'soak')?.status).toBe('failed');
  });

  it('accepts a complete 24-hour receipt prefix for phase projection', () => {
    expect(projectByocReleaseMilestones(completedSoak().source, { minimumSoakDurationMs: DAY }).shipped).toBe(true);
  });

  it.each([0, -1, NaN, Infinity, 1.5])('refuses an invalid duration bar %s', (minimumSoakDurationMs) => {
    expect(projectByocReleaseMilestones(completedSoak().source, { minimumSoakDurationMs }).shipped).toBe(false);
  });

  it.each([
    ['missing policy', (soak: TaskReleaseReceipt) => { soak.inputIdentity = null; }],
    ['invalid policy', (soak: TaskReleaseReceipt) => { soak.inputIdentity = { stageIdentity: { policy: { durationMs: DAY, intervalMs: 0 } } }; }],
    ['missing verdict', (soak: TaskReleaseReceipt) => { soak.evidenceRefs = soak.evidenceRefs.filter((ref) => !ref.startsWith('soak-verdict:')); }],
    ['contradictory verdict', (soak: TaskReleaseReceipt) => { soak.evidenceRefs.push('soak-verdict:fail'); }],
    ['missing window', (soak: TaskReleaseReceipt) => { soak.evidenceRefs = soak.evidenceRefs.filter((ref) => !ref.startsWith('soak-window:')); }],
    ['duplicate window', (soak: TaskReleaseReceipt) => { soak.evidenceRefs.push(soak.evidenceRefs.find((ref) => ref.startsWith('soak-window:'))!); }],
    ['invalid window', (soak: TaskReleaseReceipt) => { soak.evidenceRefs = soak.evidenceRefs.map((ref) => ref.startsWith('soak-window:') ? 'soak-window:none/none' : ref); }],
    ['short window', (soak: TaskReleaseReceipt) => { soak.evidenceRefs = soak.evidenceRefs.map((ref) => ref.startsWith('soak-window:') ? 'soak-window:2026-10-12T00:00:00.000Z/2026-10-12T01:00:00.000Z' : ref); }],
    ['reversed window', (soak: TaskReleaseReceipt) => { soak.evidenceRefs = soak.evidenceRefs.map((ref) => ref.startsWith('soak-window:') ? 'soak-window:2026-10-13T00:00:00.000Z/2026-10-12T00:00:00.000Z' : ref); }],
  ] as const)('blocks shipment for %s', (_name, mutate) => {
    const { source, soak } = completedSoak();
    mutate(soak);
    const result = projectByocReleaseMilestones(source, { minimumSoakDurationMs: DAY });
    expect(result.shipped).toBe(false);
    expect(result.milestones.find(({ key }) => key === 'shipment')?.status).toBe('blocked');
  });

  it.each(BYOC_RELEASE_MILESTONES.map(({ key }) => key))('requires the %s milestone', (key) => {
    const { source } = completedSoak();
    source.receipts = source.receipts.filter((receipt) =>
      receipt.stage !== BYOC_RELEASE_MILESTONES.find((milestone) => milestone.key === key)!.stages[0]);
    expect(projectByocReleaseMilestones(source, { minimumSoakDurationMs: DAY }).shipped).toBe(false);
  });

  it('re-reads the selected task and computes the passing outcome from canonical samples', async () => {
    const { source, record } = completedSoak();
    const sql = vi.fn(async () => [{ detail: { release: source } }]) as unknown as Sql;
    const read = vi.fn(async () => record);
    expect(await readByocReleaseAcceptance({
      taskId: 'release-task', workspaceId: 'workspace-1', minimumSoakDurationMs: DAY,
    }, sql, read)).toMatchObject({ shipped: true, contradictions: [] });
    expect(sql).toHaveBeenCalledWith(expect.any(Array), 'workspace-1', 'release-task');
    expect(read).toHaveBeenCalledExactlyOnceWith('workspace-1', 'host-1', 'soak-1');
  });

  it.each([
    ['other task', ({ record }: ReturnType<typeof completedSoak>) => { record.envelope!.releaseTaskId = 'other-task'; }],
    ['other policy', ({ record }: ReturnType<typeof completedSoak>) => { record.envelope!.policy = { ...record.envelope!.policy, durationMs: DAY / 2 }; }],
    ['malformed rows', ({ record }: ReturnType<typeof completedSoak>) => { record.malformedRows = 1; }],
    ['other incarnation', ({ record }: ReturnType<typeof completedSoak>) => { record.samples[1]!.pinned.instanceId = 'other-instance'; }],
    ['other image', ({ record }: ReturnType<typeof completedSoak>) => { record.samples[1]!.pinned.image = 'other-image'; }],
    ['other soak', ({ record }: ReturnType<typeof completedSoak>) => { record.samples[1]!.soakId = 'other-soak'; }],
    ['failed sample', ({ record }: ReturnType<typeof completedSoak>) => { record.samples[1]!.checks[0]!.ok = false; }],
    ['missing samples', ({ record }: ReturnType<typeof completedSoak>) => { record.samples.splice(1, 100); }],
    ['changed window', ({ record }: ReturnType<typeof completedSoak>) => { record.samples.push({ ...record.samples.at(-1)!, sequence: record.samples.length, observedAt: '2026-10-13T00:01:00.000Z' }); }],
    ['other bundle', ({ soak }: ReturnType<typeof completedSoak>) => { (soak.inputIdentity as { stageIdentity: { bundleSha256: string } }).stageIdentity.bundleSha256 = 'e'.repeat(64); }],
    ['ambiguous bundle', ({ source }: ReturnType<typeof completedSoak>) => { source.receipts[0]!.evidenceRefs.push('bundle:sha256:' + 'e'.repeat(64)); }],
    ['other workspace', ({ soak }: ReturnType<typeof completedSoak>) => { soak.evidenceRefs = soak.evidenceRefs.map((ref) => ref.startsWith('soak-host:') ? 'soak-host:workspace-2/host-1' : ref); }],
    ['duplicate subject', ({ soak }: ReturnType<typeof completedSoak>) => { soak.evidenceRefs.push('soak:soak-2'); }],
  ] as const)('rejects a claimed passing receipt with %s', async (_name, mutate) => {
    const fixture = completedSoak();
    mutate(fixture);
    const sql = vi.fn(async () => [{ detail: { release: fixture.source } }]) as unknown as Sql;
    const result = await readByocReleaseAcceptance({
      taskId: 'release-task', workspaceId: 'workspace-1', minimumSoakDurationMs: DAY,
    }, sql, async () => fixture.record);
    expect(result?.shipped).toBe(false);
    expect(result?.milestones.find(({ key }) => key === 'soak')?.status).toBe('failed');
    expect(result?.milestones.find(({ key }) => key === 'shipment')?.status).toBe('blocked');
  });

  it('returns no acceptance claim for a missing authoritative task journal', async () => {
    const sql = vi.fn(async () => []) as unknown as Sql;
    const read = vi.fn();
    expect(await readByocReleaseAcceptance({
      taskId: 'absent', workspaceId: 'workspace-1', minimumSoakDurationMs: DAY,
    }, sql, read)).toBeNull();
    expect(read).not.toHaveBeenCalled();
  });

  it('propagates an unavailable persisted reader instead of claiming a pass', async () => {
    const { source } = completedSoak();
    const sql = vi.fn(async () => [{ detail: { release: source } }]) as unknown as Sql;
    await expect(readByocReleaseAcceptance({
      taskId: 'release-task', workspaceId: 'workspace-1', minimumSoakDurationMs: DAY,
    }, sql, async () => { throw new Error('database unavailable'); })).rejects.toThrow('database unavailable');
  });
});

describe('BYOC release carry adapter', () => {
  it('derives only a contiguous evidence-backed milestone prefix', () => {
    const receipts: TaskReleaseReceipt[] = BYOC_RELEASE_MILESTONES.slice(0, 5).map((milestone, sequence) => ({
      sequence,
      operationId: 'release-op-current',
      requestIdentity: `request-${sequence}`,
      stage: milestone.stages[0],
      state: 'committed' as const,
      inputHash: String(sequence).repeat(64),
      evidenceRefs: [`receipt:${milestone.key}`],
      recordedAt: `2026-09-12T1${sequence}:00:00.000Z`,
    }));
    const projection = projectByocReleaseMilestones(journal({
      cursor: receipts.length,
      currentStage: receipts.at(-1)!.stage,
      currentState: 'committed',
      receipts,
    }));
    expect(projection.current).toBe('customer-acceptance');
    expect(projection.customerReady).toBe(true);
    expect(projection.shipped).toBe(false);
    expect(projection.milestones.map(({ status }) => status)).toEqual([
      'verified', 'verified', 'verified', 'verified', 'verified',
      'pending', 'pending', 'pending', 'pending', 'pending',
    ]);
  });

  it('flags a published-but-uninitialized chain and never displays it as customer-ready or shipped', () => {
    const source = journal({
      cursor: 5,
      currentStage: 'desktop-session.customer-acceptance',
      currentState: 'committed',
      receipts: [
        {
          sequence: 0, operationId: 'release-op-current', requestIdentity: 'build',
          stage: 'release.build.linux', state: 'committed', inputHash: 'a'.repeat(64),
          evidenceRefs: ['build:verified'], recordedAt: '2026-09-12T10:00:00.000Z',
        },
        {
          sequence: 1, operationId: 'release-op-current', requestIdentity: 'publish',
          stage: 'publish.finalize', state: 'committed', inputHash: 'b'.repeat(64),
          evidenceRefs: ['publication:verified'], recordedAt: '2026-09-12T11:00:00.000Z',
        },
        {
          sequence: 2, operationId: 'release-op-current', requestIdentity: 'bootstrap',
          stage: 'workspace.root-bootstrap', state: 'committed', inputHash: 'c'.repeat(64),
          evidenceRefs: ['bootstrap:verified'], recordedAt: '2026-09-12T12:00:00.000Z',
        },
        {
          sequence: 3, operationId: 'release-op-current', requestIdentity: 'initialize',
          stage: 'workspace.fixed-agent-initialization', state: 'refused', inputHash: 'd'.repeat(64),
          evidenceRefs: ['initialization:failed'], recordedAt: '2026-09-12T13:00:00.000Z',
        },
        {
          sequence: 4, operationId: 'release-op-current', requestIdentity: 'accept',
          stage: 'desktop-session.customer-acceptance', state: 'committed', inputHash: 'c'.repeat(64),
          evidenceRefs: ['acceptance:claimed'], recordedAt: '2026-09-12T14:00:00.000Z',
        },
      ],
    });
    const snapshot = projectByocReleaseCarry('taskrelease01', 'WI-7', source);
    const rendered = renderByocReleaseCarry(snapshot);
    expect(snapshot.milestoneProjection.customerReady).toBe(false);
    expect(snapshot.milestoneProjection.shipped).toBe(false);
    expect(snapshot.milestoneProjection.milestones.find(({ key }) => key === 'fixed-agent-initialization')?.status).toBe('failed');
    expect(snapshot.milestoneProjection.milestones.find(({ key }) => key === 'customer-acceptance')?.status).toBe('blocked');
    expect(snapshot.milestoneProjection.contradictions).toContain(
      'DesktopSession/customer acceptance has a committed receipt but an earlier prerequisite is not verified',
    );
    expect(rendered).toContain('customer-ready=false; shipped=false');
    expect(rendered).toContain('⚠ receipt contradictions:');
    expect(rendered).toContain('acceptance:claimed');
  });

  it('does not regress a verified phase when a later receipt revisits an earlier stage', () => {
    const receipts: TaskReleaseReceipt[] = BYOC_RELEASE_MILESTONES.slice(0, 5).map((milestone, sequence) => ({
      sequence,
      operationId: 'release-op-current', requestIdentity: `request-${sequence}`,
      stage: milestone.stages[0], state: 'committed' as const,
      inputHash: String(sequence).repeat(64), evidenceRefs: [`receipt:${milestone.key}`],
      recordedAt: `2026-09-12T1${sequence}:00:00.000Z`,
    }));
    receipts.push({
      sequence: 5, operationId: 'release-op-current', requestIdentity: 'recheck-build',
      stage: 'release.build.linux', state: 'committed', inputHash: 'f'.repeat(64),
      evidenceRefs: ['build:reverified'], recordedAt: '2026-09-12T15:00:00.000Z',
    });
    const projection = projectByocReleaseMilestones(journal({
      cursor: receipts.length, currentStage: 'release.build.linux', currentState: 'committed', receipts,
    }));
    expect(projection.current).toBe('customer-acceptance');
    expect(projection.customerReady).toBe(true);
  });

  it('projects the live journal into a concise reconciliation-safe receipt', () => {
    const source = journal();
    const snapshot = projectByocReleaseCarry('taskrelease01', 'WI-7', source);
    expect(snapshot).toMatchObject({
      taskId: 'taskrelease01', workItemId: 'WI-7', operationId: 'release-op-current', cursor: 2,
      currentStage: 'publish.multipart.initiate', currentState: 'unknown',
      spentRequestIdentities: ['request-spent-1'],
    });
    expect(snapshot.nextAction).toMatch(/Reconcile request request-spent-1.*before any further mutation/);
    expect(snapshot.evidenceRefs).toEqual(['manifest:sha256:' + 'd'.repeat(64), 'provider-response:lost']);
    expect(JSON.stringify(snapshot).length).toBeLessThan(JSON.stringify(source).length / 2);
  });

  it('rebuilds from current state instead of letting stale carry override a changed operation', () => {
    const stale = projectByocReleaseCarry('taskrelease01', 'WI-7', journal());
    const current = projectByocReleaseCarry('taskrelease01', 'WI-7', journal({
      operationId: 'release-op-retracted-and-replaced', cursor: 0, currentStage: null,
      currentState: null, spentOperationIds: [], receipts: [],
    }));
    expect(stale.operationId).toBe('release-op-current');
    expect(current).toMatchObject({ operationId: 'release-op-retracted-and-replaced', cursor: 0, currentStage: null, currentState: null, spentRequestIdentities: [] });
    expect(current.nextAction).toMatch(/Begin the first stage/);
  });

  it('keeps BYOC state, open walls and retraction liveness separate in the existing carry renderer', () => {
    const brief: CarryBrief = {
      ownerId: 'su-owner', workspaceId: 'workspace-1', loop: null, heldItems: [],
      byocReleases: [projectByocReleaseCarry('taskrelease01', 'WI-7', journal())], deferredItems: [],
      directives: [], directivesTotalOpen: 0,
      walls: [{ id: 'do-not-repeat', claim: 'Do not reuse the retracted credential.', recheck: 'Read credential generation 7', sinceMs: 1 }],
      checks: [], facts: [], factsStaleness: [], awaits: [], fleet: null,
      citedRefs: ['EI-7 [change/done]: "retracted stale diagnosis"'],
    };
    const rendered = renderCarryBriefColdExtras(brief);
    expect(rendered).toContain('AUTHORITATIVE BYOC RELEASE RECEIPTS');
    expect(rendered).toContain('Reconcile request request-spent-1');
    expect(rendered).toContain('Do not reuse the retracted credential.');
    expect(rendered).toContain('EI-7 [change/done]');
    expect(rendered).toContain('task:taskrelease01#release');
  });

  it('reads only explicitly owner/work-item-linked complete deploy journals', async () => {
    const sql = vi.fn(async () => [
      { task_id: 'linkedtask01', work_item_id: 'WI-7', detail: { release: journal() } },
      { task_id: 'malformedtask', work_item_id: 'WI-7', detail: { release: { cursor: 0 } } },
    ]) as unknown as Sql;
    Object.assign(sql, { array: (values: unknown[]) => values });
    const snapshots = await readLinkedByocReleaseCarries({ ownerId: 'su-owner', workspaceId: 'workspace-1', heldWorkItemIds: ['WI-7'] }, sql);
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toMatchObject({ taskId: 'linkedtask01', workItemId: 'WI-7' });
    expect(sql).toHaveBeenCalledTimes(1);
  });

  it('wires the linked release projection into the shared carry builder', async () => {
    const snapshot = projectByocReleaseCarry('taskrelease01', 'WI-7', journal());
    const built = await buildCarryBrief('su-owner', {
      workspaceId: 'workspace-1',
      listOpenDirectivesFn: async () => ({ rows: [], totalOpen: 0 }),
      getLoopStatusFn: async () => null,
      readHeldWorkItemsFn: async () => [{
        id: 'WI-7', title: 'BYOC release', body: null, harness: 'papercusp', checkpoint: null,
        holderProof: { ownerId: 'su-owner', workspaceId: 'workspace-1' },
      }],
      readByocReleaseCarriesFn: async (_ownerId, _workspaceId, heldIds) => {
        expect(heldIds).toEqual(['WI-7']);
        return [snapshot];
      },
      readDeferredWorkItemsFn: async () => [],
      listOwnerFactsFn: async () => [],
      listActiveAwaitsFn: async () => [],
      getFleetFn: async () => null,
    });
    expect(built.byocReleases).toEqual([snapshot]);
    expect(renderCarryBriefColdExtras(built)).toContain('operation=release-op-current');
  });

  it.each([
    { state: 'committed' as const, refs: ['artifact:verified'], action: /without rerunning committed stage/ },
    { state: 'refused' as const, refs: ['provider:denied'], action: /Stop at stage/ },
    { state: 'refused' as const, refs: ['reconcile:confirmed-absent'], action: /mint a new one-use request identity/ },
  ])('derives the next action from receipt state $state and evidence $refs', ({ state, refs, action }) => {
    const source = journal();
    const latest = { ...source.receipts.at(-1)!, state, evidenceRefs: refs };
    const snapshot = projectByocReleaseCarry('taskrelease01', 'WI-7', { ...source, currentState: state, receipts: [source.receipts[0]!, latest] });
    expect(renderByocReleaseCarry(snapshot)).toMatch(action);
  });
});
