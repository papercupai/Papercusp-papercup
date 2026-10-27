/**
 * release-request-sweep.test.ts — the `release-request-sweep` periodic check
 * (in-process-periodic.ts, WI-5974): fires the ANNOUNCED onSilence consequence for
 * work_items:request_release deadlines that passed unanswered.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DueReleaseRequestRow } from '../work-items-release-request';

vi.mock('@papercusp/db-org', async (orig) => ({ ...(await orig<typeof import('@papercusp/db-org')>()), getOrgPg: () => ({ sql: {} }) }));

const findDueReleaseRequests = vi.fn();
const findPendingReleaseRequestConsequences = vi.fn();
const resolveWorkItemReleaseRequest = vi.fn();
const settleReleaseRequestCondition = vi.fn();
const settleReleaseRequestConsequence = vi.fn();
const hasWorkItemProgressAfterReleaseRequest = vi.fn(
  (request: { requestedAt: number }, lastProgressAt: string | Date | null) => {
    if (lastProgressAt == null) return false;
    const progressAt = lastProgressAt instanceof Date ? lastProgressAt.getTime() : Date.parse(lastProgressAt);
    return Number.isFinite(progressAt) && progressAt > request.requestedAt;
  },
);
vi.mock('../work-items-release-request', () => ({
  findDueReleaseRequests: (...a: unknown[]) => findDueReleaseRequests(...a),
  findPendingReleaseRequestConsequences: (...a: unknown[]) => findPendingReleaseRequestConsequences(...a),
  hasWorkItemProgressAfterReleaseRequest: (
    request: { requestedAt: number },
    lastProgressAt: string | Date | null,
  ) => hasWorkItemProgressAfterReleaseRequest(request, lastProgressAt),
  resolveWorkItemReleaseRequest: (...a: unknown[]) => resolveWorkItemReleaseRequest(...a),
  settleReleaseRequestCondition: (...a: unknown[]) => settleReleaseRequestCondition(...a),
  settleReleaseRequestConsequence: (...a: unknown[]) => settleReleaseRequestConsequence(...a),
}));

const releaseWorkItem = vi.fn();
const setWorkItemClaimHold = vi.fn();
const commentWorkItem = vi.fn();
vi.mock('../work-items', () => ({
  releaseWorkItem: (...a: unknown[]) => releaseWorkItem(...a),
  setWorkItemClaimHold: (...a: unknown[]) => setWorkItemClaimHold(...a),
  commentWorkItem: (...a: unknown[]) => commentWorkItem(...a),
}));

const releaseReclaimedWorkItemLocks = vi.fn();
vi.mock('../work-item-lock-release', () => ({
  releaseReclaimedWorkItemLocks: (...a: unknown[]) => releaseReclaimedWorkItemLocks(...a),
}));

const sendMessage = vi.fn();
vi.mock('../agent-tools/coordination/messages', () => ({
  sendMessage: (...a: unknown[]) => sendMessage(...a),
}));

const notifyAttention = vi.fn();
vi.mock('../attention-notify', () => ({
  notifyAttention: (...a: unknown[]) => notifyAttention(...a),
  notifyAttentionOnce: (...a: unknown[]) => notifyAttention(...a),
}));

const broadcastSevereEvent = vi.fn();
const broadcastSevereEventResolved = vi.fn();
vi.mock('../severe-event-broadcast', () => ({
  broadcastSevereEvent: (...a: unknown[]) => broadcastSevereEvent(...a),
  broadcastSevereEventResolved: (...a: unknown[]) => broadcastSevereEventResolved(...a),
}));

const assessForceRelease = vi.fn();
vi.mock('../agent-tools/work_items/release-force-guard', () => ({
  assessForceRelease: (...a: unknown[]) => assessForceRelease(...a),
}));

const { buildDefaultChecks } = await import('./in-process-periodic');
const check = buildDefaultChecks().find((c) => c.name === 'release-request-sweep')!;

function dueRow(overrides: Partial<{ id: string; harness: string | null; workspaceId: string; holderNow: string | null; onSilence: 'reclaim' | 'escalate' | 'nothing' }> = {}): DueReleaseRequestRow {
  const onSilence = overrides.onSilence ?? 'reclaim';
  return {
    id: overrides.id ?? 'WI-1',
    harness: overrides.harness ?? 'papercup',
    workspaceId: overrides.workspaceId ?? 'default',
    holderNow: overrides.holderNow ?? 'holder-1',
    lastProgressAt: null,
    terminal: false,
    conditionRequest: null as { by: string; holder: string; deadlineAt: number } | null,
    paths: ['packages/target.ts'],
    request: {
      by: 'requester-1',
      holder: 'holder-1',
      reason: 'looked orphaned',
      onSilence,
      deadlineAt: Date.now() - 1000,
      requestedAt: Date.now() - 60_000,
      resolved: false,
      resolution: null,
      resolvedAt: null,
    },
  };
}

function consequenceJob(row: DueReleaseRequestRow) {
  const req = row.request;
  const resolution =
    req.onSilence === 'reclaim' ? 'consequence-reclaim' : req.onSilence === 'escalate' ? 'consequence-escalate' : 'consequence-nothing';
  return {
    id: 'release-request:' + req.requestedAt + ':' + req.deadlineAt,
    resolution,
    by: req.by,
    holder: req.holder,
    reason: req.reason,
    onSilence: req.onSilence,
    deadlineAt: req.deadlineAt,
    requestedAt: req.requestedAt,
    reclaimHolder: row.holderNow ?? req.holder,
    paths: row.paths,
  };
}

function pendingConsequence(row: DueReleaseRequestRow) {
  return {
    id: row.id,
    harness: row.harness,
    workspaceId: row.workspaceId,
    job: consequenceJob(row),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // The tick intentionally console.warn()s a one-line summary per fired consequence
  // (operational visibility, mirrors every other sweep in this file) — expected, not a bug.
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  findDueReleaseRequests.mockResolvedValue([]);
  findPendingReleaseRequestConsequences.mockResolvedValue([]);
  settleReleaseRequestCondition.mockResolvedValue(true);
  settleReleaseRequestConsequence.mockResolvedValue(true);
  broadcastSevereEvent.mockResolvedValue(true);
  broadcastSevereEventResolved.mockResolvedValue(true);
  commentWorkItem.mockResolvedValue({ id: 'post' });
  sendMessage.mockResolvedValue(undefined);
  notifyAttention.mockResolvedValue({ recordId: 1, deduped: false, mobileDelivered: false, desktopDelivered: true });
  releaseWorkItem.mockResolvedValue({ id: 'WI-1', assignee: null });
  setWorkItemClaimHold.mockResolvedValue({ id: 'WI-1', hold: false, applicable: true });
  releaseReclaimedWorkItemLocks.mockResolvedValue({ releases: [], failures: 0, skipped: null });
  assessForceRelease.mockResolvedValue({ allowed: true, basis: 'holder-warm-idle', holderLiveness: {} });
});

describe('release-request-sweep check', () => {
  it('refreshes a durable timeout after failed paging; unreadable scans and failed resolution preserve it', async () => {
    const row = dueRow({ onSilence: 'escalate' });
    row.request = { ...row.request, resolved: true, resolution: 'consequence-escalate' };
    row.conditionRequest = { by: row.request.by, holder: row.request.holder, deadlineAt: row.request.deadlineAt };
    findDueReleaseRequests.mockImplementation(async (_sql, opts) => opts.alarmPending ? [row] : []);
    await check.tick(); await check.tick();
    expect(broadcastSevereEvent).toHaveBeenCalledTimes(2);
    expect(notifyAttention).not.toHaveBeenCalled();
    expect(broadcastSevereEventResolved).not.toHaveBeenCalled();
    findDueReleaseRequests.mockRejectedValueOnce(new Error('scan unavailable'));
    await expect(check.tick()).rejects.toThrow('scan unavailable');
    expect(broadcastSevereEventResolved).not.toHaveBeenCalled();
    row.lastProgressAt = new Date(row.request.requestedAt + 1).toISOString();
    broadcastSevereEventResolved.mockResolvedValueOnce(false);
    await check.tick();
    expect(settleReleaseRequestCondition).not.toHaveBeenCalledWith(expect.anything(), row, true);
    await check.tick();
    expect(settleReleaseRequestCondition).toHaveBeenCalledWith(expect.anything(), row, true);
  });

  it.each(['release', 'terminal', 'replacement'])('resolves only the measured %s recovery without replaying the consequence', async (kind) => {
    const row = dueRow({ onSilence: 'escalate' });
    row.conditionRequest = { by: row.request.by, holder: row.request.holder, deadlineAt: row.request.deadlineAt };
    if (kind === 'release') row.holderNow = null;
    if (kind === 'terminal') row.terminal = true;
    if (kind === 'replacement') row.request.deadlineAt++;
    findDueReleaseRequests.mockImplementation(async (_sql, opts) => opts.alarmPending ? [row] : []);
    await check.tick();
    expect(broadcastSevereEventResolved).toHaveBeenCalledWith(expect.objectContaining({ conditionKey: 'alarm:release-request:default:WI-1' }));
    expect(settleReleaseRequestCondition).toHaveBeenCalledWith(expect.anything(), row, true);
    expect(resolveWorkItemReleaseRequest).not.toHaveBeenCalled();
    expect(notifyAttention).not.toHaveBeenCalled();
  });
  it('is registered at a 60s cadence and does not shed under load', () => {
    expect(check.intervalMs).toBe(60_000);
    expect(check.shed).toBeFalsy();
    // A restarted host must reconcile an already-expired durable request immediately,
    // rather than waiting another full 60s interval before the first sweep.
    expect(check.fireOnArm).toBe(true);
  });

  it('no due rows → no side effects', async () => {
    await check.tick();
    expect(resolveWorkItemReleaseRequest).not.toHaveBeenCalled();
    expect(releaseWorkItem).not.toHaveBeenCalled();
    expect(notifyAttention).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('supersedes an old release request after a successor takes the claim', async () => {
    const row = dueRow({ onSilence: 'reclaim', holderNow: 'successor' });
    findDueReleaseRequests.mockResolvedValue([row]);
    resolveWorkItemReleaseRequest.mockImplementation(async (_id, opts) => ({
      ...row.request, resolved: true, resolution: opts.resolution,
    }));

    await check.tick();

    expect(resolveWorkItemReleaseRequest).toHaveBeenCalledWith(row.id, expect.objectContaining({
      resolution: 'superseded', expectedHolder: row.request.holder,
      expectedBy: row.request.by, expectedDeadlineAt: row.request.deadlineAt,
    }));
    expect(assessForceRelease).not.toHaveBeenCalled();
    expect(releaseReclaimedWorkItemLocks).not.toHaveBeenCalled();
    expect(releaseWorkItem).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('retires a persisted reclaim that captured a replacement holder without releasing it', async () => {
    const pending = pendingConsequence(dueRow({ onSilence: 'reclaim', holderNow: 'successor' }));
    expect(pending.job.reclaimHolder).not.toBe(pending.job.holder);
    findPendingReleaseRequestConsequences.mockResolvedValue([pending]);

    await check.tick();

    expect(settleReleaseRequestConsequence).toHaveBeenCalledWith({}, pending);
    expect(releaseReclaimedWorkItemLocks).not.toHaveBeenCalled();
    expect(releaseWorkItem).not.toHaveBeenCalled();
    expect(setWorkItemClaimHold).not.toHaveBeenCalled();
    expect(commentWorkItem).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('onSilence:"reclaim" — CAS wins → releases the item + notifies both parties + comments', async () => {
    const row = dueRow({ onSilence: 'reclaim' });
    findDueReleaseRequests.mockResolvedValue([row]);
    resolveWorkItemReleaseRequest.mockResolvedValue({ ...row.request, resolved: true, resolution: 'consequence-reclaim' });

    await check.tick();

    expect(assessForceRelease).toHaveBeenCalledWith({
      callerOwnerId: 'requester-1',
      holderOwnerId: 'holder-1',
      workspaceId: 'default',
      itemLastProgressAt: null,
      releaseRequest: row.request,
    });
    expect(resolveWorkItemReleaseRequest).toHaveBeenCalledWith('WI-1', {
      harness: 'papercup',
      resolution: 'consequence-reclaim',
      expectedBy: 'requester-1',
      expectedHolder: 'holder-1',
      expectedDeadlineAt: row.request.deadlineAt,
      expectedLastProgressAt: row.lastProgressAt,
      consequenceJob: consequenceJob(row),
    });
    expect(releaseReclaimedWorkItemLocks).toHaveBeenCalledWith({
      ownerId: 'holder-1',
      paths: ['packages/target.ts'],
      goalRef: 'WI-1',
    });
    expect(releaseWorkItem).toHaveBeenCalledWith('WI-1', {
      harness: 'papercup',
      expectedAssignee: 'holder-1',
    });
    expect(setWorkItemClaimHold).toHaveBeenCalledWith('WI-1', false, {
      harness: 'papercup',
      leaseOnly: true,
      expectedLeaseHolder: 'holder-1',
    });
    expect(commentWorkItem).toHaveBeenCalledTimes(1);
    expect(commentWorkItem.mock.calls[0][1]).toContain('EXPIRED');
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0][1]).toMatchObject({ to: ['holder-1', 'requester-1'] });
    expect(sendMessage.mock.calls[0][1].msgId).toContain(consequenceJob(row).id);
    expect(settleReleaseRequestConsequence).toHaveBeenCalledWith({}, pendingConsequence(row));
    expect(notifyAttention).not.toHaveBeenCalled();
  });

  it('EI-21377805080867612: a live progressing holder defers reclaim without resolving the request CAS', async () => {
    const row = dueRow({ onSilence: 'reclaim' });
    findDueReleaseRequests.mockResolvedValue([row]);
    assessForceRelease.mockResolvedValue({
      allowed: false,
      holderLiveness: { live: true, lastToolInvocationAt: new Date().toISOString() },
    });

    await check.tick();

    expect(resolveWorkItemReleaseRequest).not.toHaveBeenCalled();
    expect(releaseReclaimedWorkItemLocks).not.toHaveBeenCalled();
    expect(releaseWorkItem).not.toHaveBeenCalled();
    expect(commentWorkItem).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('EI-23831380926942341: progress since the request resolves it before the reclaim consequence', async () => {
    const due = dueRow();
    const row = { ...due, lastProgressAt: new Date(due.request.requestedAt + 1000) };
    findDueReleaseRequests.mockResolvedValue([row]);
    resolveWorkItemReleaseRequest.mockResolvedValue({ ...row.request, resolved: true, resolution: 'holder-progressed' });

    await check.tick();

    expect(resolveWorkItemReleaseRequest).toHaveBeenCalledWith('WI-1', {
      harness: 'papercup',
      resolution: 'holder-progressed',
      expectedBy: 'requester-1',
      expectedHolder: 'holder-1',
      expectedDeadlineAt: row.request.deadlineAt,
      expectedLastProgressAt: row.lastProgressAt,
    });
    expect(assessForceRelease).not.toHaveBeenCalled();
    expect(releaseReclaimedWorkItemLocks).not.toHaveBeenCalled();
    expect(releaseWorkItem).not.toHaveBeenCalled();
    expect(commentWorkItem.mock.calls[0]?.[1]).toContain('progress after the request');
  });

  it('terminalized before the deadline — superseded CAS produces no consequence side effects', async () => {
    const row = dueRow({ onSilence: 'reclaim' });
    findDueReleaseRequests.mockResolvedValue([row]);
    resolveWorkItemReleaseRequest.mockResolvedValue({ ...row.request, resolved: true, resolution: 'superseded' });

    await check.tick();

    expect(resolveWorkItemReleaseRequest).toHaveBeenCalledWith('WI-1', {
      harness: 'papercup',
      resolution: 'consequence-reclaim',
      expectedBy: 'requester-1',
      expectedHolder: 'holder-1',
      expectedDeadlineAt: row.request.deadlineAt,
      expectedLastProgressAt: row.lastProgressAt,
      consequenceJob: consequenceJob(row),
    });
    expect(releaseReclaimedWorkItemLocks).not.toHaveBeenCalled();
    expect(releaseWorkItem).not.toHaveBeenCalled();
    expect(commentWorkItem).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(notifyAttention).not.toHaveBeenCalled();
  });

  it('onSilence:"escalate" — CAS wins → pages the owner, item is NEVER released', async () => {
    const row = dueRow({ onSilence: 'escalate' });
    findDueReleaseRequests.mockImplementation(async (_sql, opts) => opts.alarmPending ? [] : [row]);
    resolveWorkItemReleaseRequest.mockResolvedValue({ ...row.request, resolved: true, resolution: 'consequence-escalate' });

    await check.tick();

    expect(releaseWorkItem).not.toHaveBeenCalled();
    expect(notifyAttention).toHaveBeenCalledTimes(1);
    expect(notifyAttention.mock.calls[0][0]).toMatchObject({ kind: 'intervention', importance: 'high' });
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(broadcastSevereEvent).toHaveBeenCalledWith(expect.objectContaining({
      conditionKey: 'alarm:release-request:default:WI-1', oneShot: true,
    }));
  });

  it('onSilence:"nothing" — CAS wins → records the silence, no release, no escalation', async () => {
    const row = dueRow({ onSilence: 'nothing' });
    findDueReleaseRequests.mockResolvedValue([row]);
    resolveWorkItemReleaseRequest.mockResolvedValue({ ...row.request, resolved: true, resolution: 'consequence-nothing' });

    await check.tick();

    expect(releaseWorkItem).not.toHaveBeenCalled();
    expect(notifyAttention).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(commentWorkItem).toHaveBeenCalledTimes(1);
  });

  it('replays the persisted consequence after an interruption immediately following the CAS', async () => {
    const row = dueRow({ onSilence: 'reclaim' });
    const job = consequenceJob(row);
    const pending = pendingConsequence(row);
    findPendingReleaseRequestConsequences
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([pending]);
    findDueReleaseRequests
      .mockResolvedValueOnce([]) // alarm scan before the CAS
      .mockResolvedValueOnce([row])
      .mockResolvedValueOnce([]) // restarted sweep has no new deadline
      .mockResolvedValueOnce([]);
    resolveWorkItemReleaseRequest.mockResolvedValue({
      ...row.request,
      resolved: true,
      resolution: 'consequence-reclaim',
    });
    releaseReclaimedWorkItemLocks.mockRejectedValueOnce(new Error('simulated process interruption'));

    await expect(check.tick()).resolves.toBeUndefined();

    expect(resolveWorkItemReleaseRequest).toHaveBeenCalledWith('WI-1', expect.objectContaining({
      resolution: 'consequence-reclaim',
      consequenceJob: job,
    }));
    expect(releaseWorkItem).not.toHaveBeenCalled();
    expect(settleReleaseRequestConsequence).not.toHaveBeenCalled();

    await check.tick();

    expect(resolveWorkItemReleaseRequest).toHaveBeenCalledTimes(1);
    expect(releaseWorkItem).toHaveBeenCalledWith('WI-1', {
      harness: 'papercup',
      expectedAssignee: 'holder-1',
    });
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(settleReleaseRequestConsequence).toHaveBeenCalledWith({}, pending);
  });

  it('CAS losing the race (null) → the row is skipped entirely — no double-fire', async () => {
    const row = dueRow({ onSilence: 'reclaim' });
    findDueReleaseRequests.mockResolvedValue([row]);
    resolveWorkItemReleaseRequest.mockResolvedValue(null); // a concurrent holder-release / tick already resolved it

    await check.tick();

    expect(releaseWorkItem).not.toHaveBeenCalled();
    expect(commentWorkItem).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(notifyAttention).not.toHaveBeenCalled();
  });

  it('processes multiple due rows independently', async () => {
    const rowA = dueRow({ id: 'WI-A', onSilence: 'reclaim', holderNow: 'holder-a' });
    const rowB = dueRow({ id: 'WI-B', onSilence: 'nothing', holderNow: 'holder-b' });
    rowA.request.holder = 'holder-a';
    rowB.request.holder = 'holder-b';
    findDueReleaseRequests.mockResolvedValue([rowA, rowB]);
    resolveWorkItemReleaseRequest.mockImplementation(async (id: string) => ({
      ...(id === 'WI-A' ? rowA.request : rowB.request),
      resolved: true,
      resolution: id === 'WI-A' ? 'consequence-reclaim' : 'consequence-nothing',
    }));

    await check.tick();

    expect(releaseWorkItem).toHaveBeenCalledTimes(1);
    expect(releaseWorkItem).toHaveBeenCalledWith('WI-A', {
      harness: 'papercup',
      expectedAssignee: 'holder-a',
    });
    expect(setWorkItemClaimHold).toHaveBeenCalledWith('WI-A', false, {
      harness: 'papercup',
      leaseOnly: true,
      expectedLeaseHolder: 'holder-a',
    });
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });

  it('never throws when releaseWorkItem itself fails (best-effort logging only)', async () => {
    const row = dueRow({ onSilence: 'reclaim' });
    findDueReleaseRequests.mockResolvedValue([row]);
    resolveWorkItemReleaseRequest.mockResolvedValue({ ...row.request, resolved: true, resolution: 'consequence-reclaim' });
    releaseWorkItem.mockRejectedValue(new Error('boom'));

    await expect(check.tick()).resolves.toBeUndefined();
  });
});
