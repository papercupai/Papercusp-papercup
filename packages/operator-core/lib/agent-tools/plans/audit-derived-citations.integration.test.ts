import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFreshPgDb, type FreshPgDb } from '../../../test/_pg-helpers';

const h = vi.hoisted(() => ({ db: null as FreshPgDb | null }));
vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: h.db!.sql }),
}));
const { proposeAuditCitations } = await import('./audit-derived-citations');
const input = { workspaceId: 'ws', harnessSlug: 'app', planSlug: 'plan', items: [
  { itemId: 'P-001', status: 'done', itemText: 'First' },
  { itemId: 'P-002', status: 'done', itemText: 'Second' },
] };

beforeAll(async () => {
  h.db = await createFreshPgDb('audit-derived-citations');
  await h.db.sql.unsafe(`
    CREATE TABLE harness_shared.work_items (workspace_id text, harness_slug text, feature_id text,
      source_plan_slug text, source_plan_item_ids text[], payload jsonb, terminal_owner text,
      created_ts bigint, closed_ts bigint);
    CREATE TABLE harness_shared.coord_links (workspace_id text, src_kind text, src_ref text,
      dst_kind text, dst_ref text, rel text);
    CREATE TABLE harness_shared.edit_attribution_ledger (workspace_id text, harness_slug text,
      work_item_id text, plan_slug text, file text, ts timestamptz);
    CREATE TABLE harness_shared.git_sync_commit_attribution (workspace_id text, harness_slug text,
      work_item_id text, repo text, file text);
    CREATE TABLE harness_shared.agent_activity (workspace_id text, harness_slug text, owner_id text,
      phase text, status text, tool_name text, summary text, detail jsonb, created_at timestamptz);
  `);
}, 90_000);
afterAll(async () => { await h.db?.cleanup(); });
beforeEach(async () => {
  await h.db!.sql.unsafe(`TRUNCATE harness_shared.work_items, harness_shared.coord_links,
    harness_shared.edit_attribution_ledger, harness_shared.git_sync_commit_attribution, harness_shared.agent_activity`);
  for (const [id, path] of [['P-001', 'src/one.ts'], ['P-002', 'src/two.test.ts']]) {
    const payload = { _completionEvidence: { filesChanged: [path],
      settlementManifest: { repositoryRoot: '/repo' } } };
    await h.db!.sql`INSERT INTO harness_shared.work_items VALUES
      ('ws','app',${'WI-' + id},'plan',${[id]},${h.db!.sql.json(payload)},'owner',1000,3000)`;
  }
});

describe('citation reader against actual attribution tables', () => {
  it('recovers plan-only edits and completed native patches without mapping every plan file to every item', async () => {
    await h.db!.sql`INSERT INTO harness_shared.edit_attribution_ledger VALUES
      ('ws',NULL,NULL,'plan','src/one.ts',to_timestamp(2)),
      ('ws',NULL,NULL,'plan','src/unrelated.ts',to_timestamp(2))`;
    const command = '*** Begin Patch\n*** Update File: /repo/src/two.test.ts\n@@\n-old\n+new\n*** End Patch';
    await h.db!.sql`INSERT INTO harness_shared.agent_activity VALUES
      ('ws','app','owner','post',NULL,'apply_patch','✎ apply_patch',
       ${h.db!.sql.json({ command })},to_timestamp(2))`;
    const result = await proposeAuditCitations(input, { blobSha: path => 'blob:' + path });
    expect(result.proposals.map(p => [p.itemId, p.citations.map(c => c.path)])).toEqual([
      ['P-001', ['src/one.ts']], ['P-002', ['src/two.test.ts']],
    ]);
    expect(result.proposals.every(p => p.citations[0]!.sources[0] === 'completion-edit')).toBe(true);
    expect(result.unresolved).toEqual([]);
  });

  it('does not turn declarations, foreign scope, pre-edit, failed edits or edits outside the lifecycle into citations', async () => {
    await h.db!.sql`INSERT INTO harness_shared.edit_attribution_ledger VALUES
      ('foreign','app',NULL,'plan','src/one.ts',to_timestamp(2)),
      ('ws','other',NULL,'plan','src/one.ts',to_timestamp(2)),
      ('ws','app',NULL,'other','src/one.ts',to_timestamp(2)),
      ('ws','app',NULL,'plan','src/one.ts',to_timestamp(4))`;
    for (const [owner, phase, status, at, path] of [
      ['stranger', 'post', 'ok', 2, '/repo/src/two.test.ts'],
      ['owner', 'pre', 'ok', 2, '/repo/src/two.test.ts'],
      ['owner', 'post', 'error', 2, '/repo/src/two.test.ts'],
      ['owner', 'post', 'ok', 4, '/repo/src/two.test.ts'],
      ['owner', 'post', 'ok', 2, '/other/src/two.test.ts'],
    ] as const) {
      await h.db!.sql`INSERT INTO harness_shared.agent_activity VALUES
        ('ws','app',${owner},${phase},${status},'Edit','✎ Edit',
         ${h.db!.sql.json({ file: path })},to_timestamp(${at}))`;
    }
    const result = await proposeAuditCitations(input, { blobSha: () => 'blob' });
    expect(result.proposals.every(p => p.citations.length === 0)).toBe(true);
    expect(result.unresolved.map(x => x.itemId)).toEqual(['P-001', 'P-002']);
  });

  it('retains exact work-item edit/commit attribution without requiring completion declarations', async () => {
    await h.db!.sql`UPDATE harness_shared.work_items SET payload=NULL`;
    await h.db!.sql`INSERT INTO harness_shared.git_sync_commit_attribution VALUES
      ('ws','app','WI-P-001','superproject','src/one.ts'),
      ('ws','app','WI-P-002','libs/module','src/two.ts')`;
    const result = await proposeAuditCitations(input, { blobSha: () => 'blob' });
    expect(result.proposals.map(p => p.citations.map(c => c.path))).toEqual([
      ['src/one.ts'], ['libs/module/src/two.ts'],
    ]);
    expect(result.unresolved).toEqual([]);
  });
});
