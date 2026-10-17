import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { commitPushFacts, CODE_INTEL_PUSH_TURN_CHARS, type PushFact } from './push-channel';
import { parsePushSnapshot } from './push-snapshot';
import { readPushIncidentAttribution } from './push-channel';

let db: OrgTestDb;
vi.mock('@papercusp/db-org', async importOriginal => ({
  ...(await importOriginal<object>()),
  withWorkspace: (ws: string, cb: (tx: unknown) => Promise<unknown>) => db.appSql.begin(async tx => {
    await tx`SELECT set_config('app.workspace_id', ${ws}, true)`;
    return cb(tx);
  }),
}));
const input = { workspace: 'push-integration-A', owner: 'agent-A', harness: 'papercusp', calls: [{ tool: 'Read' }] };
const snapshot = () => parsePushSnapshot(JSON.stringify({ schema: 'graph-dependency-snapshot-v1',
  index: { backend: 'first-party-imports', lastCommit: 'a'.repeat(40) }, generatedAt: new Date().toISOString(),
  edges: [{ importer: 'test.ts', imported: 'target.ts', importerSha256: 'b'.repeat(64) }] }))!;
const fact = (subject: string): PushFact => ({ leg: 'first-touch', subject, text: 'x'.repeat(550), citedPaths: ['target.ts'] });
const deliver = (facts: PushFact[], workspace = input.workspace, budget = CODE_INTEL_PUSH_TURN_CHARS) =>
  commitPushFacts({ ...input, workspace }, snapshot(), facts, budget, new AbortController().signal);

describe('push ledger cross-worker budget, dedupe and workspace isolation', () => {
  beforeAll(async () => {
    db = await createOrgTestDb();
    // The normal migration runner creates the ledger; re-application must also be safe.
    const sql = await readFile(new URL('../../../../libs/papercusp/libs/db/sql/1519-code-intel-pushes.sql', import.meta.url), 'utf8');
    await db.adminSql.unsafe(sql);
  }, 120_000);
  afterAll(async () => { await db?.cleanup(); });

  it('joins edit-time items and open scoped paths without leaking foreign harnesses or inferring symbol authorship', async () => {
    const workspace = 'push-incident-join';
    for (const [id, harness, state, paths] of [
      ['WI-edited', 'papercusp', 'done', ['target.ts']],
      ['WI-open', 'papercusp', 'open', ['target.ts']],
      ['WI-other', 'foreign', 'open', ['target.ts']],
      ['WI-unrelated', 'papercusp', 'open', ['unrelated.ts']],
      ['WI-closed', 'papercusp', 'done', ['target.ts']],
    ] as const) await db.adminSql`INSERT INTO harness_shared.work_items
      (workspace_id, harness_slug, feature_id, kind, title, status, payload)
      VALUES (${workspace}, ${harness}, ${id}, 'feature', ${id}, ${state}, ${JSON.stringify({ paths })}::jsonb)`;
    // Historical repo_root is the serving checkout: workspace/harness/path are
    // the documented ledger join keys, not the current filesystem root.
    await db.adminSql`INSERT INTO harness_shared.edit_attribution_ledger
      (workspace_id, harness_slug, repo_root, file, agent_id, work_item_id)
      VALUES (${workspace}, 'papercusp', '/old-serving-checkout', 'target.ts', 'agent', 'WI-edited'),
        (${workspace}, 'foreign', '/old-serving-checkout', 'target.ts', 'agent', 'WI-other')`;
    const result = await readPushIncidentAttribution({ ...input, workspace }, ['target.ts'], db.adminSql);
    expect(result.changedSymbols).toEqual([]);
    expect(result.workItems).toEqual([
      expect.objectContaining({ id: 'WI-edited', state: 'done', relation: 'file-edit-ledger', paths: ['target.ts'] }),
      expect.objectContaining({ id: 'WI-open', state: 'open', relation: 'open-on-path', paths: ['target.ts'] }),
    ]);
  });

  it('groups multi-path work items before bounding attribution so repeated files cannot crowd out other items', async () => {
    const workspace = 'push-incident-multi-path';
    const paths = Array.from({ length: 12 }, (_, index) => `source-${index}.ts`);
    for (const [id, itemPaths] of [['WI-many', paths], ['WI-next', ['next.ts']]] as const) {
      await db.adminSql`INSERT INTO harness_shared.work_items
        (workspace_id, harness_slug, feature_id, kind, title, status, payload)
        VALUES (${workspace}, 'papercusp', ${id}, 'feature', ${id}, 'open', ${JSON.stringify({ paths: itemPaths })}::jsonb)`;
    }
    // Repeated edits and several reached paths retain one relationship, with
    // every supporting path, rather than repeating the same rendered item.
    for (const path of [paths[0]!, paths[0]!, paths[1]!]) {
      await db.adminSql`INSERT INTO harness_shared.edit_attribution_ledger
        (workspace_id, harness_slug, repo_root, file, agent_id, work_item_id)
        VALUES (${workspace}, 'papercusp', '/old-serving-checkout', ${path}, 'agent', 'WI-many')`;
    }
    const result = await readPushIncidentAttribution({ ...input, workspace }, [...paths, 'next.ts'], db.adminSql);
    expect(result.workItems).toEqual([
      expect.objectContaining({ id: 'WI-many', relation: 'file-edit-ledger', paths: paths.slice(0, 2).sort() }),
      expect.objectContaining({ id: 'WI-many', relation: 'open-on-path', paths: [...paths].sort() }),
      expect.objectContaining({ id: 'WI-next', relation: 'open-on-path', paths: ['next.ts'] }),
    ]);
  });

  it('concurrent workers cannot spend the per-turn budget more than once', async () => {
    const texts = await Promise.all(Array.from({ length: 6 }, (_, i) => deliver([fact(`fact-${i}`)])));
    const rows = await db.adminSql<{ chars: number }[]>`SELECT chars FROM harness_shared.code_intel_pushes WHERE workspace_id = ${input.workspace}`;
    expect(rows.length).toBe(2);
    expect(texts.filter(Boolean)).toHaveLength(2);
    expect(rows.reduce((sum, row) => sum + row.chars, 0)).toBeLessThanOrEqual(CODE_INTEL_PUSH_TURN_CHARS);
    expect(texts.filter(Boolean).every(text => text.includes('Snapshot aaaaaaaaaaaa'))).toBe(true);
  });

  it('a new turn restores spend but only compaction makes the same fact eligible again', async () => {
    const workspace = 'push-integration-B';
    expect(await deliver([fact('one')], workspace)).not.toBe('');
    expect(await deliver([fact('one')], workspace)).toBe('');
    await db.adminSql`UPDATE harness_shared.identity_hook_turns SET turn_id = 'next-turn' WHERE workspace_id = ${workspace}`;
    expect(await deliver([fact('one')], workspace)).toBe('');
    await db.adminSql`INSERT INTO harness_shared.memory_session_epochs (session_id, epoch) VALUES (${input.owner}, 1)
      ON CONFLICT (session_id) DO UPDATE SET epoch = 1`;
    expect(await deliver([fact('one')], workspace)).not.toBe('');
  });

  it('dedupes concurrent same-fact attempts and enforces RLS on the real app role', async () => {
    const workspace = 'push-integration-C';
    const texts = await Promise.all([deliver([fact('same')], workspace), deliver([fact('same')], workspace)]);
    expect(texts.filter(Boolean)).toHaveLength(1);
    const leaked = await db.appSql.begin(async tx => {
      await tx`SELECT set_config('app.workspace_id', 'foreign-workspace', true)`;
      return tx`SELECT id FROM harness_shared.code_intel_pushes WHERE workspace_id = ${workspace}`;
    });
    expect(leaked).toHaveLength(0);
    expect(await deliver([fact('too-large')], workspace, 10)).toBe('');
  });
});
