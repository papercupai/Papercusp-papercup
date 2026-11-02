import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import type { OrgTestDb } from '../test/_org-test-db';
import type { SessionUser } from './auth';
import type { ScheduleInventoryRow } from './schedule-inventory';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql, rows: [] as ScheduleInventoryRow[] }));
vi.mock('@papercusp/db-org', async orig => ({
  ...await orig<typeof import('@papercusp/db-org')>(), getOrgPg: () => ({ sql: h.sql }),
}));
vi.mock('./workspace-registry', () => ({ activeWorkspaceId: () => 'startup-policy-test' }));
vi.mock('./sync-sse', () => ({ notifySyncInvalidate: vi.fn(async () => {}) }));
vi.mock('./schedule-inventory', async orig => ({
  ...await orig<typeof import('./schedule-inventory')>(), collectScheduleInventory: vi.fn(async () => h.rows),
}));

import { createOrgTestDb } from '../test/_org-test-db';
import { setFeatureBackgroundActivityPolicy, workspaceBackgroundActivityAllowed } from './device-operator-actions';
import { readStartupActivityHistory, recordStartupActivityHistory } from './startup-activity';
import { readOperatorState, updateOperatorState, writeOperatorState } from './operator-state-pg';
import { startupActivityFeatureId } from './schedule-inventory';
import { notifySyncInvalidate } from './sync-sse';
import { registerSystemAction } from './harness/routines/system-actions';

const workspace = 'startup-policy-test';
const user: SessionUser = { id: '03ffddab-83cb-44a2-93e5-d16429c72a2f', username: 'private-user',
  display_name: 'Private', has_password: false, workspace_id: workspace, capabilities: ['*'] };
const registration = { source: 'routines', installSlug: 'test', name: 'optional-startup-test',
  armed: true, detail: { targetRole: 'system:startup-test-optional' } } as ScheduleInventoryRow;
const featureId = startupActivityFeatureId(registration, { workspaceId: workspace });
const change = (automatic = false, revision = 0, principal = user) =>
  setFeatureBackgroundActivityPolicy(featureId, { action: 'automatic', automatic }, revision, principal);
let db: OrgTestDb;

beforeAll(async () => { db = await createOrgTestDb(); h.sql = db.adminSql; }, 180_000);
afterAll(async () => { await db?.cleanup(); });
beforeEach(async () => {
  await db.adminSql`DELETE FROM harness_shared.operator_paused`;
  await db.adminSql`DELETE FROM harness_shared.audit_log WHERE action = 'background-activity'`;
  h.rows = [registration];
  vi.clearAllMocks();
});

describe('scoped startup policy and atomic history (real PostgreSQL)', () => {
  it('commits a feature disable and redacted before/after history together', async () => {
    const policy = await change();
    expect(policy).toMatchObject({ automatic: false, revision: 1 });
    await expect(workspaceBackgroundActivityAllowed(workspace, featureId)).resolves.toBe(false);
    const history = await readStartupActivityHistory([featureId]);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ featureId, operation: 'policy-change', status: 'completed',
      previous: { automatic: true, revision: 0 }, resulting: { automatic: false, revision: 1 },
      source: 'settings', trigger: 'settings', reason: 'user-choice' });
    expect(history[0]!.actor).toMatch(/^user:[a-f0-9]{64}$/);
    expect(JSON.stringify(history)).not.toMatch(/private-user|03ffddab/);
  });

  it('rolls back a policy change when the audit insert fails, without notifying success', async () => {
    await db.adminSql`ALTER TABLE harness_shared.audit_log ADD CONSTRAINT startup_test_audit_failure
      CHECK (action <> 'background-activity') NOT VALID`;
    try {
      await expect(change()).rejects.toThrow();
      expect(await db.adminSql`SELECT payload FROM harness_shared.operator_paused`).toHaveLength(0);
      expect(await readStartupActivityHistory([featureId])).toEqual([]);
      expect(notifySyncInvalidate).not.toHaveBeenCalled();
    } finally { await db.adminSql`ALTER TABLE harness_shared.audit_log DROP CONSTRAINT startup_test_audit_failure`; }
  });

  it('rolls back an inserted history row when a later transaction step fails', async () => {
    await expect(updateOperatorState('operator_paused', {}, () => ({ paused: true }), workspace, async (tx) => {
      await recordStartupActivityHistory({ featureId, operation: 'pause', status: 'completed',
        at: new Date().toISOString(), actor: 'user', trigger: 'settings', source: 'settings', reason: 'user-choice',
        previous: null, resulting: null }, user.id, 'user', { sql: tx, workspaceId: workspace });
      throw new Error('later companion failed');
    })).rejects.toThrow('later companion failed');
    expect(await db.adminSql`SELECT payload FROM harness_shared.operator_paused`).toHaveLength(0);
    expect(await readStartupActivityHistory([featureId])).toEqual([]);
    expect(notifySyncInvalidate).not.toHaveBeenCalled();
  });

  it('serializes concurrent first writers; a stale revision cannot overwrite the winner', async () => {
    const results = await Promise.allSettled([change(false), change(true)]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    expect(await readStartupActivityHistory([featureId])).toHaveLength(1);
    expect(await readOperatorState('operator_paused', workspace, { fresh: true })).toMatchObject({
      backgroundActivity: { revision: 1 },
    });
  });

  it('preserves a newer disable across stale resume and expired feature pause', async () => {
    await change(false);
    await expect(setFeatureBackgroundActivityPolicy(featureId, { action: 'resume' }, 0, user))
      .rejects.toMatchObject({ code: 'startup_policy_conflict' });
    await setFeatureBackgroundActivityPolicy(featureId, { action: 'pause', until: new Date(Date.now() + 60_000).toISOString() }, 1, user);
    await setFeatureBackgroundActivityPolicy(featureId, { action: 'resume' }, 2, user);
    await expect(workspaceBackgroundActivityAllowed(workspace, featureId)).resolves.toBe(false);
    expect(await readStartupActivityHistory([featureId])).toHaveLength(3);
  });

  it('preserves unknown stored fields while stripping them from responses and audit', async () => {
    const root = { paused: true, privateRoot: 'secret-root', backgroundActivity: {
      version: 1, revision: 4, automatic: false, pausedUntil: null, futurePolicy: 'secret-policy', features: {
        [featureId]: { automatic: true, paused: true, pausedUntil: null, revision: 4, futureFeature: 'secret-feature' },
      },
    } };
    await writeOperatorState('operator_paused', root, workspace);
    const result = await change(false, 4);
    const stored = await readOperatorState('operator_paused', workspace, { fresh: true });
    expect(stored).toMatchObject({ privateRoot: 'secret-root', paused: true,
      backgroundActivity: { automatic: false, futurePolicy: 'secret-policy', features: {
        [featureId]: { automatic: false, paused: true, futureFeature: 'secret-feature' },
      } } });
    expect(JSON.stringify([result, await readStartupActivityHistory([featureId])])).not.toMatch(/secret|future/);
  });

  it.each([
    { ...user, workspace_id: 'another-workspace' }, { ...user, capabilities: [] },
    { ...user, capabilities: ['workspace:view'] }, { ...user, id: '' },
  ])('denies an unauthorized session before looking up registrations or writing', async principal => {
    await expect(change(false, 0, principal)).rejects.toMatchObject({ code: 'startup_policy_forbidden' });
    const { collectScheduleInventory } = await import('./schedule-inventory');
    expect(collectScheduleInventory).not.toHaveBeenCalled();
    expect(await db.adminSql`SELECT payload FROM harness_shared.operator_paused`).toHaveLength(0);
  });

  it('accepts existing workspace:operate authority without the local wildcard', async () => {
    await expect(change(false, 0, { ...user, capabilities: ['workspace:operate'] })).resolves.toMatchObject({ revision: 1 });
  });

  it('refuses an orphan, a required recovery action, a device, and a foreign managed binding', async () => {
    h.rows = [];
    await expect(change()).rejects.toMatchObject({ code: 'startup_policy_forbidden' });
    registerSystemAction('startup-test-required', async () => {}, { requiredForControl: 'Keeps settings reachable' });
    h.rows = [{ ...registration, detail: { targetRole: 'system:startup-test-required' } }];
    await expect(change()).rejects.toMatchObject({ code: 'startup_policy_forbidden' });
    h.rows = [{ ...registration, source: 'managed', detail: {} }];
    let id = startupActivityFeatureId(h.rows[0]!, { workspaceId: workspace });
    await expect(setFeatureBackgroundActivityPolicy(id, { action: 'resume' }, 0, user)).rejects.toMatchObject({ code: 'startup_policy_forbidden' });
    h.rows = [{ ...registration, source: 'managed', detail: { activity: {
      kind: 'workspace', workspaceId: 'another-workspace', featureId,
    } } }];
    await expect(change()).rejects.toMatchObject({ code: 'startup_policy_forbidden' });
    expect(await readStartupActivityHistory([featureId])).toEqual([]);
  });

  it('rejects invalid changes and newer saved formats without changing state or history', async () => {
    await expect(setFeatureBackgroundActivityPolicy(featureId, { action: 'pause', until: '2000-01-01T00:00:00Z' }, 0, user))
      .rejects.toMatchObject({ code: 'startup_policy_invalid' });
    await writeOperatorState('operator_paused', { backgroundActivity: { version: 2, future: 'preserve' } }, workspace);
    await expect(change()).rejects.toThrow();
    expect(await readOperatorState('operator_paused', workspace, { fresh: true })).toEqual({ backgroundActivity: { version: 2, future: 'preserve' } });
    expect(await readStartupActivityHistory([featureId])).toEqual([]);
  });
});
