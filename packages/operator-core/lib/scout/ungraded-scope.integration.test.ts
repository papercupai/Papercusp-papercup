import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { enumerableWorkspaceGlobalLabels, WORKSPACE_GLOBAL_LABEL_PREFIX } from '../workspace-global-labels';
import {
  countActionableUngradedOlderThan,
  countActionableUngradedOutsideScopes,
  readActionableUngradedFilings,
  type UngradedEpochPolicy,
} from './ungraded-scope';

const EPOCH = Date.parse('2026-10-01T00:00:00Z');
const STALE = EPOCH + 10_000;
const POLICY: UngradedEpochPolicy = {
  byOrigin: { scout: EPOCH, 'su-ideate': EPOCH + 1_000 },
  fallbackMs: EPOCH - 1_000,
};

describe('ungraded condition recovery partitions (real migrated PG)', () => {
  let db: OrgTestDb;
  beforeAll(async () => { db = await createOrgTestDb(); });
  afterAll(async () => { await db?.cleanup(); });

  async function insert(workspace: string, id: string, overrides: {
    harness?: string; origin?: string; at?: number; grade?: number; outcome?: string;
  } = {}) {
    await db.adminSql`INSERT INTO harness_shared.scout_routed_ideas
      (idea_id, workspace_id, harness_slug, lens, rail, routed_ref, routed_at, origin, human_grade, outcome)
      VALUES (${workspace + ':' + id}, ${workspace}, ${overrides.harness ?? 'portal'}, 'analogical',
        'improvement', ${'wi:' + id}, ${overrides.at ?? EPOCH + 2_000},
        ${overrides.origin ?? 'scout'}, ${overrides.grade ?? null}, ${overrides.outcome ?? null})`;
  }

  it('counts only exact stale actionable origin/harness/workspace rows, including both boundaries', async () => {
    const workspaceId = 'ungraded-exact-partition';
    await insert(workspaceId, 'epoch-boundary', { at: EPOCH });
    await insert(workspaceId, 'stale-boundary', { at: STALE, outcome: 'pending' });
    await insert(workspaceId, 'pre-epoch', { at: EPOCH - 1 });
    await insert(workspaceId, 'fresh', { at: STALE + 1 });
    await insert(workspaceId, 'graded', { grade: 4 });
    await insert(workspaceId, 'terminal', { outcome: 'landed' });
    await insert(workspaceId, 'other-origin', { origin: 'su-ideate' });
    await insert(workspaceId, 'origin-before-own-epoch', { origin: 'su-ideate', at: EPOCH });
    await insert(workspaceId, 'shadow', { origin: 'shadow-variant' });
    await insert(workspaceId, 'other-harness', { harness: 'sidestage' });
    await insert(workspaceId + '-other', 'other-workspace');
    const args = { workspaceId, policy: POLICY, staleBeforeMs: STALE };
    expect(await countActionableUngradedOlderThan(db.adminSql, {
      ...args, harnessSlug: 'portal', origin: 'scout',
    })).toBe(2);
    expect(await countActionableUngradedOlderThan(db.adminSql, {
      ...args, harnessSlug: 'portal', origin: 'su-ideate',
    })).toBe(1);
    expect(await countActionableUngradedOlderThan(db.adminSql, args)).toBe(4);
  });

  it.each(['papercusp', 'papercup'])('uses the row reader workspace-global reach for %s, without merging real harnesses', async (harnessSlug) => {
    const workspaceId = 'ungraded-global-' + harnessSlug;
    const globals = [...enumerableWorkspaceGlobalLabels(workspaceId), WORKSPACE_GLOBAL_LABEL_PREFIX + 'legacy-home'];
    await insert(workspaceId, 'own', { harness: harnessSlug });
    for (const [index, harness] of globals.entries()) await insert(workspaceId, 'global-' + index, { harness });
    await insert(workspaceId, 'portal');
    const args = { workspaceId, policy: POLICY, staleBeforeMs: STALE };
    const exact = await countActionableUngradedOlderThan(db.adminSql, { ...args, harnessSlug, origin: 'scout' });
    const rows = await readActionableUngradedFilings(db.adminSql, { ...args, harnessSlug, limitPerOrigin: 100 });
    expect(exact).toBe(globals.length + 1);
    expect(rows.map(row => row.ideaId).sort()).toEqual([
      workspaceId + ':own', ...globals.map((_, index) => workspaceId + ':global-' + index),
    ].sort());
    expect(await countActionableUngradedOlderThan(db.adminSql, { ...args, harnessSlug: 'portal', origin: 'scout' })).toBe(1);
    expect(await countActionableUngradedOutsideScopes(db.adminSql, { ...args, harnessSlugs: [harnessSlug, 'portal'] })).toBe(0);
    expect(await countActionableUngradedOutsideScopes(db.adminSql, { ...args, harnessSlugs: ['portal'] })).toBe(globals.length + 1);
  });

  it('keeps an uncapped exact backlog until measured recovery, independently of other origins', async () => {
    const workspaceId = 'ungraded-bounded-recovery';
    for (let index = 0; index < 5; index++) await insert(workspaceId, 'backlog-' + index);
    await insert(workspaceId, 'fallback-origin', { origin: 'drill', at: EPOCH - 500 });
    await insert(workspaceId, 'fallback-pre-epoch', { origin: 'drill', at: EPOCH - 1_001 });
    const args = { workspaceId, policy: POLICY, staleBeforeMs: STALE };
    const exact = { ...args, harnessSlug: 'portal', origin: 'scout' };
    const bounded = await readActionableUngradedFilings(db.adminSql, { ...args, harnessSlug: 'portal', limitPerOrigin: 1 });
    expect(bounded.filter(row => row.origin === 'scout')).toHaveLength(1);
    expect(await countActionableUngradedOlderThan(db.adminSql, exact)).toBe(5);
    expect(await countActionableUngradedOutsideScopes(db.adminSql, { ...args, harnessSlugs: [] })).toBe(6);
    expect(await countActionableUngradedOutsideScopes(db.adminSql, { ...args, harnessSlugs: ['portal'] })).toBe(0);
    await db.adminSql`UPDATE harness_shared.scout_routed_ideas SET human_grade = 4
      WHERE workspace_id = ${workspaceId} AND origin = 'scout'`;
    expect(await countActionableUngradedOlderThan(db.adminSql, exact)).toBe(0);
    expect(await countActionableUngradedOlderThan(db.adminSql, { ...args, harnessSlug: 'portal', origin: 'drill' })).toBe(1);
    expect(await countActionableUngradedOlderThan(db.adminSql, args)).toBe(1);
  });
});
