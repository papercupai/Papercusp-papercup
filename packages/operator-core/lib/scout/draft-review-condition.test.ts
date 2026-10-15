import type { Sql } from 'postgres';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { query, scopes, workspaces, claim, nudge } = vi.hoisted(() => ({
  query: vi.fn(), scopes: vi.fn(), workspaces: vi.fn(), claim: vi.fn(), nudge: vi.fn(),
}));
vi.mock('@papercusp/db-org', async original => ({ ...(await original<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: query }) }));
vi.mock('../pot/started', () => ({ listBlenderMaintenanceScopes: scopes, listBlenderMaintenanceWorkspaceIds: workspaces }));
vi.mock('../pot/watchdog', () => ({ claimWatchdogFire: claim }));
vi.mock('../pot/placement-watchdog', () => ({ resolveMugOwner: async () => null }));
vi.mock('../pot-membership', () => ({ routineStorageSlug: async (slug: string) => slug }));
vi.mock('./nudge-recipient', () => ({ deliverScoutNudge: nudge }));

import { readScoutDraftReviewRecovery, scoutDraftReviewConditionKey, scoutDraftReviewCoverageKey,
  scoutDraftReviewSweep } from './draft-review-watchdog';

const HOUR = 3600_000, NOW = 100 * HOUR;
const identity = { workspaceId: 'ws', planStorageSlug: 'pot', planSlug: 'idea:one' };
const key = scoutDraftReviewConditionKey('ws', 'pot', 'idea:one');
function row() {
  return { workspace_id: 'ws', harness_slug: 'pot', plan_slug: identity.planSlug,
    title: 'idea', updated_at_ms: NOW - 48 * HOUR, status: 'draft', archived: false,
    items: [], decisions: [], content: '\norigin: scout\n' };
}
let candidates: object[], exact: object[], count: unknown;
const originalThreshold = process.env.PAPERCUSP_SCOUT_DRAFT_REVIEW_STALE_SEC;
beforeEach(() => {
  vi.resetAllMocks();
  process.env.PAPERCUSP_SCOUT_DRAFT_REVIEW_STALE_SEC = '43200';
  candidates = [row()]; exact = [row()]; count = 1;
  scopes.mockResolvedValue([{ workspaceId: 'ws', installSlug: 'pot' }]);
  workspaces.mockReturnValue(['ws']); claim.mockResolvedValue(false); nudge.mockResolvedValue(undefined);
  query.mockImplementation(async (strings: TemplateStringsArray) => {
    const text = strings.join(' ');
    if (text.includes('SELECT DISTINCT workspace_id')) return [];
    if (text.includes('SELECT count(*)')) return [{ c: count }];
    if (text.includes('AND plan_slug =')) return exact;
    return candidates;
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  if (originalThreshold === undefined) delete process.env.PAPERCUSP_SCOUT_DRAFT_REVIEW_STALE_SEC;
  else process.env.PAPERCUSP_SCOUT_DRAFT_REVIEW_STALE_SEC = originalThreshold;
});
function deps(open: string[] = []) {
  return { now: NOW, readOpenConditionKeys: vi.fn(async () => open),
    rail: { broadcast: vi.fn(async (_event: { conditionKey?: string; oneShot?: boolean }) => true),
      resolve: vi.fn(async (_event: { conditionKey: string; summary: string }) => true) } };
}

describe('original draft review detector condition episodes', () => {
  it('opens one stable plan episode per workspace/storage scope before legacy debounce', async () => {
    const order: string[] = [], d = deps();
    scopes.mockResolvedValue([{ workspaceId: 'ws', installSlug: 'pot' }, { workspaceId: 'ws:2', installSlug: 'pot:2' }]);
    d.rail.broadcast.mockImplementation(async event => { order.push(event.conditionKey!); return true; });
    claim.mockImplementation(async () => { order.push('legacy'); return false; });
    await scoutDraftReviewSweep(d);
    expect(order).toEqual([key, 'legacy', scoutDraftReviewConditionKey('ws:2', 'pot:2', identity.planSlug), 'legacy']);
    expect(d.rail.broadcast.mock.calls.every(([event]) => event.oneShot === true)).toBe(true);
    expect(nudge).not.toHaveBeenCalled();
  });

  it('records the condition even when the legacy claim fails', async () => {
    const d = deps(); claim.mockRejectedValue(new Error('claim failed'));
    expect(await scoutDraftReviewSweep(d)).toEqual([expect.objectContaining({ outcome: 'error' })]);
    expect(d.rail.broadcast).toHaveBeenCalledWith(expect.objectContaining({ conditionKey: key }));
  });

  it('contains rail delivery failure and still performs the existing nudge', async () => {
    const d = deps(); d.rail.broadcast.mockRejectedValue(new Error('rail unavailable')); claim.mockResolvedValue(true);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await scoutDraftReviewSweep(d)).toEqual([expect.objectContaining({ outcome: 'nudged' })]);
    expect(nudge).toHaveBeenCalledTimes(1);
  });

  it.each(['review', 'fresh', 'ready', 'archived'])('recovers a durable episode from exact %s evidence beyond the capped candidate page', async kind => {
    candidates = [];
    const current = row();
    if (kind === 'review') current.decisions = [{ id: 'D-001', body: 'Needs revision' }] as never;
    if (kind === 'fresh') current.updated_at_ms = NOW - HOUR;
    if (kind === 'ready') current.status = 'ready';
    if (kind === 'archived') current.archived = true;
    exact = [current];
    const d = deps([key]);
    await scoutDraftReviewSweep({ ...d });
    expect(d.rail.resolve).toHaveBeenCalledWith({ conditionKey: key, summary: 'scout-draft-review recovered' });
    const call = query.mock.calls.find(([strings]) => strings.join(' ').includes('AND plan_slug ='))!;
    expect(call.slice(1)).toEqual(['ws', 'pot', identity.planSlug]);
    expect(call[0].join(' ')).not.toContain('LIMIT');
  });

  it.each(['missing', 'foreign-workspace', 'foreign-scope', 'foreign-plan', 'bad-status', 'bad-archived',
    'null-time', 'future-time', 'bad-time', 'bad-items', 'bad-decisions', 'missing-content', 'read-failed'])(
    'preserves the episode for %s recovery input', async kind => {
      candidates = [];
      const current: Record<string, unknown> = { ...row(), updated_at_ms: NOW - HOUR };
      if (kind === 'missing') exact = [];
      else {
        if (kind === 'foreign-workspace') current.workspace_id = 'other';
        if (kind === 'foreign-scope') current.harness_slug = 'other';
        if (kind === 'foreign-plan') current.plan_slug = 'other';
        if (kind === 'bad-status') current.status = 'unknown';
        if (kind === 'bad-archived') current.archived = null;
        if (kind === 'null-time') current.updated_at_ms = null;
        if (kind === 'future-time') current.updated_at_ms = NOW + HOUR;
        if (kind === 'bad-time') current.updated_at_ms = 'not-measured';
        if (kind === 'bad-items') current.items = '{broken';
        if (kind === 'bad-decisions') current.decisions = [null];
        if (kind === 'missing-content') current.content = null;
        exact = [current];
      }
      if (kind === 'read-failed') query.mockRejectedValue(new Error('store unavailable'));
      const d = deps([key]); vi.spyOn(console, 'warn').mockImplementation(() => {});
      await scoutDraftReviewSweep(d);
      expect(d.rail.resolve).not.toHaveBeenCalled();
    });

  it('preserves a still-stale draft and never resolves from page absence', async () => {
    candidates = []; const d = deps([key]);
    await scoutDraftReviewSweep(d);
    expect(d.rail.resolve).not.toHaveBeenCalled();
  });

  it('reuses conditional hold evaluation for exact recovery and preserves unreadable blockers', async () => {
    const current = { ...row(), decisions: [{ title: '', body: 'retry once EI-1 resolves' }] };
    const sql = vi.fn().mockResolvedValueOnce([current]).mockRejectedValueOnce(new Error('refs unavailable'));
    await expect(readScoutDraftReviewRecovery(sql as unknown as Sql, identity, NOW, 12 * HOUR)).rejects.toThrow('refs unavailable');
    const settled = vi.fn().mockResolvedValueOnce([current]).mockResolvedValueOnce([{ feature_id: 'EI-1', status: 'done' }]);
    expect(await readScoutDraftReviewRecovery(settled as unknown as Sql, identity, NOW, 12 * HOUR)).toBe(false);
    const held = vi.fn().mockResolvedValueOnce([current]).mockResolvedValueOnce([{ feature_id: 'EI-1', status: 'open' }]);
    expect(await readScoutDraftReviewRecovery(held as unknown as Sql, identity, NOW, 12 * HOUR)).toBe(true);
  });

  it('ignores malformed identities, and disables the complete sweep with the existing switch', async () => {
    candidates = [];
    const d = deps(['alarm:scout-draft-review:stale:broken', scoutDraftReviewConditionKey('', 'pot', 'idea')]);
    await scoutDraftReviewSweep(d);
    expect(query.mock.calls.some(([strings]) => strings.join(' ').includes('AND plan_slug ='))).toBe(false);
    process.env.PAPERCUSP_SCOUT_DRAFT_REVIEW_STALE_SEC = '0';
    query.mockClear(); await scoutDraftReviewSweep(deps([key]));
    expect(query).not.toHaveBeenCalled();
  });

  it('continues current detection when the durable ledger read fails', async () => {
    const d = deps(); d.readOpenConditionKeys.mockRejectedValue(new Error('ledger unavailable'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await scoutDraftReviewSweep(d);
    expect(d.rail.broadcast).toHaveBeenCalledTimes(1);
    expect(d.rail.resolve).not.toHaveBeenCalled();
  });

  it('opens coverage loss independently, preserving unknown counts until measured zero', async () => {
    scopes.mockResolvedValue([]); candidates = [];
    const coverageKey = scoutDraftReviewCoverageKey('ws'), d = deps([coverageKey]);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await scoutDraftReviewSweep(d);
    expect(d.rail.broadcast).toHaveBeenCalledWith(expect.objectContaining({ conditionKey: coverageKey, oneShot: true }));
    count = null; await scoutDraftReviewSweep(d);
    expect(d.rail.resolve).not.toHaveBeenCalled();
    count = 0; await scoutDraftReviewSweep(d);
    expect(d.rail.resolve).toHaveBeenCalledWith({ conditionKey: coverageKey, summary: 'scout-draft-review recovered' });
  });

  it('recovers coverage only after matching scope measurements, preserving foreign scope authority', async () => {
    const coverageKey = scoutDraftReviewCoverageKey('ws'), d = deps([coverageKey]);
    candidates = []; await scoutDraftReviewSweep(d);
    expect(d.rail.resolve).toHaveBeenCalledTimes(1);
    d.rail.resolve.mockClear(); scopes.mockResolvedValue([{ workspaceId: 'other', installSlug: 'pot' }]);
    await scoutDraftReviewSweep(d);
    expect(d.rail.resolve).not.toHaveBeenCalled();
  });

  it.each([false, true, ' ', -1, 0.5, 'not-measured'])('preserves coverage for malformed count %s', async value => {
    scopes.mockResolvedValue([]); candidates = []; count = value;
    const d = deps([scoutDraftReviewCoverageKey('ws')]);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await scoutDraftReviewSweep(d);
    expect(d.rail.resolve).not.toHaveBeenCalled();
    expect(d.rail.broadcast).not.toHaveBeenCalled();
  });
});
