import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { FLAGS } from '@papercusp/flags';
import type { FlagAttestation } from '@papercusp/flags/server';
import { teardownTestPg } from '@papercusp/test-config/pg';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { readDreamControlObservations } from './dream-control-observations';

const now = Date.parse('2026-10-17T12:00:00Z');
const runtime = { host: 'test-observation-runtime', processId: 'test-process', buildSha: 'test-loaded-source' };
const scope = { workspaceId: 'observation-test', potSlug: 'pot-a', since: '2026-10-16T12:00:00Z',
  until: '2026-10-17T12:00:00Z', expectedRuntime: runtime };
const flag = (key: FlagAttestation['key']): FlagAttestation => ({ key, resolvedValue: true, compiledDefault: true,
  source: 'env-override', observedAtMs: now, backendConfigured: false,
  overrideRead: { kind: 'not-read', storeConfigured: false, cacheKey: 'test', cacheGeneration: null,
    cacheLoadedAtMs: null, cacheAgeMs: null, ttlMs: 5000, ttlRemainingMs: 0, loadError: null } });
const deps = { workspace: () => scope.workspaceId, now: () => now, runtime: () => runtime,
  flags: async () => ({ dream: flag(FLAGS.DREAM_CYCLE), learningGovernor: flag(FLAGS.LEARNING_GOVERNOR) }) };

describe('loaded-control observations against real PostgreSQL', () => {
  let db: OrgTestDb;
  beforeAll(async () => {
    db = await createOrgTestDb();
    for (const mode of ['manual', 'auto']) await db.adminSql`
      INSERT INTO harness_shared.routines (id, workspace_id, install_slug, name, trigger_kind, trigger_config,
        target_role, payload_template, concurrency, catchup, active, next_fire_at)
      VALUES (${`observe-${mode}`}, ${scope.workspaceId}, ${scope.potSlug}, ${`dream-cycle-${mode}`}, 'cron',
        '{"cron":"0 */17 * * * *"}'::jsonb, 'system:dream-cycle', ${JSON.stringify({ mode })}::jsonb,
        'skip', 'skip-old', false, now())`;
    await db.adminSql`INSERT INTO harness_shared.gym_autoloop_config
      (workspace_id, harness_slug, enabled, budget_usd, spent_usd, status, updated_at)
      VALUES (${scope.workspaceId}, ${scope.potSlug}, true, NULL, 0, 'idle', ${now})`;
    for (const prefix of ['dream', 'gym', 'blender']) await db.adminSql`
      INSERT INTO harness_shared.learning_governor_loops
        (workspace_id, loop_id, pot_slug, display_name, budget_kind, budget_usd, spent_usd, enabled, enforcement)
      VALUES (${scope.workspaceId}, ${`${prefix}:${scope.potSlug}`}, ${scope.potSlug}, 'observation-test', 'per-cycle', 1, 0, true, 'native')`;
    // A positive row at @singleton belongs to this POT. Wrong-workspace,
    // wrong-pot and su-ideate rows deliberately share the same timestamp.
    for (const [workspace, pot, install, origin] of [
      [scope.workspaceId, scope.potSlug, '@singleton', 'scout'],
      ['wrong-workspace', scope.potSlug, '@singleton', 'scout'],
      [scope.workspaceId, 'wrong-pot', scope.potSlug, 'scout'],
      [scope.workspaceId, scope.potSlug, '@singleton', 'su-ideate'],
    ]) await db.adminSql`INSERT INTO harness_shared.scout_ticks
      (workspace_id, pot_slug, install_slug, tick_at, origin, status, ideas_routed, budget_used_usd, detail)
      VALUES (${workspace}, ${pot}, ${install}, ${scope.since}::timestamptz, ${origin}, 'ran', 0, 0.12,
        '{"ideators":[{"lens":"analogical","ok":true,"raw":0,"produced":0}]}'::jsonb)`;
  }, 180_000);
  afterAll(async () => { await db?.cleanup(); if (!process.env.KEEP_TEST_PG) await teardownTestPg(); });

  it('runs in a READ ONLY transaction, preserving controls and the exact scoped zero-route row', async () => {
    const before = await db.adminSql`SELECT active, payload_template FROM harness_shared.routines
      WHERE workspace_id = ${scope.workspaceId} ORDER BY id`;
    const value = await db.adminSql.begin('READ ONLY', tx => readDreamControlObservations(tx as unknown as Sql, scope, deps));
    expect(value.status).toBe('observed');
    expect(value.observations?.gym).toMatchObject({ status: 'observed', value: {
      autoloop: { budgetUsd: null }, nativeBudgetEligible: false, cycleHardCapUsd: null,
    } });
    expect(value.observations?.activity).toMatchObject({ status: 'observed', value: { scout: {
      rows: [expect.objectContaining({ workspace_id: scope.workspaceId, pot_slug: scope.potSlug, install_slug: '@singleton', origin: 'scout' })],
      observations: [expect.objectContaining({ ideatorCount: 1, lenses: ['analogical'], ideasRouted: 0, costUsd: 0.12, oneIdeatorZeroRoute: true })],
    } } });
    if (value.observations?.activity.status === 'observed') expect(value.observations.activity.value.scout.rows).toHaveLength(1);
    expect(await db.adminSql`SELECT active, payload_template FROM harness_shared.routines
      WHERE workspace_id = ${scope.workspaceId} ORDER BY id`).toEqual(before);
  });

  it('does not materialize missing controls during a read', async () => {
    const missing = { ...scope, potSlug: 'unprovisioned' };
    const value = await db.adminSql.begin('READ ONLY', tx => readDreamControlObservations(tx as unknown as Sql, missing, deps));
    expect(value.status).toBe('unknown');
    expect(value.observations?.dream.status).toBe('unknown');
    expect(await db.adminSql`SELECT id FROM harness_shared.routines
      WHERE workspace_id = ${scope.workspaceId} AND install_slug = 'unprovisioned'`).toHaveLength(0);
  });
});
