/**
 * package-update.test.ts — the goal-package update story's core
 * (work-on-everything-goal-2026-08-23 P-018).
 */
import { describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import {
  applyGoalPackageUpdate,
  goalPackageUpdateInfo,
  LIVE_CONTRACT_WITHHELD,
  mergeTripwiresPreservingCurrent,
  planGoalPackageUpdate,
  type GoalPackageUpdateDeps,
  type GoalRowForPackageUpdate,
} from './package-update';
import type { LocalGoalPackage } from '../cupboard/goal-package-store';

const mkPkg = (over: Partial<LocalGoalPackage> = {}): LocalGoalPackage => ({
  ref: 'work-on-everything',
  title: 'Work on everything v2',
  body: 'v2 duties',
  standing: true,
  killCriterion: null,
  tripwires: [{ metric: 'usd_spend', label: 'Spend', threshold: 50 }],
  budgetCents: 2500,
  budgetWindowSec: 604_800,
  launchSettings: null,
  inputSchema: null,
  outputSchema: null,
  propertySchema: null,
  description: 'd',
  requiresRubrics: [],
  version: '0.2.0',
  source: 'first-party',
  dir: '/tmp/pkg',
  layer: 'bundled',
  ...over,
});

const mkRow = (over: Partial<GoalRowForPackageUpdate> = {}): GoalRowForPackageUpdate => ({
  id: 'g-1',
  title: 'Work on everything',
  status: 'paused',
  body: 'v1 duties',
  standing: true,
  kill_criterion: null,
  tripwires: null,
  budget_cents: 2500,
  budget_window_sec: 604_800,
  launch_settings: null,
  input_schema: null,
  output_schema: null,
  property_schema: null,
  metadata: { goalPackageRef: 'work-on-everything', packageVersion: '0.1.0' },
  ...over,
});

const sql = null as unknown as Sql;

function mkDeps(o: {
  row?: GoalRowForPackageUpdate | null;
  pkg?: LocalGoalPackage | null;
}): { deps: GoalPackageUpdateDeps; writes: Array<Record<string, unknown> & { kind: string }> } {
  const writes: Array<Record<string, unknown> & { kind: string }> = [];
  return {
    writes,
    deps: {
      resolvePackage: () => (o.pkg === undefined ? mkPkg() : o.pkg),
      readRow: async () => (o.row === undefined ? mkRow() : o.row),
      validatePropertySchema: async () => ({ ok: true }),
      writeStubRefresh: async (_s, w) => {
        writes.push({ kind: 'stub', ...w });
      },
      writeLiveContract: async (_s, w) => {
        writes.push({ kind: 'live', ...w });
      },
    },
  };
}

describe('goalPackageUpdateInfo', () => {
  it('is null for an unpackaged goal and for an unresolvable package', () => {
    expect(goalPackageUpdateInfo({}, () => mkPkg())).toBeNull();
    expect(goalPackageUpdateInfo(null, () => mkPkg())).toBeNull();
    expect(goalPackageUpdateInfo({ goalPackageRef: 'gone' }, () => null)).toBeNull();
  });

  it('offers exactly when the store version is semver-newer', () => {
    const meta = { goalPackageRef: 'work-on-everything', packageVersion: '0.1.0' };
    expect(goalPackageUpdateInfo(meta, () => mkPkg({ version: '0.2.0' }))).toMatchObject({
      ref: 'work-on-everything',
      installedVersion: '0.1.0',
      availableVersion: '0.2.0',
      updateAvailable: true,
      layer: 'bundled',
    });
    expect(
      goalPackageUpdateInfo(meta, () => mkPkg({ version: '0.1.0' }))?.updateAvailable,
    ).toBe(false);
  });

  it('never claims an offer for a version-unstamped legacy instance', () => {
    const info = goalPackageUpdateInfo({ goalPackageRef: 'work-on-everything' }, () => mkPkg());
    expect(info).toMatchObject({ installedVersion: null, updateAvailable: false });
  });
});

describe('mergeTripwiresPreservingCurrent', () => {
  it('carries current readings over by metric; new metrics start unmeasured', () => {
    const merged = mergeTripwiresPreservingCurrent(
      [
        { metric: 'usd_spend', label: 'Spend', threshold: 75 },
        { metric: 'red_hours', label: 'Red', threshold: 4 },
      ],
      [{ metric: 'usd_spend', label: 'Spend', threshold: 50, current: 34.6 }],
    );
    expect(merged).toEqual([
      { metric: 'usd_spend', label: 'Spend', threshold: 75, current: 34.6 },
      { metric: 'red_hours', label: 'Red', threshold: 4, current: null },
    ]);
  });

  it('is null when the new package declares none', () => {
    expect(mergeTripwiresPreservingCurrent(null, [{ metric: 'x', current: 1 }])).toBeNull();
  });
});

describe('planGoalPackageUpdate refusals', () => {
  it('refuses not-found / not-packaged / package-not-found', async () => {
    const a = await planGoalPackageUpdate(sql, { workspaceId: 'w', goalId: 'g-1' }, mkDeps({ row: null }).deps);
    expect(a).toMatchObject({ ok: false, reason: 'not-found' });
    const b = await planGoalPackageUpdate(
      sql,
      { workspaceId: 'w', goalId: 'g-1' },
      mkDeps({ row: mkRow({ metadata: {} }) }).deps,
    );
    expect(b).toMatchObject({ ok: false, reason: 'not-packaged' });
    const c = await planGoalPackageUpdate(sql, { workspaceId: 'w', goalId: 'g-1' }, mkDeps({ pkg: null }).deps);
    expect(c).toMatchObject({ ok: false, reason: 'package-not-found' });
  });

  it('refuses version-unstamped and up-to-date honestly, with both versions named', async () => {
    const unstamped = await planGoalPackageUpdate(
      sql,
      { workspaceId: 'w', goalId: 'g-1' },
      mkDeps({ row: mkRow({ metadata: { goalPackageRef: 'work-on-everything' } }) }).deps,
    );
    expect(unstamped).toMatchObject({ ok: false, reason: 'version-unstamped', toVersion: '0.2.0' });
    const upToDate = await planGoalPackageUpdate(
      sql,
      { workspaceId: 'w', goalId: 'g-1' },
      mkDeps({ pkg: mkPkg({ version: '0.1.0' }) }).deps,
    );
    expect(upToDate).toMatchObject({ ok: false, reason: 'up-to-date', fromVersion: '0.1.0' });
  });

  it('refuses a terminal instance and an uncompilable new contract', async () => {
    const terminal = await planGoalPackageUpdate(
      sql,
      { workspaceId: 'w', goalId: 'g-1' },
      mkDeps({ row: mkRow({ status: 'achieved' }) }).deps,
    );
    expect(terminal).toMatchObject({ ok: false, reason: 'terminal-instance' });
    const broken = await planGoalPackageUpdate(
      sql,
      { workspaceId: 'w', goalId: 'g-1' },
      mkDeps({ pkg: mkPkg({ inputSchema: { type: 'not-a-real-json-schema-type' } }) }).deps,
    );
    expect(broken).toMatchObject({ ok: false, reason: 'contract-problem' });
  });
});

describe('planGoalPackageUpdate modes', () => {
  it('a never-started stub plans a FULL refresh (stub-refresh)', async () => {
    const plan = await planGoalPackageUpdate(
      sql,
      { workspaceId: 'w', goalId: 'g-1' },
      mkDeps({ pkg: mkPkg({ budgetCents: 9_999 }) }).deps,
    );
    expect(plan).toMatchObject({ ok: true, mode: 'stub-refresh', fromVersion: '0.1.0', toVersion: '0.2.0' });
    const fields = plan.ok ? plan.changes.map((c) => c.field) : [];
    expect(fields).toContain('title');
    expect(fields).toContain('body');
    expect(fields).toContain('budgetCents');
  });

  it('a started instance plans CONTRACT fields only, budgets and settings withheld', async () => {
    const started = mkRow({
      status: 'active',
      metadata: {
        goalPackageRef: 'work-on-everything',
        packageVersion: '0.1.0',
        agentOwnerId: 'su-x',
      },
    });
    const plan = await planGoalPackageUpdate(
      sql,
      { workspaceId: 'w', goalId: 'g-1' },
      mkDeps({ row: started, pkg: mkPkg({ budgetCents: 9_999, launchSettings: { holder: {} } }) }).deps,
    );
    expect(plan).toMatchObject({ ok: true, mode: 'live-contract' });
    if (!plan.ok) return;
    const fields = plan.changes.map((c) => c.field);
    // The package's budget/settings DIFFER from the row's — and still must not
    // appear in a live-contract diff: operational tuning is never retuned here.
    expect(fields).not.toContain('budgetCents');
    expect(fields).not.toContain('launchSettings');
    expect(fields).not.toContain('standing');
    expect(fields).toContain('title');
    expect(plan.withheld).toEqual([...LIVE_CONTRACT_WITHHELD]);
  });

  it('a paused-but-previously-started instance is live-contract, not stub-refresh', async () => {
    const pausedStarted = mkRow({
      status: 'paused',
      metadata: {
        goalPackageRef: 'work-on-everything',
        packageVersion: '0.1.0',
        agentOwnerId: 'su-x',
      },
    });
    const plan = await planGoalPackageUpdate(
      sql,
      { workspaceId: 'w', goalId: 'g-1' },
      mkDeps({ row: pausedStarted }).deps,
    );
    expect(plan).toMatchObject({ ok: true, mode: 'live-contract' });
  });
});

describe('applyGoalPackageUpdate', () => {
  it.each(['paused', 'killed'])('preserves paused/killed started lifecycle status without resurrection (%s)', async (status) => {
    const row = mkRow({ status, metadata: { goalPackageRef: 'work-on-everything',
      packageVersion: '0.1.0', agentOwnerId: 'prior-holder' } });
    const before = row.status;
    const { deps, writes } = mkDeps({ row });
    const plan = await planGoalPackageUpdate(sql, { workspaceId: 'w', goalId: 'g-1' }, deps);
    const applied = await applyGoalPackageUpdate(sql, { workspaceId: 'w', goalId: 'g-1' }, deps);
    if (status === 'killed') {
      expect(plan).toMatchObject({ ok: false, reason: 'terminal-instance' });
      expect(applied).toMatchObject({ ok: false, reason: 'terminal-instance' });
      expect(writes).toEqual([]);
    } else {
      expect(plan).toMatchObject({ ok: true, mode: 'live-contract' });
      expect(applied).toMatchObject({ ok: true, mode: 'live-contract' });
      expect(writes).toHaveLength(1);
      expect(writes[0]).not.toHaveProperty('status');
    }
    expect(row.status).toBe(before);
  });

  it.each(['active', 'paused'])('merges package declarations without losing instance keys or owner policy (%s)', async (status) => {
    const worklist = { datatype: 'plan-ref-list', default: [], editable_by: 'both' };
    const instanceOnly = { datatype: 'string', editable_by: 'owner' };
    const declaration = { ...worklist, collection: { source: 'active-workspace-plans',
      policy: 'worklist_policy', order: 'priority', selectable: true, defaultSelected: true } };
    const schema = { worklist: declaration, worklist_policy: { datatype: 'ordered-selection-policy',
      default: { order: [], excluded: [] }, editable_by: 'owner' } };
    const metadata = { goalPackageRef: 'work-on-everything', packageVersion: '0.1.0',
      ...(status === 'active' ? { agentOwnerId: 'su-x' } : {}), marker: { keep: true } };
    const { deps, writes } = mkDeps({ row: mkRow({ status, metadata,
      property_schema: { worklist, instance_only: instanceOnly } }), pkg: mkPkg({ propertySchema: schema }) });
    const plan = await planGoalPackageUpdate(sql, { workspaceId: 'w', goalId: 'g-1' }, deps);
    expect(plan.ok && plan.changes.find((c) => c.field === 'propertySchema')?.to)
      .toEqual({ ...schema, instance_only: instanceOnly });
    expect(writes).toEqual([]);
    const applied = await applyGoalPackageUpdate(sql, { workspaceId: 'w', goalId: 'g-1' }, deps);
    expect(applied.ok && applied.applied).toContain('propertySchema');
    expect(writes[0].propertySchema).toEqual({ ...schema, instance_only: instanceOnly });
    expect(writes[0].metadata).toEqual({ ...metadata, packageVersion: '0.2.0' });
    expect(writes[0]).not.toHaveProperty('properties');
  });

  it('refuses invalid collection declarations and unresolved datatypes before a goal write', async () => {
    const invalid = mkDeps({ pkg: mkPkg({ propertySchema: { list: { datatype: 'string',
      collection: { source: 'manual', policy: 'missing', order: 'priority', selectable: true, defaultSelected: true } } } }) });
    expect(await applyGoalPackageUpdate(sql, { workspaceId: 'w', goalId: 'g-1' }, invalid.deps))
      .toMatchObject({ ok: false, reason: 'contract-problem' });
    expect(invalid.writes).toEqual([]);
    const unknown = mkDeps({ pkg: mkPkg({ propertySchema: { list: { datatype: 'not-installed', editable_by: 'both' } } }) });
    unknown.deps.validatePropertySchema = async () => ({ ok: false, issues: ['unknown datatype'] });
    expect(await applyGoalPackageUpdate(sql, { workspaceId: 'w', goalId: 'g-1' }, unknown.deps))
      .toMatchObject({ ok: false, reason: 'contract-problem', detail: expect.stringContaining('unknown datatype') });
    expect(unknown.writes).toEqual([]);
  });

  it('stub-refresh writes the full package and re-stamps ONLY packageVersion in metadata', async () => {
    const { deps, writes } = mkDeps({
      row: mkRow({ metadata: { goalPackageRef: 'work-on-everything', packageVersion: '0.1.0', pause: { by: 'cupboard:install-goal' } } }),
    });
    const applied = await applyGoalPackageUpdate(sql, { workspaceId: 'w', goalId: 'g-1' }, deps);
    expect(applied).toMatchObject({ ok: true, mode: 'stub-refresh', toVersion: '0.2.0' });
    expect(writes).toHaveLength(1);
    expect(writes[0].kind).toBe('stub');
    const meta = writes[0].metadata as Record<string, unknown>;
    expect(meta.packageVersion).toBe('0.2.0');
    // The pause record and package identity survive the refresh verbatim.
    expect(meta.goalPackageRef).toBe('work-on-everything');
    expect(meta.pause).toEqual({ by: 'cupboard:install-goal' });
    if (applied.ok) expect(applied.applied).toContain('metadata.packageVersion');
  });

  it('live-contract writes merged tripwires (current preserved) and never a budget/settings field', async () => {
    const started = mkRow({
      status: 'active',
      tripwires: [{ metric: 'usd_spend', label: 'Spend', threshold: 50, current: 34.6 }],
      metadata: {
        goalPackageRef: 'work-on-everything',
        packageVersion: '0.1.0',
        agentOwnerId: 'su-x',
      },
    });
    const { deps, writes } = mkDeps({ row: started, pkg: mkPkg({ tripwires: [{ metric: 'usd_spend', label: 'Spend', threshold: 75 }] }) });
    const applied = await applyGoalPackageUpdate(sql, { workspaceId: 'w', goalId: 'g-1' }, deps);
    expect(applied).toMatchObject({ ok: true, mode: 'live-contract' });
    expect(writes).toHaveLength(1);
    expect(writes[0].kind).toBe('live');
    expect(writes[0].tripwires).toEqual([
      { metric: 'usd_spend', label: 'Spend', threshold: 75, current: 34.6 },
    ]);
    const meta = writes[0].metadata as Record<string, unknown>;
    expect(meta.packageVersion).toBe('0.2.0');
    expect(meta.agentOwnerId).toBe('su-x');
  });

  it('passes refusals through without writing', async () => {
    const { deps, writes } = mkDeps({ pkg: mkPkg({ version: '0.1.0' }) });
    const applied = await applyGoalPackageUpdate(sql, { workspaceId: 'w', goalId: 'g-1' }, deps);
    expect(applied).toMatchObject({ ok: false, reason: 'up-to-date' });
    expect(writes).toHaveLength(0);
  });
});
