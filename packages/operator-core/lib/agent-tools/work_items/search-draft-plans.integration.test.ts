import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { OrgTestDb } from '../../../test/_org-test-db';
import { createOrgTestDb } from '../../../test/_org-test-db';

const h = vi.hoisted(() => ({ sql: null as unknown, ws: 'draft-discovery-test' }));
vi.mock('@papercusp/db-org', async original => ({
  ...await original<typeof import('@papercusp/db-org')>(), getOrgPg: () => ({ sql: h.sql }),
}));
vi.mock('../../workspace-registry', async original => ({
  ...await original<typeof import('../../workspace-registry')>(), activeWorkspaceId: () => h.ws,
}));
import search from './search';

describe('work discovery includes draft plan items', () => {
  let db: OrgTestDb;
  beforeAll(async () => {
    db = await createOrgTestDb();
    h.sql = db.adminSql;
    for (const [ws, harness, slug, status, archived] of [
      [h.ws, 'pot-a', 'optional-evaluations', 'draft', false],
      [h.ws, 'pot-a', 'already-active', 'active', false],
      [h.ws, 'pot-a', 'old-draft', 'draft', true],
      [h.ws, 'pot-b', 'other-harness', 'draft', false],
      ['foreign-workspace', 'pot-a', 'other-workspace', 'draft', false],
    ] as const) {
      const text = 'Evaluate spectraclone duplicate mechanism discovery';
      const items = [{ id: 'P-005', status: 'todo', text, importance: 'low', blockedBy: [], decisionRefs: [], phase: null }];
      await db.adminSql`INSERT INTO harness_shared.harness_plans
        (workspace_id,harness_slug,plan_slug,title,content,status,archived,items)
        VALUES (${ws},${harness},${slug},'Optional evaluations',
          ${`## Phase 1\n- **P-005** \`todo\` ${text}`},${status},${archived},${db.adminSql.json(items)})`;
    }
  }, 120_000);
  afterAll(async () => { await db?.cleanup(); });

  it('finds an unpromoted P-NNN in one work search and labels its plan as draft', async () => {
    const result = await search.handler({ query: 'spectraclone', harness: 'pot-a', semantic: false } as never, {} as never);
    const data = (result as { data: { count: number; items: Array<Record<string, unknown>> } }).data;
    expect(data.count).toBe(1);
    expect(data.items[0]).toMatchObject({ kind: 'plan_item', family: 'plan', planStatus: 'draft',
      planSlug: 'optional-evaluations', planItemId: 'P-005', harness: 'pot-a', state: 'todo' });
    expect(data.items[0].title).toContain('spectraclone');
    expect(data).not.toHaveProperty('plan_scope_hint');
  });

  it('respects an explicit execution-kind filter instead of returning draft references', async () => {
    const result = await search.handler({ query: 'spectraclone', harness: 'pot-a', kind: 'bug', semantic: false } as never, {} as never);
    expect((result as { data: { items: unknown[] } }).data.items).toEqual([]);
  });
});
