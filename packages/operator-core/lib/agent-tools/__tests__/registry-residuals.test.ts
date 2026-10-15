/**
 * Registry-residual tools — actions:recent, notifications:recent,
 * harness:escalation, harness:pending_reviews, harness:health,
 * harness:list_features.
 *
 * After the function-as-truth refactor these tools call lib functions
 * directly (no HTTP roundtrip). Tests mock the lib (vi.doMock) and
 * assert the tool's projection/filter logic.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const MAKE_CTX = (over: Record<string, unknown> = {}) =>
  ({
    log: vi.fn(),
    signal: new AbortController().signal,
    progress: vi.fn(),
    workspaceId: 'default',
    harnessSlug: 'sheets',
    role: 'architect' as const,
    runId: 'run_T',
    spawnId: 'spw_T',
    ...over,
  } as never);

function parsePayload(result: {
  content?: Array<{ text: string }>;
  data?: unknown;
}): Record<string, unknown> {
  // Tools are migrating to the `{ data }` return shape (token-opt P-003 —
  // tool-data-shape-ratchet.test.ts); un-migrated ones still return the
  // inline-JSON content envelope. Accept both so a per-tool migration
  // (e.g. harness:pending_reviews, 2026-08-24) cannot red this file.
  if (result.data !== undefined) return result.data as Record<string, unknown>;
  return JSON.parse(result.content![0].text);
}

const listUserActionsMock = vi.fn();
const listToastsMock = vi.fn();
const getEscalationMock = vi.fn();
const listPendingReviewsMock = vi.fn();
const listFeaturesForHarnessMock = vi.fn();
const getHealthMock = vi.fn();
const readHarnessStuckFeaturesMock = vi.fn();

let actionsRecent: { handler: (a: unknown, c: unknown) => Promise<{ content: Array<{ text: string }> }> };
let notificationsRecent: typeof actionsRecent;
let harnessEscalation: typeof actionsRecent;
let harnessPendingReviews: typeof actionsRecent;
let harnessListFeatures: typeof actionsRecent;
let harnessHealth: typeof actionsRecent;

beforeAll(async () => {
  vi.doMock('../../user-actions-data', () => ({
    listUserActions: listUserActionsMock,
    InvalidSlugError: class InvalidSlugError extends Error {},
  }));
  vi.doMock('../../toast-log-data', () => ({
    listToasts: listToastsMock,
  }));
  vi.doMock('../../harness-readers', () => ({
    getEscalation: getEscalationMock,
    listPendingReviews: listPendingReviewsMock,
    listFeaturesForHarness: listFeaturesForHarnessMock,
    getHealth: getHealthMock,
  }));
  // P-008 (work-queue-stuck-item-recovery): harness:health dynamically imports
  // work-queue-health to augment the lib data with the per-harness stuck-queue slice.
  // Mock it so the projection is deterministic (no real PG dependency in this unit test).
  // The handler wraps that whole slice in a best-effort try/catch, so the two other
  // modules it pulls in on the same path (db-org's pool accessor, the workspace
  // registry) must be mocked too — either one throwing silently drops `stuckQueue`
  // from the payload and the assertion below fails on a missing key, not a wrong one.
  vi.doMock('../../work-queue-health', () => ({
    readHarnessStuckFeatures: readHarnessStuckFeaturesMock,
  }));
  vi.doMock('@papercusp/db-org', async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    getOrgPg: () => ({ sql: vi.fn() }),
  }));
  vi.doMock('../../workspace-registry', async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    activeWorkspaceId: () => 'default',
  }));

  actionsRecent = (await import('../operator/actions_recent')).default as never;
  notificationsRecent = (await import('../operator/notifications_recent'))
    .default as never;
  harnessEscalation = (await import('../harness/escalation')).default as never;
  harnessPendingReviews = (await import('../harness/pending_reviews'))
    .default as never;
  harnessListFeatures = (await import('../harness/list_features'))
    .default as never;
  harnessHealth = (await import('../harness/health')).default as never;
});

afterAll(() => {
  vi.doUnmock('../../user-actions-data');
  vi.doUnmock('../../toast-log-data');
  vi.doUnmock('../../harness-readers');
});

describe('actions:recent', () => {
  it('returns count + actions slice', async () => {
    listUserActionsMock.mockResolvedValueOnce({
      actions: [{ id: 1 }, { id: 2 }],
      cacheStatus: 'MISS',
      cacheAgeMs: 0,
    });
    const result = await actionsRecent.handler({ slug: 'sheets', limit: 5 }, MAKE_CTX());
    expect(listUserActionsMock).toHaveBeenCalledWith({ slug: 'sheets', limit: 5 });
    const payload = parsePayload(result);
    expect(payload).toEqual({ count: 2, actions: [{ id: 1 }, { id: 2 }] });
  });

  it('returns empty list on InvalidSlugError', async () => {
    const { InvalidSlugError } = await import('../../user-actions-data');
    listUserActionsMock.mockRejectedValueOnce(new InvalidSlugError('!!'));
    const result = await actionsRecent.handler({ slug: 'unknown' }, MAKE_CTX());
    const payload = parsePayload(result);
    expect(payload).toEqual({ count: 0, actions: [] });
  });

  it('rethrows other errors', async () => {
    listUserActionsMock.mockRejectedValueOnce(new Error('PG dropped'));
    await expect(actionsRecent.handler({ slug: 'sheets' }, MAKE_CTX())).rejects.toThrow(
      /PG dropped/,
    );
  });
});

describe('notifications:recent', () => {
  it('returns toasts unfiltered when level=all (default)', async () => {
    listToastsMock.mockResolvedValueOnce({
      toasts: [
        { level: 'error', message: 'oops' },
        { level: 'info', message: 'hi' },
      ],
    });
    const result = await notificationsRecent.handler({}, MAKE_CTX());
    const payload = parsePayload(result);
    expect(payload.count).toBe(2);
  });

  it('pushes the level filter into the toast query before applying the limit', async () => {
    listToastsMock.mockClear();
    const warning = { level: 'warning', message: 'disk space low' };
    listToastsMock.mockResolvedValueOnce({
      toasts: [warning],
    });
    const result = await notificationsRecent.handler(
      { level: 'warning', limit: 1 },
      MAKE_CTX(),
    );
    expect(listToastsMock).toHaveBeenCalledWith({ limit: 1, level: 'warning' });
    const payload = parsePayload(result);
    expect(payload).toEqual({ count: 1, notifications: [warning] });
  });
});

describe('harness:escalation', () => {
  it('hasEscalation:true when escalation text present', async () => {
    getEscalationMock.mockResolvedValueOnce({
      ok: true,
      data: {
        escalation: 'something is broken',
        supervisorNotes: 'investigate X',
        mtimeMs: 1234,
      },
    });
    const result = await harnessEscalation.handler({ slug: 'sheets' }, MAKE_CTX());
    const payload = parsePayload(result);
    expect(payload.hasEscalation).toBe(true);
    expect(payload.escalation).toBe('something is broken');
  });

  it('hasEscalation:false when escalation is whitespace', async () => {
    getEscalationMock.mockResolvedValueOnce({
      ok: true,
      data: { escalation: '   ', supervisorNotes: null, mtimeMs: null },
    });
    const result = await harnessEscalation.handler({ slug: 'sheets' }, MAKE_CTX());
    const payload = parsePayload(result);
    expect(payload.hasEscalation).toBe(false);
  });

  it('returns an explicit read error on 404', async () => {
    getEscalationMock.mockResolvedValueOnce({
      ok: false,
      status: 404,
      error: 'unknown project',
    });
    const result = await harnessEscalation.handler({ slug: 'unknown' }, MAKE_CTX());
    const payload = parsePayload(result);
    expect(result).toMatchObject({ isError: true });
    expect(payload).toEqual({ ok: false, status: 404, error: 'unknown project' });
  });
});

describe('harness:pending_reviews', () => {
  it('returns count + reviews slice', async () => {
    listPendingReviewsMock.mockResolvedValueOnce({
      reviews: [{ id: 'r1' }, { id: 'r2' }, { id: 'r3' }],
    });
    const result = await harnessPendingReviews.handler(
      { slug: 'sheets', limit: 2 },
      MAKE_CTX(),
    );
    const payload = parsePayload(result);
    expect(payload.count).toBe(2);
  });
});

describe('harness:health', () => {
  it('passes lib data through (+ augments with the P-008 stuck-queue slice)', async () => {
    const data = {
      ok: true,
      alive: true,
      escalated: false,
      features: { total: 5, passed: 5, failing: 0, inProgress: 0, blocked: 0 },
      lastRunAgeSeconds: 30,
      ghostRate: 0,
      checks: [],
    };
    getHealthMock.mockResolvedValueOnce({ ok: true, data });
    readHarnessStuckFeaturesMock.mockResolvedValueOnce({ stuckFeatures: 0, deadHeldFeatures: 0 });
    const result = await harnessHealth.handler({ slug: 'sheets' }, MAKE_CTX());
    // P-008: the handler surfaces the per-harness stuck-queue counts alongside the lib data.
    expect(parsePayload(result)).toEqual({ ...data, stuckQueue: { stuckFeatures: 0, deadHeldFeatures: 0 } });
  });

  it('returns error shape on unknown project', async () => {
    getHealthMock.mockResolvedValueOnce({
      ok: false,
      status: 404,
      error: 'unknown project',
    });
    const result = await harnessHealth.handler({ slug: 'unknown' }, MAKE_CTX());
    expect(parsePayload(result)).toEqual({ error: 'unknown project' });
  });
});

describe('harness:list_features', () => {
  it('projects to id/title/status/claims/attempts only', async () => {
    listFeaturesForHarnessMock.mockResolvedValueOnce({
      ok: true,
      data: {
        features: [
          { id: 'f1', title: 'A', status: 'passed', claims: [], attempts: 1, extra: 'drop' },
          { id: 'f2', title: 'B', status: 'failing', claims: ['x'], attempts: 3, extra: 'drop' },
        ],
      },
    });
    const result = await harnessListFeatures.handler({ slug: 'sheets' }, MAKE_CTX());
    const payload = parsePayload(result);
    const features = payload.features as Array<Record<string, unknown>>;
    expect(features).toHaveLength(2);
    expect(features[0]).toEqual({
      id: 'f1',
      title: 'A',
      status: 'passed',
      claims: [],
      attempts: 1,
    });
    expect(features[0].extra).toBeUndefined();
  });

  it('filters by status', async () => {
    listFeaturesForHarnessMock.mockResolvedValueOnce({
      ok: true,
      data: {
        features: [
          { id: 'f1', status: 'passed' },
          { id: 'f2', status: 'failing' },
        ],
      },
    });
    const result = await harnessListFeatures.handler(
      { slug: 'sheets', status: 'failing' },
      MAKE_CTX(),
    );
    const payload = parsePayload(result);
    expect(payload.count).toBe(1);
    expect((payload.features as Array<{ id: string }>)[0].id).toBe('f2');
  });

  it('passes phase=testing through to the lib', async () => {
    listFeaturesForHarnessMock.mockResolvedValueOnce({
      ok: true,
      data: { features: [] },
    });
    await harnessListFeatures.handler({ slug: 'sheets', phase: 'testing' }, MAKE_CTX());
    expect(listFeaturesForHarnessMock).toHaveBeenLastCalledWith('sheets', 'testing');
  });
});
