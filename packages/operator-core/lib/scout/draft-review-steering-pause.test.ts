/**
 * P-013 (goal-mode-2026-08-07) — the scout-draft-review backstop must NOT be
 * suppressed by owner steering `pauseNewWork`.
 *
 * WHY THIS GUARD EXISTS. `pot:wake` carries a steering-pause gate
 * (agent-tools/pot/wake.ts; see wake-paused-gate.test.ts §"pot:wake
 * steering-pause gate") that skips placement-demand event wakes while
 * `pauseNewWork: true`. The scout-draft-review backstop does NOT go through
 * that tool at all — its path is
 *
 *     scoutDraftReviewSweep  (DBOS routine, bg-host)
 *       -> listBlenderMaintenanceScopes() reads registered Hive scopes
 *       -> fireReviewWake()
 *       -> deliverScoutNudge()           (scout/nudge-recipient)
 *            -> live su / owner escalation through the shared nudge ladder
 *
 * so no leg of it consults owner steering. That is CORRECT and deliberate:
 * disposing drafts that were ALREADY routed is not "new work", and
 * mug.base.md:183-186 names `scout-draft-review` the friction-path exception
 * that "must NOT wait". But it holds only by ACCIDENT OF ROUTING — nothing
 * asserted it. Adding a steering check here (a plausible "make it consistent
 * with pot:wake" change) would silently starve draft disposal for exactly as
 * long as the owner keeps the pot paused, and no test would fail.
 *
 * The pause axes that DO suppress this wake, and must keep working, are
 * covered as controls below so this file cannot pass vacuously:
 *   - registry removal -> the Hive leaves listBlenderMaintenanceScopes()
 *   - the per-hive debounce (claimWatchdogFire)
 *   - the kill switch (PAPERCUSP_SCOUT_DRAFT_REVIEW_STALE_SEC <= 0)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const HOUR = 3_600_000;

const {
  listBlenderMaintenanceScopes,
  listBlenderMaintenanceWorkspaceIds,
  deliverScoutNudge,
  resolveMugOwner,
  claimWatchdogFire,
  routineStorageSlug,
  draftRows,
} =
  vi.hoisted(() => ({
    listBlenderMaintenanceScopes: vi.fn(),
    listBlenderMaintenanceWorkspaceIds: vi.fn(() => []),
    deliverScoutNudge: vi.fn().mockResolvedValue(undefined),
    resolveMugOwner: vi.fn(),
    claimWatchdogFire: vi.fn(),
    routineStorageSlug: vi.fn(),
    draftRows: {
      current: [] as Array<{
        plan_slug: string;
        title: string | null;
        updated_at_ms: number;
        workspace_id?: string;
        harness_slug?: string;
        items?: unknown;
        decisions?: unknown;
        content?: string;
      }>,
    },
  }));

vi.mock('@papercusp/db-org', async (orig) => ({
  ...(await orig<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: () => Promise.resolve(draftRows.current) }),
}));
vi.mock('../pot/started', () => ({ listBlenderMaintenanceScopes, listBlenderMaintenanceWorkspaceIds }));
vi.mock('../pot/placement-watchdog', () => ({ resolveMugOwner }));
vi.mock('../pot/watchdog', () => ({ claimWatchdogFire }));
vi.mock('../pot-membership', () => ({ routineStorageSlug }));
vi.mock('./nudge-recipient', () => ({ deliverScoutNudge }));
vi.mock('../severe-event-broadcast', () => ({ broadcastSevereEvent: vi.fn(async () => true) }));
vi.mock('../agent-tools/coordination/tools/conditions', () => ({
  readConditionEnvelopes: async () => [], computeConditionStates: () => [],
}));

// The steering store answers PAUSED for every read. If any leg of the sweep
// ever starts consulting it, it gets the pause — and the assertions below flip.
const getOwnerSteering = vi.fn();
const isPausedNow = vi.fn();
vi.mock('../owner-steering', () => ({
  getOwnerSteering: (...a: unknown[]) => getOwnerSteering(...a),
  isPausedNow: (...a: unknown[]) => isPausedNow(...a),
}));

import { scoutDraftReviewSweep } from './draft-review-watchdog';

/** One scout draft, stale well past the 12h default. */
function staleDraftRow(slug = 'scout-idea-2026-08-08', ageHours = 48) {
  return { plan_slug: slug, title: 'a routed idea', updated_at_ms: Date.now() - ageHours * HOUR };
}

const savedEnv = { ...process.env };

beforeEach(() => {
  vi.clearAllMocks();
  draftRows.current = [staleDraftRow()];
  listBlenderMaintenanceScopes.mockResolvedValue([{ workspaceId: 'ws-1', installSlug: 'pot-1' }]);
  routineStorageSlug.mockImplementation(async (installSlug: string) => installSlug);
  claimWatchdogFire.mockResolvedValue(true);
  resolveMugOwner.mockResolvedValue('mug-owner-1');
  // Owner steering: HARD PAUSED, for every test in this file.
  getOwnerSteering.mockResolvedValue({ pauseNewWork: true, pausedUntil: null });
  isPausedNow.mockReturnValue(true);
});

afterEach(() => {
  process.env = { ...savedEnv };
});

describe('scout-draft-review vs owner steering pauseNewWork (P-013)', () => {
  it('FIRES the review wake for a started pot even while pauseNewWork is true', async () => {
    const results = await scoutDraftReviewSweep();

    expect(deliverScoutNudge).toHaveBeenCalledTimes(1);
    expect(deliverScoutNudge).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: 'ws-1', source: 'scout-draft-review' }),
    );
    expect(results).toEqual([
      expect.objectContaining({ workspaceId: 'ws-1', installSlug: 'pot-1', outcome: 'nudged' }),
    ]);
  });

  it('never consults owner steering on the backstop path at all', async () => {
    await scoutDraftReviewSweep();
    // Not merely "the answer was ignored" — the sweep must not even ask, so a
    // future steering read shows up here as a failure rather than as silence.
    expect(getOwnerSteering).not.toHaveBeenCalled();
    expect(isPausedNow).not.toHaveBeenCalled();
  });

  it('still disposes drafts of EVERY started pot while paused (no per-pot steering skip)', async () => {
      listBlenderMaintenanceScopes.mockResolvedValue([
      { workspaceId: 'ws-1', installSlug: 'pot-1' },
      { workspaceId: 'ws-1', installSlug: 'pot-2' },
    ]);
    const results = await scoutDraftReviewSweep();
    expect(deliverScoutNudge).toHaveBeenCalledTimes(2);
    expect(results.map((r) => r.outcome)).toEqual(['nudged', 'nudged']);
  });

  it('unions plan-discovered legacy scopes with registered scopes', async () => {
    draftRows.current = [
      {
        ...staleDraftRow('registered-draft'),
        workspace_id: 'ws-1',
        harness_slug: 'pot-1',
        content: '\norigin: scout\n',
      },
      {
        ...staleDraftRow('legacy-draft'),
        workspace_id: 'ws-2',
        harness_slug: 'legacy-pot',
        content: '\norigin: scout\n',
      },
    ];
    listBlenderMaintenanceScopes.mockResolvedValue([{ workspaceId: 'ws-1', installSlug: 'pot-1' }]);
    routineStorageSlug.mockImplementation(async (installSlug: string) => installSlug);

    const results = await scoutDraftReviewSweep();

    expect(deliverScoutNudge).toHaveBeenCalledTimes(2);
    expect(results.map(({ workspaceId, installSlug }) => `${workspaceId}:${installSlug}`)).toEqual([
      'ws-1:pot-1',
      'ws-2:legacy-pot',
    ]);
    expect(results).toEqual([
      expect.objectContaining({ evaluatedWorkspaceCount: 2, evaluatedScopeCount: 2 }),
      expect.objectContaining({ evaluatedWorkspaceCount: 2, evaluatedScopeCount: 2 }),
    ]);
  });
});

/**
 * CONTROLS — the suppressors that must KEEP working. Without these the file
 * above would pass even if the sweep had been gutted to always wake, so they
 * are what make the "fires while paused" assertions meaningful.
 */
describe('scout-draft-review suppressors that DO apply (controls)', () => {
  it('does not wake when no registered scope has eligible backlog', async () => {
    listBlenderMaintenanceScopes.mockResolvedValue([]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const results = await scoutDraftReviewSweep();
    expect(deliverScoutNudge).not.toHaveBeenCalled();
    expect(results).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('does not wake when the per-hive debounce declines the fire', async () => {
    claimWatchdogFire.mockResolvedValue(false);
    const results = await scoutDraftReviewSweep();
    expect(deliverScoutNudge).not.toHaveBeenCalled();
    expect(results).toEqual([expect.objectContaining({ outcome: 'skipped', reason: 'debounced' })]);
  });

  it('does not wake when no draft is stale (default-safe)', async () => {
    draftRows.current = [staleDraftRow('fresh-draft', 1)];
    const results = await scoutDraftReviewSweep();
    expect(deliverScoutNudge).not.toHaveBeenCalled();
    expect(results).toEqual([]);
  });

  it('does not wake when the kill switch is set', async () => {
    process.env.PAPERCUSP_SCOUT_DRAFT_REVIEW_STALE_SEC = '0';
    const results = await scoutDraftReviewSweep();
    expect(deliverScoutNudge).not.toHaveBeenCalled();
    expect(listBlenderMaintenanceScopes).not.toHaveBeenCalled();
    expect(results).toEqual([]);
  });
});
