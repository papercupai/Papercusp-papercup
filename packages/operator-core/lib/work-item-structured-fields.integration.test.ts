/** P-022 / R-13: structured work definitions roundtrip through real Postgres. */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyEventSubstrateMigrationsForTest, createFreshPgDb, type FreshPgDb } from '../test/_pg-helpers';
import { DISCLOSURE_LEDGER_FIXTURE_DDL } from '../test/_disclosure-ledger-fixture';
import { HARNESS_FEATURES_CONSOLIDATED_DDL, USER_TRUST_LIST_DDL, WORK_ADMISSIONS_MIN_DDL,
  WORK_ITEM_DEPS_DDL, applyClaimPathReadDeps } from '../test/_work-items-schema';
import { ensureCoordCapabilityTables } from '@papercusp/coordination/capabilities';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async (orig) => ({
  ...(await orig<typeof import('@papercusp/db-org')>()), getOrgPg: () => ({ sql: h.sql }),
}));
vi.mock('./workspace-registry', async (orig) => ({
  ...(await orig<typeof import('./workspace-registry')>()), activeWorkspaceId: () => 'default',
}));
vi.mock('./harness-core', async (orig) => ({
  ...(await orig<typeof import('./harness-core')>()),
  resolveProject: async (slug: string) => ({ slug, path: `/tmp/${slug}` }),
}));
vi.mock('./hive-federation', async (orig) => ({
  ...(await orig<typeof import('./hive-federation')>()),
  potHomeSlugForHarness: async (_ws: string, slug: string) => slug,
}));
vi.mock('./memory/recall-stats', async (orig) => ({
  ...(await orig<typeof import('./memory/recall-stats')>()), recordRecallStats: async () => {},
}));
vi.mock('./blueprint/operation-worker-binding', async (orig) => ({
  ...(await orig<typeof import('./blueprint/operation-worker-binding')>()),
  readActiveOperationWorkerClaimBinding: async () => ({ status: 'none' as const }),
}));

const { default: createTool } = await import('./agent-tools/work_items/create');
const { default: updateTool } = await import('./agent-tools/work_items/update');
const { getWorkItem } = await import('./work-items');
const CTX = { isSuperuser: true, uiClientId: 'su-work-definition', workspaceId: 'default' } as never;
const definition = {
  acceptanceCriteria: ['Fields survive a database roundtrip'],
  scope: { inScope: ['create, update and read'], outOfScope: ['body-heading migration'] },
  verificationTarget: { target: 'isolated Postgres', verifiedHow: 'integration' },
  firstUnit: 'create one item with a conflicting body',
};

async function call(tool: { handler: (a: never, c: never) => Promise<unknown> }, args: Record<string, unknown>) {
  const result = await tool.handler(args as never, CTX) as { data?: Record<string, unknown>; content?: { text: string }[] };
  const data = result.data ?? (result.content?.[0]?.text ? JSON.parse(result.content[0].text) : result);
  return data as { results: { ok: boolean; id: string; error?: string; workItem?: { id: string } }[] };
}

let db: FreshPgDb;
beforeAll(async () => {
  db = await createFreshPgDb('work-item-fields');
  h.sql = db.sql;
  const sqlDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../../libs/papercusp/libs/db/sql');
  const migration = (name: string) => readFileSync(resolve(sqlDir, name), 'utf8').split('\n')
    .filter((line) => !/^\s*\\/.test(line) && !/\bGRANT\b/.test(line) && !/^\s*(BEGIN|COMMIT);\s*$/.test(line)).join('\n');
  await ensureCoordCapabilityTables(db.sql);
  for (const name of ['500-agent-modes.sql', '767-agent-modes-subject.sql', '1032-agent-mode-goal-holder-election.sql']) {
    await db.sql.unsafe(migration(name)).simple();
  }
  await applyEventSubstrateMigrationsForTest(db.sql, { label: 'work-item-fields.integration.test.ts' });
  await db.sql.unsafe(HARNESS_FEATURES_CONSOLIDATED_DDL);
  await db.sql.unsafe(migration('831-issue-occurrence-ledger.sql')).simple();
  await db.sql.unsafe(WORK_ADMISSIONS_MIN_DDL);
  await db.sql.unsafe(migration('140-plan-item-assignments.sql')).simple();
  await db.sql.unsafe(USER_TRUST_LIST_DDL);
  await applyClaimPathReadDeps((ddl) => db.sql.unsafe(ddl).simple());
  await db.sql.unsafe(DISCLOSURE_LEDGER_FIXTURE_DDL);
  await db.sql.unsafe(WORK_ITEM_DEPS_DDL);
}, 90_000);
afterAll(async () => { await db?.cleanup(); });
beforeEach(async () => {
  await db.sql`TRUNCATE harness_shared.work_items, harness_shared.work_item_deps RESTART IDENTITY CASCADE`;
});

describe('structured work-item fields (P-022)', () => {
  it.each(['feature', 'bug'])('creates, reads, replaces and clears %s definitions without parsing prose', async (kind) => {
    const created = await call(createTool, { kind, title: `structured ${kind}`, harness: 'papercup',
      force: true, definition, body: '## Acceptance criteria\nThis body contradicts the structured field.' });
    expect(created.results[0]?.ok, JSON.stringify(created)).toBe(true);
    const id = created.results[0]!.workItem!.id;
    expect((await getWorkItem(id, 'papercup'))?.definition).toEqual(definition);
    const replacement = { acceptanceCriteria: ['Replacement only'] };
    const updated = await call(updateTool, { id, harness: 'papercup', definition: replacement });
    expect(updated.results[0]?.ok, JSON.stringify(updated)).toBe(true);
    expect((await getWorkItem(id, 'papercup'))?.definition).toEqual(replacement);
    const bulk = await call(updateTool, { harness: 'papercup', definition,
      items: [{ id, definition: { firstUnit: 'bulk item override' } }] });
    expect(bulk.results[0]?.ok, JSON.stringify(bulk)).toBe(true);
    expect((await getWorkItem(id, 'papercup'))?.definition).toEqual({ firstUnit: 'bulk item override' });
    expect((await call(updateTool, { harness: 'papercup', definition,
      items: [{ id, definition: null }] })).results[0]?.ok).toBe(true);
    expect((await getWorkItem(id, 'papercup'))?.definition).toBeNull();
  });

  it('never derives acceptance criteria from a legacy body', async () => {
    const created = await call(createTool, { kind: 'feature', title: 'body-only acceptance', harness: 'papercup',
      body: '## Acceptance criteria\nLooks structured, but is only prose.' });
    expect(created.results[0]?.ok, JSON.stringify(created)).toBe(true);
    expect((await getWorkItem(created.results[0]!.workItem!.id, 'papercup'))?.definition).toBeNull();
  });

  it('refuses malformed create input and reserved-payload/mixed updates without changing saved fields', async () => {
    const bad = await call(createTool, { kind: 'feature', title: 'bad definition', harness: 'papercup', definition: { acceptanceCriteria: [] } });
    expect(bad.results[0]).toMatchObject({ ok: false, error: 'invalid_definition' });
    const created = await call(createTool, { kind: 'feature', title: 'guarded definition', harness: 'papercup', definition });
    const id = created.results[0]!.workItem!.id;
    for (const patch of [{ payload: { workDefinition: { firstUnit: 'bypass' } } },
      { definition: { firstUnit: 'partial' }, title: 'mixed edit' }]) {
      expect((await call(updateTool, { id, harness: 'papercup', ...patch })).results[0]?.ok).toBe(false);
      expect((await getWorkItem(id, 'papercup'))?.definition).toEqual(definition);
    }
  });
});
