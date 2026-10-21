/** EI-26582812922777022 — real SQL → notification bridge → cached latest audit.
 * Uses the actual table/function migrations in a private DB. No manual tag bump.
 * The handler's consumer wiring remains covered by plans/get.cache.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import postgres from 'postgres';
import { Cache, InMemoryGenerationStore } from '@papercusp/cache';
import { setFlagOverridesForTest } from '@papercusp/flags/test';
import { createFreshTestDb, type MigratedTestDb } from '@papercusp/test-config/pg';
import { cachedRead, __setCachedReadEnabledForTests } from '../../cache/cached-read';
import { installOperatorCache, resetOperatorCacheForTests } from '../../cache/instance';
import { PgL2Store } from '../../cache/pg-l2-store';
import { installL2StoreForTests, __resetL2StateForTests, setL2EnabledForTests } from '../../cache/l2-tier';
import { _resetReactionsForTests } from '../../events/registry';
import { registerCacheTagEcaRule, _refreshCacheEcaForTests } from '../../events/cache-eca-rule';
import { bridgeTriggerEvent } from '../../sync-sse';
import { TABLE_TO_QUERY_NAMES } from '../table-to-query-names';

const fixture = vi.hoisted(() => ({ sql: null as postgres.Sql | null }));
vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getOrgPg: () => {
    if (!fixture.sql) throw new Error('private audit-notify database is not ready');
    return { sql: fixture.sql };
  },
}));

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');
const SQL_DIR = resolve(ROOT, 'libs/papercusp/libs/db/sql');
const MIGRATION = resolve(SQL_DIR, '1549-plan-audits-change-notify.sql');
const migrationSql = readFileSync(existsSync(MIGRATION) ? MIGRATION : `${MIGRATION}.DRAFT`, 'utf8');

// Derive the trigger-coverage population from the real consumer, so adding a
// tagged table while forgetting the map cannot escape the PG coverage guard.
function planGetCacheTags(): string[] {
  const source = ts.createSourceFile('get.ts', readFileSync(
    resolve(ROOT, 'packages/operator-core/lib/agent-tools/plans/get.ts'), 'utf8',
  ), ts.ScriptTarget.Latest, true);
  const tags: string[] = [];
  let consumers = 0;
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'cachedRead') {
      consumers++;
      const options = node.arguments[1];
      expect(options && ts.isObjectLiteralExpression(options), 'inspect the actual cachedRead options').toBe(true);
      if (options && ts.isObjectLiteralExpression(options)) {
        const property = options.properties.find((p) => ts.isPropertyAssignment(p) && p.name.getText(source) === 'tags');
        expect(property && ts.isPropertyAssignment(property) && ts.isArrayLiteralExpression(property.initializer),
          'dynamic cache tags require extending this coverage guard').toBe(true);
        if (property && ts.isPropertyAssignment(property) && ts.isArrayLiteralExpression(property.initializer)) {
          for (const tag of property.initializer.elements) {
            expect(ts.isStringLiteral(tag), 'table tags must remain enumerable by producer coverage').toBe(true);
            if (ts.isStringLiteral(tag)) tags.push(tag.text);
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  expect(consumers).toBe(1);
  expect(tags).toContain('plan_audits');
  return tags;
}

interface Notification {
  name: string;
  args: Record<string, unknown>;
}
let db: MigratedTestDb;
let sql: postgres.Sql;
let listener: postgres.Sql;
let l2: PgL2Store;
const received: Notification[] = [];
let barrierSeq = 0;
const builds = new Map<string, number>();

async function drainNotifications(): Promise<void> {
  const channel = `audit_barrier_${++barrierSeq}`;
  let delivered!: () => void;
  const barrier = new Promise<void>((resolve) => { delivered = resolve; });
  const subscription = await listener.listen(channel, delivered);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await sql`SELECT pg_notify(${channel}, 'complete')`;
    await Promise.race([barrier, new Promise<never>((_, reject) => {
      timeout = setTimeout(() => reject(new Error('plan audit notification barrier was not delivered')), 5_000);
    })]);
  } finally {
    clearTimeout(timeout);
    await subscription.unlisten();
  }
}

async function appendAudit(workspace: string, sequence: number): Promise<void> {
  await sql`INSERT INTO harness_shared.plan_audits
    (workspace_id, harness_slug, plan_slug, audit_seq, created_by, summary)
    VALUES (${workspace}, 'fixture-harness', 'fixture-plan', ${sequence}, 'fixture-author', ${`audit-${sequence}`})`;
  await drainNotifications();
}

async function readCachedAudit(workspace: string) {
  return cachedRead({ workspaceId: workspace }, {
    tool: 'plans:get', key: { slug: 'fixture-plan' }, tags: planGetCacheTags(),
    softTtlMs: 60_000, hardTtlMs: 120_000, l2: true,
  }, async () => {
    builds.set(workspace, (builds.get(workspace) ?? 0) + 1);
    const [audit] = await sql<{ auditSeq: number; summary: string }[]>`
      SELECT audit_seq AS "auditSeq", summary FROM harness_shared.plan_audits
      WHERE workspace_id = ${workspace} AND plan_slug = 'fixture-plan'
      ORDER BY audit_seq DESC LIMIT 1`;
    return { latestAudit: audit ?? null };
  });
}

beforeAll(async () => {
  db = await createFreshTestDb({ prefix: 'planauditnotify1549' });
  sql = postgres(db.url, { max: 1, onnotice: () => {} });
  fixture.sql = sql;
  await sql`CREATE SCHEMA harness_shared`;
  // Same psql-metacommand stripping as the boot runner, actual L2 table DDL.
  await sql.unsafe(readFileSync(resolve(SQL_DIR, '369-cache-l2-table.sql'), 'utf8')
    .split('\n').filter((line) => !line.trimStart().startsWith('\\')).join('\n'));
  await sql.unsafe(readFileSync(resolve(SQL_DIR, '832-plan-audits.sql'), 'utf8'));
  await sql.unsafe(readFileSync(resolve(SQL_DIR, '1436-emit-change-notify-row-workspace.sql'), 'utf8'));
  // A stale pooled-connection GUC must not route a row's invalidation elsewhere.
  await sql`SELECT set_config('app.workspace_id', 'other-workspace', false)`;
  _resetReactionsForTests();
  setFlagOverridesForTest({ 'papercusp-cache-tag-eca': true, 'papercusp-cache-layer': true });
  await _refreshCacheEcaForTests();
  registerCacheTagEcaRule();
  installOperatorCache(new Cache({ generationStore: new InMemoryGenerationStore() }));
  l2 = new PgL2Store();
  installL2StoreForTests(l2);
  setL2EnabledForTests(true);
  __setCachedReadEnabledForTests(true);
  listener = postgres(db.url, { max: 1, onnotice: () => {} });
  await listener.listen('sync_invalidate', (payload) => {
    const event = JSON.parse(payload) as Notification;
    received.push(event);
    bridgeTriggerEvent(event.name, event.args);
  });
}, 120_000);

afterAll(async () => {
  await listener?.end({ timeout: 5 });
  __setCachedReadEnabledForTests(false);
  __resetL2StateForTests();
  resetOperatorCacheForTests();
  _resetReactionsForTests();
  setFlagOverridesForTest(null);
  await sql?.end({ timeout: 5 });
  await db?.drop();
});

describe('plan audit notification producer and cache coverage', () => {
  it('includes every plans:get table tag in the real-migration trigger coverage population', () => {
    for (const tag of planGetCacheTags()) {
      expect(Object.hasOwn(TABLE_TO_QUERY_NAMES, `harness_shared.${tag}`), `${tag} must be checked for a producer`).toBe(true);
    }
  });

  it('reproduces stale audit reads without the producer, then refreshes through raw writes in the row workspace', async () => {
    await appendAudit('audit-workspace', 1);
    await appendAudit('other-workspace', 1);
    expect((await readCachedAudit('audit-workspace')).latestAudit?.auditSeq).toBe(1);
    expect((await readCachedAudit('other-workspace')).latestAudit?.auditSeq).toBe(1);
    await appendAudit('audit-workspace', 2);
    expect(received).toEqual([]);
    expect((await readCachedAudit('audit-workspace')).latestAudit?.auditSeq).toBe(1);
    expect(builds.get('audit-workspace')).toBe(1);
    const cacheKey = 'plans:get|{"slug":"fixture-plan"}';
    expect((await l2.get<{ latestAudit: { auditSeq: number } }>('audit-workspace', cacheKey))?.value.latestAudit.auditSeq).toBe(1);

    await sql.unsafe(migrationSql);
    await sql.unsafe(migrationSql);
    const [shape] = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
      WHERE t.tgrelid = 'harness_shared.plan_audits'::regclass
        AND NOT t.tgisinternal AND t.tgenabled <> 'D' AND p.proname = 'emit_change_notify'`;
    expect(shape?.count).toBe(1);

    await appendAudit('audit-workspace', 3);
    await expect.poll(() => l2.get('audit-workspace', cacheKey)).toBeUndefined();
    await expect.poll(async () => (await readCachedAudit('audit-workspace')).latestAudit?.auditSeq).toBe(3);
    await sql`UPDATE harness_shared.plan_audits SET summary = 'revised'
      WHERE workspace_id = 'audit-workspace' AND audit_seq = 3`;
    await drainNotifications();
    await expect.poll(() => l2.get('audit-workspace', cacheKey)).toBeUndefined();
    await expect.poll(async () => (await readCachedAudit('audit-workspace')).latestAudit?.summary).toBe('revised');
    await sql`DELETE FROM harness_shared.plan_audits WHERE workspace_id = 'audit-workspace' AND audit_seq = 3`;
    await drainNotifications();
    await expect.poll(() => l2.get('audit-workspace', cacheKey)).toBeUndefined();
    await expect.poll(async () => (await readCachedAudit('audit-workspace')).latestAudit?.auditSeq).toBe(2);
    expect((await readCachedAudit('other-workspace')).latestAudit?.auditSeq).toBe(1);
    expect(builds.get('other-workspace')).toBe(1);
    expect(received.map((event) => ({ name: event.name, ...event.args }))).toEqual(
      ['INSERT', 'UPDATE', 'DELETE'].map((op) => ({
        name: 'harness_shared.plan_audits.changed', op, workspace_id: 'audit-workspace',
        id: null, plan_slug: 'fixture-plan', harness_slug: 'fixture-harness',
      })),
    );
    expect(bridgeTriggerEvent(received[0]!.name, received[0]!.args)).toContainEqual({
      name: 'plans.get', args: { slug: 'fixture-plan' },
    });
  });
});
