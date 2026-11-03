import { afterAll, describe, expect, it, vi } from 'vitest';
import { readRealPgRailBlocks } from '@papercusp/test-config/silenced-console-census';
import { DEFAULT_SCRIPT_TIMEOUT_MS } from '@papercusp/tooldef';

// Producer observations are asserted by the original-row coverage matrix.
// These dispatch fixtures must not flush diagnostics into real PostgreSQL.
vi.mock('./degradation/fallback-observations', () => ({ observeFallback: vi.fn(() => true) }));

afterAll(() => {
  const rail = readRealPgRailBlocks();
  expect(rail.blocked, rail.callers.join('\n')).toBe(0);
});
import { poolVerdictByProvider, type AccountStatusRow } from './deployment/account-pool-store';
import type { Rubric } from './rubrics';
import * as rubricStore from './rubrics';
import type { ScorecardEvidenceRow, ScorecardRow } from './scorecards';
import { gradingAuditReplayBasisFingerprint } from './scorecards';
import type { TaskRow } from './task-manager/types';
import type { CoordEnvelope } from '@papercusp/coordination';
import type { OrgSql } from './work-items';
import { runWithWorkspace } from './workspace-als';
import { activeWorkspaceId } from './workspace-registry';
import { FOREGROUND_TIMEOUT_CEILING_MS } from './agent-tools/capability/foreground-transport-cap';
import {
  dispatchPendingGradingAudits,
  confirmPendingGradingAuditReservation,
  notifyRetainedGradingAuditor,
  GRADING_AUDIT_BACKLOG_SCAN_LIMIT,
  GRADING_AUDIT_DISPATCH_CONCURRENCY,
  GRADING_AUDIT_DISPATCH_LIMIT,
  GRADING_AUDIT_FAILURE_BACKOFF_MS,
  GRADING_AUDIT_RESERVATION_TTL_MS,
  GRADING_AUDIT_STRANDED_AFTER_MS,
  STRANDED_RECERTIFY_KEY_PREFIX,
  STRANDED_RECERTIFY_LIMIT,
  assessEvaluatorBuildStranding,
  strandedSpecAdequacyRecertifyCall,
  type EvaluatorBuildStrandingCard,
  GRADING_AUDIT_QUOTA_BACKOFF_DEFAULT_MS,
  GRADING_AUDIT_QUOTA_BACKOFF_MAX_MS,
  GRADING_AUDIT_QUOTA_BACKOFF_MIN_MS,
  GRADING_AUDIT_DISPATCH_ACTOR,
  GRADING_INTEGRITY_RUBRIC_REF,
  GRADING_AUDIT_FALLBACK,
  gradingAuditFallbackModelCanServe,
  gradingAuditFallbackVerdictCanServe,
  gradingAuditProviderCanServe,
  gradingAuditQuotaRouteCanServe,
  gradingAuditorLaunchCtx,
  readGradingAuditDispatchSuppression,
  reconcilePendingGradingAudits,
  resolveGradingAuditQuotaBackoff,
  type GradingAuditReservationResult,
  type DispatchPendingGradingAuditsDeps,
  type DispatchPendingGradingAuditsInput,
} from './grading-integrity';
import { GRADING_INTEGRITY_JUDGE_STACK } from './judge-identity-stack';
import { GradingAuditRuntimeReadinessError, type GradingAuditRuntimeReadinessDiagnostic } from './release/grading-audit-runtime';

type ListScorecards = NonNullable<DispatchPendingGradingAuditsDeps['listScorecards']>;
type ReadEvidence = NonNullable<DispatchPendingGradingAuditsDeps['readEvidence']>;
type GetRubric = NonNullable<DispatchPendingGradingAuditsDeps['getRubric']>;
type Launch = NonNullable<DispatchPendingGradingAuditsDeps['launch']>;
type GetTask = NonNullable<DispatchPendingGradingAuditsDeps['getTask']>;
type ConfirmReservation = NonNullable<DispatchPendingGradingAuditsDeps['confirmReservation']>;
type ListTasks = NonNullable<DispatchPendingGradingAuditsDeps['listTasks']>;
type LaunchResult = Awaited<ReturnType<Launch>>;
type ReadCurrentGeneration = NonNullable<DispatchPendingGradingAuditsDeps['readCurrentGeneration']>;
type GenerationAncestry = NonNullable<DispatchPendingGradingAuditsDeps['generationAncestry']>;

// Keep the mock result shape explicit without using `as never` at a mock call;
// the cast is isolated here so the escape guard still typechecks every install site.
function launchResult(data: unknown): LaunchResult {
  return { data } as LaunchResult;
}

const ctx = { workspaceId: 'ws-test', harnessSlug: 'papercusp' } as DispatchPendingGradingAuditsInput['ctx'];

describe('grading audit stand-down owner scope', () => {
  it('suppresses only the scorecard author named by the active stand-down set', async () => {
    const listWorkspaceWideLoopStanddownOwners = vi.fn(async () => new Set(['su-paused']));

    const paused = await readGradingAuditDispatchSuppression('ws-test', {
      listWorkspaceWideLoopStanddownOwners,
      targetOwnerId: 'su-paused',
    });
    const resumed = await readGradingAuditDispatchSuppression('ws-test', {
      listWorkspaceWideLoopStanddownOwners,
      targetOwnerId: 'su-resumed',
    });
    const unknown = await readGradingAuditDispatchSuppression('ws-test', {
      listWorkspaceWideLoopStanddownOwners,
    });

    expect(paused).toMatchObject({ reason: 'workspace-wide-loop-standdown', targetOwnerId: 'su-paused' });
    expect(resumed).toBeNull();
    expect(unknown).toMatchObject({ reason: 'workspace-wide-loop-standdown', pausedOwnerCount: 1 });
    expect(listWorkspaceWideLoopStanddownOwners).toHaveBeenCalledTimes(3);
  });
});

// Fresh auditors launch as the system dispatch actor, never as the dispatching
// caller — the caller is often the card author (EI-23911815311476758). Spelled
// out literally rather than via gradingAuditorLaunchCtx(ctx) so a regression in
// that helper cannot also rewrite the expectation.
const auditorCtx = {
  ...ctx,
  uiClientId: null,
  isSuperuser: false,
  isPowerUser: false,
  principal: { kind: 'system', slug: GRADING_AUDIT_DISPATCH_ACTOR, workspaceId: 'ws-test' },
  ownerId: GRADING_AUDIT_DISPATCH_ACTOR,
  ownerLabel: 'grading audit dispatch',
  userId: null,
};

function card(issueId: string, over: Partial<ScorecardRow> = {}): ScorecardRow {
  return {
    issueId,
    createdAt: '2026-08-28T00:00:00.000Z',
    createdBy: 'evaluator',
    rubricRef: 'standard-rubric',
    ratings: {},
    nKeys: 0,
    missingKeys: [],
    extraKeys: [],
    rubricResolved: true,
    synthesized: false,
    linkedItems: [],
    gradingAudit: {
      state: 'pending',
      metaRubricRef: GRADING_INTEGRITY_RUBRIC_REF,
      stampedAt: '2026-08-28T00:00:00.000Z',
    },
    ...over,
  } as ScorecardRow;
}

function evidenceCard(issueId: string, over: Partial<ScorecardEvidenceRow> = {}): ScorecardEvidenceRow {
  return {
    issueId,
    createdAt: '2026-08-28T00:00:00.000Z',
    createdBy: 'evaluator',
    rubricRef: 'standard-rubric',
    criteria: [],
    nKeys: 0,
    missingKeys: [],
    extraKeys: [],
    rubricResolved: true,
    synthesized: false,
    auditTarget: {
      current: true,
      superseded: false,
      supersededBy: null,
      retracted: false,
      subjectRubricCurrentness: null,
    },
    ...over,
  };
}

function standardRubric(): Rubric {
  return { kind: 'standard' } as Rubric;
}

function deps() {
  const route = vi.fn<NonNullable<DispatchPendingGradingAuditsDeps['route']>>().mockResolvedValue({
    state: 'fallback',
    reason: 'existing router: no_qualified_responder',
  });
  const listScorecards = vi.fn<ListScorecards>().mockResolvedValue([]);
  const cancelSuperseded = vi.fn(async () => false);
  const getEvaluatorBuild = vi.fn(() => ({ sha: 'live-evaluator-sha', version: '1.2.3' }));
  const ensureRuntime = vi.fn<NonNullable<DispatchPendingGradingAuditsDeps['ensureRuntime']>>(async input => {
    if (input.allowSeed === false) throw new Error('No retained source');
    return { taskId: 'runtime-exact', baseUrl: 'http://127.0.0.1:45187',
      evaluatorBuild: input.evaluatorBuild, bundleSha256: 'a'.repeat(64), expiresAtSec: 4102444800 };
  });
  const readEvidence = vi.fn<ReadEvidence>().mockResolvedValue({ kind: 'not_found' });
  const getRubric = vi.fn<GetRubric>().mockResolvedValue(standardRubric());
  const launch = vi
    .fn<Launch>()
    .mockResolvedValue(launchResult({ deduped: false, launch: { opened: 1, tasks: [{ taskId: 'task-audit' }] } }));
  const reserve = vi.fn<NonNullable<DispatchPendingGradingAuditsDeps['reserve']>>().mockResolvedValue({
    status: 'claimed',
    reservation: { key: 'grading-audit:test', reservedAt: '2026-09-08T00:00:00.000Z' },
  });
  const release = vi.fn(async () => true);
  const confirmReservation = vi.fn<ConfirmReservation>().mockResolvedValue(true);
  const listTasks = vi.fn<ListTasks>().mockResolvedValue([]);
  const getTask = vi.fn<GetTask>().mockResolvedValue({ state: 'running' } as Awaited<ReturnType<GetTask>>);
  const notifyRetainedAuditor = vi.fn<typeof notifyRetainedGradingAuditor>()
    .mockResolvedValue({ state: 'delivered', ownerId: 'su-independent', msgId: 'renewal-1', queued: 1, pickupConfirmed: false });
  const readCurrentGeneration = vi.fn<ReadCurrentGeneration>().mockResolvedValue({
    deployedSha: '2222222',
    hostStartedAt: null,
    bootHeadSha: null,
    scoutCodeHash: null,
    staleHost: false,
  });
  const generationAncestry = vi.fn<GenerationAncestry>().mockReturnValue(true);
  const listWorkspaceWideLoopStanddownOwners = vi.fn(async (_workspaceId: string, _nowMs: number) => new Set<string>());
  return {
    listScorecards,
    cancelSuperseded,
    getEvaluatorBuild,
    ensureRuntime,
    retireRuntimes: vi.fn<NonNullable<DispatchPendingGradingAuditsDeps['retireRuntimes']>>(async () => {}),
    readEvidence,
    getRubric,
    launch,
    route,
    reserve,
    confirmReservation,
    release,
    listTasks,
    readRetainedTaskKernelVerdicts: vi.fn(async (_tasks: readonly TaskRow[], _workspaceId?: string) =>
      new Map<string, string>()),
    bindTaskNativeSession: vi.fn<NonNullable<DispatchPendingGradingAuditsDeps['bindTaskNativeSession']>>()
      .mockResolvedValue(null),
    getTask,
    notifyRetainedAuditor,
    readCurrentGeneration,
    generationAncestry,
    listWorkspaceWideLoopStanddownOwners,
    readProviderResets: vi.fn(async () => [] as number[]),
    providerCanServe: vi.fn(async () => true),
    isCurrentSourceAuditResponder: vi.fn(async () => true),
  };
}

describe('targeted grading runtime cleanup (EI-26838521482108819)', () => {
  it('reaches dispatch without awaiting an unrelated runtime cleanup mutex', async () => {
    const d = deps();
    d.listScorecards.mockResolvedValue([card('EI-target')]);
    d.retireRuntimes.mockImplementation(async (_workspace, _pending, _deps, targets) => {
      if (!targets?.includes('EI-target')) throw new Error('unrelated runtime mutex is held');
    });

    const result = await reconcilePendingGradingAudits({ ctx, targetIds: ['EI-target'] }, d);

    expect(result.receipts).toEqual([expect.objectContaining({ issueId: 'EI-target', state: 'launched' })]);
    expect(d.launch).toHaveBeenCalledTimes(1);
  });

  it('dispatches before slow settled-task and runtime cleanup', async () => {
    const d = deps();
    d.listScorecards.mockResolvedValue([card('EI-target')]);
    let releaseSettledScan!: () => void;
    const settledScanGate = new Promise<void>(resolve => { releaseSettledScan = resolve; });
    let releaseRuntimeCleanup!: () => void;
    const runtimeCleanupGate = new Promise<void>(resolve => { releaseRuntimeCleanup = resolve; });
    const settledScanStarted = vi.fn();
    d.listTasks.mockImplementation(async filter => {
      if (filter?.launchedBy === GRADING_AUDIT_DISPATCH_ACTOR && filter.limit === 2_000) {
        settledScanStarted();
        await settledScanGate;
      }
      return [];
    });
    d.retireRuntimes.mockImplementation(async () => { await runtimeCleanupGate; });

    const running = reconcilePendingGradingAudits({ ctx, harness: 'papercusp' }, d);
    try {
      await vi.waitFor(() => {
        expect(d.launch).toHaveBeenCalledTimes(1);
        expect(settledScanStarted).toHaveBeenCalledOnce();
      });
      expect(d.retireRuntimes).not.toHaveBeenCalled();
      releaseSettledScan();
      await vi.waitFor(() => expect(d.retireRuntimes).toHaveBeenCalledOnce());
    } finally {
      releaseSettledScan();
      releaseRuntimeCleanup();
      await running;
    }

    const result = await running;
    expect(result.receipts).toEqual([expect.objectContaining({ issueId: 'EI-target', state: 'launched' })]);
  });
});

describe('retained grading auditor lease delivery (EI-25289706163098558)', () => {
  type RenewalDeps = NonNullable<Parameters<typeof notifyRetainedGradingAuditor>[1]>;
  function fixture() {
    const target = card('EI-renew', { createdBy: 'su-author', evidenceFingerprint: 'exact-fingerprint' });
    const task = { taskId: 'task-retained', workspaceId: 'ws-test', class: 'agent-session', state: 'running',
      workItemId: target.issueId, detail: { label: 'grading-audit:EI-renew:relay-route', coordOwnerId: 'su-independent' },
      // The launcher is deliberately NOT the task owner.
      launchedBy: 'su-author',
    } as unknown as TaskRow;
    const input = { card: target, task, workspaceId: 'ws-test', harness: 'papercusp',
      reservation: { key: 'grading-audit:EI-renew', reservedAt: '2026-10-07T04:00:51.909Z' } };
    const tx = vi.fn(async () => [{ task_id: task.taskId }]);
    const db = tx as unknown as OrgSql;
    const stored = new Map<string, CoordEnvelope>();
    // Model the EXISTING append seam's replay serialization, with preparation
    // skipped on a replay and failed preparation leaving no persisted line.
    let tail = Promise.resolve();
    const append = vi.fn<NonNullable<RenewalDeps['append']>>(async (_surface, _writer, envelope, hooks) => {
      const previous = tail;
      let unlock!: () => void;
      tail = new Promise<void>((resolve) => { unlock = resolve; });
      await previous;
      try {
        const existing = stored.get(envelope.msg_id);
        if (existing) return { created: false, sequence: 1, envelope: existing };
        const prepared = hooks?.prepare ? await hooks.prepare(db) : envelope;
        stored.set(envelope.msg_id, prepared);
        return { created: true, sequence: 1, envelope: prepared };
      } finally { unlock(); }
    });
    const send = vi.fn<NonNullable<RenewalDeps['send']>>(async (identity, options) => {
      const envelope = { msg_id: options.msgId!, from: identity.ownerId, to: options.to, kind: 'message',
        ts: '2026-10-07T05:00:00.000Z', summary: options.summary, body: options.body } as CoordEnvelope;
      return options.persistEnvelope!(envelope);
    });
    const wake = vi.fn<NonNullable<RenewalDeps['wake']>>().mockResolvedValue({ targets: ['su-independent'],
      keys: [], woken: 1, queued: 1, pickupConfirmed: false } as unknown as Awaited<ReturnType<NonNullable<RenewalDeps['wake']>>>);
    const confirmReservation = vi.fn<ConfirmReservation>().mockResolvedValue(true);
    const resolveParties = vi.fn<NonNullable<RenewalDeps['resolveParties']>>(async (ids) =>
      new Map(ids.map((id) => [id!, id!])));
    const mutex: NonNullable<RenewalDeps['mutex']> = async (_workspace, _issue, fn) => fn();
    return { input, stored, tx, db, d: { append, send, wake, confirmReservation, resolveParties, mutex } };
  }

  it('delivers the exact renewed lease to the authoritative independent task owner and queues one wake', async () => {
    const f = fixture();
    const result = await notifyRetainedGradingAuditor(f.input, f.d);
    expect(result).toMatchObject({ state: 'delivered', ownerId: 'su-independent', queued: 1, pickupConfirmed: false });
    const [identity, sent] = f.d.send.mock.calls[0]!;
    expect(identity.ownerId).toBe(GRADING_AUDIT_DISPATCH_ACTOR);
    expect(sent.to).toEqual(['su-independent']);
    expect(sent.body).toContain("exact target 'EI-renew' and evidence fingerprint 'exact-fingerprint'");
    expect(sent.body).toContain("reservedAt '2026-10-07T04:00:51.909Z'");
    expect(sent.body).toContain("gradingAudit.state is 'pending'");
    expect(sent.body).toContain("subjectRubricCurrentness");
    expect(f.d.confirmReservation).toHaveBeenCalledWith('EI-renew', 'grading-audit:EI-renew', {
      workspaceId: 'ws-test', reservedAt: f.input.reservation.reservedAt, expectedCard: f.input.card, tx: f.db,
    });
    const [query, ...bindings] = f.tx.mock.calls[0] as unknown as [TemplateStringsArray, ...unknown[]];
    expect(query.join('?').replace(/\s+/g, ' ')).toContain(
      "UPDATE harness_shared.task_ledger SET detail = COALESCE(detail, '{}'::jsonb) || ?::text::jsonb",
    );
    expect(query.join('?')).toContain('RETURNING task_id');
    expect(query.join('?')).toContain("detail->>'coordOwnerId' = ? AND detail->>'label' = ?");
    expect(query.join('?')).toContain("state IN ('pending', 'running')");
    expect(query.join('?')).not.toContain('FOR SHARE');
    expect(bindings).toEqual([
      JSON.stringify({ gradingAudit: {
        issueId: 'EI-renew',
        evidenceFingerprint: 'exact-fingerprint',
        reservation: f.input.reservation,
      } }),
      'ws-test', 'task-retained', 'su-independent', 'grading-audit:EI-renew:relay-route', 'EI-renew',
    ]);
    expect(f.d.wake).toHaveBeenCalledTimes(1);
    expect(f.stored.size).toBe(1);
  });

  it('uses a changed replay basis as a new retained-auditor notice identity', async () => {
    const f = fixture();
    f.input.card.gradingAudit = {
      ...f.input.card.gradingAudit!,
      replayRefusal: {
        code: 'grading_audit_replay_consistent',
        at: '2026-10-07T04:01:00.000Z',
        basisFingerprint: 'a'.repeat(64),
        reservation: f.input.reservation,
        responderOwnerId: 'su-independent',
      },
    };

    await notifyRetainedGradingAuditor({ ...f.input, replayBasisFingerprint: 'b'.repeat(64) }, f.d);
    await notifyRetainedGradingAuditor({ ...f.input, replayBasisFingerprint: 'c'.repeat(64) }, f.d);

    const first = f.d.send.mock.calls[0]?.[1];
    const second = f.d.send.mock.calls[1]?.[1];
    expect(first?.msgId).not.toBe(second?.msgId);
    expect(first?.body).toContain('evidenceKind and evidenceRef');
    expect(first?.body).toContain('outside the exact replay selection');
    expect(first?.body).not.toContain('human finding');
  });

  it('rebinds a retained auditor to its recovered evaluator without changing its target or lease', async () => {
    const f = fixture();
    f.input.task.detail.gradingAuditRuntimeBinding = { baseUrl: 'http://127.0.0.1:42457' };
    const runtime = { taskId: 'runtime-recovered', baseUrl: 'http://127.0.0.1:33015',
      evaluatorBuild: { sha: 'recovered-build', version: '1.2.3' }, bundleSha256: 'b'.repeat(64),
      expiresAtSec: Math.floor(Date.now() / 1000) + 3600 };
    const result = await notifyRetainedGradingAuditor({ ...f.input, runtime }, f.d);
    expect(result).toMatchObject({ state: 'delivered', ownerId: 'su-independent' });
    const sent = f.d.send.mock.calls[0]![1];
    expect(sent.body).toContain(runtime.baseUrl);
    expect(sent.body).toContain(runtime.evaluatorBuild.sha);
    expect(sent.body).toContain('node scripts/mcp-call.mjs --port 33015 <tool> --json -');
    expect(sent.body).toContain('Never remove the pin or substitute a default operator or proxy.');
    expect(sent.body).not.toContain('http://127.0.0.1:42457');
    expect(sent.body).not.toContain('--port 42457');
    const [, serialized] = f.tx.mock.calls[0] as unknown as [TemplateStringsArray, string];
    expect(JSON.parse(serialized)).toEqual({ gradingAudit: {
      issueId: f.input.card.issueId, evidenceFingerprint: f.input.card.evidenceFingerprint,
      reservation: f.input.reservation,
    }, gradingAuditRuntimeBinding: runtime });
    expect(f.d.wake).toHaveBeenCalledTimes(1);
  });

  it('delivers a changed evaluator once even when the same lease was already delivered', async () => {
    const f = fixture();
    const runtime = { taskId: 'runtime-old', baseUrl: 'http://127.0.0.1:42457',
      evaluatorBuild: { sha: 'exact-build', version: '1.2.3' }, bundleSha256: 'b'.repeat(64),
      expiresAtSec: Math.floor(Date.now() / 1000) + 3600 };
    const old = await notifyRetainedGradingAuditor({ ...f.input, runtime }, f.d);
    const replacement = { ...runtime, taskId: 'runtime-new', baseUrl: 'http://127.0.0.1:33015' };
    const results = await Promise.all(Array.from({ length: 4 }, () =>
      notifyRetainedGradingAuditor({ ...f.input, runtime: replacement }, f.d)));
    expect(results.map(r => r.state).sort()).toEqual(['already-delivered', 'already-delivered', 'already-delivered', 'delivered']);
    expect(results[0]!.msgId).not.toBe(old.msgId);
    expect(new Set(results.map(r => r.msgId)).size).toBe(1);
    expect(f.stored.size).toBe(2);
    expect(f.d.wake).toHaveBeenCalledTimes(2);
  });

  it('does not publish a recovered evaluator when the target fingerprint or lease changed', async () => {
    const f = fixture();
    f.d.confirmReservation.mockResolvedValue(false);
    const runtime = { taskId: 'runtime-new', baseUrl: 'http://127.0.0.1:33015',
      evaluatorBuild: { sha: 'exact-build', version: '1.2.3' }, bundleSha256: 'b'.repeat(64),
      expiresAtSec: Math.floor(Date.now() / 1000) + 3600 };
    expect(await notifyRetainedGradingAuditor({ ...f.input, runtime }, f.d))
      .toMatchObject({ state: 'failed', reason: expect.stringContaining('target/fingerprint/lease changed') });
    expect(f.tx).not.toHaveBeenCalled();
    expect(f.stored.size).toBe(0);
    expect(f.d.wake).not.toHaveBeenCalled();
  });

  it('deduplicates concurrent renewal notifications and their wake for the same lease', async () => {
    const f = fixture();
    const results = await Promise.all(Array.from({ length: 4 }, () => notifyRetainedGradingAuditor(f.input, f.d)));
    expect(results.map((r) => r.state).sort()).toEqual(['already-delivered', 'already-delivered', 'already-delivered', 'delivered']);
    expect(new Set(results.map((r) => r.msgId)).size).toBe(1);
    expect(f.stored.size).toBe(1);
    expect(f.d.confirmReservation).toHaveBeenCalledTimes(1);
    expect(f.d.wake).toHaveBeenCalledTimes(1);
  });

  it('resumes a parked task once under its existing lease even after its renewal was delivered', async () => {
    const f = fixture();
    const renewed = await notifyRetainedGradingAuditor(f.input, f.d);
    const results = await Promise.all(Array.from({ length: 4 }, () =>
      notifyRetainedGradingAuditor({ ...f.input, resumeParked: true }, f.d)));
    expect(results.map((r) => r.state).sort()).toEqual(['already-delivered', 'already-delivered', 'already-delivered', 'delivered']);
    expect(new Set(results.map((r) => r.msgId)).size).toBe(1);
    expect(results[0]!.msgId).not.toBe(renewed.msgId);
    const sent = f.d.send.mock.calls[1]![1];
    expect(sent.to).toEqual(['su-independent']);
    expect(sent.summary).toContain('Resume retained grading audit');
    expect(sent.body).toContain("reservedAt '2026-10-07T04:00:51.909Z'");
    expect(sent.body).toContain("exact target 'EI-renew' and evidence fingerprint 'exact-fingerprint'");
    expect(f.d.confirmReservation).toHaveBeenCalledTimes(2);
    expect(f.d.wake).toHaveBeenCalledTimes(2);
    expect(f.stored.size).toBe(2);
  });

  it.each(['owner', 'target', 'label-boundary', 'task-state', 'workspace', 'fingerprint', 'lease-key', 'task-class'])
  ('refuses mismatched or missing %s provenance without notifying another actor', async (field) => {
    const f = fixture();
    if (field === 'owner') delete f.input.task.detail.coordOwnerId;
    if (field === 'target') f.input.task.workItemId = 'EI-other';
    if (field === 'label-boundary') f.input.task.detail.label = 'grading-audit:EI-renew-other';
    if (field === 'task-state') f.input.task.state = 'exited';
    if (field === 'workspace') f.input.task.workspaceId = 'other';
    if (field === 'fingerprint') f.input.card.evidenceFingerprint = undefined;
    if (field === 'lease-key') f.input.reservation.key = 'grading-audit:EI-other';
    if (field === 'task-class') f.input.task.class = 'bash-job';
    expect(await notifyRetainedGradingAuditor(f.input, f.d)).toMatchObject({ state: 'skipped' });
    expect(f.d.send).not.toHaveBeenCalled();
    expect(f.d.wake).not.toHaveBeenCalled();
  });

  it('refuses a retired or rebound task discovered at commit time', async () => {
    const f = fixture();
    f.tx.mockResolvedValue([]);
    expect(await notifyRetainedGradingAuditor(f.input, f.d)).toMatchObject({ state: 'failed', reason: expect.stringContaining('changed or retired') });
    expect(f.stored.size).toBe(0);
    expect(f.d.wake).not.toHaveBeenCalled();
  });

  it.each(['same-party', 'unknown-party'])('fails closed on %s independence at the transaction boundary', async (kind) => {
    const f = fixture();
    f.d.resolveParties.mockResolvedValue(kind === 'same-party'
      ? new Map([['su-author', 'same'], ['su-independent', 'same']]) : new Map([['su-author', 'author']]));
    expect(await notifyRetainedGradingAuditor(f.input, f.d)).toMatchObject({ state: 'failed', reason: 'retained auditor independence is not proven' });
    expect(f.stored.size).toBe(0);
    expect(f.d.wake).not.toHaveBeenCalled();
  });

  it('abandons delivery if the target settles, fingerprint changes or another lease wins before append', async () => {
    const f = fixture();
    f.d.confirmReservation.mockResolvedValue(false);
    expect(await notifyRetainedGradingAuditor(f.input, f.d)).toMatchObject({ state: 'failed', reason: expect.stringContaining('target/fingerprint/lease changed') });
    expect(f.stored.size).toBe(0);
    expect(f.tx).not.toHaveBeenCalled();
    expect(f.d.wake).not.toHaveBeenCalled();
  });

  it('preserves a delivered directive on wake failure without duplicating its notification', async () => {
    const f = fixture();
    f.d.wake.mockRejectedValue(new Error('wake unavailable'));
    expect(await notifyRetainedGradingAuditor(f.input, f.d)).toMatchObject({
      state: 'delivered', reason: expect.stringContaining('notification persisted'), pickupConfirmed: false,
    });
    expect(await notifyRetainedGradingAuditor(f.input, f.d)).toMatchObject({ state: 'already-delivered' });
    expect(f.stored.size).toBe(1);
    expect(f.d.wake).toHaveBeenCalledTimes(1);
  });

  it('confirms fingerprint, author, rubric and lease on the same supplied transaction', async () => {
    // The reservation read interpolates the issue-family kind list through tx.unsafe (297f8966cc).
    const tx = Object.assign(vi.fn((_strings: TemplateStringsArray, ..._values: unknown[]) => Promise.resolve([])),
      { unsafe: (fragment: string) => fragment });
    const current = await confirmPendingGradingAuditReservation('EI-renew', 'grading-audit:EI-renew', {
      workspaceId: 'ws-test', reservedAt: 'renewed-at', tx: tx as unknown as OrgSql,
      expectedCard: card('EI-renew', { createdBy: 'su-author', evidenceFingerprint: 'exact-fingerprint' }),
    });
    expect(current).toBe(false);
    const [query, ...bindings] = tx.mock.calls.find(([strings]) => strings.join('').includes('SELECT scorecard.feature_id')) as unknown as [TemplateStringsArray, ...unknown[]];
    for (const clause of ["'state' = 'pending'", "'reservedAt' = ?", "'evidenceFingerprint' IS NOT DISTINCT FROM ?",
      "scorecard.payload->'_ei'->>'created_by' IS NOT DISTINCT FROM ?", "'rubricRef' IS NOT DISTINCT FROM ?", "'retracted' IS NULL", 'NOT EXISTS', 'FOR UPDATE']) {
      expect(query.join('?')).toContain(clause);
    }
    expect(bindings).toEqual(expect.arrayContaining(['EI-renew', 'grading-audit:EI-renew', 'renewed-at', 'exact-fingerprint', 'su-author', 'standard-rubric']));
  });
});

describe('dispatchPendingGradingAudits', () => {
  it.each([
    { explicit: true, targeted: true, serving: true, launches: 1 },
    { explicit: true, targeted: true, serving: false, launches: 0 },
    { explicit: false, targeted: true, serving: true, launches: 0 },
    { explicit: true, targeted: false, serving: true, launches: 0 },
  ])('rechecks a quota wall only for a serving explicit repair: %j', async ({ explicit, targeted, serving, launches }) => {
    const d = deps();
    const issueId = 'EI-recovered-quota-route';
    d.listScorecards.mockResolvedValue([card(issueId)]);
    d.reserve.mockResolvedValueOnce({ status: 'quota-backoff', backoff: {
      until: '2099-01-01T00:00:00.000Z', source: 'account-ledger',
      code: 'model_quota_exhausted', recordedAt: '2026-09-08T00:00:00.000Z', reason: 'old route quota',
    } });
    const quotaRouteCanServe = vi.fn(async () => serving);
    const gradingLaunch = { agent: 'codex', model: 'gpt-6.1-sol', effort: 'xhigh', account: 'auto' } as const;
    await dispatchPendingGradingAudits({
      ...(targeted ? { targetIds: [issueId] } : {}),
      ctx: { ...ctx, ...(explicit ? { gradingLaunch } : {}) },
    }, { ...d, quotaRouteCanServe });
    expect(d.launch).toHaveBeenCalledTimes(launches);
    expect(d.reserve).toHaveBeenCalledTimes(launches + 1);
    expect(quotaRouteCanServe).toHaveBeenCalledTimes(explicit && targeted ? 1 : 0);
    if (launches) {
      expect(d.reserve).toHaveBeenLastCalledWith(issueId, `grading-audit:${issueId}`,
        expect.objectContaining({ allowRecoveredQuotaBackoff: true }));
    }
  });

  it.each([
    { kind: 'read-failed', state: 'failed', reason: 'target rubric read failed; retry this audit when its backing plan is readable' },
    { kind: 'missing', state: 'skipped', reason: 'target rubric not found' },
  ] as const)('distinguishes a $kind rubric lookup before reserving an auditor', async ({ kind, state, reason }) => {
    const d = deps();
    d.listScorecards.mockResolvedValue([card('EI-rubric-lookup')]);
    const read = vi.spyOn(rubricStore, 'readRubric').mockResolvedValue({ kind });
    try {
      const result = await dispatchPendingGradingAudits(
        { targetIds: ['EI-rubric-lookup'], ctx },
        { ...d, getRubric: undefined },
      );
      expect(result.receipts).toEqual([
        expect.objectContaining({ issueId: 'EI-rubric-lookup', state, reason }),
      ]);
      expect(read).toHaveBeenCalledWith('standard-rubric');
      expect(d.reserve).not.toHaveBeenCalled();
      expect(d.launch).not.toHaveBeenCalled();
    } finally {
      read.mockRestore();
    }
  });

  it('dispatches a readable rubric through the typed production lookup', async () => {
    const d = deps();
    d.listScorecards.mockResolvedValue([card('EI-readable-rubric')]);
    const read = vi.spyOn(rubricStore, 'readRubric').mockResolvedValue({ kind: 'found', rubric: standardRubric() });
    try {
      const result = await dispatchPendingGradingAudits(
        { targetIds: ['EI-readable-rubric'], ctx },
        { ...d, getRubric: undefined },
      );
      expect(result.receipts).toEqual([
        expect.objectContaining({ issueId: 'EI-readable-rubric', state: 'launched' }),
      ]);
      expect(d.reserve).toHaveBeenCalledOnce();
      expect(d.launch).toHaveBeenCalledOnce();
    } finally {
      read.mockRestore();
    }
  });

  it('pins internal scorecard reads to the dispatch workspace instead of ambient ALS (EI-26052688889546507)', async () => {
    const d = deps();
    d.listScorecards.mockImplementation(async () => {
      expect(activeWorkspaceId()).toBe('ws-test');
      return [card('EI-workspace-scoped')];
    });

    await runWithWorkspace('ambient-other', () =>
      dispatchPendingGradingAudits({ targetIds: ['EI-workspace-scoped'], ctx }, d),
    );

    expect(d.launch).toHaveBeenCalledOnce();
  });

  it('carries the originating completion reference into the auditor brief without changing its target', async () => {
    const d = deps();
    const issueId = 'EI-acceptance-ref';
    d.listScorecards.mockResolvedValue([card(issueId)]);

    await dispatchPendingGradingAudits(
      { targetIds: [issueId], ctx, harness: 'papercusp', acceptanceRef: 'F-101' },
      d,
    );

    expect(d.launch).toHaveBeenCalledOnce();
    const launchInput = d.launch.mock.calls[0]?.[0] as unknown as Record<string, unknown>;
    expect(launchInput.workItem).toBe(issueId);
    expect(launchInput.brief).toContain('Originating completion reference: "F-101"');
  });

  it('cancels the pending lease and retires its live auditor when the target was superseded', async () => {
    const d = deps();
    const issueId = 'EI-superseded-audit';
    const supersederId = 'EI-current-audit';
    d.listScorecards.mockResolvedValue([
      card(issueId, {
        supersededBy: supersederId,
        gradingAudit: {
          state: 'pending',
          metaRubricRef: GRADING_INTEGRITY_RUBRIC_REF,
          stampedAt: '2026-10-08T02:01:07.761Z',
          dispatchReservation: {
            key: `grading-audit:${issueId}`,
            reservedAt: '2026-10-08T02:01:10.391Z',
          },
        },
      }),
    ]);
    d.listTasks.mockResolvedValue([
      {
        taskId: 'task-superseded-auditor',
        state: 'running',
        detail: { label: `grading-audit:${issueId}` },
      } as unknown as TaskRow,
    ]);
    const cancelSuperseded = vi.fn(async () => true);
    const killTask = vi.fn(async (taskId: string) => ({ ok: true as const, taskId, action: 'kill' }));

    const result = await dispatchPendingGradingAudits(
      { ctx },
      { ...d, cancelSuperseded, killTask },
    );

    expect(cancelSuperseded).toHaveBeenCalledWith(issueId, supersederId, { workspaceId: 'ws-test' });
    expect(d.listTasks).toHaveBeenCalledWith({
      workspaceId: 'ws-test',
      states: ['pending', 'running'],
      labelPrefix: `grading-audit:${issueId}`,
      limit: 20,
    });
    expect(killTask).toHaveBeenCalledWith('task-superseded-auditor', {
      includeSubtree: true,
      escalateAfterMs: 5_000,
    });
    expect(d.reserve).not.toHaveBeenCalled();
    expect(result.receipts).toEqual([]);
  });

  it.each([undefined, { sha: 'recorded-evaluator-sha', version: '1.2.2' }])(
    'cancels a pending lease for an exact stale binding across evaluator builds (%j)', async (evaluatorBuild) => {
    const d = deps();
    const issueId = 'EI-stale-binding-audit';
    const rerunRecipe = {
      args: { harness: 'papercusp' },
      selection: { bindingIds: [30308, 30309] },
      ...(evaluatorBuild ? { evaluatorBuild } : {}),
    } as NonNullable<ScorecardEvidenceRow['rerunRecipe']>;
    const target = card(issueId, {
      evidenceFingerprint: 'scorecard-evidence-v1',
      rerunRecipe,
    });
    d.listScorecards.mockResolvedValue([
      target,
    ]);
    const staleCurrentness = {
      state: 'stale' as const,
      reason: 'cited-binding-retracted' as const,
      citedBindingCount: 2,
      retractedBindingIds: ['30309'],
      unavailableBindingIds: [],
    };
    d.readEvidence.mockResolvedValue({
      kind: 'found',
      scorecard: evidenceCard(issueId, {
        evidenceFingerprint: target.evidenceFingerprint,
        rerunRecipe,
        gradingAudit: target.gradingAudit,
        evidenceBindingCurrentness: staleCurrentness,
        auditTarget: {
          current: false,
          superseded: false,
          supersededBy: null,
          retracted: false,
          subjectRubricCurrentness: null,
          evidenceBindingCurrentness: staleCurrentness,
        },
      }),
    });
    d.listTasks.mockResolvedValue([
      {
        taskId: 'task-stale-binding-auditor',
        state: 'running',
        detail: { label: `grading-audit:${issueId}` },
      } as unknown as TaskRow,
    ]);
    const cancelStaleEvidence = vi.fn(async () => true);
    const killTask = vi.fn(async (taskId: string) => ({ ok: true as const, taskId, action: 'kill' }));

    const result = await dispatchPendingGradingAudits(
      { targetIds: [issueId], ctx },
      { ...d, cancelStaleEvidence, killTask },
    );

    expect(d.readEvidence).toHaveBeenCalledWith(issueId);
    expect(cancelStaleEvidence).toHaveBeenCalledWith(issueId, {
      stampedAt: '2026-08-28T00:00:00.000Z',
      evidenceFingerprint: 'scorecard-evidence-v1',
      harnessSlug: 'papercusp',
      bindingIds: [30308, 30309],
    }, { workspaceId: 'ws-test' });
    expect(d.listTasks).toHaveBeenCalledWith({
      workspaceId: 'ws-test',
      states: ['pending', 'running'],
      labelPrefix: `grading-audit:${issueId}`,
      limit: 20,
    });
    expect(killTask).toHaveBeenCalledWith('task-stale-binding-auditor', {
      includeSubtree: true,
      escalateAfterMs: 5_000,
    });
    expect(d.reserve).not.toHaveBeenCalled();
    expect(d.route).not.toHaveBeenCalled();
    expect(d.launch).not.toHaveBeenCalled();
    expect(result.receipts).toEqual([
      expect.objectContaining({ issueId, state: 'skipped', reason: expect.stringContaining('no longer a current pending') }),
    ]);
  });

  it('does not dispatch a legacy current[] snapshot card after its evidence cohort is rebound', async () => {
    const d = deps();
    const issueId = 'EI-legacy-rebound-evidence-audit';
    const snapshot = {
      planSlug: 'plan-a',
      specId: 'SPEC-001',
      specRevision: 1,
      specFingerprint: 'sha256:spec-001',
      evidenceKind: 'test',
      evidenceRef: 'test-run:old-binding',
      sourceFingerprint: 'sha256:old-source',
      testFingerprint: 'sha256:old-test',
      fixtureFingerprint: null,
      rubricFingerprint: null,
      environmentFingerprint: null,
    };
    const rerunRecipe = {
      schemaVersion: 1,
      evaluator: 'plans:evaluate-spec-test-adequacy',
      classRef: 'plan-class-feature-ship',
      args: {
        harness: 'papercusp',
        slug: 'plan-a',
        classRef: 'plan-class-feature-ship',
        specIds: ['SPEC-001'],
        includeDraft: true,
        current: [snapshot],
      },
      selection: {
        planSlug: 'plan-a', specId: 'SPEC-001', specRevision: 1,
        specFingerprint: 'sha256:spec-001',
        evidence: [{ evidenceKind: 'test', evidenceRef: 'test-run:old-binding' }],
      },
      current: { supplied: true, fingerprints: [snapshot] },
      derivation: {
        kind: 'listSpecEvidence.currentness',
        classifier: 'classifySpecEvidenceCurrentness',
        unknownWhenMissing: true,
      },
    } as NonNullable<ScorecardRow['rerunRecipe']>;
    const target = card(issueId, {
      evidenceFingerprint: 'legacy-snapshot-evidence-v1',
      rerunRecipe,
    });
    d.listScorecards.mockResolvedValue([target]);
    const staleCurrentness = {
      state: 'stale' as const,
      reason: 'cited-binding-retracted' as const,
      citedBindingCount: 1,
      retractedBindingIds: ['30309'],
      unavailableBindingIds: [],
    };
    d.readEvidence.mockResolvedValue({
      kind: 'found',
      scorecard: evidenceCard(issueId, {
        evidenceFingerprint: target.evidenceFingerprint,
        rerunRecipe,
        gradingAudit: target.gradingAudit,
        evidenceBindingCurrentness: staleCurrentness,
        auditTarget: {
          current: false,
          superseded: false,
          supersededBy: null,
          retracted: false,
          subjectRubricCurrentness: null,
          evidenceBindingCurrentness: staleCurrentness,
        },
      }),
    });

    const result = await dispatchPendingGradingAudits({ targetIds: [issueId], ctx }, d);

    expect(d.readEvidence).toHaveBeenCalledWith(issueId);
    expect(d.reserve).not.toHaveBeenCalled();
    expect(d.launch).not.toHaveBeenCalled();
    expect(result.receipts).toEqual([
      expect.objectContaining({
        issueId,
        state: 'skipped',
        reason: expect.stringContaining('no longer a current pending'),
      }),
    ]);
  });

  it('defers a foreign evaluator build without invalidating its card or retiring its auditor', async () => {
    const d = deps();
    const issueId = 'EI-evaluator-build-drift';
    const reservation = {
      key: `grading-audit:${issueId}`,
      reservedAt: '2026-09-24T11:38:02.124Z',
    };
    const rerunRecipe = {
      schemaVersion: 1,
      evaluator: 'plans:evaluate-spec-test-adequacy',
      evaluatorBuild: { sha: 'recorded-evaluator-sha', version: '1.2.2' },
      args: { harness: 'papercusp' },
      selection: { bindingIds: [30308] },
    } as NonNullable<ScorecardRow['rerunRecipe']>;
    const target = card(issueId, {
      evidenceFingerprint: 'scorecard-evidence-v1',
      rerunRecipe,
      gradingAudit: {
        state: 'pending',
        metaRubricRef: GRADING_INTEGRITY_RUBRIC_REF,
        stampedAt: '2026-08-28T00:00:00.000Z',
        dispatchReservation: reservation,
      },
    });
    d.listScorecards.mockResolvedValue([target]);
    d.listTasks.mockResolvedValue([
      {
        taskId: 'task-drifted-auditor',
        state: 'running',
        detail: { label: `grading-audit:${issueId}` },
      } as unknown as TaskRow,
    ]);
    const killTask = vi.fn(async (taskId: string) => ({ ok: true as const, taskId, action: 'kill' }));

    d.readEvidence.mockResolvedValue({ kind: 'found', scorecard: evidenceCard(issueId, {
      evidenceFingerprint: target.evidenceFingerprint,
      rerunRecipe,
      gradingAudit: target.gradingAudit,
    }) });
    const cancelStaleEvidence = vi.fn(async () => true);

    const result = await dispatchPendingGradingAudits(
      { targetIds: [issueId], ctx },
      { ...d, cancelStaleEvidence, killTask },
    );

    expect(d.listTasks).toHaveBeenCalledWith({
      workspaceId: 'ws-test',
      states: ['pending', 'running'],
      labelPrefix: `grading-audit:${issueId}`,
      limit: 10,
    });
    expect(killTask).not.toHaveBeenCalled();
    expect(target.gradingAudit).toMatchObject({ state: 'pending', dispatchReservation: reservation });
    expect(d.readEvidence).toHaveBeenCalledWith(issueId);
    expect(cancelStaleEvidence).not.toHaveBeenCalled();
    expect(d.reserve).not.toHaveBeenCalled();
    expect(d.route).not.toHaveBeenCalled();
    expect(d.launch).not.toHaveBeenCalled();
    expect(result.receipts).toEqual([
      expect.objectContaining({
        issueId,
        state: 'skipped',
        reason: expect.stringContaining('requires a dispatcher running the recorded evaluator build'),
      }),
    ]);
  });

  it('retires a build-drifted retained auditor only with an owner-bound native unsupported-role error', async () => {
    const d = deps();
    const issueId = 'EI-evaluator-build-drift-terminal-role';
    const sessionId = 'native-drift-terminal-role';
    const ownerId = 'su-retained-auditor';
    const rerunRecipe = {
      schemaVersion: 1,
      evaluator: 'plans:evaluate-spec-test-adequacy',
      evaluatorBuild: { sha: 'recorded-evaluator-sha', version: '1.2.2' },
      args: { harness: 'papercusp' },
      selection: {},
    } as NonNullable<ScorecardRow['rerunRecipe']>;
    d.listScorecards.mockResolvedValue([card(issueId, { rerunRecipe })]);
    d.listTasks.mockResolvedValue([{
      taskId: 'task-drifted-terminal-role', sessionId, workspaceId: 'ws-test', class: 'agent-session', state: 'running',
      startedAt: new Date().toISOString(), logPath: '/tmp/drifted-terminal-role.log',
      detail: { label: `grading-audit:${issueId}`, coordOwnerId: ownerId },
    } as unknown as TaskRow]);
    const listNativeSessions = vi.fn<NonNullable<DispatchPendingGradingAuditsDeps['listNativeSessionsByTranscriptHandles']>>()
      .mockResolvedValue([{ sessionId, coordOwnerId: ownerId, agent: 'claude' }]);
    const resolveTranscript = vi.fn<NonNullable<DispatchPendingGradingAuditsDeps['findSessionTranscript']>>()
      .mockResolvedValue('/tmp/drifted-terminal-role.jsonl');
    const killTask = vi.fn(async (taskId: string) => ({ ok: true as const, taskId, action: 'kill' as const }));
    const nativeTranscript = JSON.stringify({
      type: 'assistant', sessionId, isSidechain: false, isApiErrorMessage: true, apiErrorStatus: 400,
      message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: "API Error: 400 role 'system' is not supported on this model" }] },
    });

    const result = await dispatchPendingGradingAudits(
      { targetIds: [issueId], ctx },
      {
        ...d, listNativeSessionsByTranscriptHandles: listNativeSessions, findSessionTranscript: resolveTranscript, killTask,
        readLogTail: (path) => path.endsWith('.jsonl') ? nativeTranscript : "● API Error: 400 role 'system' is not supported on this model\n❯",
        terminalLogRecheckDelayMs: 0, terminalLogMaxRechecks: 0,
      },
    );

    expect(listNativeSessions).toHaveBeenCalledExactlyOnceWith([sessionId]);
    expect(resolveTranscript).toHaveBeenCalledExactlyOnceWith(sessionId, { owner: ownerId });
    expect(killTask).toHaveBeenCalledExactlyOnceWith('task-drifted-terminal-role', { includeSubtree: true, escalateAfterMs: 5_000 });
    expect(d.reserve).not.toHaveBeenCalled();
    expect(d.route).not.toHaveBeenCalled();
    expect(d.launch).not.toHaveBeenCalled();
    expect(result.receipts[0]).toMatchObject({
      issueId, state: 'skipped',
      terminalRecovery: { retiredTaskIds: ['task-drifted-terminal-role'], codes: ['inference_gateway_error'] },
    });
  });

  it('preserves a build-drifted retained auditor when the unsupported-role text is only quoted', async () => {
    const d = deps();
    const issueId = 'EI-evaluator-build-drift-quoted-role';
    const sessionId = 'native-drift-quoted-role';
    const ownerId = 'su-retained-auditor';
    const rerunRecipe = {
      schemaVersion: 1,
      evaluator: 'plans:evaluate-spec-test-adequacy',
      evaluatorBuild: { sha: 'recorded-evaluator-sha', version: '1.2.2' },
      args: { harness: 'papercusp' },
      selection: {},
    } as NonNullable<ScorecardRow['rerunRecipe']>;
    d.listScorecards.mockResolvedValue([card(issueId, { rerunRecipe })]);
    d.listTasks.mockResolvedValue([{
      taskId: 'task-drifted-quoted-role', sessionId, workspaceId: 'ws-test', class: 'agent-session', state: 'running',
      startedAt: new Date().toISOString(), logPath: '/tmp/drifted-quoted-role.log',
      detail: { label: `grading-audit:${issueId}`, coordOwnerId: ownerId },
    } as unknown as TaskRow]);
    const listNativeSessions = vi.fn<NonNullable<DispatchPendingGradingAuditsDeps['listNativeSessionsByTranscriptHandles']>>()
      .mockResolvedValue([{ sessionId, coordOwnerId: ownerId, agent: 'claude' }]);
    const resolveTranscript = vi.fn<NonNullable<DispatchPendingGradingAuditsDeps['findSessionTranscript']>>()
      .mockResolvedValue('/tmp/drifted-quoted-role.jsonl');
    const killTask = vi.fn();
    const nativeTranscript = JSON.stringify({
      type: 'assistant', sessionId, isSidechain: false,
      message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: "The source evidence quoted API Error: 400 role 'system' is not supported on this model" }] },
    });

    const result = await dispatchPendingGradingAudits(
      { targetIds: [issueId], ctx },
      {
        ...d, listNativeSessionsByTranscriptHandles: listNativeSessions, findSessionTranscript: resolveTranscript, killTask,
        readLogTail: (path) => path.endsWith('.jsonl') ? nativeTranscript : "● API Error: 400 role 'system' is not supported on this model\n❯",
        terminalLogRecheckDelayMs: 0, terminalLogMaxRechecks: 0,
      },
    );

    expect(listNativeSessions).toHaveBeenCalledExactlyOnceWith([sessionId]);
    expect(resolveTranscript).toHaveBeenCalledExactlyOnceWith(sessionId, { owner: ownerId });
    expect(killTask).not.toHaveBeenCalled();
    expect(d.reserve).not.toHaveBeenCalled();
    expect(d.route).not.toHaveBeenCalled();
    expect(d.launch).not.toHaveBeenCalled();
    expect(result.receipts[0]).toMatchObject({ issueId, state: 'skipped' });
  });

  it('defers a foreign evaluator build pinned only in executable recipe args', async () => {
    const d = deps();
    const issueId = 'EI-evaluator-build-drift-args-only';
    const rerunRecipe = {
      schemaVersion: 1,
      evaluator: 'plans:evaluate-spec-test-adequacy',
      args: {
        harness: 'papercusp',
        evaluatorBuild: { sha: 'recorded-evaluator-sha', version: '1.2.2' },
      },
      selection: { bindingIds: [30308] },
    } as NonNullable<ScorecardRow['rerunRecipe']>;
    d.listScorecards.mockResolvedValue([card(issueId, {
      evidenceFingerprint: 'scorecard-evidence-v1',
      rerunRecipe,
    })]);

    const result = await dispatchPendingGradingAudits({ targetIds: [issueId], ctx }, d);

    expect(d.reserve).not.toHaveBeenCalled();
    expect(d.route).not.toHaveBeenCalled();
    expect(d.launch).not.toHaveBeenCalled();
    expect(result.receipts).toEqual([
      expect.objectContaining({
        issueId,
        state: 'skipped',
        reason: expect.stringContaining('requires a dispatcher running the recorded evaluator build'),
      }),
    ]);
  });

  it('EI-25965998744903219: names a stranded drift card and its exact re-grade call, still without touching card or lease', async () => {
    const d = deps();
    const issueId = 'EI-evaluator-build-stranded';
    const nowMs = Date.parse('2026-10-14T18:00:00.000Z');
    const lapsed = { key: `grading-audit:${issueId}`, reservedAt: '2026-10-14T13:39:00.000Z' };
    const rerunRecipe = {
      schemaVersion: 1,
      evaluator: 'plans:evaluate-spec-test-adequacy',
      evaluatorBuild: { sha: '9cb343871d', version: '1.2.2' },
      args: { harness: 'papercusp', slug: 'some-plan' },
      selection: { bindingIds: [44556] },
    } as NonNullable<ScorecardRow['rerunRecipe']>;
    const target = card(issueId, {
      evidenceFingerprint: 'scorecard-evidence-v1',
      rerunRecipe,
      gradingAudit: {
        state: 'pending',
        metaRubricRef: GRADING_INTEGRITY_RUBRIC_REF,
        stampedAt: '2026-10-14T13:30:00.000Z',
        lastDispatchReservation: lapsed,
      },
    });
    d.listScorecards.mockResolvedValue([target]);
    const generationAncestry = vi.fn(() => true);

    const result = await dispatchPendingGradingAudits(
      { targetIds: [issueId], ctx },
      {
        ...d,
        now: () => nowMs,
        getEvaluatorBuild: () => ({ sha: 'd357aa11bb', version: '1.2.2' }) as ReturnType<
          NonNullable<DispatchPendingGradingAuditsDeps['getEvaluatorBuild']>
        >,
        generationAncestry,
      },
    );

    expect(generationAncestry).toHaveBeenCalledWith(expect.any(String), '9cb343871d', 'd357aa11bb');
    expect(target.gradingAudit).toMatchObject({ state: 'pending', lastDispatchReservation: lapsed });
    expect(d.reserve).not.toHaveBeenCalled();
    expect(d.route).not.toHaveBeenCalled();
    expect(d.launch).not.toHaveBeenCalled();
    expect(result.receipts).toEqual([
      expect.objectContaining({
        issueId,
        state: 'skipped',
        reason: expect.stringMatching(/^stranded: .*plans:evaluate-spec-test-adequacy/),
        stranded: expect.objectContaining({
          stranded: true,
          idleSince: '2026-10-14T13:39:00.000Z',
          regrade: { tool: 'plans:evaluate-spec-test-adequacy', args: { harness: 'papercusp', slug: 'some-plan' } },
        }),
      }),
    ]);
  });

  describe('stranded spec-test-adequacy re-certification (WI-6554700010013275)', () => {
    const nowMs = Date.parse('2026-10-14T18:00:00.000Z');
    const liveBuild = () =>
      ({ sha: 'd357aa11bb', version: '1.2.2' }) as ReturnType<NonNullable<DispatchPendingGradingAuditsDeps['getEvaluatorBuild']>>;
    const recipeArgs = {
      harness: 'papercusp',
      slug: 'roadmap',
      classRef: 'plan-class-feature-ship',
      evaluatorBuild: { sha: '9cb343871d', version: '1.2.2' },
      specIds: ['roadmap/ENT-P-008-OUTCOME'],
      workItemIds: ['WI-10007903'],
      evidenceRefs: ['test-run:4242'],
      bindingIds: [44556],
      specRevision: 1,
      specFingerprint: 'fp-1',
      replaySnapshot: true,
      includeDraft: true,
      current: [],
    };
    const strandedCard = (issueId: string, args: Record<string, unknown> = recipeArgs) =>
      card(issueId, {
        evidenceFingerprint: 'scorecard-evidence-v1',
        rerunRecipe: {
          schemaVersion: 1,
          evaluator: 'plans:evaluate-spec-test-adequacy',
          evaluatorBuild: { sha: '9cb343871d', version: '1.2.2' },
          args,
          selection: { bindingIds: [44556] },
        } as unknown as NonNullable<ScorecardRow['rerunRecipe']>,
        gradingAudit: {
          state: 'pending',
          metaRubricRef: GRADING_INTEGRITY_RUBRIC_REF,
          stampedAt: '2026-10-14T13:30:00.000Z',
        },
      });
    const certifyReply = (supersededIssueId: string, newIssueId: string) => ({
      ok: true,
      counts: { clauses: 1, passing: 1, filed: 1, unchanged: 0, refused: 0, notPassing: 0 },
      clauses: [
        {
          specId: 'roadmap/ENT-P-008-OUTCOME',
          card: { status: 'filed', issueId: newIssueId },
          strandedSuperseded: { issueId: supersededIssueId, evaluatorBuild: { sha: '9cb343871d', version: '1.2.2' } },
        },
      ],
    });

    it('keeps the recipe selection, drops every replay pin, and acknowledges the existing card', () => {
      expect(
        strandedSpecAdequacyRecertifyCall({ evaluator: 'plans:evaluate-spec-test-adequacy', args: recipeArgs }),
      ).toEqual({
        tool: 'plans:certify-spec-clauses',
        args: {
          harness: 'papercusp',
          slug: 'roadmap',
          classRef: 'plan-class-feature-ship',
          specIds: ['roadmap/ENT-P-008-OUTCOME'],
          workItemIds: ['WI-10007903'],
          evidenceRefs: ['test-run:4242'],
          includeDraft: true,
          acknowledgeExisting: true,
        },
      });
    });

    it('offers no re-certification for another rubric or a recipe that cannot select the clause', () => {
      expect(strandedSpecAdequacyRecertifyCall({ evaluator: 'scorecards:emit', args: recipeArgs })).toBeNull();
      expect(strandedSpecAdequacyRecertifyCall({ evaluator: 'plans:evaluate-spec-test-adequacy', args: { slug: 'p' } })).toBeNull();
      expect(strandedSpecAdequacyRecertifyCall(undefined)).toBeNull();
    });

    it('the periodic sweep re-certifies a stranded card on the live build and the new card supersedes it', async () => {
      const d = deps();
      const issueId = 'EI-stranded-recert';
      d.listScorecards.mockResolvedValue([strandedCard(issueId)]);
      d.reserve.mockResolvedValue({ status: 'claimed', reservation: { key: `${STRANDED_RECERTIFY_KEY_PREFIX}${issueId}`, reservedAt: '2026-10-14T18:00:00.000Z' } });
      const recertifyStranded = vi.fn<NonNullable<DispatchPendingGradingAuditsDeps['recertifyStranded']>>(async () => certifyReply(issueId, 'EI-new-card'));

      // The routine's own call shape: no targetIds, so drift cards are selected from the backlog.
      const result = await reconcilePendingGradingAudits(
        { ctx, harness: 'papercusp' },
        { ...d, now: () => nowMs, getEvaluatorBuild: liveBuild, recertifyStranded },
      );

      expect(d.reserve).toHaveBeenCalledTimes(1);
      expect(d.reserve).toHaveBeenCalledWith(
        issueId,
        `${STRANDED_RECERTIFY_KEY_PREFIX}${issueId}`,
        expect.objectContaining({ workspaceId: 'ws-test', allowGenerationIncompatibleBackoff: true }),
      );
      // Released BEFORE certification: certify supersedes only a card with no live lease.
      expect(d.release).toHaveBeenCalledWith(issueId, `${STRANDED_RECERTIFY_KEY_PREFIX}${issueId}`, expect.objectContaining({ reservedAt: '2026-10-14T18:00:00.000Z' }));
      expect(d.release.mock.invocationCallOrder[0]).toBeLessThan(recertifyStranded.mock.invocationCallOrder[0]!);
      expect(recertifyStranded).toHaveBeenCalledWith(
        expect.objectContaining({ tool: 'plans:certify-spec-clauses', args: expect.objectContaining({ slug: 'roadmap', acknowledgeExisting: true }) }),
        ctx,
      );
      expect(recertifyStranded.mock.calls[0]![0].args).not.toHaveProperty('evaluatorBuild');
      expect(d.launch).not.toHaveBeenCalled();
      expect(result.recertifications).toEqual([
        expect.objectContaining({ issueId, state: 'recertified', supersededBy: 'EI-new-card' }),
      ]);
      // The dispatch receipt names the certify call, not the read-only evaluator.
      expect(result.receipts).toEqual([
        expect.objectContaining({ issueId, reason: expect.stringContaining('plans:certify-spec-clauses') }),
      ]);
    });

    it('can run dispatch-only reconciliation without re-certifying stranded cards', async () => {
      const d = deps();
      const issueId = 'EI-stranded-dispatch-only';
      d.listScorecards.mockResolvedValue([strandedCard(issueId)]);
      const recertifyStranded = vi.fn<NonNullable<DispatchPendingGradingAuditsDeps['recertifyStranded']>>();

      const result = await reconcilePendingGradingAudits(
        { targetIds: [issueId], ctx, recertifyStranded: false },
        { ...d, now: () => nowMs, getEvaluatorBuild: liveBuild, recertifyStranded },
      );

      expect(recertifyStranded).not.toHaveBeenCalled();
      expect(d.reserve).not.toHaveBeenCalled();
      expect(d.release).not.toHaveBeenCalled();
      expect(result).not.toHaveProperty('recertifications');
      expect(result.receipts).toEqual([
        expect.objectContaining({ issueId, stranded: expect.objectContaining({ recertify: expect.any(Object) }) }),
      ]);
    });

    it('clears a legacy generation-incompatible backoff before re-certifying a stranded card', async () => {
      const d = deps();
      const issueId = 'EI-stranded-generation-backoff';
      d.listScorecards.mockResolvedValue([
        strandedCard(issueId),
      ]);
      const reservation = {
        key: `${STRANDED_RECERTIFY_KEY_PREFIX}${issueId}`,
        reservedAt: '2026-10-14T18:00:00.000Z',
      };
      d.reserve.mockImplementation(async (_id, _key, options) => {
        if (options?.allowGenerationIncompatibleBackoff !== true) {
          return {
            status: 'dispatch-backoff',
            backoff: {
              until: '2026-10-14T18:15:00.000Z',
              source: 'retry-window',
              code: 'generation_incompatible',
              recordedAt: '2026-10-14T18:00:00.000Z',
              reason: 'legacy exact-build dispatcher backoff',
            },
          };
        }
        return { status: 'claimed', reservation };
      });
      const recertifyStranded = vi.fn<NonNullable<DispatchPendingGradingAuditsDeps['recertifyStranded']>>(async () =>
        certifyReply(issueId, 'EI-new-generation-card'),
      );

      const result = await reconcilePendingGradingAudits(
        { targetIds: [issueId], ctx },
        { ...d, now: () => nowMs, getEvaluatorBuild: liveBuild, recertifyStranded },
      );

      expect(d.reserve).toHaveBeenCalledWith(
        issueId,
        `${STRANDED_RECERTIFY_KEY_PREFIX}${issueId}`,
        expect.objectContaining({ allowGenerationIncompatibleBackoff: true }),
      );
      expect(d.release).toHaveBeenCalledWith(
        issueId,
        `${STRANDED_RECERTIFY_KEY_PREFIX}${issueId}`,
        expect.objectContaining({ reservedAt: reservation.reservedAt }),
      );
      expect(recertifyStranded).toHaveBeenCalledTimes(1);
      expect(result.recertifications).toEqual([
        expect.objectContaining({ issueId, state: 'recertified', supersededBy: 'EI-new-generation-card' }),
      ]);
    });

    it('leaves a card whose lease another dispatcher holds, without certifying it', async () => {
      const d = deps();
      const issueId = 'EI-stranded-held';
      d.listScorecards.mockResolvedValue([strandedCard(issueId)]);
      d.reserve.mockResolvedValue({ status: 'already-reserved' });
      const recertifyStranded = vi.fn(async () => certifyReply(issueId, 'EI-never'));

      const result = await reconcilePendingGradingAudits(
        { targetIds: [issueId], ctx },
        { ...d, now: () => nowMs, getEvaluatorBuild: liveBuild, recertifyStranded },
      );

      expect(recertifyStranded).not.toHaveBeenCalled();
      expect(d.release).not.toHaveBeenCalled();
      expect(result.recertifications).toEqual([expect.objectContaining({ issueId, state: 'deduped' })]);
    });

    it.each(['pending', 'running'] as const)('preserves an expired audit epoch while its exact auditor is %s', async (state) => {
      const d = deps();
      const issueId = 'EI-stranded-live-auditor';
      const source = strandedCard(issueId);
      source.gradingAudit!.dispatchReservation = {
        key: `grading-audit:${issueId}`, reservedAt: '2026-10-14T13:35:00.000Z',
      };
      d.listScorecards.mockResolvedValue([source]);
      const task = { taskId: 'retained-auditor', class: 'agent-session', state,
        detail: { label: `grading-audit:${issueId}` } } as unknown as TaskRow;
      d.listTasks.mockResolvedValue([task]);
      const readRetainedTaskKernelVerdicts = vi.fn(async () => new Map<string, string>());
      const recertifyStranded = vi.fn(async () => certifyReply(issueId, 'EI-never'));

      const result = await reconcilePendingGradingAudits({ targetIds: [issueId], ctx }, {
        ...d, now: () => nowMs, getEvaluatorBuild: liveBuild, recertifyStranded, readRetainedTaskKernelVerdicts,
      });

      expect(d.reserve).not.toHaveBeenCalled();
      expect(d.release).not.toHaveBeenCalled();
      expect(recertifyStranded).not.toHaveBeenCalled();
      expect(readRetainedTaskKernelVerdicts).toHaveBeenCalledWith([task], 'ws-test');
      expect(result.recertifications).toEqual([expect.objectContaining({
        issueId, state: 'deduped', reason: expect.stringContaining('retained-auditor'),
      })]);
    });

    it('permits recertification after the exact retained auditor is independently kernel-ended', async () => {
      const d = deps();
      const issueId = 'EI-stranded-ended-auditor';
      d.listScorecards.mockResolvedValue([strandedCard(issueId)]);
      const task = { taskId: 'ended-auditor', class: 'agent-session', state: 'running',
        detail: { label: `grading-audit:${issueId}:recovery` } } as unknown as TaskRow;
      d.listTasks.mockResolvedValue([task]);
      const readRetainedTaskKernelVerdicts = vi.fn(async () => new Map([[task.taskId, 'scope collected']]));
      const recertifyStranded = vi.fn(async () => certifyReply(issueId, 'EI-new-card'));

      const result = await reconcilePendingGradingAudits({ targetIds: [issueId], ctx }, {
        ...d, now: () => nowMs, getEvaluatorBuild: liveBuild, recertifyStranded, readRetainedTaskKernelVerdicts,
      });

      expect(d.reserve).toHaveBeenCalledOnce();
      expect(recertifyStranded).toHaveBeenCalledOnce();
      expect(result.recertifications).toEqual([expect.objectContaining({ state: 'recertified' })]);
    });

    it('does not let a sibling audit label block recertification', async () => {
      const d = deps();
      const issueId = 'EI-stranded-label';
      d.listScorecards.mockResolvedValue([strandedCard(issueId)]);
      d.listTasks.mockResolvedValue([{ taskId: 'sibling-auditor', class: 'agent-session', state: 'running',
        detail: { label: `grading-audit:${issueId}-other` } } as unknown as TaskRow]);
      const readRetainedTaskKernelVerdicts = vi.fn(async () => new Map<string, string>());
      const recertifyStranded = vi.fn(async () => certifyReply(issueId, 'EI-new-card'));

      await reconcilePendingGradingAudits({ targetIds: [issueId], ctx }, {
        ...d, now: () => nowMs, getEvaluatorBuild: liveBuild, recertifyStranded, readRetainedTaskKernelVerdicts,
      });

      expect(readRetainedTaskKernelVerdicts).not.toHaveBeenCalled();
      expect(recertifyStranded).toHaveBeenCalledOnce();
    });

    it('reports a certification that superseded nothing, or threw, and keeps going', async () => {
      const d = deps();
      d.listScorecards.mockResolvedValue([strandedCard('EI-stranded-a'), strandedCard('EI-stranded-b')]);
      const recertifyStranded = vi
        .fn<NonNullable<DispatchPendingGradingAuditsDeps['recertifyStranded']>>()
        .mockResolvedValueOnce({
          ok: true,
          counts: { notPassing: 1 },
          clauses: [{ specId: 'roadmap/ENT-P-008-OUTCOME', card: { status: 'not-passing' } }],
        })
        .mockRejectedValueOnce(new Error('certify exploded'));

      const result = await reconcilePendingGradingAudits(
        { targetIds: ['EI-stranded-a', 'EI-stranded-b'], ctx },
        { ...d, now: () => nowMs, getEvaluatorBuild: liveBuild, recertifyStranded },
      );

      expect(result.recertifications).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ state: 'not-recertified', reason: expect.stringContaining('not-passing') }),
          expect.objectContaining({ state: 'failed', reason: 'certify exploded' }),
        ]),
      );
    });

    it('re-certifies at most STRANDED_RECERTIFY_LIMIT cards per pass, one at a time', async () => {
      const d = deps();
      const ids = Array.from({ length: STRANDED_RECERTIFY_LIMIT + 2 }, (_, i) => `EI-stranded-${i}`);
      d.listScorecards.mockResolvedValue(ids.map((id) => strandedCard(id)));
      let inFlight = 0;
      let maxInFlight = 0;
      const recertifyStranded = vi.fn(async (call: { args: Record<string, unknown> }) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await Promise.resolve();
        inFlight -= 1;
        return { ok: true, clauses: [], call };
      });

      const result = await reconcilePendingGradingAudits(
        { targetIds: ids, ctx },
        { ...d, now: () => nowMs, getEvaluatorBuild: liveBuild, recertifyStranded },
      );

      expect(recertifyStranded).toHaveBeenCalledTimes(STRANDED_RECERTIFY_LIMIT);
      expect(maxInFlight).toBe(1);
      expect(result.recertifications).toHaveLength(STRANDED_RECERTIFY_LIMIT);
    });

    it('does nothing for a stranded card whose recipe cannot select its clause', async () => {
      const d = deps();
      d.listScorecards.mockResolvedValue([strandedCard('EI-stranded-thin', { harness: 'papercusp', slug: 'roadmap' })]);
      const recertifyStranded = vi.fn();

      const result = await reconcilePendingGradingAudits(
        { targetIds: ['EI-stranded-thin'], ctx },
        { ...d, now: () => nowMs, getEvaluatorBuild: liveBuild, recertifyStranded },
      );

      expect(recertifyStranded).not.toHaveBeenCalled();
      expect(d.reserve).not.toHaveBeenCalled();
      expect(result).not.toHaveProperty('recertifications');
      expect(result.receipts).toEqual([expect.objectContaining({ stranded: expect.objectContaining({ recertify: null }) })]);
    });
  });

  describe('assessEvaluatorBuildStranding (EI-25965998744903219)', () => {
    const nowMs = Date.parse('2026-10-14T18:00:00.000Z');
    const live = { sha: 'd357aa11bb', version: '0.0.0' };
    const base = (over: Partial<NonNullable<EvaluatorBuildStrandingCard['gradingAudit']>> = {}): EvaluatorBuildStrandingCard => ({
      gradingAudit: { state: 'pending', stampedAt: '2026-10-14T13:30:00.000Z', ...over },
      rerunRecipe: {
        evaluator: 'plans:evaluate-spec-test-adequacy',
        evaluatorBuild: { sha: '9cb343871d', version: '0.0.0' },
        args: { slug: 'p' },
      },
    });
    const opts = (probe: () => boolean | null) => ({ nowMs, root: '/repo', probe });

    it('flags a descendant-host card idle past the grace with no live lease', () => {
      const verdict = assessEvaluatorBuildStranding(base(), live, opts(() => true));
      expect(verdict).toMatchObject({ stranded: true, idleSince: '2026-10-14T13:30:00.000Z' });
    });

    it('does not fire while an audit lease is live', () => {
      const reservedAt = new Date(nowMs - GRADING_AUDIT_RESERVATION_TTL_MS + 60_000).toISOString();
      const verdict = assessEvaluatorBuildStranding(base({ dispatchReservation: { reservedAt } }), live, opts(() => true));
      expect(verdict).toEqual({ stranded: false, reason: 'audit-lease-live' });
    });

    it('does not fire inside the exact-build grace window', () => {
      const stampedAt = new Date(nowMs - GRADING_AUDIT_STRANDED_AFTER_MS + 60_000).toISOString();
      const verdict = assessEvaluatorBuildStranding(base({ stampedAt }), live, opts(() => true));
      expect(verdict).toEqual({ stranded: false, reason: 'within-exact-build-grace' });
    });

    it('does not fire from a host OLDER than the recorded build, or when ancestry is unknown', () => {
      expect(assessEvaluatorBuildStranding(base(), live, opts(() => false))).toEqual({
        stranded: false,
        reason: 'live-build-not-proven-descendant:auditor-build-older-than-graded-build',
      });
      expect(assessEvaluatorBuildStranding(base(), live, opts(() => null))).toMatchObject({ stranded: false });
    });

    it('does not fire on the exact build, a non-pending card, or a superseded card', () => {
      const probe = opts(() => true);
      expect(assessEvaluatorBuildStranding(base(), { sha: '9cb343871d', version: '0.0.0' }, probe))
        .toEqual({ stranded: false, reason: 'exact-build-dispatcher' });
      expect(assessEvaluatorBuildStranding(base({ state: 'passed' }), live, probe)).toMatchObject({ stranded: false });
      expect(assessEvaluatorBuildStranding({ ...base(), supersededBy: 'EI-newer' }, live, probe)).toMatchObject({ stranded: false });
    });
  });

  it('can dispatch the same deferred card from its exact evaluator build and pins the fresh judge to that host', async () => {
    const issueId = 'EI-cross-runtime-replay';
    const rerunRecipe: NonNullable<ScorecardRow['rerunRecipe']> = {
      schemaVersion: 1,
      evaluator: 'plans:evaluate-spec-test-adequacy',
      evaluatorBuild: { sha: 'staging-evaluator-sha', version: '1.2.3' },
      evaluatorRevision: 20,
      classRef: 'plan-class-bugfix',
      args: {
        harness: 'papercusp',
        slug: 'runtime-replay',
        classRef: 'plan-class-bugfix',
        specIds: ['SPEC-RUNTIME-REPLAY'],
        includeDraft: true,
      },
      selection: {
        planSlug: 'runtime-replay',
        specId: 'SPEC-RUNTIME-REPLAY',
        specRevision: 1,
        specFingerprint: 'runtime-replay-fingerprint',
        bindingIds: [],
        evidence: [],
      },
      current: { supplied: false, fingerprints: [] },
      derivation: {
        kind: 'listSpecEvidence.currentness',
        classifier: 'classifySpecEvidenceCurrentness',
        unknownWhenMissing: true,
      },
    };
    const target = card(issueId, { rerunRecipe });
    const foreign = deps();
    foreign.listScorecards.mockResolvedValue([target]);
    await dispatchPendingGradingAudits({ targetIds: [issueId], ctx }, foreign);

    const compatible = deps();
    compatible.getEvaluatorBuild.mockReturnValue({ sha: 'staging-evaluator-sha', version: '1.2.3' });
    compatible.listScorecards.mockResolvedValue([target]);
    // A routed reviewer can inherit another host. Exact replay requires a fresh
    // independent judge bound to the host whose evaluator identity was checked.
    compatible.route.mockResolvedValue({ state: 'routed', conversationId: 'wrong-host-route' });
    const result = await dispatchPendingGradingAudits({ targetIds: [issueId], ctx }, compatible);

    expect(foreign.reserve).not.toHaveBeenCalled();
    expect(compatible.route).not.toHaveBeenCalled();
    expect(compatible.launch).toHaveBeenCalledWith(
      expect.objectContaining({ mcpTarget: 'spawn-host', independent: true }),
      expect.objectContaining(auditorCtx),
    );
    expect(result.receipts[0]).toMatchObject({ state: 'launched' });
  });

  it('recovers an evaluator-drift card only after exact retained endpoint readiness is proven', async () => {
    const d = deps();
    const issueId = 'EI-retained-exact-recovery';
    const rerunRecipe: NonNullable<ScorecardRow['rerunRecipe']> = {
      schemaVersion: 1, evaluator: 'plans:evaluate-spec-test-adequacy',
      evaluatorBuild: { sha: 'old-evaluator', version: '1.2.2' }, evaluatorRevision: 20,
      classRef: 'plan-class-bugfix',
      args: { harness: 'papercusp', slug: 'retained-recovery', classRef: 'plan-class-bugfix',
        specIds: ['SPEC-RETAINED-RECOVERY'], includeDraft: true },
      selection: { planSlug: 'retained-recovery', specId: 'SPEC-RETAINED-RECOVERY', specRevision: 1,
        specFingerprint: 'retained-recovery-fingerprint', bindingIds: [], evidence: [] },
      current: { supplied: false, fingerprints: [] },
      derivation: { kind: 'listSpecEvidence.currentness', classifier: 'classifySpecEvidenceCurrentness', unknownWhenMissing: true },
    };
    d.listScorecards.mockResolvedValue([card(issueId, { rerunRecipe })]);
    const runtime = { taskId: 'retained-old', baseUrl: 'http://127.0.0.1:45188',
      evaluatorBuild: { sha: 'old-evaluator', version: '1.2.2' }, bundleSha256: 'b'.repeat(64), expiresAtSec: 4102444800 };
    d.ensureRuntime.mockResolvedValue(runtime);
    const result = await dispatchPendingGradingAudits({ targetIds: [issueId], ctx }, d);
    expect(result.receipts[0]).toMatchObject({ state: 'launched' });
    expect(d.ensureRuntime).toHaveBeenCalledWith(expect.objectContaining({ issueId, allowSeed: false }));
    const { INTERNAL_GRADING_AUDIT_RUNTIME } = await import('./agent-tools/capability/launch-agent');
    expect(d.launch.mock.calls[0]?.[1]).toMatchObject({ [INTERNAL_GRADING_AUDIT_RUNTIME]: runtime });
    const brief = (d.launch.mock.calls[0]?.[0] as { brief: string }).brief;
    expect(brief).toContain('node scripts/mcp-call.mjs --port 45188 <tool> --json -');
    expect(brief).toContain('If that endpoint is unreachable, stop without grading or emitting');
    expect(brief).toContain('pending-audit dispatcher can restore it through canonical runtime recovery');
  });

  it('never falls back to a mutable spawn host when exact endpoint admission fails', async () => {
    const d = deps();
    d.listScorecards.mockResolvedValue([card('EI-runtime-refused', { gradedGeneration: { deployedSha: '2222222' } as ScorecardRow['gradedGeneration'] })]);
    d.ensureRuntime.mockRejectedValue(new Error('bundle digest changed'));
    const result = await dispatchPendingGradingAudits({ targetIds: ['EI-runtime-refused'], ctx }, d);
    expect(result.receipts[0]).toMatchObject({ state: 'failed', reason: expect.stringContaining('bundle digest changed') });
    expect(d.reserve).not.toHaveBeenCalled();
    expect(d.launch).not.toHaveBeenCalled();
  });

  it.each([false, true])('preserves exact readiness diagnostics through the repair receipt (evaluator drift: %s)', async drift => {
    const d = deps();
    const issueId = 'EI-runtime-unready';
    const evaluatorBuild = { sha: drift ? 'old-evaluator' : 'live-evaluator-sha', version: '1.2.3' };
    d.listScorecards.mockResolvedValue([card(issueId, {
      gradedGeneration: { deployedSha: '2222222' } as ScorecardRow['gradedGeneration'],
      ...(drift ? { rerunRecipe: {
        schemaVersion: 1, evaluator: 'plans:evaluate-spec-test-adequacy', evaluatorBuild,
        evaluatorRevision: 20, classRef: 'plan-class-bugfix',
        args: { harness: 'papercusp', slug: 'retained-unready', classRef: 'plan-class-bugfix',
          specIds: ['SPEC-RETAINED-UNREADY'], includeDraft: true },
        selection: { planSlug: 'retained-unready', specId: 'SPEC-RETAINED-UNREADY', specRevision: 1,
          specFingerprint: 'retained-unready-fingerprint', bindingIds: [], evidence: [] },
        current: { supplied: false, fingerprints: [] },
        derivation: { kind: 'listSpecEvidence.currentness', classifier: 'classifySpecEvidenceCurrentness', unknownWhenMissing: true },
      } as NonNullable<ScorecardRow['rerunRecipe']> } : {}),
    })]);
    const diagnostic: GradingAuditRuntimeReadinessDiagnostic = {
      taskId: 'runtime-unready', logPath: '/logs/exact-runtime.log', attempts: 1,
      locator: { schemaVersion: 1, sourceRoot: '/immutable/checkout', bundlePath: '/immutable/checkout/apps/operator/dist-host/hono-host.mjs',
        ownerRef: 'grading-audit-runtime:exact', evaluatorBuild, bundleSha256: 'b'.repeat(64),
        expiresAtSec: 4102444800, baseUrl: 'http://127.0.0.1:45188', issueIds: [issueId] },
      lastProbe: { status: 'unready', reason: 'connection-error', errorCode: 'ECONNREFUSED' },
      readiness: { method: 'GET', url: 'http://127.0.0.1:45188/api/health', timeoutMs: 2000 },
      taskRead: { tool: 'processes:list', args: { taskId: 'runtime-unready' } },
      recovery: { tool: 'scorecards:repair', args: { targetIds: [issueId] } },
    };
    d.ensureRuntime.mockRejectedValue(new GradingAuditRuntimeReadinessError(diagnostic));
    const result = await dispatchPendingGradingAudits({ targetIds: [issueId], ctx }, d);
    expect(JSON.parse(JSON.stringify(result)).receipts[0]).toMatchObject({
      issueId, state: 'failed', runtimeReadiness: diagnostic,
      reason: expect.stringContaining('ECONNREFUSED'),
    });
    expect(d.reserve).not.toHaveBeenCalled();
    expect(d.route).not.toHaveBeenCalled();
    expect(d.launch).not.toHaveBeenCalled();
  });

  it('does not dispatch an audit for a stale or unbound rubric-subject attestation', async () => {
    const d = deps();
    d.listScorecards.mockResolvedValue([
      card('EI-stale-subject', {
        subject: { kind: 'rubric', ref: 'acceptance-rubric' },
        subjectRubricCurrentness: {
          state: 'stale', reason: 'criteria-hash-mismatch',
          recordedRevision: 4, currentRevision: 5,
          recordedCriteriaHash: 'old', currentCriteriaHash: 'new',
        },
      }),
      card('EI-unbound-subject', { subject: { kind: 'rubric', ref: 'acceptance-rubric' } }),
    ]);

    const result = await dispatchPendingGradingAudits({ targetIds: ['EI-stale-subject', 'EI-unbound-subject'], ctx }, d);

    expect(result.receipts).toEqual([
      expect.objectContaining({ issueId: 'EI-stale-subject', state: 'skipped' }),
      expect.objectContaining({ issueId: 'EI-unbound-subject', state: 'skipped' }),
    ]);
    expect(d.reserve).not.toHaveBeenCalled();
    expect(d.route).not.toHaveBeenCalled();
    expect(d.launch).not.toHaveBeenCalled();
  });

  it('routes the exact source card before launch, retaining reservation and subject evidence', async () => {
    const d = deps();
    const source = card('EI-routed', {
      subject: { kind: 'plan', ref: 'source-plan' },
      evidenceFingerprint: 'frozen-fingerprint',
    });
    d.listScorecards.mockResolvedValue([source]);
    d.route.mockResolvedValue({ state: 'routed', conversationId: 'audit-consult' });
    const result = await dispatchPendingGradingAudits({ targetIds: ['EI-routed'], ctx }, d);
    expect(d.reserve.mock.invocationCallOrder[0]).toBeLessThan(d.route.mock.invocationCallOrder[0]);
    expect(d.route).toHaveBeenCalledWith(
      expect.objectContaining({
        card: source,
        reservationKey: 'grading-audit:EI-routed',
        reservationReservedAt: '2026-09-08T00:00:00.000Z',
        brief: expect.stringContaining('frozen-fingerprint'),
      }),
      expect.objectContaining({ confirmReservation: expect.any(Function) }),
    );
    const brief = d.route.mock.calls[0]?.[0].brief ?? '';
    expect(brief).toContain("capability:git-evidence { op:'readFileAtCommit'");
    expect(brief).toContain("tools:find { query:'capability:git-evidence', limit:1 }");
    expect(brief).toContain('Copy the returned servingGeneration unchanged and pass it to every tools:invoke page request on that same runtime.');
    // A retained evaluator uses an ephemeral port. Its main classification is
    // independent of its pinned source; a staging selector blocks discovery.
    expect(brief).toContain('Do not add a build selector');
    expect(brief).not.toContain("build:'staging'");
    expect(brief).toContain('If stale_tool_contract is returned, refresh from the same runtime and resume the exact cursor.');
    expect(brief).toContain('Preserve a transport failure as a retrieval failure; never treat it as absent evidence.');
    expect(brief).toContain(`code:run scripts use a default budget of ${DEFAULT_SCRIPT_TIMEOUT_MS.toLocaleString('en-US')} ms`);
    expect(brief).toContain(`explicit timeoutSec can raise it to the ${FOREGROUND_TIMEOUT_CEILING_MS.toLocaleString('en-US')} ms`);
    expect(brief).not.toContain('code:run has a 45-second foreground timeout ceiling');
    expect(brief).toContain('capability:git-evidence is not in the code:run facade');
    expect(brief).toContain('For pinned files, issue capability:git-evidence pages directly with tools:invoke');
    expect(brief).toContain('preserving servingGeneration and every exact next_cursor');
    expect(brief).toContain("Read one oversized blob's chain at a time");
    expect(brief).toContain("If its full chain might approach the foreground ceiling, read a bounded page segment");
    expect(brief).toContain('continue the exact cursor in a later call');
    expect(brief).toContain('copy that exact registered slug');
    // WI-6554700010009935: the terminal-re-rate read is subject-scoped and provisional-only.
    expect(brief).toContain(`scorecards:list { rubricRef:'${source.rubricRef}', subjectRef:'source-plan', provisional:true }`);
    expect(brief).toContain("path, rootHarnessSlug }");
    expect(brief).toContain('does not establish absence in the recorded evidence repository');
    expect(brief).toContain('Follow byte-page next_cursor unchanged');
    expect(brief).toContain("sessions:read only with session:'self'");
    expect(brief).toContain('sessions:search and non-self transcript reads are outside its role');
    expect(brief).toContain('state the exact unresolved ref');
    expect(brief).toContain('events:cancel { delivery_id }');
    expect(brief).toContain("Never cancel an await, tree, announcement, or another principal's delivery");
    expect(result.receipts[0]).toMatchObject({ state: 'routed', conversationId: 'audit-consult' });
    expect(d.launch).not.toHaveBeenCalled();
    expect(d.release).not.toHaveBeenCalled();
  });

  it('EI-25973755387060974: requires complete recipe and criterion pages before judging re-runnability', async () => {
    const d = deps();
    d.listScorecards.mockResolvedValue([card('EI-paged-evidence')]);

    await dispatchPendingGradingAudits({ targetIds: ['EI-paged-evidence'], ctx }, d);

    const brief = d.route.mock.calls[0]?.[0].brief ?? '';
    expect(brief).toContain('follow rerunRecipeRead.read and every rerunRecipeRead.next');
    expect(brief).toContain('parse only when rerunRecipeRead.complete is true');
    expect(brief).toContain('through the entire criterion index');
    expect(brief).toContain('applies only to that criterion');
    expect(brief).toContain('Do not rate re-runnable-evidence from the first page');
    expect(brief).toContain('preserve the exact cursor request and returned failure');
  });

  it('EI-25974515694473003: distinguishes a stored submodule pin from a failed parent-repository lookup', async () => {
    const d = deps();
    d.listScorecards.mockResolvedValue([card('EI-repository-pin')]);

    await dispatchPendingGradingAudits({ targetIds: ['EI-repository-pin'], ctx }, d);

    const brief = d.route.mock.calls[0]?.[0].brief ?? '';
    expect(brief).toContain('read the cited binding\'s full details with plans:get-spec-evidence');
    expect(brief).toContain('inspect measurementPin.files and measurementPin.repos');
    expect(brief).toContain('repos[].repo may name a submodule inside it');
    expect(brief).toContain('strip that repository prefix from the file path and pass it as repositoryPath');
    expect(brief).toContain("path:'<child-relative path>', repositoryPath:'<repo>'");
    expect(brief).toContain('when rootHarnessSlug is absent, keep the plan harness as the resolved root');
    expect(brief).toContain('Do not send a submodule\'s commit to the parent repository');
    expect(brief).toContain('Use only a supported exact-blob route for the recorded repository');
    expect(brief).toContain('report the exact unsupported locator');
  });

  it('reuses an active routed audit and never falls through to launch', async () => {
    const d = deps();
    d.listScorecards.mockResolvedValue([card('EI-active')]);
    d.route.mockResolvedValue({ state: 'deduped', conversationId: 'existing-consult' });
    const result = await reconcilePendingGradingAudits({ ctx }, d);
    expect(result.receipts[0]).toMatchObject({ state: 'deduped', conversationId: 'existing-consult' });
    expect(d.launch).not.toHaveBeenCalled();
  });

  it('retires only live one-shot tasks that predate an old settled audit', async () => {
    const d = deps();
    const nowMs = Date.parse('2026-10-06T08:00:00.000Z');
    const passedAt = '2026-10-06T07:30:00.000Z';
    const failedAt = '2026-10-06T07:35:00.000Z';
    const recentAt = '2026-10-06T07:59:30.000Z';
    const settled = (issueId: string, state: 'passed' | 'failed', auditedAt: string) =>
      card(issueId, {
        gradingAudit: {
          state,
          metaRubricRef: GRADING_INTEGRITY_RUBRIC_REF,
          stampedAt: '2026-10-06T07:00:00.000Z',
          auditedAt,
        },
      });
    d.listScorecards.mockResolvedValue([
      settled('EI-25100000000000001', 'passed', passedAt),
      settled('EI-25100000000000002', 'failed', failedAt),
      settled('EI-25100000000000003', 'passed', recentAt),
      settled('EI-25100000000000004', 'passed', passedAt),
    ]);
    d.listTasks.mockResolvedValue([
      {
        taskId: 'task-settled-passed',
        state: 'running',
        startedAt: '2026-10-06T07:20:00.000Z',
        detail: { label: 'grading-audit:EI-25100000000000001' },
      } as unknown as TaskRow,
      {
        taskId: 'task-settled-failed',
        state: 'running',
        startedAt: '2026-10-06T07:20:00.000Z',
        detail: { label: 'grading-audit:EI-25100000000000002' },
      } as unknown as TaskRow,
      {
        taskId: 'task-recent-settlement',
        state: 'running',
        startedAt: '2026-10-06T07:20:00.000Z',
        detail: { label: 'grading-audit:EI-25100000000000003' },
      } as unknown as TaskRow,
      {
        taskId: 'task-started-after-settlement',
        state: 'running',
        startedAt: '2026-10-06T07:31:00.000Z',
        detail: { label: 'grading-audit:EI-25100000000000004' },
      } as unknown as TaskRow,
    ]);
    const killTask = vi.fn(async (taskId: string) => ({ ok: true as const, taskId, action: 'kill' }));

    const result = await reconcilePendingGradingAudits(
      { ctx, harness: 'papercusp' },
      { ...d, killTask, now: () => nowMs },
    );

    expect(d.listTasks).toHaveBeenCalledWith({
      workspaceId: 'ws-test',
      states: ['pending', 'running'],
      launchedBy: GRADING_AUDIT_DISPATCH_ACTOR,
      labelPrefix: 'grading-audit:',
      limit: 2_000,
    });
    expect(killTask).toHaveBeenCalledTimes(2);
    expect(killTask).toHaveBeenCalledWith('task-settled-passed', {
      includeSubtree: true,
      escalateAfterMs: 5_000,
    });
    expect(killTask).toHaveBeenCalledWith('task-settled-failed', {
      includeSubtree: true,
      escalateAfterMs: 5_000,
    });
    expect(result.receipts).toEqual([]);
    expect(d.launch).not.toHaveBeenCalled();
  });

  it('retires cancelled audit missions without retiring their pending replacements', async () => {
    const d = deps();
    d.listScorecards.mockResolvedValue([
      card('EI-25100000000000005', {
        gradingAudit: {
          state: 'cancelled',
          metaRubricRef: GRADING_INTEGRITY_RUBRIC_REF,
          stampedAt: '2026-10-06T07:00:00.000Z',
        },
      }),
      card('EI-25100000000000006'),
    ]);
    d.listTasks.mockResolvedValue([
      {
        taskId: 'task-cancelled-original',
        state: 'running',
        startedAt: '2026-10-06T07:20:00.000Z',
        detail: { label: 'grading-audit:EI-25100000000000005' },
      } as unknown as TaskRow,
      {
        taskId: 'task-cancelled-late-launch',
        state: 'running',
        startedAt: '2026-10-06T07:59:59.000Z',
        detail: { label: 'grading-audit:EI-25100000000000005' },
      } as unknown as TaskRow,
      {
        taskId: 'task-pending-replacement',
        state: 'running',
        startedAt: '2026-10-06T07:30:00.000Z',
        detail: { label: 'grading-audit:EI-25100000000000006' },
      } as unknown as TaskRow,
    ]);
    const killTask = vi.fn(async (taskId: string) => ({ ok: true as const, taskId, action: 'kill' }));

    await reconcilePendingGradingAudits(
      { ctx, harness: 'papercusp', targetIds: ['EI-25100000000000005'] },
      { ...d, killTask, now: () => Date.parse('2026-10-06T08:00:00.000Z') },
    );

    expect(killTask.mock.calls.map(([id]) => id).sort()).toEqual([
      'task-cancelled-late-launch', 'task-cancelled-original',
    ]);
    expect(d.launch).not.toHaveBeenCalled();
  });

  it('fresh-launches generation-bound cards only from a compatible dispatcher build', async () => {
    const d = deps();
    d.listScorecards.mockResolvedValue([
      card('EI-generation-bound', {
        gradedGeneration: {
          deployedSha: '1111111',
          hostStartedAt: '2026-09-24T11:38:02.124Z',
          bootHeadSha: null,
          scoutCodeHash: null,
          staleHost: false,
        },
      }),
    ]);
    d.generationAncestry.mockReturnValue(true);

    const result = await dispatchPendingGradingAudits({ targetIds: ['EI-generation-bound'], ctx }, d);

    expect(d.generationAncestry).toHaveBeenCalledWith(expect.any(String), '1111111', '2222222');
    expect(d.reserve).toHaveBeenCalledWith(
      'EI-generation-bound',
      'grading-audit:EI-generation-bound',
      expect.objectContaining({ allowGenerationIncompatibleBackoff: true }),
    );
    expect(d.generationAncestry.mock.invocationCallOrder[0]).toBeLessThan(
      d.reserve.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(d.route).not.toHaveBeenCalled();
    expect(d.launch).toHaveBeenCalledTimes(1);
    // EI-24339979200649356: the ancestry check measured THIS dispatcher's build, so the
    // judge must be bound to it. The default ('stable') rides the :9071 proxy to green
    // :3070 — a different build — and the judge's emit is then refused as incompatible.
    expect(d.launch).toHaveBeenCalledWith(expect.objectContaining({ mcpTarget: 'spawn-host' }), expect.anything());
    expect(result.receipts[0]).toMatchObject({
      state: 'launched',
      routingFallback: 'generation-bound card requires a fresh judge launched from this compatible dispatcher build',
    });
  });

  it('keeps a judge for a card with no graded generation on the stable MCP proxy', async () => {
    const d = deps();
    d.listScorecards.mockResolvedValue([card('EI-unbound-generation')]);

    await dispatchPendingGradingAudits({ targetIds: ['EI-unbound-generation'], ctx }, d);

    expect(d.generationAncestry).not.toHaveBeenCalled();
    expect(d.launch).toHaveBeenCalledTimes(1);
    expect(d.launch.mock.calls[0]?.[0]).not.toHaveProperty('mcpTarget');
  });

  it('binds a profile-pinned card without a graded generation to the dispatcher host', async () => {
    const d = deps();
    const issueId = 'EI-routine-profile-unbound-generation';
    d.listScorecards.mockResolvedValue([card(issueId, { rubricRef: 'spec-quality' })]);
    const profiledCtx = {
      ...ctx,
      gradingLaunch: { agent: 'codex', model: 'gpt-6.1-sol', effort: 'xhigh', account: 'auto' },
    } as DispatchPendingGradingAuditsInput['ctx'];

    await dispatchPendingGradingAudits({ targetIds: [issueId], ctx: profiledCtx }, d);

    expect(d.generationAncestry).not.toHaveBeenCalled();
    expect(d.launch).toHaveBeenCalledTimes(1);
    expect(d.launch).toHaveBeenCalledWith(expect.objectContaining({
      agent: 'codex', model: 'gpt-6.1-sol', effort: 'xhigh', account: 'auto', mcpTarget: 'spawn-host',
    }), expect.anything());
  });

  it.each([
    [false, 'auditor-build-older-than-graded-build'],
    [null, 'generation-ancestry-unknown'],
  ] as const)(
    'refuses to route or launch a generation-bound card when host ancestry is %s',
    async (isAncestor, reasonCode) => {
      const d = deps();
      d.listScorecards.mockResolvedValue([
        card('EI-incompatible-generation', {
          gradedGeneration: {
            deployedSha: '1111111',
            hostStartedAt: '2026-09-24T11:38:02.124Z',
            bootHeadSha: null,
            scoutCodeHash: null,
            staleHost: false,
          },
        }),
      ]);
      d.generationAncestry.mockReturnValue(isAncestor);

      const result = await dispatchPendingGradingAudits({ targetIds: ['EI-incompatible-generation'], ctx }, d);

      expect(result.receipts[0]).toMatchObject({ state: 'failed', reason: expect.stringContaining(reasonCode) });
      expect(d.reserve).not.toHaveBeenCalled();
      expect(d.release).not.toHaveBeenCalled();
      expect(d.confirmReservation).not.toHaveBeenCalled();
      expect(d.listTasks).not.toHaveBeenCalled();
      expect(d.route).not.toHaveBeenCalled();
      expect(d.launch).not.toHaveBeenCalled();
    },
  );

  it('does not mutate an existing auditor lease when generation is incompatible', async () => {
    const d = deps();
    const issueId = 'EI-incompatible-retained-auditor';
    const idempotencyKey = 'grading-audit:' + issueId;
    const priorReservation = {
      key: idempotencyKey,
      reservedAt: '2026-10-12T01:03:23.081Z',
    };
    d.listScorecards.mockResolvedValue([
      card(issueId, {
        gradedGeneration: {
          deployedSha: '1111111',
          hostStartedAt: '2026-09-24T11:38:02.124Z',
          bootHeadSha: null,
          scoutCodeHash: null,
          staleHost: false,
        },
        gradingAudit: {
          state: 'pending',
          metaRubricRef: GRADING_INTEGRITY_RUBRIC_REF,
          stampedAt: '2026-10-12T01:00:00.000Z',
          dispatchReservation: priorReservation,
          lastDispatchReservation: priorReservation,
        },
      }),
    ]);
    d.generationAncestry.mockReturnValue(false);

    const result = await dispatchPendingGradingAudits({ targetIds: [issueId], ctx }, d);

    expect(result.receipts[0]).toMatchObject({ state: 'failed', reason: expect.stringContaining('no auditor was routed or launched') });
    expect(d.reserve).not.toHaveBeenCalled();
    expect(d.confirmReservation).not.toHaveBeenCalled();
    expect(d.release).not.toHaveBeenCalled();
    expect(d.listTasks).not.toHaveBeenCalled();
    expect(d.route).not.toHaveBeenCalled();
    expect(d.launch).not.toHaveBeenCalled();
  });

  it('does not redispatch a target whose evaluator change requires the source card to be re-emitted', async () => {
    const d = deps();
    d.listScorecards.mockResolvedValue([
      card('EI-awaiting-reemit', {
        gradingAudit: {
          state: 'awaiting-reemit',
          metaRubricRef: GRADING_INTEGRITY_RUBRIC_REF,
          stampedAt: '2026-09-24T11:38:02.124Z',
          reemitRequired: {
            code: 'grading_audit_evaluator_changed',
            at: '2026-09-24T11:39:02.124Z',
            reason: 'evaluator revision changed the recorded falsifiability rating',
          },
        },
      }),
    ]);

    const result = await dispatchPendingGradingAudits({ targetIds: ['EI-awaiting-reemit'], ctx }, d);

    expect(result.receipts[0]).toMatchObject({
      state: 'skipped',
      reason: 'target is no longer a current pending standard-rubric scorecard',
    });
    expect(d.reserve).not.toHaveBeenCalled();
    expect(d.route).not.toHaveBeenCalled();
    expect(d.launch).not.toHaveBeenCalled();
  });

  it('skips a consult route that no longer owns the exact reservation epoch', async () => {
    const d = deps();
    d.listScorecards.mockResolvedValue([card('EI-reservation-lost')]);
    d.route.mockResolvedValue({
      state: 'reservation-lost',
      reason: 'grading-audit reservation changed before consult recruitment',
    });

    const result = await dispatchPendingGradingAudits({ targetIds: ['EI-reservation-lost'], ctx }, d);

    expect(result.receipts[0]).toMatchObject({
      state: 'skipped',
      reason: 'grading-audit reservation changed before consult recruitment',
    });
    expect(d.launch).not.toHaveBeenCalled();
    expect(d.release).toHaveBeenCalledWith('EI-reservation-lost', 'grading-audit:EI-reservation-lost', {
      workspaceId: 'ws-test',
      reservedAt: '2026-09-08T00:00:00.000Z',
    });
  });

  it('surfaces and backs off a routing failure, then a healthy retry creates exactly one consult', async () => {
    const d = deps();
    d.listScorecards.mockResolvedValue([card('EI-fault')]);
    const now = Date.parse('2026-09-13T05:39:00.000Z');
    const backoff = {
      until: new Date(now + GRADING_AUDIT_FAILURE_BACKOFF_MS).toISOString(),
      source: 'retry-window' as const,
      code: 'dispatch_exception',
      recordedAt: new Date(now).toISOString(),
      reason: 'lineage unavailable',
    };
    d.route
      .mockRejectedValueOnce(new Error('lineage unavailable'))
      .mockResolvedValueOnce({ state: 'routed', conversationId: 'healthy-consult' });
    d.reserve
      .mockResolvedValueOnce({
        status: 'claimed',
        reservation: { key: 'grading-audit:EI-fault', reservedAt: '2026-09-08T00:00:00.000Z' },
      })
      .mockResolvedValueOnce({ status: 'dispatch-backoff', backoff })
      .mockResolvedValueOnce({
        status: 'claimed',
        reservation: { key: 'grading-audit:EI-fault', reservedAt: '2026-09-08T00:00:00.000Z' },
      });
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const failed = await dispatchPendingGradingAudits({ targetIds: ['EI-fault'], ctx }, { ...d, now: () => now });
      const suppressed = await dispatchPendingGradingAudits(
        { targetIds: ['EI-fault'], ctx },
        { ...d, now: () => now + 60_000 },
      );
      const recovered = await dispatchPendingGradingAudits(
        { targetIds: ['EI-fault'], ctx },
        { ...d, now: () => now + GRADING_AUDIT_FAILURE_BACKOFF_MS + 1 },
      );

      expect(failed.receipts[0]).toMatchObject({ state: 'failed', reason: 'lineage unavailable' });
      expect(d.release).toHaveBeenCalledWith('EI-fault', 'grading-audit:EI-fault', {
        workspaceId: 'ws-test',
        reservedAt: '2026-09-08T00:00:00.000Z',
        backoff,
      });
      expect(warning).toHaveBeenCalledWith(
        '[grading-integrity] pending audit dispatch failed for EI-fault: lineage unavailable',
      );
      expect(suppressed.receipts[0]).toMatchObject({
        state: 'skipped',
        reason: expect.stringContaining(`re-dispatch suppressed until ${backoff.until}`),
      });
      expect(recovered.receipts[0]).toMatchObject({ state: 'routed', conversationId: 'healthy-consult' });
      expect(d.route).toHaveBeenCalledTimes(2);
      expect(d.launch).not.toHaveBeenCalled();
    } finally {
      warning.mockRestore();
    }
  });

  it('records the failing dispatcher phase when reservation throws CONNECT_TIMEOUT (EI-26081368846958374)', async () => {
    const d = deps();
    d.listScorecards.mockResolvedValue([card('EI-phase-receipt')]);
    const timeout = Object.assign(new Error('write CONNECT_TIMEOUT localhost:5432'), { code: 'CONNECT_TIMEOUT' });
    d.reserve.mockRejectedValue(timeout);
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = await dispatchPendingGradingAudits({ targetIds: ['EI-phase-receipt'], ctx }, d);
      expect(result.receipts[0]).toMatchObject({
        issueId: 'EI-phase-receipt',
        state: 'failed',
        reason: timeout.message,
        phase: 'reservation',
      });
    } finally {
      warning.mockRestore();
    }
  });

  it('serializes concurrent routed dispatches through the existing card reservation', async () => {
    const d = deps();
    d.listScorecards.mockResolvedValue([card('EI-race')]);
    d.reserve.mockResolvedValueOnce({
      status: 'claimed',
      reservation: { key: 'grading-audit:EI-race', reservedAt: '2026-09-08T00:00:00.000Z' },
    }).mockResolvedValue({ status: 'already-reserved' });
    d.route.mockResolvedValue({ state: 'routed', conversationId: 'one-consult' });
    const results = await Promise.all(
      [1, 2].map(() => dispatchPendingGradingAudits({ targetIds: ['EI-race'], ctx }, d)),
    );
    expect(results.flatMap((r) => r.receipts.map((receipt) => receipt.state)).sort()).toEqual(['routed', 'skipped']);
    expect(d.route).toHaveBeenCalledOnce();
    expect(d.launch).not.toHaveBeenCalled();
  });

  it('abandons a reservation when the target settles before routing', async () => {
    const d = deps();
    d.listScorecards.mockResolvedValue([card('EI-settled-after-reservation')]);
    d.confirmReservation.mockResolvedValue(false);

    const result = await dispatchPendingGradingAudits(
      { targetIds: ['EI-settled-after-reservation'], ctx },
      d,
    );

    expect(result.receipts).toEqual([
      {
        issueId: 'EI-settled-after-reservation',
        rubricRef: 'standard-rubric',
        state: 'skipped',
        idempotencyKey: 'grading-audit:EI-settled-after-reservation',
        reason: 'target is no longer pending after reservation; dispatch abandoned',
      },
    ]);
    expect(d.confirmReservation).toHaveBeenCalledWith(
      'EI-settled-after-reservation',
      'grading-audit:EI-settled-after-reservation',
      expect.objectContaining({
        workspaceId: 'ws-test',
        reservedAt: '2026-09-08T00:00:00.000Z',
        snapshot: expect.any(Object),
        expectedCard: expect.objectContaining({ createdBy: 'evaluator', rubricRef: 'standard-rubric' }),
      }),
    );
    expect(d.release).toHaveBeenCalledWith('EI-settled-after-reservation', 'grading-audit:EI-settled-after-reservation', {
      workspaceId: 'ws-test',
      reservedAt: '2026-09-08T00:00:00.000Z',
    });
    expect(d.route).not.toHaveBeenCalled();
    expect(d.launch).not.toHaveBeenCalled();
  });

  it('pins a recovered audit launch to the routine profile without changing its independent identity', async () => {
    const d = deps();
    const profile = { agent: 'codex', model: 'gpt-6.1-sol', effort: 'xhigh', account: 'auto' };
    d.listScorecards.mockResolvedValue([card('EI-pinned-audit')]);
    await dispatchPendingGradingAudits({ targetIds: ['EI-pinned-audit'], ctx: { ...ctx, gradingLaunch: profile } as never, harness: 'papercusp' }, d);
    expect(d.route).not.toHaveBeenCalled();
    expect(d.launch).toHaveBeenCalledWith(expect.objectContaining({
      ...profile, independent: true, members: [{ role: 'judge', stack: [...GRADING_INTEGRITY_JUDGE_STACK], ...profile }],
    }), expect.objectContaining({ ownerId: GRADING_AUDIT_DISPATCH_ACTOR }));
  });

  it('re-checks after routing before launching when settlement wins during the route', async () => {
    const d = deps();
    d.listScorecards.mockResolvedValue([card('EI-settled-during-route')]);
    d.route.mockResolvedValue({ state: 'fallback', reason: 'no responder' });
    d.confirmReservation.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    const result = await dispatchPendingGradingAudits(
      { targetIds: ['EI-settled-during-route'], ctx },
      d,
    );

    expect(result.receipts).toEqual([
      {
        issueId: 'EI-settled-during-route',
        rubricRef: 'standard-rubric',
        state: 'skipped',
        idempotencyKey: 'grading-audit:EI-settled-during-route',
        reason: 'target is no longer pending after reservation; dispatch abandoned',
      },
    ]);
    expect(d.confirmReservation).toHaveBeenCalledTimes(2);
    expect(d.route).toHaveBeenCalledOnce();
    expect(d.release).toHaveBeenCalledWith('EI-settled-during-route', 'grading-audit:EI-settled-during-route', {
      workspaceId: 'ws-test',
      reservedAt: '2026-09-08T00:00:00.000Z',
    });
    expect(d.launch).not.toHaveBeenCalled();
  });

  it('suppresses a paused scorecard owner during an active workspace-wide loop stand-down', async () => {
    const d = deps();
    d.listWorkspaceWideLoopStanddownOwners.mockResolvedValue(new Set(['su-owner']));
    d.listScorecards.mockResolvedValue([card('EI-paused', { createdBy: 'su-owner' })]);

    const result = await dispatchPendingGradingAudits({ targetIds: ['EI-paused'], ctx }, d);

    expect(result.receipts).toMatchObject([{ issueId: 'EI-paused', state: 'skipped' }]);
    expect(result.receipts[0]!.reason).toContain("scorecard owner 'su-owner'");
    expect(d.listScorecards).toHaveBeenCalledOnce();
    expect(d.reserve).not.toHaveBeenCalled();
    expect(d.launch).not.toHaveBeenCalled();
    expect(d.listWorkspaceWideLoopStanddownOwners).toHaveBeenCalledWith('ws-test', expect.any(Number));
  });

  it('dispatches an unpaused owner’s card while unrelated owners remain stood down', async () => {
    const d = deps();
    d.listWorkspaceWideLoopStanddownOwners.mockResolvedValue(new Set(['su-paused']));
    d.listScorecards.mockResolvedValue([card('EI-unpaused', { createdBy: 'su-resumed' })]);
    d.route.mockResolvedValue({ state: 'routed', conversationId: 'audit-unpaused-owner' });

    const result = await dispatchPendingGradingAudits({ targetIds: ['EI-unpaused'], ctx }, d);

    expect(result.receipts).toMatchObject([{ issueId: 'EI-unpaused', state: 'routed' }]);
    expect(d.reserve).toHaveBeenCalledOnce();
    expect(d.route).toHaveBeenCalledOnce();
    expect(d.launch).not.toHaveBeenCalled();
  });

  it('dispatches terminal auditor work again after the workspace-wide stand-down is cleared', async () => {
    const d = deps();
    d.listScorecards.mockResolvedValue([card('EI-resumed')]);
    d.route.mockResolvedValue({ state: 'routed', conversationId: 'audit-after-resume' });

    const result = await dispatchPendingGradingAudits({ targetIds: ['EI-resumed'], ctx }, d);

    expect(result.receipts).toMatchObject([{ issueId: 'EI-resumed', state: 'routed' }]);
    expect(d.listWorkspaceWideLoopStanddownOwners).toHaveBeenCalledWith('ws-test', expect.any(Number));
    expect(d.listScorecards).toHaveBeenCalledOnce();
    expect(d.reserve).toHaveBeenCalledOnce();
    expect(d.route).toHaveBeenCalledOnce();
  });

  it('keeps an incomplete pre-spawn duplicate fenced and marks it retryable only after the claim lease', async () => {
    const d = deps();
    const issueId = 'EI-incomplete-pre-spawn';
    d.listScorecards.mockResolvedValue([card(issueId)]);
    d.launch.mockResolvedValue(launchResult({
      deduped: true,
      launch: {
        launchState: 'spawning',
        status: 'reconciliation-required',
        reconciliationRequired: true,
        spawnAttempted: false,
        nativeSpawnAttempted: [],
        ownerIds: ['su-pre-spawn'],
        processHandles: {},
        memberResults: {},
      },
    }));

    const result = await dispatchPendingGradingAudits({ targetIds: [issueId], ctx, harness: 'papercusp' }, d);

    expect(result.receipts[0]).toMatchObject({
      issueId,
      state: 'reconciliation-required',
      reason: expect.stringContaining('proves no member process was attempted'),
      launch: { spawnAttempted: false, nativeSpawnAttempted: [], ownerIds: ['su-pre-spawn'] },
    });
    expect(d.launch).toHaveBeenCalledOnce();
    expect(d.release).not.toHaveBeenCalled();
  });

  it('does not retry or release an incomplete duplicate whose spawn may have started', async () => {
    const d = deps();
    const issueId = 'EI-incomplete-ambiguous-spawn';
    d.listScorecards.mockResolvedValue([card(issueId)]);
    d.launch.mockResolvedValue(launchResult({
      deduped: true,
      launch: {
        launchState: 'spawning',
        status: 'reconciliation-required',
        reconciliationRequired: true,
        spawnAttempted: true,
        nativeSpawnAttempted: [0],
        ownerIds: ['su-ambiguous'],
        processHandles: {},
        memberResults: { '0': { status: 'starting', outcome: 'unknown' } },
      },
    }));

    const result = await dispatchPendingGradingAudits({ targetIds: [issueId], ctx, harness: 'papercusp' }, d);

    expect(result.receipts[0]).toMatchObject({
      issueId,
      state: 'reconciliation-required',
      reason: expect.stringContaining('does not prove that no process started'),
      launch: { spawnAttempted: true, nativeSpawnAttempted: [0], ownerIds: ['su-ambiguous'] },
    });
    expect(d.launch).toHaveBeenCalledOnce();
    expect(d.release).not.toHaveBeenCalled();
  });

  it('launches a current standard target and maps a completed replay to a deduped receipt', async () => {
    const d = deps();
    d.listScorecards.mockResolvedValue([card('EI-audit-1')]);
    d.launch
      .mockResolvedValueOnce(launchResult({ deduped: false, launch: { opened: 1, tasks: [{ taskId: 'task-first' }] } }))
      .mockResolvedValueOnce(launchResult({ deduped: true, launch: { opened: 1, tasks: [{ taskId: 'task-first' }] } }));

    const input = { targetIds: [' EI-audit-1 ', 'EI-audit-1'], ctx, harness: 'papercusp' };
    const first = await dispatchPendingGradingAudits(input, d);
    const replay = await dispatchPendingGradingAudits(input, d);

    expect(first).toEqual({
      requestedTargetIds: ['EI-audit-1'],
      receipts: [
        expect.objectContaining({
          issueId: 'EI-audit-1',
          rubricRef: 'standard-rubric',
          state: 'launched',
          idempotencyKey: 'grading-audit:EI-audit-1',
          launch: { opened: 1, tasks: [{ taskId: 'task-first' }] },
        }),
      ],
    });
    expect(replay.receipts).toEqual([
      expect.objectContaining({
        issueId: 'EI-audit-1',
        state: 'deduped',
        idempotencyKey: 'grading-audit:EI-audit-1',
      }),
    ]);
    expect(d.listScorecards).toHaveBeenNthCalledWith(1, {
      includeSuperseded: true,
      includeRetracted: true,
      issueIds: ['EI-audit-1'],
      limit: GRADING_AUDIT_DISPATCH_LIMIT,
    });
    expect(d.launch).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        brief: expect.stringContaining('scorecard EI-audit-1'),
        harness: 'papercusp',
        workItem: 'EI-audit-1',
        headless: true,
        independent: true,
        account: 'auto',
        count: 1,
        members: [{ role: 'judge', stack: [...GRADING_INTEGRITY_JUDGE_STACK], account: 'auto' }],
        label: 'grading-audit:EI-audit-1',
        idempotencyKey: 'grading-audit:EI-audit-1',
      }),
      auditorCtx,
    );
    expect(d.launch).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ idempotencyKey: 'grading-audit:EI-audit-1' }),
      auditorCtx,
    );
  });

  it("launches a fresh auditor as the system dispatch actor, never inside the calling card author's lineage", async () => {
    // EI-23911815311476758 / EI-23987538343141495: dispatch runs inside the card
    // AUTHOR's own scorecards:emit. Forwarding that caller context stamped the
    // author as the judge's --launched-by, and the emit-side lineage guard then
    // refused the finished audit as self_audit_refused — every time.
    const d = deps();
    d.listScorecards.mockResolvedValue([card('EI-author-emit', { createdBy: 'su-card-author' })]);
    const authorCtx = { ...ctx, ownerId: 'su-card-author' } as DispatchPendingGradingAuditsInput['ctx'];

    await dispatchPendingGradingAudits({ targetIds: ['EI-author-emit'], ctx: authorCtx }, d);

    expect(d.launch).toHaveBeenCalledTimes(1);
    const launchCtx = d.launch.mock.calls[0]?.[1] as { ownerId?: string; principal?: unknown; workspaceId?: string };
    expect(launchCtx.ownerId).not.toBe('su-card-author');
    expect(launchCtx.ownerId).toBe(GRADING_AUDIT_DISPATCH_ACTOR);
    expect(launchCtx.principal).toEqual({ kind: 'system', slug: GRADING_AUDIT_DISPATCH_ACTOR, workspaceId: 'ws-test' });
    expect(launchCtx.workspaceId).toBe('ws-test');
  });

  it('keeps the caller context when no concrete workspace can scope a system principal', () => {
    const unscoped = { ...ctx, workspaceId: '*', ownerId: 'su-caller' } as DispatchPendingGradingAuditsInput['ctx'];
    // Whitespace-only trims to empty — the same "no concrete workspace" branch as an absent one.
    const missing = { ...ctx, workspaceId: '  ', ownerId: 'su-caller' } as DispatchPendingGradingAuditsInput['ctx'];
    expect(gradingAuditorLaunchCtx(unscoped)).toBe(unscoped);
    expect(gradingAuditorLaunchCtx(missing)).toBe(missing);
  });

  it('dedupes against a live same-label auditor after its reservation epoch expires', async () => {
    const d = deps();
    d.listScorecards.mockResolvedValue([card('EI-live-auditor')]);
    d.listTasks.mockResolvedValue([
      {
        taskId: 'task-old-auditor',
        state: 'running',
        detail: { label: 'grading-audit:EI-live-auditor' },
        logPath: '/tmp/old-auditor.log',
      } as unknown as TaskRow,
    ]);

    const result = await dispatchPendingGradingAudits({ targetIds: ['EI-live-auditor'], ctx }, d);

    expect(result.receipts).toEqual([
      {
        issueId: 'EI-live-auditor',
        rubricRef: 'standard-rubric',
        state: 'deduped',
        idempotencyKey: 'grading-audit:EI-live-auditor',
        dispatchReservation: {
          key: 'grading-audit:EI-live-auditor',
          reservedAt: '2026-09-08T00:00:00.000Z',
        },
        renewalNotification: { state: 'delivered', ownerId: 'su-independent', msgId: 'renewal-1', queued: 1, pickupConfirmed: false },
        launch: {
          deduped: true,
          opened: 0,
          failed: 0,
          mode: 'live-task-guard',
          tasks: [
            {
              taskId: 'task-old-auditor',
              logPath: '/tmp/old-auditor.log',
              label: 'grading-audit:EI-live-auditor',
            },
          ],
        },
        reason:
          "existing live grading auditor task 'task-old-auditor' owns grading-audit:EI-live-auditor; duplicate launch suppressed",
      },
    ]);
    expect(d.listTasks).toHaveBeenCalledWith({
      workspaceId: 'ws-test',
      states: ['pending', 'running'],
      labelPrefix: 'grading-audit:EI-live-auditor',
      limit: 10,
    });
    expect(d.route).not.toHaveBeenCalled();
    expect(d.launch).not.toHaveBeenCalled();
    expect(d.notifyRetainedAuditor).toHaveBeenCalledWith(expect.objectContaining({
      card: expect.objectContaining({ issueId: 'EI-live-auditor' }),
      task: expect.objectContaining({ taskId: 'task-old-auditor' }),
      reservation: { key: 'grading-audit:EI-live-auditor', reservedAt: '2026-09-08T00:00:00.000Z' },
    }));
    expect(d.release).toHaveBeenCalledWith('EI-live-auditor', 'grading-audit:EI-live-auditor', {
      workspaceId: 'ws-test',
      reservedAt: '2026-09-08T00:00:00.000Z',
      restore: {
        key: 'grading-audit:EI-live-auditor',
        reservedAt: '2026-09-08T00:00:00.000Z',
      },
    });
  });

  it('retires a live auditor after its consult answerer has been superseded, then routes the current responder', async () => {
    const d = deps();
    const prior = { key: 'grading-audit:EI-stale-responder', reservedAt: '2026-10-08T07:00:00.000Z' };
    d.reserve.mockResolvedValue({
      status: 'claimed',
      reservation: { key: prior.key, reservedAt: '2026-10-08T07:20:00.000Z' },
      prior,
    });
    d.listScorecards.mockResolvedValue([card('EI-stale-responder')]);
    d.listTasks.mockResolvedValue([{
      taskId: 'task-stale-responder',
      state: 'running',
      detail: { label: prior.key, coordOwnerId: 'su-stale-answerer' },
      logPath: '/tmp/stale-responder.log',
    } as unknown as TaskRow]);
    const isCurrentSourceAuditResponder = vi.fn(async () => false);
    const killTask = vi.fn(async (taskId: string) => ({ ok: true as const, taskId, action: 'kill' }));
    d.route.mockResolvedValue({ state: 'routed', conversationId: 'current-answerer-consult' });

    const result = await dispatchPendingGradingAudits({ targetIds: ['EI-stale-responder'], ctx }, {
      ...d,
      killTask,
      isCurrentSourceAuditResponder,
      readLogTail: async () => 'Working through grading-integrity evidence',
      readLogMtimeMs: () => Date.parse('2026-10-08T07:19:30.000Z'),
    });

    expect(isCurrentSourceAuditResponder).toHaveBeenCalledWith('EI-stale-responder', prior, 'su-stale-answerer');
    expect(killTask).toHaveBeenCalledWith('task-stale-responder', {
      includeSubtree: true,
      escalateAfterMs: 5_000,
    });
    expect(d.route).toHaveBeenCalledWith(expect.objectContaining({
      reservationKey: prior.key,
      reservationReservedAt: '2026-10-08T07:20:00.000Z',
    }), expect.anything());
    expect(result.receipts[0]).toMatchObject({
      state: 'routed',
      conversationId: 'current-answerer-consult',
      terminalRecovery: {
        retiredTaskIds: ['task-stale-responder'],
        codes: ['superseded_source_audit_responder'],
      },
    });
    expect(d.notifyRetainedAuditor).not.toHaveBeenCalled();
  });

  it.each([
    { after: 'ended_unobserved', changed: 1, routes: true },
    { after: 'exited', changed: 0, routes: true },
    { after: 'running', changed: 0, routes: false },
  ] as const)('persists collected auditor retirement before routing: $after', async ({ after, changed, routes }) => {
    const d = deps();
    const issueId = 'EI-collected-auditor';
    const taskId = 'task-collected-auditor';
    const prior = { key: `grading-audit:${issueId}`, reservedAt: '2026-10-08T07:00:00.000Z' };
    d.reserve.mockResolvedValue({ status: 'claimed', reservation: prior, prior });
    d.listScorecards.mockResolvedValue([card(issueId)]);
    d.listTasks.mockResolvedValue([{
      taskId, state: 'running', detail: { label: prior.key, coordOwnerId: 'su-old-answerer' },
      logPath: '/tmp/collected-auditor.log',
    } as unknown as TaskRow]);
    let storedState: TaskRow['state'] = 'running';
    const markEndedUnobserved = vi.fn(async () => {
      // An exit observer may win the store's ended_at CAS; its observed exit
      // remains authoritative instead of being overwritten by reconciliation.
      storedState = after;
      return changed;
    });
    d.getTask.mockImplementation(async () => ({ state: storedState } as TaskRow));
    d.route.mockImplementation(async () => {
      expect(storedState).not.toBe('running');
      return { state: 'routed', conversationId: 'replacement-audit' };
    });
    const result = await dispatchPendingGradingAudits({ targetIds: [issueId], ctx }, {
      ...d,
      markEndedUnobserved,
      killTask: vi.fn(async () => ({ ok: false as const, taskId, action: 'kill', error: 'already_gone' as const })),
      isCurrentSourceAuditResponder: vi.fn(async () => false),
      readLogTail: async () => 'Auditor is working',
      readLogMtimeMs: () => Date.parse('2026-10-08T07:19:30.000Z'),
    });

    expect(markEndedUnobserved).toHaveBeenCalledWith([{
      taskId, reason: expect.stringContaining('collected'),
    }]);
    if (routes) {
      expect(d.route).toHaveBeenCalledOnce();
      expect(result.receipts[0]).toMatchObject({
        state: 'routed', terminalRecovery: { retiredTaskIds: [taskId] },
      });
    } else {
      expect(d.route).not.toHaveBeenCalled();
      expect(d.launch).not.toHaveBeenCalled();
      expect(result.receipts[0]).toMatchObject({ state: 'failed', phase: 'task-termination' });
    }
  });

  it.each([
    { after: 'ended_unobserved', changed: 1, routes: true },
    { after: 'exited', changed: 0, routes: true },
    { after: 'running', changed: 0, routes: false },
  ] as const)('reconciles a kernel-ended auditor before the live-task guard: $after', async ({ after, changed, routes }) => {
    const d = deps();
    const issueId = 'EI-kernel-ended-auditor';
    const taskId = 'task-kernel-ended-auditor';
    const prior = { key: `grading-audit:${issueId}`, reservedAt: '2026-10-08T07:00:00.000Z' };
    const task = {
      taskId, state: 'running', detail: { label: prior.key, coordOwnerId: 'su-missing-owner' },
      logPath: '/tmp/kernel-ended-auditor.log',
    } as unknown as TaskRow;
    d.reserve.mockResolvedValue({ status: 'claimed', reservation: prior, prior });
    d.listScorecards.mockResolvedValue([card(issueId)]);
    d.listTasks.mockResolvedValue([task]);
    d.readRetainedTaskKernelVerdicts.mockResolvedValueOnce(new Map([[taskId, 'exact process identity gone; scope collected']]));
    let storedState: TaskRow['state'] = 'running';
    const markEndedUnobserved = vi.fn(async () => {
      storedState = after;
      return changed;
    });
    d.getTask.mockImplementation(async () => ({ state: storedState } as TaskRow));
    d.route.mockImplementation(async () => {
      expect(storedState).not.toBe('running');
      return { state: 'routed', conversationId: 'replacement-audit' };
    });

    const result = await dispatchPendingGradingAudits({ targetIds: [issueId], ctx }, {
      ...d,
      markEndedUnobserved,
      resolveOwnerLiveness: async () => null,
      readLogTail: async () => 'Auditor is working',
      readLogMtimeMs: () => Date.parse('2026-10-08T07:19:30.000Z'),
    });

    expect(d.readRetainedTaskKernelVerdicts).toHaveBeenCalledWith([task], 'ws-test');
    expect(markEndedUnobserved).toHaveBeenCalledWith([{
      taskId, reason: 'exact process identity gone; scope collected',
    }]);
    expect(d.notifyRetainedAuditor).not.toHaveBeenCalled();
    if (routes) {
      expect(d.route).toHaveBeenCalledOnce();
      expect(result.receipts[0]).toMatchObject({
        state: 'routed', terminalRecovery: { retiredTaskIds: [taskId] },
      });
    } else {
      expect(d.route).not.toHaveBeenCalled();
      expect(d.launch).not.toHaveBeenCalled();
      expect(result.receipts[0]).toMatchObject({ state: 'failed', phase: 'retained-task-kernel-reconciliation' });
    }
  });

  it('preserves the retained auditor when kernel reconciliation is unavailable', async () => {
    const d = deps();
    d.listScorecards.mockResolvedValue([card('EI-kernel-unknown')]);
    d.listTasks.mockResolvedValue([{
      taskId: 'task-kernel-unknown', state: 'running',
      detail: { label: 'grading-audit:EI-kernel-unknown', coordOwnerId: 'su-unknown' },
    } as unknown as TaskRow]);
    d.readRetainedTaskKernelVerdicts.mockRejectedValueOnce(new Error('kernel scan unavailable'));
    const markEndedUnobserved = vi.fn(async () => 0);

    const result = await dispatchPendingGradingAudits({ targetIds: ['EI-kernel-unknown'], ctx }, {
      ...d, markEndedUnobserved,
    });

    expect(result.receipts[0]).toMatchObject({ state: 'deduped', launch: { mode: 'live-task-guard' } });
    expect(markEndedUnobserved).not.toHaveBeenCalled();
    expect(d.route).not.toHaveBeenCalled();
    expect(d.launch).not.toHaveBeenCalled();
  });

  it('hands the live auditor its own expired lease back instead of deleting it (WI-10005273)', async () => {
    // The reproduced deadlock: a sweep after the 15-minute TTL re-claims the auditor's lease,
    // finds the auditor still live, and used to DELETE the reservation. The auditor's
    // scorecards:emit then had no lease to cite and was refused, so the card stayed pending.
    const d = deps();
    const auditorLease = { key: 'grading-audit:EI-long-audit', reservedAt: '2026-09-07T23:40:00.000Z' };
    d.reserve.mockResolvedValue({
      status: 'claimed',
      reservation: { key: 'grading-audit:EI-long-audit', reservedAt: '2026-09-08T00:00:00.000Z' },
      prior: auditorLease,
    });
    d.listScorecards.mockResolvedValue([card('EI-long-audit')]);
    d.listTasks.mockResolvedValue([
      {
        taskId: 'task-long-auditor',
        state: 'running',
        detail: { label: 'grading-audit:EI-long-audit' },
        logPath: '/tmp/long-auditor.log',
      } as unknown as TaskRow,
    ]);

    const result = await dispatchPendingGradingAudits({ targetIds: ['EI-long-audit'], ctx }, d);

    expect(result.receipts[0]).toMatchObject({ state: 'deduped', idempotencyKey: 'grading-audit:EI-long-audit' });
    expect(result.receipts[0]).toHaveProperty('dispatchReservation', auditorLease);
    expect(d.notifyRetainedAuditor).not.toHaveBeenCalled();
    expect(d.launch).not.toHaveBeenCalled();
    expect(d.release).toHaveBeenCalledTimes(1);
    expect(d.release).toHaveBeenCalledWith('EI-long-audit', 'grading-audit:EI-long-audit', {
      workspaceId: 'ws-test',
      reservedAt: '2026-09-08T00:00:00.000Z',
      restore: auditorLease,
    });
  });

  it('keeps the old auditor epoch through a separate dispatch claim and never promotes a retained task', async () => {
    const d = deps();
    const prior = { key: 'grading-audit:EI-retained-claim', reservedAt: '2026-09-07T23:40:00.000Z' };
    const claim = { ...prior, reservedAt: '2026-09-08T00:00:00.000Z' };
    d.listScorecards.mockResolvedValue([card('EI-retained-claim')]);
    d.reserve.mockResolvedValue({ status: 'claimed', reservation: prior, prior, dispatchClaim: claim });
    d.listTasks.mockResolvedValue([{ taskId: 'retained', state: 'running',
      detail: { label: prior.key, coordOwnerId: 'su-independent' } } as unknown as TaskRow]);
    const promoteClaim = vi.fn<NonNullable<DispatchPendingGradingAuditsDeps['promoteClaim']>>();
    const result = await dispatchPendingGradingAudits({ targetIds: ['EI-retained-claim'], ctx }, {
      ...d, promoteClaim, resolveOwnerLiveness: vi.fn(async () => ({ sessionState: 'live' as const })),
    });
    expect(result.receipts[0]).toMatchObject({ state: 'deduped', dispatchReservation: prior });
    expect(d.confirmReservation).toHaveBeenCalledWith('EI-retained-claim', prior.key, expect.objectContaining({
      reservedAt: prior.reservedAt, dispatchClaimReservedAt: claim.reservedAt, snapshot: undefined,
    }));
    expect(d.release).toHaveBeenCalledWith('EI-retained-claim', prior.key, {
      workspaceId: 'ws-test', reservedAt: prior.reservedAt, dispatchClaimReservedAt: claim.reservedAt, restore: prior,
    });
    expect(d.notifyRetainedAuditor).toHaveBeenCalledWith(expect.objectContaining({ reservation: prior }));
    expect(promoteClaim).not.toHaveBeenCalled();
    expect(d.launch).not.toHaveBeenCalled();
  });

  it.each([true, false])('publishes a claimed replacement only after no viable auditor remains (CAS=%s)', async (wins) => {
    const d = deps();
    const prior = { key: 'grading-audit:EI-promote-claim', reservedAt: '2026-09-07T23:40:00.000Z' };
    const claim = { ...prior, reservedAt: '2026-09-08T00:00:00.000Z' };
    d.listScorecards.mockResolvedValue([card('EI-promote-claim')]);
    d.reserve.mockResolvedValue({ status: 'claimed', reservation: prior, prior, dispatchClaim: claim });
    d.listTasks.mockResolvedValue([]);
    const promoteClaim = vi.fn<NonNullable<DispatchPendingGradingAuditsDeps['promoteClaim']>>().mockResolvedValue(wins);
    const result = await dispatchPendingGradingAudits({ targetIds: ['EI-promote-claim'], ctx }, { ...d, promoteClaim });
    expect(promoteClaim).toHaveBeenCalledWith('EI-promote-claim', prior, claim, 'ws-test');
    if (wins) {
      expect(d.confirmReservation).toHaveBeenLastCalledWith('EI-promote-claim', prior.key,
        expect.objectContaining({ reservedAt: claim.reservedAt }));
    } else {
      expect(result.receipts[0]).toMatchObject({ state: 'skipped', reason: expect.stringContaining('claim changed') });
      expect(d.launch).not.toHaveBeenCalled();
      expect(d.route).not.toHaveBeenCalled();
    }
  });

  it.each([false, true])('passes the recovered evaluator to the existing auditor with prior lease=%s', async (hasPrior) => {
    const d = deps();
    const key = 'grading-audit:EI-runtime-renew';
    const lease = { key, reservedAt: '2026-09-08T00:00:00.000Z' };
    d.reserve.mockResolvedValue({ status: 'claimed', reservation: lease,
      ...(hasPrior ? { prior: { key, reservedAt: '2026-09-07T23:40:00.000Z' } } : {}) });
    d.listScorecards.mockResolvedValue([card('EI-runtime-renew', {
      gradedGeneration: { deployedSha: '2222222', hostStartedAt: null, bootHeadSha: null,
        scoutCodeHash: null, staleHost: false },
    })]);
    d.listTasks.mockResolvedValue([{ taskId: 'retained', state: 'running',
      detail: { label: key, coordOwnerId: 'su-independent' } } as unknown as TaskRow]);
    const resolveOwnerLiveness = vi.fn<NonNullable<DispatchPendingGradingAuditsDeps['resolveOwnerLiveness']>>()
      .mockResolvedValue({ sessionState: 'live' });
    const result = await dispatchPendingGradingAudits({ targetIds: ['EI-runtime-renew'], ctx }, { ...d, resolveOwnerLiveness });
    expect(result.receipts[0]).toMatchObject({ state: 'deduped', renewalNotification: { state: 'delivered' } });
    expect(d.notifyRetainedAuditor).toHaveBeenCalledWith(expect.objectContaining({
      runtime: await d.ensureRuntime.mock.results[0]!.value,
      task: expect.objectContaining({ taskId: 'retained' }),
    }));
    expect(d.launch).not.toHaveBeenCalled();
    expect(d.route).not.toHaveBeenCalled();
  });

  it.each(['single', 'ambiguous', 'changed-task', 'not-current'] as const)(
    'EI-26950964476692806: hands off an exact runtime under a fresh retained lease only for one identified task (%s)',
    async (population) => {
      const d = deps();
      const issueId = 'EI-runtime-fresh-reservation';
      const lease = { key: `grading-audit:${issueId}`, reservedAt: '2026-09-08T00:00:00.000Z' };
      const target = card(issueId, {
        gradedGeneration: { deployedSha: '2222222', hostStartedAt: null, bootHeadSha: null,
          scoutCodeHash: null, staleHost: false },
      });
      target.gradingAudit = { ...target.gradingAudit!, dispatchReservation: lease };
      d.listScorecards.mockResolvedValue([target]);
      d.reserve.mockResolvedValue({ status: 'already-reserved' });
      const task = { taskId: 'retained', workspaceId: 'ws-test', class: 'agent-session', state: 'running',
        detail: { label: lease.key, coordOwnerId: 'su-independent' } } as unknown as TaskRow;
      d.listTasks.mockResolvedValue(population === 'ambiguous'
        ? [task, { ...task, taskId: 'second-retained' }] : [task]);
      d.getTask.mockResolvedValue(population === 'changed-task' ? { ...task, taskId: 'different-task' } : task);

      const result = await dispatchPendingGradingAudits({ targetIds: [issueId], ctx }, {
        ...d, isCurrentSourceAuditResponder: vi.fn().mockResolvedValue(population !== 'not-current'),
      });
      if (population === 'single') {
        expect(d.notifyRetainedAuditor).toHaveBeenCalledWith(expect.objectContaining({
          card: target, task, reservation: lease, runtime: await d.ensureRuntime.mock.results[0]!.value,
        }));
        expect(result.receipts[0]).toMatchObject({ state: 'deduped', dispatchReservation: lease,
          renewalNotification: { state: 'delivered' } });
      } else {
        expect(d.notifyRetainedAuditor).not.toHaveBeenCalled();
        expect(result.receipts[0]).toMatchObject({ state: 'skipped' });
      }
      expect(d.release).not.toHaveBeenCalled();
      expect(d.launch).not.toHaveBeenCalled();
      expect(d.route).not.toHaveBeenCalled();
    },
  );

  it('does not hand off a renewed lease after losing the restore CAS', async () => {
    const d = deps();
    d.listScorecards.mockResolvedValue([card('EI-renew')]);
    d.listTasks.mockResolvedValue([{ taskId: 'retained', state: 'running', detail: { label: 'grading-audit:EI-renew' } } as unknown as TaskRow]);
    d.release.mockResolvedValue(false);
    const result = await dispatchPendingGradingAudits({ targetIds: ['EI-renew'], ctx }, d);
    expect(result.receipts[0]).toMatchObject({ state: 'skipped', reason: expect.stringContaining('CAS lost') });
    expect(result.receipts[0]).not.toHaveProperty('dispatchReservation');
    expect(d.notifyRetainedAuditor).not.toHaveBeenCalled();
    expect(d.route).not.toHaveBeenCalled();
    expect(d.launch).not.toHaveBeenCalled();
  });

  function parkedAuditorFixture() {
    const d = deps();
    const prior = { key: 'grading-audit:EI-parked', reservedAt: '2026-09-07T23:40:00.000Z' };
    d.reserve.mockResolvedValue({ status: 'claimed', prior,
      reservation: { key: prior.key, reservedAt: '2026-09-08T00:00:00.000Z' } });
    d.listScorecards.mockResolvedValue([card('EI-parked', { evidenceFingerprint: 'exact-fingerprint' })]);
    d.listTasks.mockResolvedValue([{ taskId: 'retained', state: 'running',
      detail: { label: prior.key, coordOwnerId: 'su-independent' } } as unknown as TaskRow]);
    const resolveOwnerLiveness = vi.fn<NonNullable<DispatchPendingGradingAuditsDeps['resolveOwnerLiveness']>>()
      .mockResolvedValue({ sessionState: 'parked' });
    const killTask = vi.fn<NonNullable<DispatchPendingGradingAuditsDeps['killTask']>>();
    return { d, prior, resolveOwnerLiveness, killTask,
      isCurrentSourceAuditResponder: vi.fn(async () => true) };
  }

  it('wakes a positively parked retained auditor without replacing its expired lease or launching another task', async () => {
    const f = parkedAuditorFixture();
    const result = await dispatchPendingGradingAudits({ targetIds: ['EI-parked'], ctx }, { ...f.d, ...f });
    expect(result.receipts[0]).toMatchObject({ state: 'deduped', dispatchReservation: f.prior,
      renewalNotification: { state: 'delivered' } });
    expect(f.d.notifyRetainedAuditor).toHaveBeenCalledWith(expect.objectContaining({
      reservation: f.prior, resumeParked: true, task: expect.objectContaining({ taskId: 'retained' }),
    }));
    expect(f.resolveOwnerLiveness).toHaveBeenCalledWith('su-independent');
    expect(f.d.launch).not.toHaveBeenCalled();
    expect(f.d.route).not.toHaveBeenCalled();
    expect(f.killTask).not.toHaveBeenCalled();
  });

  it('suppresses a retained wake when the same auditor already refused the unchanged basis', async () => {
    const f = parkedAuditorFixture();
    const target = card('EI-parked', { evidenceFingerprint: 'exact-fingerprint' });
    const basisFingerprint = gradingAuditReplayBasisFingerprint(target.issueId, target.gradingAudit!, {
      evidenceFingerprint: 'exact-fingerprint',
      evaluatorBuild: null,
      bindingIds: [],
      bindingCurrentness: null,
    })!;
    target.gradingAudit!.replayRefusal = {
      code: 'grading_audit_replay_consistent',
      at: '2026-09-08T00:01:00.000Z',
      basisFingerprint,
      reservation: f.prior,
      responderOwnerId: 'su-independent',
    };
    f.d.listScorecards.mockResolvedValue([target]);

    const result = await dispatchPendingGradingAudits({ targetIds: ['EI-parked'], ctx }, { ...f.d, ...f });

    expect(result.receipts[0]).toMatchObject({
      state: 'deduped',
      renewalNotification: {
        state: 'skipped',
        reason: 'retained auditor already refused this unchanged replay basis',
      },
    });
    expect(f.d.notifyRetainedAuditor).not.toHaveBeenCalled();
    expect(f.d.launch).not.toHaveBeenCalled();
  });

  it('notifies the retained auditor when the replay basis changed', async () => {
    const f = parkedAuditorFixture();
    const target = card('EI-parked', { evidenceFingerprint: 'exact-fingerprint' });
    const currentBasis = gradingAuditReplayBasisFingerprint(target.issueId, target.gradingAudit!, {
      evidenceFingerprint: 'exact-fingerprint',
      evaluatorBuild: null,
      bindingIds: [],
      bindingCurrentness: null,
    })!;
    target.gradingAudit!.replayRefusal = {
      code: 'grading_audit_replay_consistent',
      at: '2026-09-08T00:01:00.000Z',
      basisFingerprint: 'a'.repeat(64),
      reservation: f.prior,
      responderOwnerId: 'su-independent',
    };
    f.d.listScorecards.mockResolvedValue([target]);

    const result = await dispatchPendingGradingAudits({ targetIds: ['EI-parked'], ctx }, { ...f.d, ...f });

    expect(result.receipts[0]).toMatchObject({ state: 'deduped', renewalNotification: { state: 'delivered' } });
    expect(f.d.notifyRetainedAuditor).toHaveBeenCalledWith(expect.objectContaining({
      replayBasisFingerprint: currentBasis,
      task: expect.objectContaining({ taskId: 'retained' }),
    }));
  });

  it.each(['live', 'suspect', 'ended', 'unknown', 'unavailable'])
  ('delivers the retained lease notice when auditor liveness is %s', async (state) => {
    const f = parkedAuditorFixture();
    if (state === 'unavailable') f.resolveOwnerLiveness.mockRejectedValue(new Error('oracle unavailable'));
    else f.resolveOwnerLiveness.mockResolvedValue(state === 'unknown' ? null
      : { sessionState: state as 'live' | 'suspect' | 'ended' });
    const result = await dispatchPendingGradingAudits({ targetIds: ['EI-parked'], ctx }, { ...f.d, ...f });
    expect(result.receipts[0]).toMatchObject({ state: 'deduped', dispatchReservation: f.prior });
    expect(result.receipts[0]).toMatchObject({ renewalNotification: { state: 'delivered' } });
    const notice = f.d.notifyRetainedAuditor.mock.calls[0]?.[0];
    expect(notice).toEqual(expect.objectContaining({
      reservation: f.prior,
      task: expect.objectContaining({ taskId: 'retained' }),
    }));
    expect(notice).not.toHaveProperty('resumeParked');
    expect(f.d.launch).not.toHaveBeenCalled();
    expect(f.killTask).not.toHaveBeenCalled();
  });

  it('does not choose among multiple retained tasks even when a prior lease exists', async () => {
    const f = parkedAuditorFixture();
    f.d.listTasks.mockResolvedValue(['first', 'second'].map((taskId) => ({ taskId, state: 'running',
      detail: { label: f.prior.key, coordOwnerId: 'su-independent' } } as unknown as TaskRow)));
    await dispatchPendingGradingAudits({ targetIds: ['EI-parked'], ctx }, { ...f.d, ...f });
    expect(f.resolveOwnerLiveness).not.toHaveBeenCalled();
    expect(f.d.notifyRetainedAuditor).not.toHaveBeenCalled();
  });

  it('clears the restored epoch, not the temporary dispatch epoch, if a parked-auditor notice is undelivered', async () => {
    const f = parkedAuditorFixture();
    f.d.notifyRetainedAuditor.mockResolvedValue({ state: 'failed', reason: 'delivery unavailable' });
    await dispatchPendingGradingAudits({ targetIds: ['EI-parked'], ctx }, { ...f.d, ...f });
    expect(f.d.release).toHaveBeenLastCalledWith('EI-parked', f.prior.key,
      { workspaceId: 'ws-test', reservedAt: f.prior.reservedAt });
    expect(f.d.launch).not.toHaveBeenCalled();
  });

  it('does not guess an auditor when multiple live tasks claim the target', async () => {
    const d = deps();
    d.listScorecards.mockResolvedValue([card('EI-renew')]);
    d.listTasks.mockResolvedValue(['first', 'second'].map((taskId) => ({ taskId, state: 'running',
      detail: { label: 'grading-audit:EI-renew' } } as unknown as TaskRow)));
    const result = await dispatchPendingGradingAudits({ targetIds: ['EI-renew'], ctx }, d);
    expect(result.receipts[0]).toMatchObject({ state: 'deduped', renewalNotification: { state: 'skipped', reason: expect.stringContaining('ambiguous') } });
    expect(d.notifyRetainedAuditor).not.toHaveBeenCalled();
    expect(d.launch).not.toHaveBeenCalled();
  });

  it('clears only the undelivered renewal epoch so a scheduled repair can retry', async () => {
    const d = deps();
    d.listScorecards.mockResolvedValue([card('EI-renew')]);
    d.listTasks.mockResolvedValue([{ taskId: 'retained', state: 'running', detail: { label: 'grading-audit:EI-renew' } } as unknown as TaskRow]);
    d.notifyRetainedAuditor.mockResolvedValue({ state: 'failed', reason: 'delivery unavailable' });
    const result = await dispatchPendingGradingAudits({ targetIds: ['EI-renew'], ctx }, d);
    expect(result.receipts[0]).toMatchObject({ renewalNotification: { state: 'failed' } });
    expect(d.release).toHaveBeenCalledTimes(2);
    expect(d.release).toHaveBeenLastCalledWith('EI-renew', 'grading-audit:EI-renew', {
      workspaceId: 'ws-test', reservedAt: '2026-09-08T00:00:00.000Z',
    });
  });

  it('restores nothing on a non-dedupe release, even when the claim replaced an expired lease', async () => {
    // A lease is restored only to a LIVE holder; with no live task the dispatcher owns the row.
    const d = deps();
    d.reserve.mockResolvedValue({
      status: 'claimed',
      reservation: { key: 'grading-audit:EI-gone', reservedAt: '2026-09-08T00:00:00.000Z' },
      prior: { key: 'grading-audit:EI-gone', reservedAt: '2026-09-07T23:40:00.000Z' },
    });
    d.listScorecards.mockResolvedValue([card('EI-gone')]);
    d.confirmReservation.mockResolvedValue(false);

    await dispatchPendingGradingAudits({ targetIds: ['EI-gone'], ctx }, d);

    expect(d.release).toHaveBeenCalledWith('EI-gone', 'grading-audit:EI-gone', {
      workspaceId: 'ws-test',
      reservedAt: '2026-09-08T00:00:00.000Z',
    });
  });

  it('retires a live auditor only when its task and no-first-turn log both exceed the reservation TTL', async () => {
    const d = deps();
    const nowMs = Date.parse('2026-09-30T12:00:00.000Z');
    const oldTask = {
      taskId: 'task-picker-stalled',
      state: 'running',
      startedAt: new Date(nowMs - GRADING_AUDIT_RESERVATION_TTL_MS - 1).toISOString(),
      processIdentity: 'proc-picker-stalled',
      sessionId: 'native-picker-stalled',
      detail: { label: 'grading-audit:EI-picker-stalled', coordOwnerId: 'su-picker-stalled' },
      logPath: '/tmp/picker-stalled.log',
    } as unknown as TaskRow;
    d.listScorecards.mockResolvedValue([card('EI-picker-stalled')]);
    d.listTasks.mockResolvedValue([oldTask]);
    const readLogTail = vi.fn(async () => 'Claude TUI tool picker still visible');
    const killTask = vi.fn(async (taskId: string) => ({ ok: true as const, taskId, action: 'kill' }));

    const result = await reconcilePendingGradingAudits(
      { ctx, harness: 'papercusp' },
      {
        ...d,
        killTask,
        readLogTail: async (path: string) => path.endsWith('.jsonl')
          ? JSON.stringify({ type: 'user', sessionId: 'native-picker-stalled', isSidechain: false, message: { role: 'user' } })
          : readLogTail(),
        now: () => nowMs,
        readLogMtimeMs: () => nowMs - GRADING_AUDIT_RESERVATION_TTL_MS - 1,
        terminalLogMaxRechecks: 0,
        listNativeSessionsByTranscriptHandles: async () => [{
          agent: 'claude', coordOwnerId: 'su-picker-stalled', sessionId: 'native-picker-stalled',
        }],
        findSessionTranscript: async () => '/tmp/picker-stalled.jsonl',
        fetchGatewayOwnerExecution: async () => ({
          active: 1, observedAt: nowMs, processInstanceId: 'gateway-picker-stalled',
          activeRequests: [{ requestId: 1, startedAt: nowMs - 250_000, provider: 'claude' as const,
            providerQueuedAt: nowMs - 240_000, providerAdmittedAt: null, attempts: 0,
            upstreamCalls: 0, upstreamCallsDropped: 0 }],
          activeRequestsComplete: true,
        }),
      },
    );

    expect(killTask).toHaveBeenCalledWith('task-picker-stalled', {
      includeSubtree: true,
      escalateAfterMs: 5_000,
    });
    expect(result.receipts[0]).toMatchObject({
      state: 'launched',
      terminalRecovery: {
        retiredTaskIds: ['task-picker-stalled'],
        codes: ['startup_first_turn_stalled'],
      },
    });
  });

  it('keeps stale live auditors with first-turn progress or unreadable log evidence', async () => {
    for (const evidence of [
      { readLogTail: async () => 'Working (18m)\npapercusp.tools:invoke({})', logMtimeMs: null },
      { readLogTail: async () => { throw new Error('log unavailable'); }, logMtimeMs: null },
    ]) {
      const d = deps();
      const nowMs = Date.parse('2026-09-30T12:00:00.000Z');
      d.listScorecards.mockResolvedValue([card('EI-healthy-live-auditor')]);
      d.listTasks.mockResolvedValue([{
        taskId: 'task-healthy-live-auditor',
        state: 'running',
        startedAt: new Date(nowMs - GRADING_AUDIT_RESERVATION_TTL_MS - 1).toISOString(),
        detail: { label: 'grading-audit:EI-healthy-live-auditor' },
        logPath: '/tmp/healthy-live-auditor.log',
      } as unknown as TaskRow]);
      const readLogTail = vi.fn(evidence.readLogTail);
      const killTask = vi.fn(async (taskId: string) => ({ ok: true as const, taskId, action: 'kill' }));

      const result = await reconcilePendingGradingAudits(
        { ctx, harness: 'papercusp' },
        {
          ...d,
          killTask,
          readLogTail,
          now: () => nowMs,
          readLogMtimeMs: () => nowMs - GRADING_AUDIT_RESERVATION_TTL_MS - 1,
          terminalLogMaxRechecks: 0,
        },
      );

      expect(killTask).not.toHaveBeenCalled();
      expect(result.receipts[0]).toMatchObject({ state: 'deduped' });
    }
  });

  it('uses ended owner liveness to recover an old no-first-turn auditor whose terminal title keeps rewriting its log', async () => {
    const d = deps();
    const nowMs = Date.parse('2026-09-30T12:00:00.000Z');
    d.listScorecards.mockResolvedValue([card('EI-title-redraw')]);
    d.listTasks.mockResolvedValue([{
      taskId: 'task-title-redraw',
      state: 'running',
      startedAt: new Date(nowMs - GRADING_AUDIT_RESERVATION_TTL_MS - 1).toISOString(),
      processIdentity: 'proc-title-redraw',
      sessionId: 'native-title-redraw',
      detail: { label: 'grading-audit:EI-title-redraw', coordOwnerId: 'su-stalled-grader' },
      logPath: '/tmp/title-redraw.log',
    } as unknown as TaskRow]);
    const killTask = vi.fn(async (taskId: string) => ({ ok: true as const, taskId, action: 'kill' }));
    const resolveOwnerLiveness = vi.fn<NonNullable<DispatchPendingGradingAuditsDeps['resolveOwnerLiveness']>>()
      .mockResolvedValue({ sessionState: 'ended' });

    const result = await reconcilePendingGradingAudits(
      { ctx, harness: 'papercusp' },
      {
        ...d,
        killTask,
        readLogTail: async (path: string) => path.endsWith('.jsonl')
          ? JSON.stringify({ type: 'user', sessionId: 'native-title-redraw', isSidechain: false, message: { role: 'user' } })
          : '\u001b]0;grader startup title update\u0007Claude TUI tool picker still visible',
        readLogMtimeMs: () => nowMs - 30_000,
        resolveOwnerLiveness,
        now: () => nowMs,
        terminalLogMaxRechecks: 0,
        listNativeSessionsByTranscriptHandles: async () => [{
          agent: 'claude', coordOwnerId: 'su-stalled-grader', sessionId: 'native-title-redraw',
        }],
        findSessionTranscript: async () => '/tmp/title-redraw.jsonl',
        fetchGatewayOwnerExecution: async () => ({
          active: 1, observedAt: nowMs, processInstanceId: 'gateway-title-redraw',
          activeRequests: [{ requestId: 2, startedAt: nowMs - 250_000, provider: 'claude' as const,
            providerQueuedAt: nowMs - 240_000, providerAdmittedAt: null, attempts: 0,
            upstreamCalls: 0, upstreamCallsDropped: 0 }],
          activeRequestsComplete: true,
        }),
      },
    );

    expect(resolveOwnerLiveness).toHaveBeenCalledExactlyOnceWith('su-stalled-grader');
    expect(killTask).toHaveBeenCalledWith('task-title-redraw', {
      includeSubtree: true,
      escalateAfterMs: 5_000,
    });
    expect(result.receipts[0]).toMatchObject({
      state: 'launched',
      terminalRecovery: {
        retiredTaskIds: ['task-title-redraw'],
        codes: ['startup_first_turn_stalled'],
      },
    });
  });

  it.each([null, 'live', 'parked'] as const)(
    'keeps an old title-redraw task viable when owner liveness is %s',
    async (sessionState) => {
      const d = deps();
      const nowMs = Date.parse('2026-09-30T12:00:00.000Z');
      d.listScorecards.mockResolvedValue([card('EI-title-redraw-unknown')]);
      d.listTasks.mockResolvedValue([{
        taskId: 'task-title-redraw-unknown',
        state: 'running',
        startedAt: new Date(nowMs - GRADING_AUDIT_RESERVATION_TTL_MS - 1).toISOString(),
        detail: { label: 'grading-audit:EI-title-redraw-unknown', coordOwnerId: 'su-uncertain-grader' },
        logPath: '/tmp/title-redraw-unknown.log',
      } as unknown as TaskRow]);
      const killTask = vi.fn(async (taskId: string) => ({ ok: true as const, taskId, action: 'kill' }));
      const resolveOwnerLiveness = vi.fn<NonNullable<DispatchPendingGradingAuditsDeps['resolveOwnerLiveness']>>()
        .mockResolvedValue(sessionState === null ? null : { sessionState });

      const result = await reconcilePendingGradingAudits(
        { ctx, harness: 'papercusp' },
        {
          ...d,
          killTask,
          readLogTail: async () => 'Claude TUI tool picker still visible',
          readLogMtimeMs: () => nowMs - 30_000,
          resolveOwnerLiveness,
          now: () => nowMs,
          terminalLogMaxRechecks: 0,
        },
      );

      expect(resolveOwnerLiveness).toHaveBeenCalledExactlyOnceWith('su-uncertain-grader');
      expect(killTask).not.toHaveBeenCalled();
      expect(result.receipts[0]).toMatchObject({ state: 'deduped', launch: { mode: 'live-task-guard' } });
    },
  );

  describe('a live auditor that completed its turn and parked without emitting (WI-10005295)', () => {
    // Tail shape of task 0muqeanqadsbkcjglk2 (Codex auditor, 2026-10-02): it finished a
    // turn, emitted nothing, and every repair deduped to it until a human killed it.
    const parkedLog =
      '• Audit not emitted. Current target state:\n' +
      '  • gradingAudit.state: pending  › Ask Codex to do anything   Working · GPT-5.6-Sol high\n' +
      '  Worked for 20m 18s • 11:40 PMReady ·GPT-5.6-Sol high ·Context 86% left';
    const run = async (logQuietMs: number, log = parkedLog) => {
      const d = deps();
      const nowMs = Date.parse('2026-10-02T04:01:00.000Z');
      d.listScorecards.mockResolvedValue([card('EI-parked-auditor')]);
      d.listTasks.mockResolvedValue([{
        taskId: 'task-parked-auditor',
        state: 'running',
        startedAt: new Date(nowMs - 41 * 60_000).toISOString(),
        detail: { label: 'grading-audit:EI-parked-auditor' },
        logPath: '/tmp/parked-auditor.log',
      } as unknown as TaskRow]);
      const killTask = vi.fn(async (taskId: string) => ({ ok: true as const, taskId, action: 'kill' }));
      const result = await reconcilePendingGradingAudits(
        { ctx, harness: 'papercusp' },
        {
          ...d,
          killTask,
          readLogTail: vi.fn(async () => log),
          now: () => nowMs,
          readLogMtimeMs: () => nowMs - logQuietMs,
          terminalLogMaxRechecks: 0,
        },
      );
      return { killTask, receipt: result.receipts[0] };
    };

    it('retires it once its log has been quiet past the reservation TTL and relaunches', async () => {
      const { killTask, receipt } = await run(GRADING_AUDIT_RESERVATION_TTL_MS + 1);
      expect(killTask).toHaveBeenCalledWith('task-parked-auditor', {
        includeSubtree: true,
        escalateAfterMs: 5_000,
      });
      expect(receipt).toMatchObject({
        state: 'launched',
        terminalRecovery: {
          retiredTaskIds: ['task-parked-auditor'],
          codes: ['parked_without_emit'],
        },
      });
    });

    it('still dedupes to it while its log moved inside the TTL', async () => {
      const { killTask, receipt } = await run(GRADING_AUDIT_RESERVATION_TTL_MS - 60_000);
      expect(killTask).not.toHaveBeenCalled();
      expect(receipt).toMatchObject({ state: 'deduped', launch: { mode: 'live-task-guard' } });
    });

    it('retires a quiet Codex transport-error ending and relaunches through the independent dispatcher', async () => {
      const log = '• Calling papercusp.tools:invoke(scorecards:get) Working · GPT-5.6-Sol high\n' +
        '■ unexpected status 502 Bad Gateway: inference-gateway: codex OAuth upstream\n' +
        'failed: fetch failed (UND_ERR_CONNECT_TIMEOUT: Connect Timeout Error)\n' +
        '› Ask Codex to do anything Ready · GPT-5.6-Sol high';
      const { killTask, receipt } = await run(GRADING_AUDIT_RESERVATION_TTL_MS + 1, log);
      expect(killTask).toHaveBeenCalledWith('task-parked-auditor', {
        includeSubtree: true,
        escalateAfterMs: 5_000,
      });
      expect(receipt).toMatchObject({
        state: 'launched',
        terminalRecovery: { retiredTaskIds: ['task-parked-auditor'], codes: ['parked_without_emit'] },
      });
    });
  });

  it('retires a live auditor that explicitly finished without platform tools and launches a bounded fallback', async () => {
    const d = deps();
    d.listScorecards.mockResolvedValue([card('EI-tool-refusal')]);
    d.listTasks.mockResolvedValue([{
      taskId: 'task-idle-refusal',
      state: 'running',
      detail: { label: 'grading-audit:EI-tool-refusal' },
      logPath: '/tmp/idle-refusal.log',
    } as unknown as TaskRow]);
    const readLogTail = vi.fn(() =>
      "●I didn't grade scorecard EI-tool-refusal and didn't emit a\n" +
      'grading-integrity audit, because this session has no way to reach the platform.\n' +
      "The platform tools aren't loaded.\n✻Worked for 25s · done 12:33 PM\n❯",
    );
    const killTask = vi.fn(async (taskId: string) => ({ ok: true as const, taskId, action: 'kill' }));

    const result = await reconcilePendingGradingAudits(
      { ctx, harness: 'papercusp', targetIds: ['EI-tool-refusal'] },
      { ...d, readLogTail, killTask, sleep: async () => undefined, terminalLogMaxRechecks: 0 },
    );

    expect(killTask).toHaveBeenCalledWith('task-idle-refusal', {
      includeSubtree: true,
      escalateAfterMs: 5_000,
    });
    expect(d.launch).toHaveBeenCalledWith(
      expect.objectContaining({ agent: 'codex', account: 'auto' }),
      auditorCtx,
    );
    expect(result.receipts[0]).toMatchObject({
      state: 'launched',
      terminalRecovery: {
        retiredTaskIds: ['task-idle-refusal'],
        codes: ['tool_surface_unavailable'],
      },
    });
  });

  it('recovers the measured completed-turn refusal wording instead of deduping to the idle Claude judge', async () => {
    const d = deps();
    d.listScorecards.mockResolvedValue([card('EI-24234352612789401')]);
    d.listTasks.mockResolvedValue([{
      taskId: 'task-tool-less-judge',
      state: 'running',
      detail: { label: 'grading-audit:EI-24234352612789401' },
      logPath: '/tmp/tool-less-judge.log',
    } as unknown as TaskRow]);
    const killTask = vi.fn(async (taskId: string) => ({ ok: true as const, taskId, action: 'kill' }));
    const result = await reconcilePendingGradingAudits(
      { ctx, harness: 'papercusp', targetIds: ['EI-24234352612789401'] },
      {
        ...d,
        killTask,
        readLogTail: () =>
          "● I haven't graded or emitted anything for scorecard EI-24234352612789401.\n" +
          '- No platform tools loaded. No mcp__papercusp__* tool appeared.\n' +
          '✻ Cooked for 24s · done 7:57 AM\n❯',
        sleep: async () => undefined,
        terminalLogMaxRechecks: 0,
      },
    );
    expect(killTask).toHaveBeenCalledWith('task-tool-less-judge', {
      includeSubtree: true,
      escalateAfterMs: 5_000,
    });
    expect(d.launch).toHaveBeenCalledWith(
      expect.objectContaining({ agent: 'codex', account: 'auto' }),
      auditorCtx,
    );
    expect(result.receipts[0]).toMatchObject({
      state: 'launched',
      terminalRecovery: { codes: ['tool_surface_unavailable'] },
    });
  });

  it('retires a ledger-live auditor with a delayed terminal log and launches the bounded Codex fallback', async () => {
    const d = deps();
    d.listScorecards.mockResolvedValue([card('EI-live-terminal-auditor')]);
    d.listTasks.mockResolvedValue([
      {
        taskId: 'task-live-terminal-auditor',
        state: 'running',
        detail: { label: 'grading-audit:EI-live-terminal-auditor' },
        logPath: '/tmp/live-terminal-auditor.log',
      } as unknown as TaskRow,
    ]);
    d.launch.mockResolvedValue(
      launchResult({
        deduped: false,
        launch: { tasks: [{ taskId: 'task-live-terminal-recovery', logPath: '/tmp/recovery.log' }] },
      }),
    );
    const killTask = vi.fn(async (taskId: string) => ({ ok: true as const, taskId, action: 'kill' }));
    const readLogTail = vi.fn((path: string) =>
      path.includes('live-terminal-auditor')
        ? 'API Error: Request rejected (429) · inference-gateway: all accounts throttled; retry after 60s\n' +
          '✻ Brewed for 10m 2s · done 7:45 AM\n❯'
        : 'healthy fallback boot',
    );

    const result = await reconcilePendingGradingAudits(
      { ctx, harness: 'papercusp' },
      {
        ...d,
        killTask,
        readLogTail,
        sleep: async () => undefined,
        terminalLogMaxRechecks: 0,
      },
    );

    expect(killTask).toHaveBeenCalledWith('task-live-terminal-auditor', {
      includeSubtree: true,
      escalateAfterMs: 5_000,
    });
    expect(d.route).toHaveBeenCalledTimes(1);
    expect(d.launch).toHaveBeenCalledTimes(1);
    expect(d.launch).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: 'codex',
        account: 'auto',
        members: [{ role: 'judge', stack: [...GRADING_INTEGRITY_JUDGE_STACK], agent: 'codex', model: 'gpt-5.6-sol', effort: 'high', account: 'auto' }],
        idempotencyKey: expect.stringMatching(
          /^grading-audit:EI-live-terminal-auditor:recovery:[a-f0-9]{16}$/,
        ),
      }),
      auditorCtx,
    );
    expect(result.receipts).toEqual([
      expect.objectContaining({
        issueId: 'EI-live-terminal-auditor',
        state: 'launched',
        terminalRecovery: expect.objectContaining({
          retiredTaskIds: ['task-live-terminal-auditor'],
          attempts: 1,
          codes: ['model_quota_exhausted'],
        }),
      }),
    ]);
  });

  it('gives concurrent auditors scorecard-scoped scratch isolation for the MCP recovery fallback', async () => {
    const d = deps();
    d.listScorecards.mockResolvedValue([card('EI-audit-a'), card('EI-audit-b')]);

    await dispatchPendingGradingAudits({ targetIds: ['EI-audit-a', 'EI-audit-b'], ctx }, d);

    expect(d.launch).toHaveBeenCalledTimes(2);
    const firstBrief = (d.launch.mock.calls[0]?.[0] as { brief: string }).brief;
    const secondBrief = (d.launch.mock.calls[1]?.[0] as { brief: string }).brief;
    expect(firstBrief).toContain('scripts/mcp-call.mjs');
    expect(firstBrief).toContain('--json -');
    expect(firstBrief).toContain('mktemp -d /tmp/grading-integrity-EI-audit-a.XXXXXX');
    expect(firstBrief).toContain('Never read or write shared fixed names such as /tmp/eval-args.json');
    expect(secondBrief).toContain('mktemp -d /tmp/grading-integrity-EI-audit-b.XXXXXX');
    expect(secondBrief).not.toContain('/tmp/grading-integrity-EI-audit-a.XXXXXX');
  });

  it('dispatches independent targets with bounded concurrency while preserving receipt order', async () => {
    const d = deps();
    const targetIds = Array.from({ length: GRADING_AUDIT_DISPATCH_CONCURRENCY + 1 }, (_, i) => `EI-parallel-${i + 1}`);
    d.listScorecards.mockResolvedValue(targetIds.map((issueId) => card(issueId)));

    let active = 0;
    let peak = 0;
    let started = 0;
    let releaseFirstBatch!: () => void;
    const firstBatchReleased = new Promise<void>((resolve) => {
      releaseFirstBatch = resolve;
    });
    d.launch.mockImplementation(async (args) => {
      active += 1;
      peak = Math.max(peak, active);
      started += 1;
      if (started === GRADING_AUDIT_DISPATCH_CONCURRENCY) releaseFirstBatch();
      if (started <= GRADING_AUDIT_DISPATCH_CONCURRENCY) await firstBatchReleased;
      active -= 1;
      return launchResult({
        deduped: false,
        launch: { opened: 1, tasks: [{ taskId: `task-${String((args as { idempotencyKey: string }).idempotencyKey)}` }] },
      });
    });

    const result = await dispatchPendingGradingAudits({ targetIds, ctx }, d);

    expect(peak).toBe(GRADING_AUDIT_DISPATCH_CONCURRENCY);
    expect(result.receipts.map((receipt) => receipt.issueId)).toEqual(targetIds);
    expect(d.launch).toHaveBeenCalledTimes(targetIds.length);
  });

  it('instructs auditors to re-check live grading state before emitting', async () => {
    const d = deps();
    const targetCard = card('EI-state-recheck');
    d.listScorecards.mockResolvedValue([targetCard]);

    await dispatchPendingGradingAudits({ targetIds: ['EI-state-recheck'], ctx }, d);

    const brief = (d.launch.mock.calls[0]?.[0] as { brief: string }).brief;
    expect(brief).toContain('Before emitting, re-read the target with scorecards:get');
    expect(brief).toContain('papercusp.output-envelope/v1');
    expect(brief).toContain('Inspect the outer response before reading scorecard.criteria');
    expect(brief).toContain('follow its content reference with capability:read');
    expect(brief).toContain('never pass the wrapper to a scorecard field reader');
    // EI-24583166035391772: the brief must name fields scorecards:get actually returns.
    expect(brief).toContain('scorecard.auditTarget');
    expect(brief).toContain("scorecard.gradingAuditCurrentness.state to be 'current'");
    expect(brief).toContain("call scorecards:get { issueId:'EI-state-recheck' }");
    expect(brief).toContain('field of that scorecard response, not a state:read registry cell');
    expect(brief).toContain("If the field is absent, 'stale' or 'unknown'");
    expect(brief).toContain("gradingAudit.state is exactly 'pending'");
    expect(brief).toContain("state is not 'pending' (including 'passed', 'failed', or 'cancelled')");
    expect(brief).toContain('superseded or retracted');
    expect(brief).toContain("Dispatch lease: key 'grading-audit:EI-state-recheck', reservedAt '2026-09-08T00:00:00.000Z'");
    expect(brief).toContain("gradingAuditReservation:{ key:'<effective key>', reservedAt:'<effective reservedAt>' }");
    expect(brief).toContain('Before reading criterion evidence');
    expect(brief).toContain('A missing reservation at the START means this kickoff is stale');
    expect(brief).toContain('If a present reservation differs, treat it as a renewal only when your direct coord inbox contains a message from system:grading-audit-dispatch');
    expect(brief).toContain('then use the renewed key and reservedAt as your effective lease for the audit and eventual gradingAuditReservation');
    expect(brief).toContain('Without that direct matching renewal, report the current state and stop without grading or emitting');
    expect(brief).toContain('If you verified a renewal at start or pre-emit, use its renewed key and reservedAt');
    expect(brief).toContain("For a scorecards:emit refusal with code 'grading_audit_replay_consistent'");
    expect(brief).toContain('independently verified evidence outside the exact replay selection');
    expect(brief).toContain('both evidenceKind and evidenceRef');
    expect(brief).toContain('repeat the exact target, currentness, pending-state, and lease checks');
    expect(brief).toContain('retry this same audit at most once');
    expect(brief).toContain("work_items:comment { id:'EI-state-recheck'");
    expect(brief).toContain('Do not claim that an audit was recorded');
    expect(brief).not.toContain('If the emit is refused, report the refusal code and stop.');
    // WI-10006794: an auditor whose lease lapsed mid-audit must still emit. A renewed epoch
    // is accepted only through its direct retained-task notice; unrelated changes still stop.
    expect(brief).toContain('This strict check applies only at the START of the audit');
    expect(brief).toContain('a dispatchReservation that is ABSENT means only that your lease lapsed');
    expect(brief).toContain('it is NOT a reason to stop');
    expect(brief).toContain('emit with your original gradingAuditReservation unchanged');
    expect(brief).toContain('A present reservation with a different key or reservedAt is a renewal only if your direct coord inbox contains a message from system:grading-audit-dispatch');
    expect(brief).toContain('summary "Renewed grading-audit lease for EI-state-recheck"');
    expect(brief).toContain('your existing independent audit task is retained');
    expect(brief).toContain(`the current evidence fingerprint '${targetCard.evidenceFingerprint ?? 'not recorded'}'`);
    expect(brief).toContain('then emit using the renewed key and reservedAt in gradingAuditReservation');
    expect(brief).toContain('Without that direct matching renewal, stop without emitting');
    expect(brief).toContain('an unrelated reservation change or a notice for another task, target, fingerprint, key, or reservedAt is not authority to continue');
  });

  it('selects a settled card whose audit identity is stale and forwards currentness for atomic reopening', async () => {
    const d = deps();
    const currentness = {
      state: 'stale' as const,
      reason: 'revision-mismatch' as const,
      recordedRevision: 4,
      currentRevision: 6,
      recordedCriteriaHash: 'hash-old',
      currentCriteriaHash: 'hash-new',
    };
    d.listScorecards.mockResolvedValue([
      card('EI-stale-settled', {
        gradingAudit: {
          state: 'passed',
          metaRubricRef: GRADING_INTEGRITY_RUBRIC_REF,
          stampedAt: '2026-09-07T00:00:00.000Z',
          rubricRevision: 4,
          criteriaHash: 'hash-old',
          auditIssueId: 'EI-old-audit',
        },
        gradingAuditCurrentness: currentness,
      }),
    ]);

    const result = await dispatchPendingGradingAudits({ targetIds: ['EI-stale-settled'], ctx }, d);

    expect(result.receipts).toEqual([expect.objectContaining({ issueId: 'EI-stale-settled', state: 'launched' })]);
    expect(d.reserve).toHaveBeenCalledWith('EI-stale-settled', 'grading-audit:EI-stale-settled', expect.objectContaining({
      workspaceId: 'ws-test',
      currentness,
      snapshot: expect.any(Object),
    }));
  });

  it('never reopens a cancelled audit stamp even when its recorded audit identity is stale', async () => {
    const d = deps();
    d.listScorecards.mockResolvedValue([
      card('EI-cancelled-audit', {
        retracted: { at: '2026-09-20T04:02:52.814Z', by: 'su-author', reason: 'withdrawn' },
        gradingAudit: {
          state: 'cancelled',
          metaRubricRef: GRADING_INTEGRITY_RUBRIC_REF,
          stampedAt: '2026-09-20T04:02:01.584Z',
          rubricRevision: 6,
          criteriaHash: 'hash-before-retraction',
        },
        gradingAuditCurrentness: {
          state: 'stale',
          reason: 'revision-mismatch',
          recordedRevision: 6,
          currentRevision: 7,
          recordedCriteriaHash: 'hash-before-retraction',
          currentCriteriaHash: 'hash-current',
        },
      }),
    ]);

    const result = await dispatchPendingGradingAudits({ targetIds: ['EI-cancelled-audit'], ctx }, d);

    expect(result.receipts).toEqual([
      expect.objectContaining({ issueId: 'EI-cancelled-audit', state: 'skipped' }),
    ]);
    expect(d.reserve).not.toHaveBeenCalled();
    expect(d.route).not.toHaveBeenCalled();
    expect(d.launch).not.toHaveBeenCalled();
  });

  it('reopens a settled legacy card whose recorded audit identity is missing', async () => {
    const d = deps();
    const currentness = {
      state: 'unknown' as const,
      reason: 'recorded-identity-missing' as const,
      recordedRevision: null,
      currentRevision: 6,
      recordedCriteriaHash: null,
      currentCriteriaHash: 'hash-current',
    };
    d.listScorecards.mockResolvedValue([
      card('EI-legacy-settled', {
        gradingAudit: {
          state: 'failed',
          metaRubricRef: GRADING_INTEGRITY_RUBRIC_REF,
          stampedAt: '2026-09-07T00:00:00.000Z',
          auditIssueId: 'EI-retracted-audit',
        },
        gradingAuditCurrentness: currentness,
      }),
    ]);

    const result = await dispatchPendingGradingAudits({ targetIds: ['EI-legacy-settled'], ctx }, d);

    expect(result.receipts).toEqual([expect.objectContaining({ issueId: 'EI-legacy-settled', state: 'launched' })]);
    expect(d.reserve).toHaveBeenCalledWith('EI-legacy-settled', 'grading-audit:EI-legacy-settled', expect.objectContaining({
      workspaceId: 'ws-test',
      currentness,
      snapshot: expect.any(Object),
    }));
  });

  it.each(['passed', 'failed'] as const)(
    'skips an explicitly requested %s target after its grading audit settled',
    async (state) => {
      const d = deps();
      d.listScorecards.mockResolvedValue([
        card('EI-settled', {
          gradingAudit: {
            state,
            metaRubricRef: GRADING_INTEGRITY_RUBRIC_REF,
            stampedAt: '2026-08-28T00:00:00.000Z',
            auditIssueId: 'EI-grading-audit',
            auditor: 'independent-auditor',
            auditedAt: '2026-08-28T00:05:00.000Z',
          },
        }),
      ]);

      const result = await dispatchPendingGradingAudits({ targetIds: ['EI-settled'], ctx }, d);

      expect(result).toEqual({
        requestedTargetIds: ['EI-settled'],
        receipts: [
          expect.objectContaining({
            issueId: 'EI-settled',
            state: 'skipped',
            reason: 'target is no longer a current pending standard-rubric scorecard',
          }),
        ],
      });
      expect(d.reserve).not.toHaveBeenCalled();
      expect(d.launch).not.toHaveBeenCalled();
    },
  );

  it('reserves a target before launch so a concurrent dispatcher skips the loser', async () => {
    const d = deps();
    d.listScorecards.mockResolvedValue([card('EI-concurrent')]);
    let claimed = false;
    d.reserve.mockImplementation(async () => {
      if (claimed) return { status: 'already-reserved' };
      claimed = true;
      return {
        status: 'claimed',
        reservation: { key: 'grading-audit:EI-concurrent', reservedAt: '2026-09-08T00:00:00.000Z' },
      };
    });

    const [first, second] = await Promise.all([
      dispatchPendingGradingAudits({ targetIds: ['EI-concurrent'], ctx }, d),
      dispatchPendingGradingAudits({ targetIds: ['EI-concurrent'], ctx }, d),
    ]);

    expect(d.reserve).toHaveBeenCalledTimes(2);
    expect(d.launch).toHaveBeenCalledTimes(1);
    expect([first, second].map((result) => result.receipts[0]?.state).sort()).toEqual(['launched', 'skipped']);
    expect([first, second].find((result) => result.receipts[0]?.state === 'skipped')?.receipts[0]?.reason).toBe(
      'another dispatcher already reserved this scorecard',
    );
  });

  it('releases a reservation when the launch fails so repair can retry the target', async () => {
    const d = deps();
    d.listScorecards.mockResolvedValue([card('EI-launch-failure')]);
    d.launch.mockResolvedValue({ isError: true, content: [{ text: 'launch refused' }] } as LaunchResult);

    const now = Date.parse('2026-09-13T05:39:00.000Z');
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await dispatchPendingGradingAudits(
      { targetIds: ['EI-launch-failure'], ctx },
      { ...d, now: () => now },
    );
    warning.mockRestore();

    expect(result.receipts).toEqual([
      expect.objectContaining({ issueId: 'EI-launch-failure', state: 'failed', reason: 'launch refused' }),
    ]);
    expect(d.release).toHaveBeenCalledWith('EI-launch-failure', 'grading-audit:EI-launch-failure', {
      workspaceId: 'ws-test',
      reservedAt: '2026-09-08T00:00:00.000Z',
      backoff: {
        until: new Date(now + GRADING_AUDIT_FAILURE_BACKOFF_MS).toISOString(),
        source: 'retry-window',
        code: 'launch_failed',
        recordedAt: new Date(now).toISOString(),
        reason: 'launch refused',
      },
    });
  });

  describe('zero-process account admission refusal (EI-24935954591005579)', () => {
    const refusal = (opened = 0, tasks: unknown[] = []) => ({
      isError: true,
      content: [{ text: 'psu: --account auto could not be honored: no allowed claude account is available in the pool. Refusing to fall back to the default system login.' }],
      data: { launch: { opened, failed: 1, partial: false, tasks } },
    } as LaunchResult);

    it('reuses the independent, one-retry Codex gateway route when no process started', async () => {
      const d = deps();
      d.listScorecards.mockResolvedValue([card('EI-no-primary-account')]);
      d.launch.mockResolvedValueOnce(refusal())
        .mockResolvedValueOnce(launchResult({ launch: { opened: 1, tasks: [{ taskId: 'codex-audit' }] } }));
      const providerCanServe = vi.fn(async () => true);
      const result = await dispatchPendingGradingAudits(
        { targetIds: ['EI-no-primary-account'], ctx, harness: 'papercusp' }, { ...d, providerCanServe },
      );
      expect(d.launch).toHaveBeenCalledTimes(2);
      expect(d.launch.mock.calls[1]).toEqual([
        expect.objectContaining({
          independent: true, agent: 'codex', account: 'auto',
          members: [{ role: 'judge', stack: [...GRADING_INTEGRITY_JUDGE_STACK], agent: 'codex', model: 'gpt-5.6-sol', effort: 'high', account: 'auto' }],
          idempotencyKey: expect.stringContaining(':recovery:'),
        }),
        auditorCtx,
      ]);
      expect(providerCanServe).toHaveBeenCalledWith('codex');
      expect(result.receipts[0]?.state).toBe('launched');
      expect(d.release).not.toHaveBeenCalled();
    });

    it.each([
      { opened: 1, tasks: [], serviceable: true },
      { opened: 0, tasks: [{ taskId: 'unknown-task' }], serviceable: true },
      { opened: 0, tasks: [], serviceable: false },
    ])('does not retry an unknown/partially-started or unavailable fallback: %j', async (fixture) => {
      const d = deps();
      d.listScorecards.mockResolvedValue([card('EI-not-safe-to-fallback')]);
      d.launch.mockResolvedValue(refusal(fixture.opened, fixture.tasks));
      const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const result = await dispatchPendingGradingAudits(
          { targetIds: ['EI-not-safe-to-fallback'], ctx },
          { ...d, providerCanServe: async () => fixture.serviceable },
        );
        expect(d.launch).toHaveBeenCalledTimes(1);
        expect(result.receipts[0]?.state).toBe('failed');
        expect(d.release).toHaveBeenCalledOnce();
      } finally { warning.mockRestore(); }
    });

    // WI-6554700010030191: the Codex leg of the same zero-process class. The
    // exit-78 text is psu-launcher.mjs's walled-pool refusal, as observed live
    // on 2026-10-27 11:52Z for EI-27130401906495305's recovery leg.
    const codexPreflightRefusal = () => ({
      isError: true,
      content: [{ text: 'capability:launch-agent: 0 of 1 member(s) opened' }],
      data: { launch: { opened: 0, failed: 1, partial: false, tasks: [], failures: [{
        memberIndex: 0, code: 502,
        reason: "headless psu died at boot (exit 78) within 1200ms — log tail: psu: REFUSING TO LAUNCH — no Codex " +
          "account will serve model 'gpt-5.6-sol': the gateway can route to 1 Codex account(s), but every one of them " +
          "currently refuses 'gpt-5.6-sol'. Re-route instead: --agent claude, or a Codex model those accounts accept.",
      }] } },
    } as LaunchResult);

    it('re-routes a zero-process Codex walled-pool boot refusal to Claude once, without a new paid retry', async () => {
      const d = deps();
      d.listScorecards.mockResolvedValue([card('EI-codex-preflight')]);
      d.launch.mockResolvedValueOnce(refusal())
        .mockResolvedValueOnce(codexPreflightRefusal())
        .mockResolvedValueOnce(launchResult({ launch: { opened: 1, tasks: [{ taskId: 'claude-audit' }] } }));
      const providerCanServe = vi.fn(async () => true);
      const result = await dispatchPendingGradingAudits(
        { targetIds: ['EI-codex-preflight'], ctx, harness: 'papercusp' }, { ...d, providerCanServe },
      );
      expect(d.launch).toHaveBeenCalledTimes(3);
      expect(d.launch.mock.calls[1]?.[0]).toEqual(expect.objectContaining({ agent: 'codex' }));
      const reroute = d.launch.mock.calls[2]?.[0] as Record<string, unknown>;
      expect(reroute).not.toHaveProperty('agent');
      expect(reroute.members).toEqual([{ role: 'judge', stack: [...GRADING_INTEGRITY_JUDGE_STACK], account: 'auto' }]);
      expect(reroute.idempotencyKey).toEqual(expect.stringContaining(':recovery:'));
      expect(reroute.idempotencyKey).not.toBe((d.launch.mock.calls[1]?.[0] as Record<string, unknown>).idempotencyKey);
      expect(providerCanServe).toHaveBeenCalledWith('claude');
      expect(result.receipts[0]?.state).toBe('launched');
      expect(d.release).not.toHaveBeenCalled();
    });

    it.each([
      { name: 'claude unserviceable', secondRefusal: false, claudeAvailable: false },
      { name: 'reroute is bounded to one', secondRefusal: true, claudeAvailable: true },
    ])('does not loop or misroute a Codex boot refusal: $name', async (fixture) => {
      const d = deps();
      d.listScorecards.mockResolvedValue([card('EI-codex-preflight-bounded')]);
      d.launch.mockResolvedValueOnce(refusal())
        .mockResolvedValueOnce(codexPreflightRefusal())
        .mockResolvedValue(fixture.secondRefusal ? refusal() : codexPreflightRefusal());
      const providerCanServe = vi.fn(async (backend: string) => backend === 'codex' || fixture.claudeAvailable);
      const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const result = await dispatchPendingGradingAudits(
          { targetIds: ['EI-codex-preflight-bounded'], ctx, harness: 'papercusp' }, { ...d, providerCanServe },
        );
        expect(d.launch).toHaveBeenCalledTimes(fixture.claudeAvailable ? 3 : 2);
        expect(result.receipts[0]?.state).toBe('failed');
        expect(d.release).toHaveBeenCalledOnce();
      } finally { warning.mockRestore(); }
    });
  });

  it('selects a bounded oldest-first backlog when no explicit targets are supplied', async () => {
    const d = deps();
    d.listScorecards.mockResolvedValue([
      card('EI-new', { createdAt: '2026-09-05T00:00:00.000Z' }),
      card('EI-old', { createdAt: '2026-09-01T00:00:00.000Z' }),
      card('EI-tie-b', { createdAt: '2026-09-02T00:00:00.000Z' }),
      card('EI-tie-a', { createdAt: '2026-09-02T00:00:00.000Z' }),
      card('EI-superseded', { createdAt: '2026-08-01T00:00:00.000Z', supersededBy: 'EI-replacement' }),
      card('EI-retracted', { createdAt: '2026-08-02T00:00:00.000Z', retracted: {} as ScorecardRow['retracted'] }),
      card('EI-meta', { createdAt: '2026-08-03T00:00:00.000Z', rubricRef: GRADING_INTEGRITY_RUBRIC_REF }),
    ]);

    const result = await dispatchPendingGradingAudits({ ctx, harness: 'papercusp' }, d);

    expect(result.requestedTargetIds).toEqual(['EI-old', 'EI-tie-a', 'EI-tie-b', 'EI-new']);
    expect(d.listScorecards).toHaveBeenCalledWith({
      includeSuperseded: true,
      includeRetracted: true,
      limit: GRADING_AUDIT_BACKLOG_SCAN_LIMIT,
    });
    expect(d.launch.mock.calls.map(([args]) => (args as { idempotencyKey?: string }).idempotencyKey)).toEqual([
      'grading-audit:EI-old',
      'grading-audit:EI-tie-a',
      'grading-audit:EI-tie-b',
      'grading-audit:EI-new',
    ]);
  });

  it('finds an explicit pending target outside the newest scorecard page', async () => {
    const d = deps();
    const oldTarget = card('EI-old-target', { createdAt: '2026-08-01T00:00:00.000Z' });
    d.listScorecards.mockImplementation(async (filter) =>
      filter?.issueIds?.includes(oldTarget.issueId)
        ? [oldTarget]
        : Array.from({ length: GRADING_AUDIT_DISPATCH_LIMIT }, (_, i) => card(`EI-new-${i}`)),
    );

    const result = await dispatchPendingGradingAudits({ targetIds: [oldTarget.issueId], ctx }, d);

    expect(d.listScorecards).toHaveBeenCalledWith({
      includeSuperseded: true,
      includeRetracted: true,
      issueIds: [oldTarget.issueId],
      limit: GRADING_AUDIT_DISPATCH_LIMIT,
    });
    expect(result.receipts).toEqual([
      expect.objectContaining({ issueId: oldTarget.issueId, state: 'launched' }),
    ]);
    expect(d.launch).toHaveBeenCalledOnce();
  });

  it('skips superseded, retracted, meta-rubric, missing-rubric, and nonstandard targets', async () => {
    const d = deps();
    d.listScorecards.mockResolvedValue([
      card('EI-current'),
      card('EI-superseded', { supersededBy: 'EI-replacement' }),
      card('EI-retracted', { retracted: {} as ScorecardRow['retracted'] }),
      card('EI-meta', { rubricRef: GRADING_INTEGRITY_RUBRIC_REF }),
      card('EI-missing', { rubricRef: 'missing-rubric' }),
      card('EI-acceptance', { rubricRef: 'acceptance-rubric' }),
    ]);
    d.getRubric.mockImplementation(async (ref) => {
      if (ref === 'missing-rubric') return null;
      if (ref === 'acceptance-rubric') return { kind: 'acceptance' } as Rubric;
      return standardRubric();
    });

    const result = await dispatchPendingGradingAudits(
      {
        targetIds: ['EI-current', 'EI-superseded', 'EI-retracted', 'EI-meta', 'EI-missing', 'EI-acceptance'],
        ctx,
        harness: '*',
      },
      d,
    );

    expect(d.launch).toHaveBeenCalledTimes(1);
    expect(d.launch).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey: 'grading-audit:EI-current' }), auditorCtx);
    expect(d.launch.mock.calls[0]?.[0]).not.toHaveProperty('harness');
    // EI-23414612968722239 regression: `role:'judge'` is a HARNESS-SCOPED persona, so it must
    // be gated on the SAME condition as `harness` itself. Sending the role without a harness
    // makes launch-agent refuse the spawn outright ("no harness resolved"), which leaves the
    // card's gradingAudit stamp stuck at 'pending' — and settledGradingAuditIsCurrent() FAILS a
    // pending stamp while PASSING an unstamped card, so a failed dispatch is strictly worse
    // than none: it deadlocks acceptance-rubric vetting for every plan it was meant to audit.
    expect((d.launch.mock.calls[0]?.[0] as { members?: unknown[] }).members?.[0]).not.toHaveProperty('role');
    expect(result.receipts).toEqual([
      expect.objectContaining({ issueId: 'EI-current', state: 'launched', rubricRef: 'standard-rubric' }),
      expect.objectContaining({ issueId: 'EI-superseded', state: 'skipped' }),
      expect.objectContaining({ issueId: 'EI-retracted', state: 'skipped' }),
      expect.objectContaining({ issueId: 'EI-meta', state: 'skipped' }),
      expect.objectContaining({ issueId: 'EI-missing', state: 'skipped', reason: 'target rubric not found' }),
      expect.objectContaining({
        issueId: 'EI-acceptance',
        state: 'skipped',
        reason: "target rubric kind 'acceptance' is not standard",
      }),
    ]);
  });

  it('bounds a duplicate-heavy request before reading or launching more than the dispatch limit', async () => {
    const d = deps();
    const targetIds = Array.from({ length: GRADING_AUDIT_DISPATCH_LIMIT + 5 }, (_, i) => `EI-audit-${i + 1}`);
    d.listScorecards.mockResolvedValue(targetIds.map((issueId) => card(issueId)));

    const result = await dispatchPendingGradingAudits({ targetIds: [...targetIds, ...targetIds.slice(0, 3)], ctx }, d);

    expect(result.requestedTargetIds).toHaveLength(GRADING_AUDIT_DISPATCH_LIMIT);
    expect(result.requestedTargetIds).toEqual(targetIds.slice(0, GRADING_AUDIT_DISPATCH_LIMIT));
    expect(result.receipts).toHaveLength(GRADING_AUDIT_DISPATCH_LIMIT);
    expect(d.listScorecards).toHaveBeenCalledWith({
      includeSuperseded: true,
      includeRetracted: true,
      issueIds: targetIds.slice(0, GRADING_AUDIT_DISPATCH_LIMIT),
      limit: GRADING_AUDIT_DISPATCH_LIMIT,
    });
    expect(d.launch).toHaveBeenCalledTimes(GRADING_AUDIT_DISPATCH_LIMIT);
  });

  it('retires a standalone weekly-limit auditor and launches one deterministic Codex fallback', async () => {
    const d = deps();
    d.listScorecards.mockResolvedValue([card('EI-weekly-limit')]);
    d.launch
      .mockResolvedValueOnce(
        launchResult({
          deduped: true,
          launch: { tasks: [{ taskId: 'task-quota', logPath: '/tmp/grading-quota.log' }] },
        }),
      )
      .mockResolvedValueOnce(
        launchResult({
          deduped: false,
          launch: { tasks: [{ taskId: 'task-fallback', logPath: '/tmp/grading-fallback.log' }] },
        }),
      );
    const killTask = vi.fn(async (taskId: string) => ({ ok: true as const, taskId, action: 'kill' }));
    const readLogTail = vi.fn((path: string) =>
      path.includes('quota')
        ? "You've hit your weekly limit · resets Sep 10, 7am (America/New_York)"
        : 'healthy fallback boot',
    );

    const result = await dispatchPendingGradingAudits(
      { targetIds: ['EI-weekly-limit'], ctx, harness: 'papercusp' },
      {
        ...d,
        killTask,
        readLogTail,
        sleep: async () => undefined,
        terminalLogRecheckDelayMs: 0,
        terminalLogMaxRechecks: 0,
      },
    );

    expect(killTask).toHaveBeenCalledWith('task-quota', { includeSubtree: true, escalateAfterMs: 5_000 });
    expect(d.launch).toHaveBeenCalledTimes(2);
    expect(d.launch.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({
        agent: 'codex',
        account: 'auto',
        members: [{ role: 'judge', stack: [...GRADING_INTEGRITY_JUDGE_STACK], agent: 'codex', model: 'gpt-5.6-sol', effort: 'high', account: 'auto' }],
        idempotencyKey: expect.stringMatching(/^grading-audit:EI-weekly-limit:recovery:[a-f0-9]{16}$/),
      }),
    );
    expect(result.receipts).toEqual([
      expect.objectContaining({
        issueId: 'EI-weekly-limit',
        state: 'launched',
        terminalRecovery: {
          retiredTaskIds: ['task-quota'],
          attempts: 2,
          codes: ['model_quota_exhausted'],
          fallback: { agent: 'codex', model: 'gpt-5.6-sol', effort: 'high', account: 'auto' },
          routedTo: 'codex',
        },
      }),
    ]);
  });

  /**
   * WI-10002318. The dispatcher holds exactly ONE terminal retry, and it used to
   * spend it on the Codex fallback unconditionally. Measured 2026-09-22T02:36Z,
   * codex was 0-of-7 serviceable (usage-wall, ~4d out) while claude was 2-of-3,
   * so every retry died at boot on the launcher's walled-pool preflight (exit 78)
   * and the audit landed in backoff without ever being tried on a live provider.
   *
   * These three cases are a MATCHED SET, not variations: the walled case alone is
   * satisfied by simply deleting the flip, so the serviceable case is the control
   * that pins the flip still happening, and the throwing case pins the documented
   * fail-open contract (a ledger outage must not stop us trying at all).
   */
  function quotaTerminalFallbackDeps() {
    const d = deps();
    d.listScorecards.mockResolvedValue([card('EI-walled-fallback')]);
    d.launch
      .mockResolvedValueOnce(
        launchResult({
          deduped: true,
          launch: { tasks: [{ taskId: 'task-quota', logPath: '/tmp/grading-quota.log' }] },
        }),
      )
      .mockResolvedValueOnce(
        launchResult({
          deduped: false,
          launch: { tasks: [{ taskId: 'task-retry', logPath: '/tmp/grading-retry.log' }] },
        }),
      );
    return {
      ...d,
      killTask: vi.fn(async (taskId: string) => ({ ok: true as const, taskId, action: 'kill' })),
      readLogTail: vi.fn((path: string) =>
        path.includes('quota')
          ? "You've hit your weekly limit · resets Sep 10, 7am (America/New_York)"
          : 'healthy retry boot',
      ),
      sleep: async () => undefined,
      terminalLogRecheckDelayMs: 0,
      terminalLogMaxRechecks: 0,
    };
  }

  it('does NOT route the bounded terminal retry to a fallback provider that is measurably at capacity', async () => {
    const d = quotaTerminalFallbackDeps();
    const providerCanServe = vi.fn(async () => false);

    const result = await dispatchPendingGradingAudits(
      { targetIds: ['EI-walled-fallback'], ctx, harness: 'papercusp' },
      { ...d, providerCanServe },
    );

    expect(providerCanServe).toHaveBeenCalledWith('codex');
    // The receipt names the route TAKEN, not just the configured fallback —
    // `fallback` still reads codex here, which is exactly what misled a reader
    // of the live 2026-09-27 receipt (WI-10003463).
    expect(result.receipts[0]).toMatchObject({
      terminalRecovery: { fallback: expect.objectContaining({ agent: 'codex' }), routedTo: 'claude' },
    });
    // The retry still happens — it is simply routed at the primary, whose
    // auto-routed gateway pool may still have headroom.
    expect(d.launch).toHaveBeenCalledTimes(2);
    const retry = d.launch.mock.calls[1]?.[0] as Record<string, unknown>;
    expect(retry).not.toHaveProperty('agent');
    expect(retry.members).toEqual([{ role: 'judge', stack: [...GRADING_INTEGRITY_JUDGE_STACK], account: 'auto' }]);
    // And the one-retry ceiling still holds: the retry was CONSUMED, not refunded.
    expect(d.launch).not.toHaveBeenCalledTimes(3);
  });

  it('DOES route the bounded terminal retry to the fallback provider when it can serve', async () => {
    const d = quotaTerminalFallbackDeps();
    const providerCanServe = vi.fn(async () => true);

    const result = await dispatchPendingGradingAudits(
      { targetIds: ['EI-walled-fallback'], ctx, harness: 'papercusp' },
      { ...d, providerCanServe },
    );

    expect(result.receipts[0]).toMatchObject({ terminalRecovery: { routedTo: 'codex' } });
    expect(d.launch).toHaveBeenCalledTimes(2);
    expect(d.launch.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({
        agent: 'codex',
        members: [{ role: 'judge', stack: [...GRADING_INTEGRITY_JUDGE_STACK], agent: 'codex', model: 'gpt-5.6-sol', effort: 'high', account: 'auto' }],
      }),
    );
  });

  it('fails OPEN to the fallback provider when the account ledger cannot be read', async () => {
    const d = quotaTerminalFallbackDeps();
    const providerCanServe = vi.fn(async () => {
      throw new Error('account ledger unavailable');
    });

    await dispatchPendingGradingAudits(
      { targetIds: ['EI-walled-fallback'], ctx, harness: 'papercusp' },
      { ...d, providerCanServe },
    );

    expect(d.launch).toHaveBeenCalledTimes(2);
    expect(d.launch.mock.calls[1]?.[0]).toEqual(expect.objectContaining({ agent: 'codex' }));
  });

  it.each([
    {
      screen: 'gateway 5xx',
      terminalCode: 'inference_gateway_error',
      gatewayLog:
        '\u001b[38;5;220m●\u001b[3GAPI Error: 500 inference-gateway internal error. This is a server-side\r\n' +
        'issue, usually temporary — try again in a moment. If it persists, check your inference gateway ' +
        '(127.0.0.1:8788).\r\n' +
        '\u001b[38;5;246m✻ Cooked for 12m 56s · done 11:27 AM\u001b[0m\r\n❯',
    },
    {
      screen: 'gateway 429',
      terminalCode: 'model_quota_exhausted',
      gatewayLog:
        '\u001b[38;5;220m●\u001b[3GAPI Error: Request rejected (429) · inference-gateway: all accounts \r\n' +
        'throttled; retry after 60s\u001b[0m\r\n\r\n✻ Worked for 13m 45s · done 9:09 AM\r\n❯',
    },
    {
      screen: 'gateway 429 without a completed-turn footer',
      terminalCode: 'model_quota_exhausted',
      gatewayLog:
        '\u001b[38;5;220m●\u001b[3GAPI Error: Request rejected (429) · inference-gateway: all accounts \r\n' +
        'throttled; retry after 60s\u001b[0m',
    },
    {
      screen: 'account-scoped gateway 429',
      terminalCode: 'model_quota_exhausted',
      gatewayLog:
        '\u001b[38;5;220m●\u001b[3GAPI Error: Request rejected (429)\r\n' +
        "This request would exceed your account's rate limit. Please try again later.\u001b[0m\r\n\r\n" +
        '✻ Cogitated for 6m 49s · done 9:01 AM\r\n❯',
    },
    {
      screen: 'account-paced gateway 429',
      terminalCode: 'inference_gateway_error',
      gatewayLog:
        "\u001b[38;5;220m●\u001b[3GAPI Error: Request rejected (429) · inference-gateway: account 'aviynw4' " +
        'paced/paused; retry after 60s\u001b[0m\r\n\r\n✻ Cooked for 13m 41s · done 9:33 AM\r\n❯',
    },
  ])('retires a deduped auditor with a terminal $screen and launches the Codex fallback', async ({ gatewayLog, terminalCode }) => {
    const d = deps();
    d.listScorecards.mockResolvedValue([card('EI-gateway-500')]);
    d.launch
      .mockResolvedValueOnce(
        launchResult({
          deduped: true,
          launch: { tasks: [{ taskId: 'task-gateway-500', logPath: '/tmp/grading-gateway-500.log' }] },
        }),
      )
      .mockResolvedValueOnce(
        launchResult({
          deduped: false,
          launch: { tasks: [{ taskId: 'task-fallback', logPath: '/tmp/grading-fallback.log' }] },
        }),
      );
    const killTask = vi.fn(async (taskId: string) => ({ ok: true as const, taskId, action: 'kill' }));
    const result = await dispatchPendingGradingAudits(
      { targetIds: ['EI-gateway-500'], ctx, harness: 'papercusp' },
      {
        ...d,
        killTask,
        readLogTail: (path) => (path.includes('gateway-500') ? gatewayLog : 'healthy fallback boot'),
        sleep: async () => undefined,
        terminalLogRecheckDelayMs: 0,
        terminalLogMaxRechecks: 0,
      },
    );

    expect(killTask).toHaveBeenCalledWith('task-gateway-500', {
      includeSubtree: true,
      escalateAfterMs: 5_000,
    });
    expect(d.launch).toHaveBeenCalledTimes(2);
    expect(d.launch.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({
        agent: 'codex',
        account: 'auto',
        members: [{ role: 'judge', stack: [...GRADING_INTEGRITY_JUDGE_STACK], agent: 'codex', model: 'gpt-5.6-sol', effort: 'high', account: 'auto' }],
        idempotencyKey: expect.stringMatching(/^grading-audit:EI-gateway-500:recovery:[a-f0-9]{16}$/),
      }),
    );
    expect(result.receipts).toEqual([
      expect.objectContaining({
        issueId: 'EI-gateway-500',
        state: 'launched',
        terminalRecovery: expect.objectContaining({
          retiredTaskIds: ['task-gateway-500'],
          codes: [terminalCode],
        }),
      }),
    ]);
  });

  it.each(['terminal', 'credit-balance', 'quoted', 'unreadable', 'healthy-peer'] as const)(
    'repairs a fresh reserved auditor only with complete terminal proof: %s', async (proof) => {
      const d = deps();
      const issueId = 'EI-fresh-reserved-terminal';
      const sessionId = 'native-fresh-reserved';
      const ownerId = 'su-failed-reserved-auditor';
      const prior = { key: `grading-audit:${issueId}`, reservedAt: '2026-10-23T22:44:48.945Z' };
      const target = card(issueId);
      target.gradingAudit = { ...target.gradingAudit!, dispatchReservation: prior };
      d.listScorecards.mockResolvedValue([target]);
      d.reserve.mockResolvedValueOnce({ status: 'already-reserved' });
      const task = {
        taskId: 'task-fresh-reserved', sessionId, workspaceId: 'ws-test', class: 'agent-session',
        state: 'running', logPath: '/tmp/fresh-reserved.log',
        detail: { label: prior.key, coordOwnerId: ownerId },
      } as unknown as TaskRow;
      const healthy = {
        ...task, taskId: 'task-healthy-reserved', sessionId: 'native-healthy',
        detail: { label: prior.key, coordOwnerId: 'su-healthy-auditor' },
      } as TaskRow;
      d.listTasks.mockResolvedValueOnce(proof === 'healthy-peer' ? [task, healthy] : [task]);
      const killTask = vi.fn(async (taskId: string) => ({ ok: true as const, taskId, action: 'kill' as const }));
      const nativeErrorText = proof === 'credit-balance'
        ? 'Credit balance too low · Add funds:'
        : "API Error: 400 role 'system' is not supported on this model";
      const nativeTranscript = JSON.stringify({
        type: 'assistant', sessionId, isSidechain: false, isApiErrorMessage: proof !== 'quoted', apiErrorStatus: 400,
        message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text',
          text: nativeErrorText }] },
      });
      const result = await dispatchPendingGradingAudits({ targetIds: [issueId], ctx, harness: 'papercusp' }, {
        ...d, killTask,
        listNativeSessionsByTranscriptHandles: async () => [{ sessionId, coordOwnerId: ownerId, agent: 'claude' }],
        findSessionTranscript: async () => '/tmp/fresh-reserved.jsonl',
        readLogTail: path => {
          if (path.endsWith('.jsonl')) {
            if (proof === 'unreadable') throw new Error('native evidence unavailable');
            return nativeTranscript;
          }
          if (proof === 'credit-balance') {
            return '  ⎿ Credit balance too low · Add funds: \n\n✻Sautéed for 1m 48s · done 5:15 AM\n❯';
          }
          return "API Error: 400 role 'system' is not supported on this model\n❯";
        },
        terminalLogRecheckDelayMs: 0, terminalLogMaxRechecks: 0,
      });
      if (proof === 'terminal' || proof === 'credit-balance') {
        expect(d.release).toHaveBeenCalledWith(issueId, prior.key,
          expect.objectContaining({ workspaceId: 'ws-test', reservedAt: prior.reservedAt }));
        expect(d.reserve).toHaveBeenCalledTimes(2);
        expect(d.launch).toHaveBeenCalledOnce();
        expect(result.receipts[0]).toMatchObject({ state: 'launched',
          terminalRecovery: { retiredTaskIds: [task.taskId], codes: ['inference_gateway_error'] } });
      } else {
        expect(d.release).not.toHaveBeenCalled();
        expect(d.reserve).toHaveBeenCalledOnce();
        expect(d.launch).not.toHaveBeenCalled();
        expect(result.receipts[0]).toMatchObject({ state: 'skipped' });
      }
      if (proof === 'terminal' || proof === 'credit-balance' || proof === 'healthy-peer') expect(killTask).toHaveBeenCalledOnce();
      else expect(killTask).not.toHaveBeenCalled();
    },
  );

  it('recovers a fresh reserved auditor from its exact terminal native transcript during a periodic no-target sweep', async () => {
    const d = deps();
    const issueId = 'EI-periodic-reserved-terminal';
    const sessionId = 'native-periodic-reserved';
    const ownerId = 'su-failed-periodic-auditor';
    const prior = { key: `grading-audit:${issueId}`, reservedAt: '2026-10-23T22:44:48.945Z' };
    const target = card(issueId);
    target.gradingAudit = { ...target.gradingAudit!, dispatchReservation: prior };
    d.listScorecards.mockResolvedValue([target]);
    d.reserve.mockResolvedValueOnce({ status: 'already-reserved' });
    const task = {
      taskId: 'task-periodic-reserved', sessionId, workspaceId: 'ws-test', class: 'agent-session',
      state: 'running', logPath: '/tmp/periodic-reserved.log',
      detail: { label: prior.key, coordOwnerId: ownerId },
    } as unknown as TaskRow;
    d.listTasks.mockResolvedValueOnce([task]);
    const killTask = vi.fn(async (taskId: string) => ({ ok: true as const, taskId, action: 'kill' as const }));
    const nativeTranscript = JSON.stringify({
      type: 'assistant', sessionId, isSidechain: false, isApiErrorMessage: true, apiErrorStatus: 400,
      message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text',
        text: 'Credit balance is too low' }] },
    });

    const result = await dispatchPendingGradingAudits({ ctx, harness: 'papercusp' }, {
      ...d,
      killTask,
      listNativeSessionsByTranscriptHandles: async () => [{ sessionId, coordOwnerId: ownerId, agent: 'claude' }],
      findSessionTranscript: async () => '/tmp/periodic-reserved.jsonl',
      readLogTail: path => path.endsWith('.jsonl') ? nativeTranscript : 'Credit balance is too low',
      terminalLogRecheckDelayMs: 0,
      terminalLogMaxRechecks: 0,
    });

    expect(killTask).toHaveBeenCalledExactlyOnceWith(task.taskId, { includeSubtree: true, escalateAfterMs: 5_000 });
    expect(d.release).toHaveBeenCalledWith(issueId, prior.key,
      expect.objectContaining({ workspaceId: 'ws-test', reservedAt: prior.reservedAt }));
    expect(d.reserve).toHaveBeenCalledTimes(2);
    expect(d.launch).toHaveBeenCalledOnce();
    expect(result.receipts[0]).toMatchObject({
      issueId,
      state: 'launched',
      terminalRecovery: { retiredTaskIds: [task.taskId], codes: ['inference_gateway_error'] },
    });
  });

  it.each([false, true])('uses the exact retained Claude session transcript (missing task binding: %s) to recover a gateway failure without a PTY footer', async (missingBinding) => {
    const d = deps();
    const sessionId = 'native-retained-session';
    const ownerId = 'su-retained-auditor';
    const nativeTranscript = JSON.stringify({
      type: 'assistant',
      sessionId,
      isSidechain: false,
      isApiErrorMessage: true,
      apiErrorStatus: 429,
      message: { role: 'assistant', stop_reason: 'stop_sequence', content: [{ type: 'text', text: 'API error' }] },
    });
    const task = {
      taskId: 'task-retained-native',
      sessionId: missingBinding ? null : sessionId,
      workspaceId: 'ws-test',
      class: 'agent-session',
      state: 'running',
      startedAt: new Date().toISOString(),
      logPath: '/tmp/grading-retained-native.log',
      detail: { label: 'grading-audit:EI-retained-native', coordOwnerId: ownerId },
    } as unknown as TaskRow;
    d.listScorecards.mockResolvedValue([card('EI-retained-native')]);
    d.listTasks.mockResolvedValue([task]);
    d.bindTaskNativeSession.mockResolvedValue(sessionId);
    d.launch.mockResolvedValueOnce(launchResult({
      deduped: false,
      launch: { tasks: [{ taskId: 'task-retained-fallback', logPath: '/tmp/grading-retained-fallback.log' }] },
    }));
    const listNativeSessions = vi.fn<NonNullable<DispatchPendingGradingAuditsDeps['listNativeSessionsByTranscriptHandles']>>()
      .mockResolvedValue([{ sessionId, coordOwnerId: ownerId, agent: 'claude' }]);
    const resolveTranscript = vi.fn<NonNullable<DispatchPendingGradingAuditsDeps['findSessionTranscript']>>()
      .mockResolvedValue('/tmp/grading-retained-native.jsonl');
    const nowMs = Date.now();
    const killTask = vi.fn(async (taskId: string) => ({ ok: true as const, taskId, action: 'kill' as const }));
    const providerCanServe = vi.fn(async () => true);
    const ptyLog =
      'API Error: Request rejected (429) · inference-gateway: all accounts throttled; retry after 60s';

    const result = await dispatchPendingGradingAudits(
      { targetIds: ['EI-retained-native'], ctx, harness: 'papercusp' },
      {
        ...d,
        listNativeSessionsByTranscriptHandles: listNativeSessions,
        findSessionTranscript: resolveTranscript,
        killTask,
        providerCanServe,
        isCurrentSourceAuditResponder: vi.fn(async () => true),
        readLogTail: (path) => path.endsWith('.jsonl')
          ? nativeTranscript
          : path.includes('fallback') ? 'healthy fallback boot' : ptyLog,
        readLogMtimeMs: () => nowMs,
        now: () => nowMs,
        terminalLogRecheckDelayMs: 0,
        terminalLogMaxRechecks: 0,
      },
    );

    expect(listNativeSessions).toHaveBeenCalledExactlyOnceWith([sessionId]);
    if (missingBinding) expect(d.bindTaskNativeSession).toHaveBeenCalledExactlyOnceWith(task.taskId);
    else expect(d.bindTaskNativeSession).not.toHaveBeenCalled();
    expect(resolveTranscript).toHaveBeenCalledExactlyOnceWith(sessionId, { owner: ownerId });
    expect(killTask).toHaveBeenCalledWith(task.taskId, { includeSubtree: true, escalateAfterMs: 5_000 });
    expect(d.launch).toHaveBeenCalledOnce();
    expect(providerCanServe).toHaveBeenCalledWith('codex');
    expect(d.launch.mock.calls[0]?.[0]).toMatchObject({ agent: 'codex' });
    expect(result.receipts[0]).toMatchObject({
      issueId: 'EI-retained-native',
      state: 'launched',
      terminalRecovery: {
        retiredTaskIds: [task.taskId],
        codes: ['model_quota_exhausted'],
        routedTo: 'codex',
      },
    });
  });

  it('recovers a retained Claude billing error from owner-bound native evidence without a rendered footer', async () => {
    const d = deps();
    const issueId = 'EI-native-credit-balance';
    const sessionId = 'native-credit-balance-session';
    const ownerId = 'su-credit-balance-auditor';
    const nativeTranscript = JSON.stringify({
      type: 'assistant',
      sessionId,
      isSidechain: false,
      isApiErrorMessage: true,
      apiErrorStatus: 400,
      message: {
        role: 'assistant',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'Credit balance is too low' }],
      },
    });
    const task = {
      taskId: 'task-native-credit-balance',
      sessionId,
      workspaceId: 'ws-test',
      class: 'agent-session',
      state: 'running',
      startedAt: new Date().toISOString(),
      logPath: '/tmp/grading-native-credit-balance.log',
      detail: { label: 'grading-audit:' + issueId, coordOwnerId: ownerId },
    } as unknown as TaskRow;
    d.listScorecards.mockResolvedValue([card(issueId)]);
    d.listTasks.mockResolvedValue([task]);
    d.launch.mockResolvedValueOnce(launchResult({
      deduped: false,
      launch: { tasks: [{ taskId: 'task-native-credit-fallback', logPath: '/tmp/grading-native-credit-fallback.log' }] },
    }));
    const listNativeSessions = vi.fn<NonNullable<DispatchPendingGradingAuditsDeps['listNativeSessionsByTranscriptHandles']>>()
      .mockResolvedValue([{ sessionId, coordOwnerId: ownerId, agent: 'claude' }]);
    const resolveTranscript = vi.fn<NonNullable<DispatchPendingGradingAuditsDeps['findSessionTranscript']>>()
      .mockResolvedValue('/tmp/grading-native-credit-balance.jsonl');
    const killTask = vi.fn(async (taskId: string) => ({ ok: true as const, taskId, action: 'kill' as const }));
    const nowMs = Date.now();

    const result = await dispatchPendingGradingAudits(
      { targetIds: [issueId], ctx, harness: 'papercusp' },
      {
        ...d,
        listNativeSessionsByTranscriptHandles: listNativeSessions,
        findSessionTranscript: resolveTranscript,
        killTask,
        providerCanServe: vi.fn(async () => true),
        readLogTail: (path) => path.endsWith('.jsonl')
          ? nativeTranscript
          : path.includes('fallback') ? 'healthy fallback boot' : 'Credit balance is too low',
        readLogMtimeMs: () => nowMs,
        now: () => nowMs,
        terminalLogRecheckDelayMs: 0,
        terminalLogMaxRechecks: 0,
      },
    );

    expect(listNativeSessions).toHaveBeenCalledExactlyOnceWith([sessionId]);
    expect(resolveTranscript).toHaveBeenCalledExactlyOnceWith(sessionId, { owner: ownerId });
    expect(killTask).toHaveBeenCalledWith(task.taskId, { includeSubtree: true, escalateAfterMs: 5_000 });
    expect(d.launch).toHaveBeenCalledOnce();
    expect(result.receipts[0]).toMatchObject({
      issueId,
      state: 'launched',
      terminalRecovery: {
        retiredTaskIds: [task.taskId],
        codes: ['inference_gateway_error'],
      },
    });
  });

  it.each(['missing', 'unavailable', 'foreign-owner'])('preserves a retained task when recovered native binding is %s', async (binding) => {
    const d = deps();
    const issueId = 'EI-unproven-native';
    const ownerId = 'su-retained-auditor';
    const sessionId = 'native-recovered-session';
    const task = { taskId: 'task-unproven-native', sessionId: null, workspaceId: 'ws-test',
      class: 'agent-session', state: 'running', startedAt: new Date().toISOString(),
      logPath: '/tmp/unproven-native.log', detail: { label: 'grading-audit:' + issueId, coordOwnerId: ownerId },
    } as unknown as TaskRow;
    d.listScorecards.mockResolvedValue([card(issueId)]);
    d.listTasks.mockResolvedValue([task]);
    if (binding === 'unavailable') d.bindTaskNativeSession.mockRejectedValue(new Error('binding unavailable'));
    else d.bindTaskNativeSession.mockResolvedValue(binding === 'missing' ? null : sessionId);
    const listNativeSessions = vi.fn<NonNullable<DispatchPendingGradingAuditsDeps['listNativeSessionsByTranscriptHandles']>>()
      .mockResolvedValue([{ sessionId, coordOwnerId: 'su-foreign-auditor', agent: 'claude' }]);
    const resolveTranscript = vi.fn<NonNullable<DispatchPendingGradingAuditsDeps['findSessionTranscript']>>();
    const killTask = vi.fn();
    const result = await dispatchPendingGradingAudits(
      { targetIds: [issueId], ctx, harness: 'papercusp' },
      { ...d, listNativeSessionsByTranscriptHandles: listNativeSessions, findSessionTranscript: resolveTranscript,
        killTask, readLogTail: () => 'API Error: Request rejected (429) · inference-gateway: all accounts throttled; retry after 60s',
        readLogMtimeMs: () => Date.now(), terminalLogMaxRechecks: 0 },
    );
    expect(d.bindTaskNativeSession).toHaveBeenCalledExactlyOnceWith(task.taskId);
    expect(resolveTranscript).not.toHaveBeenCalled();
    expect(killTask).not.toHaveBeenCalled();
    expect(d.launch).not.toHaveBeenCalled();
    expect(result.receipts[0]).toMatchObject({ state: 'deduped', launch: { mode: 'live-task-guard' } });
  });

  it.each(['bound', 'foreign-owner', 'resumed'])(
    'recovers a completed Codex overload only with an owner-bound current native receipt (%s)', async (binding) => {
      const d = deps();
      const issueId = 'EI-native-codex-overload';
      const ownerId = 'su-codex-auditor';
      const sessionId = 'native-codex-overload';
      const task = { taskId: 'task-native-codex', sessionId, workspaceId: 'ws-test',
        class: 'agent-session', state: 'running', startedAt: new Date().toISOString(),
        logPath: '/tmp/native-codex.log', detail: { label: 'grading-audit:' + issueId, coordOwnerId: ownerId },
      } as unknown as TaskRow;
      d.listScorecards.mockResolvedValue([card(issueId)]);
      d.listTasks.mockResolvedValue([task]);
      const resolveTranscript = vi.fn<NonNullable<DispatchPendingGradingAuditsDeps['findCodexRolloutPath']>>()
        .mockResolvedValue('/tmp/native-codex.jsonl');
      const killTask = vi.fn(async (taskId: string) => ({ ok: true as const, taskId, action: 'kill' as const }));
      const native = [
        JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete',
          error: { codex_error_info: 'server_overloaded', message: 'Selected model is at capacity.' } } }),
        ...(binding === 'resumed' ? [JSON.stringify({ type: 'event_msg', payload: { type: 'task_started' } })] : []),
      ].join('\n');
      const result = await dispatchPendingGradingAudits(
        { targetIds: [issueId], ctx, harness: 'papercusp' },
        { ...d, findCodexRolloutPath: resolveTranscript,
          listNativeSessionsByTranscriptHandles: async () => [{ id: 43936, sessionId, agent: 'codex',
            coordOwnerId: binding === 'foreign-owner' ? 'su-other' : ownerId }],
          killTask, providerCanServe: async () => true,
          isCurrentSourceAuditResponder: async () => true,
          readLogTail: (path) => path.endsWith('.jsonl') ? native : path.includes('native-codex')
            ? '• Called scorecards:get\nWorking · GPT-5.6-Sol high' : 'healthy fallback boot',
          readLogMtimeMs: () => Date.now(), terminalLogMaxRechecks: 0 },
      );
      if (binding === 'bound') {
        expect(resolveTranscript).toHaveBeenCalledExactlyOnceWith(sessionId, {
          homeOverride: expect.stringMatching(/session-43936$/),
        });
        expect(killTask).toHaveBeenCalledExactlyOnceWith(task.taskId, { includeSubtree: true, escalateAfterMs: 5_000 });
        expect(result.receipts[0]).toMatchObject({ state: 'launched', terminalRecovery: {
          retiredTaskIds: [task.taskId], codes: ['inference_gateway_error'], routedTo: 'claude',
        } });
        // WI-6554700010030191: the retained auditor that failed was Codex, so the
        // bounded retry goes to Claude, never back onto the provider that failed.
        expect(d.launch).toHaveBeenCalledOnce();
        const retry = d.launch.mock.calls[0]?.[0] as Record<string, unknown>;
        expect(retry).not.toHaveProperty('agent');
        expect(retry.members).toEqual([{ role: 'judge', stack: [...GRADING_INTEGRITY_JUDGE_STACK], account: 'auto' }]);
      } else {
        expect(killTask).not.toHaveBeenCalled();
        expect(d.launch).not.toHaveBeenCalled();
        expect(result.receipts[0]).toMatchObject({ state: 'deduped', launch: { mode: 'live-task-guard' } });
      }
    },
  );

  it('preserves a recovering capacity-screen fallback after retiring a gateway-failed primary', async () => {
    const d = deps();
    const nowMs = Date.parse('2026-10-12T00:08:00.000Z');
    d.listScorecards.mockResolvedValue([card('EI-gateway-capacity')]);
    d.launch
      .mockResolvedValueOnce(launchResult({
        deduped: false,
        launch: { tasks: [{ taskId: 'task-primary', logPath: '/tmp/primary.log' }] },
      }))
      .mockResolvedValueOnce(launchResult({
        deduped: false,
        launch: { tasks: [{ taskId: 'task-fallback', logPath: '/tmp/fallback.log' }] },
      }));
    const killTask = vi.fn(async (taskId: string) => ({ ok: true as const, taskId, action: 'kill' as const }));
    const result = await dispatchPendingGradingAudits(
      { targetIds: ['EI-gateway-capacity'], ctx },
      {
        ...d,
        killTask,
        providerCanServe: async () => true,
        now: () => nowMs,
        readLogTail: (path) => path.includes('fallback')
          ? '⚠ Selected model is at capacity. Please try a different model.'
          : 'API Error: Request rejected (429) · inference-gateway: all accounts throttled; retry after 60s',
        terminalLogMaxRechecks: 0,
      },
    );
    expect(d.launch).toHaveBeenCalledTimes(2);
    expect(killTask).toHaveBeenCalledExactlyOnceWith('task-primary', { includeSubtree: true, escalateAfterMs: 5_000 });
    expect(result.receipts[0]).toMatchObject({
      state: 'launched',
      terminalRecovery: {
        retiredTaskIds: ['task-primary'],
        codes: ['model_quota_exhausted'],
        attempts: 2,
      },
    });
    expect(d.release).not.toHaveBeenCalled();
  });

  it('uses bounded dispatch backoff for paced admission timeouts without reading unrelated quota resets', async () => {
    const d = deps();
    const issueId = 'EI-paced-admission';
    const nowMs = Date.parse('2026-11-02T12:00:00.000Z');
    d.listScorecards.mockResolvedValue([card(issueId)]);
    d.launch
      .mockResolvedValueOnce(launchResult({ deduped: false, launch: {
        tasks: [{ taskId: 'task-primary', logPath: '/tmp/primary.log' }],
      } }))
      .mockResolvedValueOnce(launchResult({ deduped: false, launch: {
        tasks: [{ taskId: 'task-fallback', logPath: '/tmp/fallback.log' }],
      } }));
    const readProviderResets = vi.fn(async () => [nowMs + 6 * 60 * 60_000]);
    const result = await dispatchPendingGradingAudits({ targetIds: [issueId], ctx }, {
      ...d,
      killTask: async (taskId) => ({ ok: true, taskId, action: 'kill' }),
      providerCanServe: async () => true,
      readProviderResets,
      now: () => nowMs,
      readLogTail: () => "API Error: Request rejected (429) · inference-gateway: account 'aviynw4' paced/paused; retry after 60s",
      terminalLogMaxRechecks: 0,
    });
    expect(d.launch).toHaveBeenCalledTimes(2);
    expect(result.receipts[0]).toMatchObject({ state: 'failed', terminalRecovery: {
      codes: ['inference_gateway_error', 'inference_gateway_error'],
    } });
    expect(readProviderResets).not.toHaveBeenCalled();
    expect(d.release).toHaveBeenLastCalledWith(issueId, `grading-audit:${issueId}`, expect.objectContaining({
      backoff: expect.objectContaining({ code: 'inference_gateway_error', source: 'retry-window' }),
    }));
  });

  it('stops after one recovery when the fallback is quota-terminal too', async () => {
    const d = deps();
    d.listScorecards.mockResolvedValue([card('EI-double-quota')]);
    d.launch
      .mockResolvedValueOnce(
        launchResult({
          deduped: false,
          launch: { tasks: [{ taskId: 'task-primary', logPath: '/tmp/primary.log' }] },
        }),
      )
      .mockResolvedValueOnce(
        launchResult({
          deduped: false,
          launch: { tasks: [{ taskId: 'task-fallback', logPath: '/tmp/fallback.log' }] },
        }),
      );
    const killTask = vi.fn(async (taskId: string) => ({ ok: true as const, taskId, action: 'kill' }));

    const result = await dispatchPendingGradingAudits(
      { targetIds: ['EI-double-quota'], ctx },
      {
        ...d,
        killTask,
        readLogTail: () => "You've hit your weekly limit · resets Sep 10, 7am (America/New_York)",
        sleep: async () => undefined,
        terminalLogRecheckDelayMs: 0,
        terminalLogMaxRechecks: 0,
      },
    );

    expect(d.launch).toHaveBeenCalledTimes(2);
    expect(killTask).toHaveBeenCalledTimes(2);
    expect(result.receipts).toEqual([
      expect.objectContaining({
        issueId: 'EI-double-quota',
        state: 'failed',
        reason: expect.stringContaining('one-retry ceiling'),
        terminalRecovery: expect.objectContaining({
          retiredTaskIds: ['task-primary', 'task-fallback'],
          attempts: 2,
          codes: ['model_quota_exhausted', 'model_quota_exhausted'],
        }),
      }),
    ]);
  });

  it('reconciles a quota failure that appears after the startup probe on a later sweep', async () => {
    const d = deps();
    d.listScorecards.mockResolvedValue([card('EI-delayed-quota')]);
    d.launch
      .mockResolvedValueOnce(
        launchResult({
          deduped: false,
          launch: { tasks: [{ taskId: 'task-delayed', logPath: '/tmp/delayed.log' }] },
        }),
      )
      .mockResolvedValueOnce(
        launchResult({
          deduped: true,
          launch: { tasks: [{ taskId: 'task-delayed', logPath: '/tmp/delayed.log' }] },
        }),
      )
      .mockResolvedValueOnce(
        launchResult({
          deduped: false,
          launch: { tasks: [{ taskId: 'task-recovery', logPath: '/tmp/recovery.log' }] },
        }),
      );
    const killTask = vi.fn(async (taskId: string) => ({ ok: true as const, taskId, action: 'kill' }));
    let delayedLog = 'healthy startup probe';
    const readLogTail = vi.fn((path: string) => (path.includes('delayed') ? delayedLog : 'healthy fallback boot'));

    const initial = await dispatchPendingGradingAudits(
      { targetIds: ['EI-delayed-quota'], ctx, harness: 'papercusp' },
      { ...d, killTask, readLogTail, sleep: async () => undefined, terminalLogMaxRechecks: 0 },
    );
    delayedLog = "You've hit your weekly limit · resets Sep 10, 7am (America/New_York)";

    const recovered = await reconcilePendingGradingAudits(
      { ctx, harness: 'papercusp' },
      { ...d, killTask, readLogTail, sleep: async () => undefined, terminalLogMaxRechecks: 0 },
    );

    expect(initial.receipts).toEqual([expect.objectContaining({ issueId: 'EI-delayed-quota', state: 'launched' })]);
    expect(killTask).toHaveBeenCalledWith('task-delayed', { includeSubtree: true, escalateAfterMs: 5_000 });
    expect(recovered.receipts).toEqual([
      expect.objectContaining({
        issueId: 'EI-delayed-quota',
        state: 'launched',
        terminalRecovery: expect.objectContaining({
          retiredTaskIds: ['task-delayed'],
          codes: ['model_quota_exhausted'],
        }),
      }),
    ]);
    expect(d.launch.mock.calls[2]?.[0]).toEqual(
      expect.objectContaining({
        idempotencyKey: expect.stringMatching(/^grading-audit:EI-delayed-quota:recovery:[a-f0-9]{16}$/),
        agent: 'codex',
      }),
    );
  });

  it('reconciles a launcher kickoff quota drop on a later sweep', async () => {
    const d = deps();
    d.listScorecards.mockResolvedValue([card('EI-launcher-quota-drop')]);
    d.launch
      .mockResolvedValueOnce(
        launchResult({
          deduped: false,
          launch: { tasks: [{ taskId: 'task-dropped-kickoff', logPath: '/tmp/dropped-kickoff.log' }] },
        }),
      )
      .mockResolvedValueOnce(
        launchResult({
          deduped: true,
          launch: { tasks: [{ taskId: 'task-dropped-kickoff', logPath: '/tmp/dropped-kickoff.log' }] },
        }),
      )
      .mockResolvedValueOnce(
        launchResult({
          deduped: false,
          launch: { tasks: [{ taskId: 'task-recovery', logPath: '/tmp/recovery.log' }] },
        }),
      );
    const killTask = vi.fn(async (taskId: string) => ({ ok: true as const, taskId, action: 'kill' }));
    let droppedLog = 'healthy startup probe';
    const readLogTail = vi.fn((path: string) =>
      path.includes('dropped-kickoff') ? droppedLog : 'healthy fallback boot',
    );

    const initial = await dispatchPendingGradingAudits(
      { targetIds: ['EI-launcher-quota-drop'], ctx, harness: 'papercusp' },
      { ...d, killTask, readLogTail, sleep: async () => undefined, terminalLogMaxRechecks: 0 },
    );
    droppedLog =
      '100% left · staging\u001b[22;3H\u001b[?2026l' +
      'psu-pty-host: launch kickoff DROPPED for role-7a40cbec-960b-4db9-9bca-26020817a009 ' +
      '(submit verification aborted (quota-blocked) within 600000ms over 1 attempt(s))';

    const recovered = await reconcilePendingGradingAudits(
      { ctx, harness: 'papercusp' },
      { ...d, killTask, readLogTail, sleep: async () => undefined, terminalLogMaxRechecks: 0 },
    );

    expect(initial.receipts).toEqual([
      expect.objectContaining({ issueId: 'EI-launcher-quota-drop', state: 'launched' }),
    ]);
    expect(killTask).toHaveBeenCalledWith('task-dropped-kickoff', {
      includeSubtree: true,
      escalateAfterMs: 5_000,
    });
    expect(recovered.receipts).toEqual([
      expect.objectContaining({
        issueId: 'EI-launcher-quota-drop',
        state: 'launched',
        terminalRecovery: expect.objectContaining({
          retiredTaskIds: ['task-dropped-kickoff'],
          codes: ['model_quota_exhausted'],
        }),
      }),
    ]);
    expect(d.launch.mock.calls[2]?.[0]).toEqual(
      expect.objectContaining({
        idempotencyKey: expect.stringMatching(/^grading-audit:EI-launcher-quota-drop:recovery:[a-f0-9]{16}$/),
        agent: 'codex',
        account: 'auto',
      }),
    );
  });

  it('recovers a deduped terminal task and gives each reservation epoch a fresh retry key', async () => {
    const d = deps();
    d.listScorecards.mockResolvedValue([card('EI-dead-receipt')]);
    d.reserve
      .mockResolvedValueOnce({
        status: 'claimed',
        reservation: { key: 'grading-audit:EI-dead-receipt', reservedAt: '2026-09-09T10:00:00.000Z' },
      })
      .mockResolvedValueOnce({
        status: 'claimed',
        reservation: { key: 'grading-audit:EI-dead-receipt', reservedAt: '2026-09-09T10:15:00.000Z' },
      });
    d.launch
      .mockResolvedValueOnce(
        launchResult({
          deduped: true,
          launch: { tasks: [{ taskId: 'task-dead', logPath: '/tmp/dead.log' }] },
        }),
      )
      .mockResolvedValueOnce(
        launchResult({
          deduped: false,
          launch: { agentStarted: true, tasks: [{ taskId: 'task-recovery-a', logPath: '/tmp/recovery-a.log' }] },
        }),
      )
      .mockResolvedValueOnce(
        launchResult({
          deduped: true,
          launch: { tasks: [{ taskId: 'task-dead', logPath: '/tmp/dead.log' }] },
        }),
      )
      .mockResolvedValueOnce(
        launchResult({
          deduped: false,
          launch: { agentStarted: true, tasks: [{ taskId: 'task-recovery-b', logPath: '/tmp/recovery-b.log' }] },
        }),
      );
    d.getTask.mockResolvedValue({ state: 'killed' } as Awaited<ReturnType<GetTask>>);
    const killTask = vi.fn(async (taskId: string) => ({
      ok: false as const,
      taskId,
      action: 'kill',
      error: 'not_live' as const,
    }));
    const run = () =>
      dispatchPendingGradingAudits(
        { targetIds: ['EI-dead-receipt'], ctx, harness: 'papercusp' },
        {
          ...d,
          killTask,
          readLogTail: () => 'no terminal model error was logged',
          sleep: async () => undefined,
          terminalLogMaxRechecks: 0,
        },
      );

    const first = await run();
    const second = await run();

    expect(first.receipts[0]).toMatchObject({
      state: 'launched',
      terminalRecovery: { retiredTaskIds: ['task-dead'], codes: ['task_receipt_not_live'] },
    });
    expect(second.receipts[0]).toMatchObject({
      state: 'launched',
      terminalRecovery: { retiredTaskIds: ['task-dead'], codes: ['task_receipt_not_live'] },
    });
    const firstRetryKey = (d.launch.mock.calls[1]?.[0] as { idempotencyKey: string }).idempotencyKey;
    const secondRetryKey = (d.launch.mock.calls[3]?.[0] as { idempotencyKey: string }).idempotencyKey;
    expect(firstRetryKey).toMatch(/^grading-audit:EI-dead-receipt:recovery:[a-f0-9]{16}$/);
    expect(secondRetryKey).toMatch(/^grading-audit:EI-dead-receipt:recovery:[a-f0-9]{16}$/);
    expect(secondRetryKey).not.toBe(firstRetryKey);
  });

  // WI-10002903: a headless judge whose kickoff was never submitted idles at an
  // empty composer with no terminal log text. The launcher's own receipt is the
  // only signal, so the dispatcher must treat it as a failed launch rather than
  // report 'launched' and hold the reservation for the full TTL.
  it.each(['tasks', 'failures'])(
    'retires a judge whose %s receipt says the kickoff was never submitted, and relaunches once', async receiptKind => {
    const d = deps();
    d.listScorecards.mockResolvedValue([card('EI-silent-kickoff')]);
    d.launch
      .mockResolvedValueOnce(
        launchResult({
          deduped: false,
          launch: {
            agentStarted: null,
            ...(receiptKind === 'failures' ? { opened: 0, tasks: [] } : {}),
            [receiptKind]: [
              {
                taskId: 'task-silent',
                logPath: '/tmp/silent.log',
                kickoffProof: {
                  persisted: false,
                  reason: 'kickoff-not-submitted:headless-claude-composer-not-ready',
                },
              },
            ],
          },
        }),
      )
      .mockResolvedValueOnce(
        launchResult({
          deduped: false,
          launch: {
            agentStarted: true,
            tasks: [{ taskId: 'task-retry', logPath: '/tmp/retry.log', kickoffProof: { persisted: true } }],
          },
        }),
      );
    const killTask = vi.fn(async (taskId: string) => ({
      ok: false as const,
      taskId,
      action: 'kill',
      error: 'not_live' as const,
    }));

    const result = await dispatchPendingGradingAudits(
      { targetIds: ['EI-silent-kickoff'], ctx, harness: 'papercusp' },
      {
        ...d,
        killTask,
        readLogTail: () => 'no terminal model error was logged',
        sleep: async () => undefined,
        terminalLogMaxRechecks: 0,
      },
    );

    expect(killTask).toHaveBeenCalledWith('task-silent', expect.anything());
    expect(d.launch).toHaveBeenCalledTimes(2);
    expect(result.receipts[0]).toMatchObject({
      state: 'launched',
      terminalRecovery: { retiredTaskIds: ['task-silent'], codes: ['launch_kickoff_not_persisted'] },
    });
  });

  it('retries a fresh bootstrap proxy failure when its task exits before kickoff proof returns', async () => {
    const d = deps();
    d.listScorecards.mockResolvedValue([card('EI-fresh-task-exited')]);
    d.launch
      .mockResolvedValueOnce(
        launchResult({
          deduped: false,
          launch: {
            agentStarted: null,
            tasks: [
              {
                taskId: 'task-codex-state-db',
                logPath: '/tmp/codex-state-db.log',
              },
            ],
          },
        }),
      )
      .mockResolvedValueOnce(
        launchResult({
          deduped: false,
          launch: {
            agentStarted: true,
            tasks: [{ taskId: 'task-codex-fallback', logPath: '/tmp/codex-fallback.log' }],
          },
        }),
      );
    d.getTask.mockResolvedValueOnce({
      state: 'ended_unobserved',
      exitCode: 1,
      exitReason: 'initial terminal command exited with status 1; headless launch exiting.',
    } as Awaited<ReturnType<GetTask>>);
    const killTask = vi.fn(async (taskId: string) => ({
      ok: false as const,
      taskId,
      action: 'kill',
      error: 'not_live' as const,
    }));

    const result = await dispatchPendingGradingAudits(
      { targetIds: ['EI-fresh-task-exited'], ctx, harness: 'papercusp' },
      {
        ...d,
        killTask,
        readLogTail: () =>
          'psu: mcp_proxy_upstream_error — upstream silent for 8000ms (no response headers)\n' +
          '[papercusp] initial terminal command exited with status 1; headless launch exiting.',
        sleep: async () => undefined,
        terminalLogMaxRechecks: 0,
      },
    );

    expect(d.getTask).toHaveBeenCalledWith('task-codex-state-db');
    expect(killTask).toHaveBeenCalledWith('task-codex-state-db', {
      includeSubtree: true,
      escalateAfterMs: 5_000,
    });
    expect(d.launch).toHaveBeenCalledTimes(2);
    expect(result.receipts[0]).toMatchObject({
      state: 'launched',
      terminalRecovery: { retiredTaskIds: ['task-codex-state-db'], codes: ['task_receipt_not_live'] },
    });
  });

  it('keeps a fresh kickoff timeout unconfirmed while the task-manager row is still running', async () => {
    const d = deps();
    d.listScorecards.mockResolvedValue([card('EI-still-starting')]);
    d.launch.mockResolvedValueOnce(
      launchResult({
        deduped: false,
        launch: {
          agentStarted: null,
          tasks: [
            {
              taskId: 'task-still-starting',
              logPath: '/tmp/still-starting.log',
              kickoffProof: { persisted: false, reason: 'kickoff-proof-timeout' },
            },
          ],
        },
      }),
    );
    d.getTask.mockResolvedValueOnce({ state: 'running' } as Awaited<ReturnType<GetTask>>);
    const killTask = vi.fn();

    const result = await dispatchPendingGradingAudits(
      { targetIds: ['EI-still-starting'], ctx, harness: 'papercusp' },
      { ...d, killTask, readLogTail: () => '', terminalLogMaxRechecks: 0 },
    );

    expect(d.getTask).toHaveBeenCalledWith('task-still-starting');
    expect(killTask).not.toHaveBeenCalled();
    expect(d.launch).toHaveBeenCalledTimes(1);
    expect(result.receipts[0]).toMatchObject({ state: 'launched' });
    expect(result.receipts[0]).not.toHaveProperty('terminalRecovery');
  });

  // WI-10002903 (second leg): psu-pty-host dropped the kickoff AFTER the launch
  // receipt returned, so the receipt carried no failure and the PTY stayed
  // ledger-live. The live-task guard must retire it instead of deduping to it
  // for the whole reservation (observed on EI-24118203560334206 at 07:39Z).
  it('retires a ledger-live auditor whose kickoff psu-pty-host dropped after launch, instead of deduping to it', async () => {
    const d = deps();
    d.listScorecards.mockResolvedValue([card('EI-dropped-kickoff')]);
    d.listTasks.mockResolvedValue([
      {
        taskId: 'task-dropped-kickoff',
        state: 'running',
        detail: { label: 'grading-audit:EI-dropped-kickoff' },
        logPath: '/tmp/dropped-kickoff.log',
      } as unknown as TaskRow,
    ]);
    d.launch.mockResolvedValue(
      launchResult({
        deduped: false,
        launch: {
          agentStarted: true,
          tasks: [{ taskId: 'task-dropped-recovery', logPath: '/tmp/recovery.log', kickoffProof: { persisted: true } }],
        },
      }),
    );
    const killTask = vi.fn(async (taskId: string) => ({ ok: true as const, taskId, action: 'kill' }));
    const readLogTail = vi.fn((path: string) =>
      path.includes('dropped-kickoff')
        ? 'psu-pty-host: launch kickoff DROPPED for role-d5284217 ' +
          '(the child never settled to its prompt within 20000ms over 3 attempt(s))\n'
        : 'healthy fallback boot',
    );

    const result = await reconcilePendingGradingAudits(
      { ctx, harness: 'papercusp' },
      { ...d, killTask, readLogTail, sleep: async () => undefined, terminalLogMaxRechecks: 0 },
    );

    expect(killTask).toHaveBeenCalledWith('task-dropped-kickoff', { includeSubtree: true, escalateAfterMs: 5_000 });
    expect(d.launch).toHaveBeenCalledTimes(1);
    expect(result.receipts).toEqual([
      expect.objectContaining({
        issueId: 'EI-dropped-kickoff',
        state: 'launched',
        terminalRecovery: expect.objectContaining({
          retiredTaskIds: ['task-dropped-kickoff'],
          codes: ['launch_kickoff_dropped'],
        }),
      }),
    ]);
  });

  it('retires a ledger-live auditor stopped by a credit balance refusal and launches one recovery', async () => {
    const d = deps();
    d.listScorecards.mockResolvedValue([card('EI-credit-balance')]);
    d.listTasks.mockResolvedValue([{
      taskId: 'task-credit-balance', state: 'running',
      detail: { label: 'grading-audit:EI-credit-balance' }, logPath: '/tmp/credit-balance.log',
    } as unknown as TaskRow]);
    d.launch.mockResolvedValue(launchResult({
      deduped: false,
      launch: { agentStarted: true, tasks: [{
        taskId: 'task-credit-recovery', logPath: '/tmp/recovery.log', kickoffProof: { persisted: true },
      }] },
    }));
    const killTask = vi.fn(async (taskId: string) => ({ ok: true as const, taskId, action: 'kill' }));
    const result = await reconcilePendingGradingAudits({ ctx, harness: 'papercusp' }, {
      ...d, killTask, sleep: async () => undefined, terminalLogMaxRechecks: 0,
      readLogTail: (path: string) => path.includes('credit-balance')
        ? '  ⎿ Credit balance too low · Add funds: \n\n✻Sautéed for 1m 48s · done 5:15 AM\n❯'
        : 'healthy recovery boot',
    });
    expect(killTask).toHaveBeenCalledWith('task-credit-balance', { includeSubtree: true, escalateAfterMs: 5_000 });
    expect(d.launch).toHaveBeenCalledTimes(1);
    expect(result.receipts[0]).toMatchObject({
      state: 'launched', terminalRecovery: {
        retiredTaskIds: ['task-credit-balance'], codes: ['inference_gateway_error'],
      },
    });
  });

  it('retires a heartbeat-fresh auditor that finished without emitting, then launches a replacement', async () => {
    const d = deps();
    d.listScorecards.mockResolvedValue([card('EI-finished-refusal')]);
    d.listTasks.mockResolvedValue([
      {
        taskId: 'task-finished-refusal',
        state: 'running',
        detail: { label: 'grading-audit:EI-finished-refusal' },
        logPath: '/tmp/finished-refusal.log',
      } as unknown as TaskRow,
    ]);
    d.launch.mockResolvedValue(
      launchResult({
        deduped: false,
        launch: {
          agentStarted: true,
          tasks: [{ taskId: 'task-replacement', logPath: '/tmp/replacement.log', kickoffProof: { persisted: true } }],
        },
      }),
    );
    const killTask = vi.fn(async (taskId: string) => ({ ok: true as const, taskId, action: 'kill' }));
    const result = await reconcilePendingGradingAudits(
      { ctx, harness: 'papercusp' },
      {
        ...d,
        killTask,
        readLogTail: (path: string) =>
          path.includes('finished-refusal')
            ? "● I didn't emit an audit, so the scorecard is still unsettled. The server refused my audit.\n✻ Worked for 4m 57s · done"
            : 'healthy replacement',
        sleep: async () => undefined,
        terminalLogMaxRechecks: 0,
      },
    );
    expect(killTask).toHaveBeenCalledWith('task-finished-refusal', { includeSubtree: true, escalateAfterMs: 5_000 });
    expect(d.launch).toHaveBeenCalledTimes(1);
    expect(result.receipts[0]).toMatchObject({
      state: 'launched',
      terminalRecovery: { retiredTaskIds: ['task-finished-refusal'], codes: ['grading_audit_refused'] },
    });
  });

  it('recovers a fresh auditor rejected by its native API without a PTY footer', async () => {
    const d = deps();
    d.listScorecards.mockResolvedValue([card('EI-native-api-refusal')]);
    d.launch.mockResolvedValueOnce(launchResult({
      deduped: false,
      launch: { agentStarted: true, tasks: [{
        taskId: 'task-native-api-refusal', logPath: '/tmp/native-api-refusal.log',
        kickoffProof: { persisted: true, nativeRef: '/tmp/native-api-refusal.jsonl' },
        nativeSession: { backend: 'claude', sessionId: 'native-api-refusal-session' },
      }] },
    })).mockResolvedValueOnce(launchResult({
      deduped: false, launch: { agentStarted: true,
        tasks: [{ taskId: 'task-native-api-fallback', logPath: '/tmp/healthy-fallback.log' }] },
    }));
    const killTask = vi.fn(async (taskId: string) => ({ ok: true as const, taskId, action: 'kill' }));
    const native = JSON.stringify({ type: 'assistant', sessionId: 'native-api-refusal-session',
      isApiErrorMessage: true, apiErrorStatus: 400,
      message: { role: 'assistant', stop_reason: 'stop_sequence' } });
    const result = await dispatchPendingGradingAudits(
      { targetIds: ['EI-native-api-refusal'], ctx, harness: 'papercusp' },
      { ...d, killTask, sleep: async () => undefined, terminalLogMaxRechecks: 0,
        readLogTail: (path: string) => path.endsWith('.jsonl') ? native :
          path.includes('native-api-refusal') ? "●API Error: 400 role 'system' is not supported on this model\n❯" : 'healthy fallback boot' },
    );
    expect(killTask).toHaveBeenCalledWith('task-native-api-refusal', { includeSubtree: true, escalateAfterMs: 5_000 });
    expect(d.launch).toHaveBeenCalledTimes(2);
    expect(d.launch).toHaveBeenLastCalledWith(expect.objectContaining({ agent: 'codex', account: 'auto' }), auditorCtx);
    expect(result.receipts[0]).toMatchObject({ state: 'launched',
      terminalRecovery: { retiredTaskIds: ['task-native-api-refusal'], codes: ['inference_gateway_error'] } });
  });

  it('recovers a fresh Codex auditor from its exact terminal capacity error', async () => {
    const d = deps();
    d.listScorecards.mockResolvedValue([card('EI-codex-capacity')]);
    d.launch.mockResolvedValueOnce(launchResult({ deduped: false, launch: {
      agentStarted: true, tasks: [{ taskId: 'task-codex-capacity', ownerId: 'su-codex-auditor',
        logPath: '/tmp/codex-capacity.log', kickoffProof: { persisted: true, nativeRef: '/tmp/codex-capacity.jsonl' },
        nativeSession: { backend: 'codex', ownerId: 'su-codex-auditor', rolloutId: 'exact-codex-rollout' } }],
    } })).mockResolvedValueOnce(launchResult({ deduped: false, launch: { agentStarted: true,
      tasks: [{ taskId: 'task-capacity-replacement', logPath: '/tmp/healthy.log' }] } }));
    const native = JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete',
      error: { codex_error_info: 'server_overloaded', message: 'Selected model is at capacity.' } } });
    const killTask = vi.fn(async (taskId: string) => ({ ok: true as const, taskId, action: 'kill' }));
    const result = await dispatchPendingGradingAudits({ targetIds: ['EI-codex-capacity'], ctx, harness: 'papercusp' }, {
      ...d, killTask, sleep: async () => undefined, terminalLogMaxRechecks: 0,
      readLogTail: path => path.endsWith('.jsonl') ? native : 'Working · GPT-6.1-Sol high',
    });
    expect(killTask).toHaveBeenCalledWith('task-codex-capacity', { includeSubtree: true, escalateAfterMs: 5_000 });
    expect(result.receipts[0]).toMatchObject({ terminalRecovery: {
      retiredTaskIds: ['task-codex-capacity'], codes: ['inference_gateway_error'], routedTo: 'claude',
    } });
    // WI-6554700010030191: a fresh auditor the gateway resolved to Codex failed,
    // so the retry is routed to Claude rather than to the same Codex pool.
    expect(d.launch).toHaveBeenCalledTimes(2);
    expect(d.launch.mock.calls[1]?.[0]).not.toHaveProperty('agent');
  });

  it('keeps a judge whose native kickoff marker arrived late but whose turn was observed', async () => {
    const d = deps();
    d.listScorecards.mockResolvedValue([card('EI-late-marker')]);
    d.launch.mockResolvedValueOnce(
      launchResult({
        deduped: false,
        launch: {
          agentStarted: true,
          tasks: [
            {
              taskId: 'task-late',
              logPath: '/tmp/late.log',
              kickoffProof: { persisted: false, reason: 'native-turn-marker-timeout' },
            },
          ],
        },
      }),
    );
    const killTask = vi.fn();

    const result = await dispatchPendingGradingAudits(
      { targetIds: ['EI-late-marker'], ctx, harness: 'papercusp' },
      {
        ...d,
        killTask,
        readLogTail: () => 'no terminal model error was logged',
        sleep: async () => undefined,
        terminalLogMaxRechecks: 0,
      },
    );

    expect(killTask).not.toHaveBeenCalled();
    expect(d.launch).toHaveBeenCalledTimes(1);
    expect(result.receipts[0]).toMatchObject({ state: 'launched' });
    expect(result.receipts[0]).not.toHaveProperty('terminalRecovery');
  });
});

// EI-22978598482930667. Measured over the WHOLE grading-audit log population on
// 2026-09-11 (n=6163, deliberately not a recency head): 2228 legs died on the
// pty-host `(quota-blocked)` drop and 2523 launches were refused by the walled-pool
// preflight, every refusal printing a contiguous `earliest known recovery <ISO>`.
// Nothing consumed either signal, so the ~55s sweep tick relaunched the same doomed
// judge forever. These cover the suppression that stops it.
describe('resolveGradingAuditQuotaBackoff', () => {
  const NOW = Date.parse('2026-09-11T16:00:00.000Z');
  const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();
  const refusalLog = (horizon: string) =>
    'psu: REFUSING TO LAUNCH — Codex auto-route pool is fully walled: 0 of 7 ChatGPT accounts ' +
    `serviceable; earliest known recovery ${horizon}. Every model call would fail fast with 429.`;

  it('takes the EARLIEST future candidate, whichever source supplies it', async () => {
    const ledgerFirst = await resolveGradingAuditQuotaBackoff({
      code: 'model_quota_exhausted',
      logTail: refusalLog(iso(90 * 60_000)),
      nowMs: NOW,
      readProviderResets: async () => [NOW + 40 * 60_000, NOW + 5 * 60 * 60_000],
    });
    expect(ledgerFirst).toMatchObject({ until: iso(40 * 60_000), source: 'account-ledger' });

    const horizonFirst = await resolveGradingAuditQuotaBackoff({
      code: 'model_quota_exhausted',
      logTail: refusalLog(iso(20 * 60_000)),
      nowMs: NOW,
      readProviderResets: async () => [NOW + 3 * 60 * 60_000],
    });
    expect(horizonFirst).toMatchObject({ until: iso(20 * 60_000), source: 'launcher-horizon' });
  });

  it('clamps a candidate below the floor up, and a far-future one down to the ceiling', async () => {
    // Below MIN: a pool that "recovers" in a minute must not collapse back into
    // the sweep-tick busy loop this suppression exists to stop.
    const tooSoon = await resolveGradingAuditQuotaBackoff({
      code: 'model_quota_exhausted',
      logTail: refusalLog(iso(60_000)),
      nowMs: NOW,
      readProviderResets: async () => [],
    });
    expect(tooSoon).toMatchObject({
      until: iso(GRADING_AUDIT_QUOTA_BACKOFF_MIN_MS),
      source: 'launcher-horizon',
    });

    // Above MAX, using the real horizon codex printed on 2026-09-11 (~3.4 days
    // out): a wrong-but-plausible far reset must degrade to "re-probe in six
    // hours", never strand the audit queue for days.
    const tooFar = await resolveGradingAuditQuotaBackoff({
      code: 'model_quota_exhausted',
      logTail: refusalLog('2026-09-15T01:25:13.000Z'),
      nowMs: NOW,
      readProviderResets: async () => [],
    });
    expect(tooFar).toMatchObject({
      until: iso(GRADING_AUDIT_QUOTA_BACKOFF_MAX_MS),
      source: 'launcher-horizon',
    });
  });

  it('reports source "default" rather than inventing a reset when neither source yields a FUTURE instant', async () => {
    const backoff = await resolveGradingAuditQuotaBackoff({
      code: 'model_quota_exhausted',
      // Both candidates are in the past: an already-elapsed horizon is not a
      // recovery time, and reading it as one would suppress against nothing.
      logTail: refusalLog(iso(-60 * 60_000)),
      nowMs: NOW,
      readProviderResets: async () => [NOW - 10 * 60_000],
    });
    expect(backoff).toMatchObject({
      until: iso(GRADING_AUDIT_QUOTA_BACKOFF_DEFAULT_MS),
      source: 'default',
      code: 'model_quota_exhausted',
      recordedAt: iso(0),
    });
    expect(backoff.reason).toContain('no recoverable reset');
  });

  it('fails OPEN to the default window when the account-ledger read throws', async () => {
    const backoff = await resolveGradingAuditQuotaBackoff({
      code: 'model_quota_exhausted',
      nowMs: NOW,
      readProviderResets: async () => {
        throw new Error('account pool store unavailable');
      },
    });
    expect(backoff).toMatchObject({
      until: iso(GRADING_AUDIT_QUOTA_BACKOFF_DEFAULT_MS),
      source: 'default',
    });
  });
});

describe('quota repair route capacity', () => {
  const profile = { agent: 'codex', model: 'gpt-6.1-sol', effort: 'xhigh', account: 'auto' } as const;
  it.each([
    { serviceable: 1, reachable: true, modelCount: 1, expected: true },
    { serviceable: 0, reachable: true, modelCount: 1, expected: false },
    { serviceable: 1, reachable: true, modelCount: 0, expected: false },
    { serviceable: 1, reachable: false, modelCount: 1, expected: false },
  ])('requires a serving pool and reachable non-refusing model: %j', async ({ serviceable, reachable, modelCount, expected }) => {
    await expect(gradingAuditQuotaRouteCanServe(profile, {
      readPoolVerdict: async () => ({ serviceable }),
      readCodexHeadroom: async () => ({ reachable, serviceableByModel: { [profile.model]: modelCount } }),
    })).resolves.toBe(expected);
  });
  it('preserves the old quota wall when current capacity cannot be measured', async () => {
    await expect(gradingAuditQuotaRouteCanServe(profile, {
      readPoolVerdict: async () => { throw new Error('ledger unavailable'); },
    })).resolves.toBe(false);
    await expect(gradingAuditQuotaRouteCanServe(profile, {
      readPoolVerdict: async () => ({ serviceable: 1 }),
      readCodexHeadroom: async () => { throw new Error('gateway unavailable'); },
    })).resolves.toBe(false);
  });
});

describe('terminal grading-audit failures record a reset-aware or generic backoff', () => {
  const NOW = Date.parse('2026-09-11T16:00:00.000Z');
  // Verbatim shape of the launcher refusal, taken from the real fleet logs.
  const WALLED_POOL_REFUSAL =
    'psu: REFUSING TO LAUNCH — Codex auto-route pool is fully walled: 0 of 7 ChatGPT accounts ' +
    'serviceable; earliest known recovery 2026-09-11T17:00:00.000Z. Every model call would fail ' +
    'fast with 429, so this launch can only burn quota.';

  it('records a reset-aware backoff in the SAME release that drops a quota-terminal reservation', async () => {
    const d = deps();
    d.listScorecards.mockResolvedValue([card('EI-walled')]);
    d.launch
      .mockResolvedValueOnce(
        launchResult({
          deduped: false,
          launch: { tasks: [{ taskId: 'task-primary', logPath: '/tmp/primary.log' }] },
        }),
      )
      .mockResolvedValueOnce(
        launchResult({
          deduped: false,
          launch: { tasks: [{ taskId: 'task-fallback', logPath: '/tmp/fallback.log' }] },
        }),
      );
    const killTask = vi.fn(async (taskId: string) => ({ ok: true as const, taskId, action: 'kill' }));

    const result = await dispatchPendingGradingAudits(
      { targetIds: ['EI-walled'], ctx },
      {
        ...d,
        killTask,
        readLogTail: () => WALLED_POOL_REFUSAL,
        sleep: async () => undefined,
        terminalLogRecheckDelayMs: 0,
        terminalLogMaxRechecks: 0,
        now: () => NOW,
        readProviderResets: async () => [],
      },
    );

    expect(d.release).toHaveBeenCalledWith('EI-walled', 'grading-audit:EI-walled', {
      workspaceId: 'ws-test',
      reservedAt: '2026-09-08T00:00:00.000Z',
      backoff: {
        until: '2026-09-11T17:00:00.000Z',
        source: 'launcher-horizon',
        code: 'model_quota_exhausted',
        recordedAt: '2026-09-11T16:00:00.000Z',
        reason: 'terminal model_quota_exhausted; suppressing re-dispatch until the launcher-horizon reset',
      },
    });
    expect(result.receipts[0]).toMatchObject({
      state: 'failed',
      reason: expect.stringContaining('re-dispatch suppressed until 2026-09-11T17:00:00.000Z'),
    });
  });

  it('uses the generic retry window for a non-quota terminal failure despite an unrelated account reset', async () => {
    const d = deps();
    d.listScorecards.mockResolvedValue([card('EI-dead-receipt-twice')]);
    d.launch.mockResolvedValue(
      launchResult({
        deduped: true,
        launch: { tasks: [{ taskId: 'task-dead', logPath: '/tmp/dead.log' }] },
      }),
    );
    d.getTask.mockResolvedValue({ state: 'killed' } as Awaited<ReturnType<GetTask>>);
    const killTask = vi.fn(async (taskId: string) => ({
      ok: false as const,
      taskId,
      action: 'kill',
      error: 'not_live' as const,
    }));

    const result = await dispatchPendingGradingAudits(
      { targetIds: ['EI-dead-receipt-twice'], ctx },
      {
        ...d,
        killTask,
        readLogTail: () => 'no terminal model error was logged',
        sleep: async () => undefined,
        terminalLogMaxRechecks: 0,
        now: () => NOW,
        // A live, recoverable reset is available, but this failure is not a
        // quota error; it must use the generic retry window, not that reset.
        readProviderResets: async () => [NOW + 40 * 60_000],
      },
    );

    expect(result.receipts[0]).toMatchObject({
      state: 'failed',
      terminalRecovery: expect.objectContaining({
        codes: ['task_receipt_not_live', 'task_receipt_not_live'],
      }),
    });
    expect(d.release).toHaveBeenCalledWith('EI-dead-receipt-twice', 'grading-audit:EI-dead-receipt-twice', {
      workspaceId: 'ws-test',
      reservedAt: '2026-09-08T00:00:00.000Z',
      backoff: {
        until: new Date(NOW + GRADING_AUDIT_FAILURE_BACKOFF_MS).toISOString(),
        source: 'retry-window',
        code: 'task_receipt_not_live',
        recordedAt: new Date(NOW).toISOString(),
        reason: 'terminal task_receipt_not_live; suppressing re-dispatch for a bounded retry window',
      },
    });
    expect(result.receipts[0]?.reason).toContain('re-dispatch suppressed until');
  });

  it('records a generic retry window after both auditor legs terminate on gateway errors', async () => {
    const d = deps();
    d.listScorecards.mockResolvedValue([card('EI-double-gateway-error')]);
    d.launch
      .mockResolvedValueOnce(launchResult({
        deduped: false,
        launch: { tasks: [{ taskId: 'task-gateway-primary', logPath: '/tmp/gateway-primary.log' }] },
      }))
      .mockResolvedValueOnce(launchResult({
        deduped: false,
        launch: { tasks: [{ taskId: 'task-gateway-fallback', logPath: '/tmp/gateway-fallback.log' }] },
      }));
    const killTask = vi.fn(async (taskId: string) => ({ ok: true as const, taskId, action: 'kill' }));
    const gatewayError =
      'API Error: 500 inference-gateway internal error. This is a server-side issue, usually temporary — ' +
      'try again in a moment. If it persists, check your inference gateway (127.0.0.1:8788).\n' +
      '✻ Worked for 13m 45s · done 9:09 AM\n❯';

    const result = await dispatchPendingGradingAudits(
      { targetIds: ['EI-double-gateway-error'], ctx },
      {
        ...d,
        killTask,
        readLogTail: () => gatewayError,
        sleep: async () => undefined,
        terminalLogRecheckDelayMs: 0,
        terminalLogMaxRechecks: 0,
        now: () => NOW,
        // A gateway 5xx is deliberately used here: only a measured 429 is
        // quota-classified and eligible for the account reset horizon.
        readProviderResets: async () => [NOW + 40 * 60_000],
      },
    );

    expect(result.receipts[0]).toMatchObject({
      state: 'failed',
      terminalRecovery: {
        attempts: 2,
        codes: ['inference_gateway_error', 'inference_gateway_error'],
      },
      reason: expect.stringContaining('re-dispatch suppressed until'),
    });
    expect(d.release).toHaveBeenCalledWith('EI-double-gateway-error', 'grading-audit:EI-double-gateway-error', {
      workspaceId: 'ws-test',
      reservedAt: '2026-09-08T00:00:00.000Z',
      backoff: {
        until: new Date(NOW + GRADING_AUDIT_FAILURE_BACKOFF_MS).toISOString(),
        source: 'retry-window',
        code: 'inference_gateway_error',
        recordedAt: new Date(NOW).toISOString(),
        reason: 'terminal inference_gateway_error; suppressing re-dispatch for a bounded retry window',
      },
    });
  });
});

// WI-10003463: the bounded retry is routed to the fallback provider only when
// that provider can MEASURABLY serve. These cases drive the real pool rollup, so
// a change to poolVerdictByProvider's unknown/at-capacity semantics is caught here.
describe('gradingAuditFallbackVerdictCanServe', () => {
  const NOW = Date.parse('2026-09-27T12:15:00.000Z');
  const row = (over: Partial<AccountStatusRow> & { id: string; provider: AccountStatusRow['provider'] }) =>
    ({
      credentialRef: `token:${over.id}`,
      boundTo: [],
      available: true,
      usageWalled: false,
      sustainedlyLimited: false,
      edgeThrottleKnown: false,
      edgeThrottled: false,
      edgeThrottleCooledIps: 0,
      edgeThrottleBare429Streak: 0,
      rate: { pausedUntil: 0, penaltyCount: 0, lastPenaltyAt: 0, windowStartedAt: 0 },
      liveBuckets: [],
      readingStatus: 'fresh',
      burn: {
        burnRatePerHr: null,
        headroomFraction: null,
        projectedExhaustionAt: null,
        exhaustsBeforeReset: false,
        action: 'none',
        utilization7d: null,
        disposition: 'no-verdict',
        reason: 'fixture',
      },
      ...over,
    }) as AccountStatusRow;
  const verdictFor = (rows: AccountStatusRow[], provider: AccountStatusRow['provider']) =>
    poolVerdictByProvider(rows, NOW).find((v) => v.provider === provider);

  it('THE INCIDENT: 0 serviceable + stale rows is NOT at capacity, but still cannot serve the fallback', () => {
    // The codex pool shape measured by accounts:status at 2026-09-27T12:15Z.
    const codex = [
      row({ id: 'chatgpt-sub-cli', provider: 'codex', available: false, usageWalled: true }),
      row({
        id: 'aviynw2_codex',
        provider: 'codex',
        available: false,
        usageWalled: true,
        readingStatus: 'stale',
        lastProbeFailedAt: NOW - 60_000,
      }),
      row({ id: 'aviynw_3', provider: 'codex', readingStatus: 'stale' }),
      row({ id: 'aviynw4_codex', provider: 'codex', available: false, usageWalled: true }),
      row({ id: 'aviynw5_codex', provider: 'codex', available: false, usageWalled: true }),
      row({ id: 'aviynw3_codex', provider: 'codex', readingStatus: 'stale' }),
      row({ id: 'aviynw6_codex', provider: 'codex', available: false, usageWalled: true }),
    ];
    const verdict = verdictFor(codex, 'codex');
    // Calibration: the rollup really does call this pool "not at capacity" —
    // exactly the reading the old `!atCapacity` predicate trusted.
    expect(verdict?.atCapacity).toBe(false);
    expect(verdict?.serviceable).toBe(0);
    expect(verdict?.unknown).toBe(3);
    expect(gradingAuditFallbackVerdictCanServe(verdict)).toBe(false);
  });

  it('a provider with one measured serviceable account can serve the fallback', () => {
    const claude = [
      row({ id: 'aviynw10', provider: 'claude' }),
      row({ id: 'aviynw2', provider: 'claude', available: false, usageWalled: true }),
      row({ id: 'aviynw9', provider: 'claude', readingStatus: 'stale' }),
    ];
    const verdict = verdictFor(claude, 'claude');
    expect(verdict?.serviceable).toBe(1);
    expect(gradingAuditFallbackVerdictCanServe(verdict)).toBe(true);
  });

  it('an all-stale pool is unmeasured, so the retry stays on the primary', () => {
    const verdict = verdictFor(
      [row({ id: 'c1', provider: 'codex', readingStatus: 'stale' }), row({ id: 'c2', provider: 'codex', readingStatus: 'never-observed' })],
      'codex',
    );
    expect(verdict?.atCapacity).toBe(false);
    expect(gradingAuditFallbackVerdictCanServe(verdict)).toBe(false);
  });

  it('a provider with no registered accounts cannot serve', () => {
    expect(verdictFor([row({ id: 'a', provider: 'claude' })], 'codex')).toBeUndefined();
    expect(gradingAuditFallbackVerdictCanServe(undefined)).toBe(false);
  });
});

// WI-6554700010030250: a serviceable Codex ACCOUNT that refuses the fallback MODEL
// cannot serve the bounded retry — the launch would die on its first turn.
describe('gradingAuditProviderCanServe — fallback model awareness', () => {
  const NOW = Date.parse('2026-10-27T12:57:00.000Z');
  const model = GRADING_AUDIT_FALLBACK.model;
  const oneServiceable = async () => ({ serviceable: 1 });

  it('THE INCIDENT: one serviceable Codex account that refuses the fallback model cannot serve', async () => {
    const readPoolVerdict = vi.fn(oneServiceable);
    const readCodexHeadroom = vi.fn(async () => ({ reachable: true, serviceableByModel: { [model]: 0 } }));
    await expect(
      gradingAuditProviderCanServe('codex', NOW, { readPoolVerdict, readCodexHeadroom }),
    ).resolves.toBe(false);
    expect(readPoolVerdict).toHaveBeenCalledWith('codex', NOW);
    expect(readCodexHeadroom).toHaveBeenCalledTimes(1);
  });

  it('a refusal for some OTHER model, or a positive count, leaves the fallback serviceable', async () => {
    const maps: Array<Record<string, number>> = [{ 'gpt-other': 0 }, { [model]: 1 }, {}];
    for (const serviceableByModel of maps) {
      await expect(
        gradingAuditProviderCanServe('codex', NOW, {
          readPoolVerdict: oneServiceable,
          readCodexHeadroom: async () => ({ reachable: true, serviceableByModel }),
        }),
      ).resolves.toBe(true);
    }
  });

  it('an unreachable or failing gateway read is unknown, so the account-pool verdict stands', async () => {
    await expect(
      gradingAuditProviderCanServe('codex', NOW, {
        readPoolVerdict: oneServiceable,
        readCodexHeadroom: async () => ({ reachable: false }),
      }),
    ).resolves.toBe(true);
    await expect(
      gradingAuditProviderCanServe('codex', NOW, {
        readPoolVerdict: oneServiceable,
        readCodexHeadroom: async () => { throw new Error('ECONNREFUSED'); },
      }),
    ).resolves.toBe(true);
  });

  it('an unserviceable pool refuses without reading the gateway; Claude never reads the Codex model map', async () => {
    const readCodexHeadroom = vi.fn(async () => ({ reachable: true, serviceableByModel: { [model]: 1 } }));
    await expect(
      gradingAuditProviderCanServe('codex', NOW, { readPoolVerdict: async () => ({ serviceable: 0 }), readCodexHeadroom }),
    ).resolves.toBe(false);
    await expect(
      gradingAuditProviderCanServe('claude', NOW, { readPoolVerdict: oneServiceable, readCodexHeadroom }),
    ).resolves.toBe(true);
    expect(readCodexHeadroom).not.toHaveBeenCalled();
  });

  it('a failed account-pool read still fails open (the pre-existing contract)', async () => {
    await expect(
      gradingAuditProviderCanServe('codex', NOW, {
        readPoolVerdict: async () => { throw new Error('pg down'); },
        readCodexHeadroom: async () => ({ reachable: true, serviceableByModel: { [model]: 0 } }),
      }),
    ).resolves.toBe(true);
  });

  it('the model match is case- and whitespace-insensitive, like the launcher preflight', () => {
    expect(gradingAuditFallbackModelCanServe({ reachable: true, serviceableByModel: { 'gpt-5.6-sol': 0 } }, ' GPT-5.6-Sol ')).toBe(false);
    expect(gradingAuditFallbackModelCanServe(null, model)).toBe(true);
  });
});
