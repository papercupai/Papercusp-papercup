import { describe, expect, it, vi } from 'vitest';

// WI-10004720: the PRODUCTION gate must key on the exclusive set (pending/running),
// never on getActiveRun (which also counts `review`). Only the two reads are
// replaced; everything else keeps its real export so the module graph is intact.
const store = vi.hoisted(() => ({
  getRunningRun: vi.fn(async (): Promise<{ runId: string; phase: string } | null> => null),
  getActiveRun: vi.fn(async () => ({ runId: 'bulk-review-since-aug', phase: 'review' })),
  getItemIdsAwaitingOwnerReview: vi.fn(async (): Promise<Set<string>> => new Set()),
  createRun: vi.fn(async () => ({ runId: 'bulk-new' })),
  setRunPhase: vi.fn(async () => null),
}));
vi.mock('../../attention/bulk-run-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../attention/bulk-run-store')>()),
  getRunningRun: store.getRunningRun,
  getActiveRun: store.getActiveRun,
  getItemIdsAwaitingOwnerReview: store.getItemIdsAwaitingOwnerReview,
  createRun: store.createRun,
  setRunPhase: store.setRunPhase,
}));
vi.mock('../../attention/automation-policy', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../attention/automation-policy')>()),
  readStandingBulkAutomationPolicy: async () => ({ level: 'L0', minConfidence: 'high' }),
}));

import {
  makeInboxBulkResolveAction,
  buildInboxBulkResolveSeedItems,
  neverBeatBackoff,
  NEVER_BEAT_BACKOFF_MS,
  type InboxBulkResolveActionDeps,
} from './inbox-bulk-resolve-action';
import { countConsecutiveNeverBeat } from '../../attention/bulk-run-store';

const ctx = { installSlug: 'papercusp', workspaceId: 'ws-1', triggerConfig: {}, payloadTemplate: null };

describe('inbox bulk resolver durable action', () => {
  it('makes saved recommendations eligible for a new live pass when risk autonomy is granted', async () => {
    const policy = { level: 'L0' as const, minConfidence: 'medium' as const,
      riskLevels: { low: 'automatic' as const, medium: 'automatic' as const, high: 'automatic' as const } };
    const awaitingReview = vi.fn(async () => new Set<string>());
    const action = makeInboxBulkResolveAction({ enabled: async () => true, readPolicy: async () => policy,
      runningRun: async () => null, awaitingReview, readAttention: async () => ({ groups: [] }), log: vi.fn() });
    await action(ctx);
    expect(awaitingReview).toHaveBeenCalledWith('ws-1', policy);
  });
  it('skips when the feature flag is off and states the reason', async () => {
    const readAttention = vi.fn();
    const runningRun = vi.fn();
    const launch = vi.fn();
    const log = vi.fn();
    const action = makeInboxBulkResolveAction({ enabled: async () => false, readAttention, runningRun, launch, log });
    await action(ctx);
    expect(readAttention).not.toHaveBeenCalled();
    expect(runningRun).not.toHaveBeenCalled();
    expect(launch).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith('skip: feature flag is off');
  });

  it('skips an empty action-bearing attention feed, and says so', async () => {
    const launch = vi.fn();
    const log = vi.fn();
    const action = makeInboxBulkResolveAction({
      enabled: async () => true,
      readAttention: async () => ({ groups: [{ items: [{ id: 'x', actions: [] }] }] }),
      runningRun: async () => null,
      launch,
      log,
    });
    await action(ctx);
    expect(launch).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith('skip: no action-bearing attention items');
  });

  it('skips while an executing run owns the workspace, and names it', async () => {
    const readAttention = vi.fn();
    const launch = vi.fn();
    const log = vi.fn();
    const action = makeInboxBulkResolveAction({
      enabled: async () => true,
      runningRun: async () => ({ runId: 'bulk-existing', phase: 'running' }),
      readAttention,
      launch,
      log,
    });
    await action(ctx);
    expect(readAttention).not.toHaveBeenCalled();
    expect(launch).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith('skip: run=bulk-existing is running (single-flight)');
  });

  it('is NOT blocked by a run waiting in review (production gate is getRunningRun)', async () => {
    store.getRunningRun.mockClear();
    store.getActiveRun.mockClear();
    const readAttention = vi.fn(async () => ({ groups: [] }));
    const log = vi.fn();
    // Default runningRun: the real production wiring, only the store read is mocked.
    const action = makeInboxBulkResolveAction({ enabled: async () => true, readAttention, log });
    await action(ctx);
    expect(store.getRunningRun).toHaveBeenCalledWith('ws-1', 'inbox-resolve');
    expect(store.getActiveRun).not.toHaveBeenCalled();
    // The gate passed: the feed was read even though a review run exists.
    expect(readAttention).toHaveBeenCalledTimes(1);
  });

  it('bounds and de-duplicates the canonical feed to 200 seed rows', () => {
    const items = Array.from({ length: 205 }, (_, i) => ({ id: `item-${i}`, actions: [{ id: 'ack' }] }));
    items.push({ id: 'item-0', actions: [{ id: 'ack' }] });
    const seeds = buildInboxBulkResolveSeedItems({ groups: [{ items }] });
    expect(seeds).toHaveLength(200);
    expect(seeds[0]).toMatchObject({ itemId: 'item-0' });
    expect(new Set(seeds.map((s) => s.itemId)).size).toBe(200);
  });

  // WI-10004720 follow-up: with the review gate gone, every fire re-seeded the
  // SAME head of the feed (13 runs in 3h, 194–200 of each run's 200 items
  // already in an earlier run). Held ids are skipped BEFORE the cap.
  it('skips ids already awaiting owner review and seeds the next unreviewed items', () => {
    const items = Array.from({ length: 205 }, (_, i) => ({ id: `item-${i}`, actions: [{ id: 'ack' }] }));
    const held = new Set(Array.from({ length: 200 }, (_, i) => `item-${i}`));
    const seeds = buildInboxBulkResolveSeedItems({ groups: [{ items }] }, 200, held);
    expect(seeds.map((s) => s.itemId)).toEqual(['item-200', 'item-201', 'item-202', 'item-203', 'item-204']);
  });

  it('reads held ids through the production wiring for this workspace and kind', async () => {
    store.getItemIdsAwaitingOwnerReview.mockClear();
    const action = makeInboxBulkResolveAction({
      enabled: async () => true,
      readAttention: async () => ({ groups: [] }),
      runningRun: async () => null,
      log: vi.fn(),
    });
    await action(ctx);
    expect(store.getItemIdsAwaitingOwnerReview).toHaveBeenCalledWith('ws-1', 'inbox-resolve');
  });

  it('skips, and says why, when every action-bearing item already awaits owner review', async () => {
    const launch = vi.fn();
    const log = vi.fn();
    const action = makeInboxBulkResolveAction({
      enabled: async () => true,
      readAttention: async () => ({
        groups: [{ items: [{ id: 'a', actions: [{ id: 'ack' }] }, { id: 'b', actions: [{ id: 'ack' }] }] }],
      }),
      runningRun: async () => null,
      awaitingReview: async () => new Set(['a', 'b']),
      launch,
      log,
    });
    await action(ctx);
    expect(launch).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      'skip: no unreviewed action-bearing attention items (2 already await owner review)',
    );
  });
});

// WI-10004887: on 2026-10-01 every scheduled run launched the default Claude
// model on the system login (launch_snapshot model:null, backend:'claude') while
// the owner's saved inbox-resolve profile said gpt-6.1-sol/xhigh. The system
// login was at its session limit, so four runs in a row died before their first
// heartbeat, one every 15 minutes.
describe('scheduled launch route (WI-10004887)', () => {
  const NOW = Date.parse('2026-10-01T12:30:00Z');
  const feed = async () => ({ groups: [{ items: [{ id: 'a', actions: [{ id: 'ack' }] }] }] });
  const launchSpy = () =>
    vi.fn(async (_input: Parameters<InboxBulkResolveActionDeps['launch']>[0]) => ({ ok: true }));

  it("launches with the owner's saved inbox-resolve profile, like the pane's Run button", async () => {
    const launch = launchSpy();
    const action = makeInboxBulkResolveAction({
      enabled: async () => true,
      readAttention: feed,
      runningRun: async () => null,
      awaitingReview: async () => new Set(),
      readLaunchProfile: async () => ({ model: 'gpt-6.1-sol', effort: 'xhigh', account: 'default', carry: 'warm' }),
      recentNeverBeat: async () => ({ consecutive: 0, newestCreatedAt: null }),
      nowMs: () => NOW,
      launch,
      log: vi.fn(),
    });
    await action(ctx);
    expect(launch).toHaveBeenCalledTimes(1);
    expect(launch.mock.calls[0]![0].launch).toMatchObject({
      model: 'gpt-6.1-sol',
      effort: 'xhigh',
      account: 'default',
      backend: 'codex',
    });
    // Authority still comes from the standing policy, never the profile.
    expect(launch.mock.calls[0]![0].launch).toMatchObject({ automationMode: 'review-all', minConfidence: 'high' });
  });

  it('falls back to the launcher default when no profile is saved', async () => {
    const launch = launchSpy();
    const action = makeInboxBulkResolveAction({
      enabled: async () => true,
      readAttention: feed,
      runningRun: async () => null,
      awaitingReview: async () => new Set(),
      readLaunchProfile: async () => null,
      recentNeverBeat: async () => ({ consecutive: 0, newestCreatedAt: null }),
      nowMs: () => NOW,
      launch,
      log: vi.fn(),
    });
    await action(ctx);
    expect(launch.mock.calls[0]![0].launch).toMatchObject({ model: null, account: 'default' });
  });

  it('backs off after consecutive never-heartbeated scheduled runs, and says when it retries', async () => {
    const launch = launchSpy();
    const log = vi.fn();
    const action = makeInboxBulkResolveAction({
      enabled: async () => true,
      readAttention: feed,
      runningRun: async () => null,
      awaitingReview: async () => new Set(),
      readLaunchProfile: async () => null,
      recentNeverBeat: async () => ({ consecutive: 4, newestCreatedAt: '2026-10-01T12:10:00Z' }),
      nowMs: () => NOW,
      launch,
      log,
    });
    await action(ctx);
    expect(launch).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/^skip: the last 3\+ scheduled runs failed .* next attempt in 40m$/));
  });

  it('retries once the back-off window has passed', async () => {
    const launch = launchSpy();
    const action = makeInboxBulkResolveAction({
      enabled: async () => true,
      readAttention: feed,
      runningRun: async () => null,
      awaitingReview: async () => new Set(),
      readLaunchProfile: async () => null,
      recentNeverBeat: async () => ({ consecutive: 4, newestCreatedAt: '2026-10-01T11:29:00Z' }),
      nowMs: () => NOW,
      launch,
      log: vi.fn(),
    });
    await action(ctx);
    expect(launch).toHaveBeenCalledTimes(1);
  });

  it('neverBeatBackoff: below the threshold, or with no timestamp, never backs off', () => {
    expect(neverBeatBackoff({ consecutive: 2, newestCreatedAt: '2026-10-01T12:29:00Z', nowMs: NOW })).toBeNull();
    expect(neverBeatBackoff({ consecutive: 5, newestCreatedAt: null, nowMs: NOW })).toBeNull();
    expect(neverBeatBackoff({ consecutive: 3, newestCreatedAt: '2026-10-01T12:29:00Z', nowMs: NOW })).toEqual({
      retryInMs: NEVER_BEAT_BACKOFF_MS - 60_000,
    });
  });

  it('countConsecutiveNeverBeat stops at the first run that ever beat or is still executing', () => {
    const failedNoBeat = (createdAt: string) => ({ phase: 'failed' as const, heartbeatAt: null, createdAt });
    expect(
      countConsecutiveNeverBeat([
        failedNoBeat('2026-10-01T12:25:00Z'),
        failedNoBeat('2026-10-01T12:10:00Z'),
        { phase: 'failed', heartbeatAt: '2026-10-01T11:50:00Z', createdAt: '2026-10-01T11:45:00Z' },
        failedNoBeat('2026-10-01T11:30:00Z'),
      ]),
    ).toEqual({ consecutive: 2, newestCreatedAt: '2026-10-01T12:25:00Z' });
    expect(
      countConsecutiveNeverBeat([{ phase: 'running', heartbeatAt: null, createdAt: '2026-10-01T12:25:00Z' }]),
    ).toEqual({ consecutive: 0, newestCreatedAt: null });
    expect(countConsecutiveNeverBeat([])).toEqual({ consecutive: 0, newestCreatedAt: null });
  });
});
