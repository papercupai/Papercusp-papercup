import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { putLocalRule, getLocalRule, listLocalRules, recordLocalRuleTest, setLocalRuleEnabled, deleteLocalRule, localRulePackage, validateLocalRule } from './local-rule-store';

let db: OrgTestDb;
const scope = { workspaceId: 'ws-local-rules', potSlug: 'demo' };
const definition = (id: string) => ({ schemaVersion: 1, id, title: id, description: 'Local rule fixture',
  version: '1.0.0', delivery: 'async', on: 'tasks:create', fire: 'class:demo.tasks@1.0.0#create', args: { title: 'followup' } });
beforeAll(async () => {
  db = await createOrgTestDb();
  // Apply the shipped additive migration in an isolated database.
  const sql = await readFile(new URL('../../../../libs/papercusp/libs/db/sql/1521-locally-authored-rules.sql', import.meta.url), 'utf8');
  await db.adminSql.unsafe(sql);
}, 180_000);
afterAll(async () => { await db?.cleanup(); });

describe('durable locally authored rules', () => {
  it('persists across a fresh module read and refuses enable before a nonempty passing replay', async () => {
    const created = await putLocalRule({ ...scope, authorId: 'author', definition: definition('persist') }, db.adminSql);
    expect(created).toMatchObject({ enabled: false, revision: 1, testedRevision: null });
    await expect(setLocalRuleEnabled(scope, created.id, true, db.adminSql)).rejects.toThrow('untested_revision');
    await expect(recordLocalRuleTest(scope, created.id, 1, { passed: true, samples: 0 }, db.adminSql)).rejects.toThrow('requires_samples');
    await recordLocalRuleTest(scope, created.id, 1, { passed: true, samples: 2, matches: 1 }, db.adminSql);
    await setLocalRuleEnabled(scope, created.id, true, db.adminSql);
    vi.resetModules();
    const reloaded = await import('./local-rule-store');
    expect(await reloaded.getLocalRule(scope, created.id, db.adminSql)).toMatchObject({ enabled: true, testedRevision: 1, authorId: 'author' });
    expect((await reloaded.listLocalRules(scope, { enabledOnly: true }, db.adminSql)).some((r) => r.id === created.id)).toBe(true);
  });
  it('edits atomically invalidate enable and cannot accept a stale replay receipt', async () => {
    const d = definition('revision');
    await putLocalRule({ ...scope, authorId: 'author', definition: d }, db.adminSql);
    await recordLocalRuleTest(scope, d.id, 1, { passed: true, samples: 1 }, db.adminSql);
    await setLocalRuleEnabled(scope, d.id, true, db.adminSql);
    await expect(putLocalRule({ ...scope, authorId: 'other', definition: d, expectedRevision: 1 }, db.adminSql)).rejects.toThrow('author_changed');
    expect(await putLocalRule({ ...scope, authorId: 'author', definition: { ...d, title: 'changed' }, expectedRevision: 1 }, db.adminSql))
      .toMatchObject({ enabled: false, revision: 2, testedRevision: null, testReceipt: null });
    await expect(recordLocalRuleTest(scope, d.id, 1, { passed: true, samples: 1 }, db.adminSql)).rejects.toThrow('revision_changed');
    await expect(setLocalRuleEnabled(scope, d.id, true, db.adminSql)).rejects.toThrow('untested_revision');
    await recordLocalRuleTest(scope, d.id, 2, { passed: false, samples: 1 }, db.adminSql);
    await expect(setLocalRuleEnabled(scope, d.id, true, db.adminSql)).rejects.toThrow('untested_revision');
  });
  it('separates workspaces and pots; workspace-wide rules are included only explicitly', async () => {
    const d = definition('scoped');
    await putLocalRule({ ...scope, authorId: 'a', definition: d }, db.adminSql);
    await putLocalRule({ workspaceId: scope.workspaceId, authorId: 'b', definition: d }, db.adminSql);
    await putLocalRule({ workspaceId: 'other', potSlug: scope.potSlug, authorId: 'c', definition: d }, db.adminSql);
    expect(await getLocalRule({ ...scope, potSlug: 'absent' }, d.id, db.adminSql)).toBeNull();
    expect((await listLocalRules(scope, { includeWorkspace: true }, db.adminSql)).filter((r) => r.id === d.id)).toHaveLength(2);
    expect((await listLocalRules(scope, {}, db.adminSql)).filter((r) => r.id === d.id)).toHaveLength(1);
    expect(await deleteLocalRule({ ...scope, workspaceId: 'absent' }, d.id, db.adminSql)).toBe(false);
    expect(await deleteLocalRule(scope, d.id, db.adminSql)).toBe(true);
    expect(await getLocalRule({ workspaceId: 'other', potSlug: scope.potSlug }, d.id, db.adminSql)).not.toBeNull();
  });
  it('enforces workspace isolation through the app-role connection', async () => {
    const d = definition('rls');
    await putLocalRule({ ...scope, authorId: 'author', definition: d }, db.adminSql);
    await db.appSql.begin(async (tx) => {
      await tx.unsafe("SELECT set_config('app.workspace_id',$1,true)", [scope.workspaceId]);
      expect(await getLocalRule(scope, d.id, tx)).not.toBeNull();
      expect(await getLocalRule({ ...scope, workspaceId: 'other' }, 'scoped', tx)).toBeNull();
    });
    // PostgreSQL also reports the aborted transaction at settlement; assert the full transaction.
    await expect(db.appSql.begin(async (tx) => {
      await tx.unsafe("SELECT set_config('app.workspace_id',$1,true)", [scope.workspaceId]);
      await putLocalRule({ ...scope, workspaceId: 'other', authorId: 'author', definition: definition('rls-denied') }, tx);
    })).rejects.toThrow(/row-level security/);
  });
  it('collapses racing creates to one author and prevents enable without a tested revision at the DB boundary', async () => {
    const d = definition('raced');
    const r = await Promise.allSettled(['a', 'b'].map((authorId) => putLocalRule({ ...scope, authorId, definition: d }, db.adminSql)));
    expect(r.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    expect(r.filter((x) => x.status === 'rejected')).toHaveLength(1);
    await expect(db.adminSql.unsafe("UPDATE harness_shared.local_rules SET enabled=true, test_receipt='{}'::jsonb WHERE workspace_id=$1 AND pot_slug=$2 AND rule_id=$3",
      [scope.workspaceId, scope.potSlug, d.id])).rejects.toThrow();
  });
  it('uses the portable grammar, keeps recovery callable, and exports no local authority or enable receipt', async () => {
    const d = definition('exported');
    const row = await putLocalRule({ ...scope, authorId: 'author', definition: d }, db.adminSql);
    expect(localRulePackage(row)).toEqual(d);
    const guard = { schemaVersion: 1, id: 'guard', title: 'Guard', description: 'Guard fixture', version: '1',
      delivery: 'sync', sink: 'pre-tool', guard: { deny: { 'input.command': { equals: 'git push' } } } };
    expect(() => validateLocalRule(guard)).toThrow('rule_lockout');
    expect(() => validateLocalRule({ ...guard, tools: ['r*'] })).toThrow('rule_lockout');
    expect(validateLocalRule({ ...guard, tools: ['capability:*'] })).toMatchObject({ delivery: 'sync' });
    expect(() => validateLocalRule({ ...d, capabilities: ['*'] })).toThrow('invalid_rule');
  });
});
