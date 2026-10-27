import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { applyRawSerializerFixes, createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { changeHistoryProviders, coChangeFromCommits, fileSymbolNames, readPriorWork, readSymbolProvenance } from './change-history';
import { enrichTaskBriefWithReuse, type TaskBrief, type TaskBriefDeps } from './task-brief';
import graphQuery from '../agent-tools/gitnexus/query';
const holder = vi.hoisted(() => ({ sql: null as unknown }));
vi.mock('@papercusp/db-org', async original => ({ ...await original<typeof import('@papercusp/db-org')>(),
  getOrgPg: () => ({ sql: holder.sql }) }));
const source = 'export function work() { return 2; }\n';

describe('P001 migrated edit-time attribution ledger', () => {
  let db: OrgTestDb;
  let root: string;
  const WS = 'test-p013-history', HARNESS = 'history-fixture', OWNER = 'su-history-fixture', SESSION = 'native-history-fixture';
  const since = '2026-10-01T00:00:00Z';
  const read = (patch: Partial<Parameters<typeof readSymbolProvenance>[0]> = {}) => readSymbolProvenance({
    workspaceId: WS, harness: HARNESS, root, path: 'a.ts', name: 'work', since, ...patch }, db.adminSql);
  beforeAll(async () => {
    db = await createOrgTestDb(); root = await mkdtemp(join(tmpdir(), 'provenance-'));
    for (const path of ['a.ts', 'b.ts', 'cap.ts', 'hot.ts']) await writeFile(join(root, path), source);
    holder.sql = db.adminSql;
    for (const [id, state] of [['WI-done', 'done'], ['WI-released', 'open']]) {
      await db.adminSql`INSERT INTO harness_shared.work_items
        (workspace_id, harness_slug, feature_id, item_kind, status, title, summary, taken_by, created_ts, updated_ts)
        VALUES (${WS}, ${HARNESS}, ${id}, 'feature', ${state}, 'fixture', 'fixture', NULL, 1, 1)`;
    }
    // No invocation/session rows or current holders: historical attribution must
    // come from the edit-time record even after a work item has been released.
    await db.adminSql`INSERT INTO harness_shared.edit_attribution_ledger
      (workspace_id, harness_slug, repo_root, file, agent_id, session_id, work_item_id, ts, symbols)
      VALUES (${WS}, ${HARNESS}, ${root}, 'a.ts', ${OWNER}, ${SESSION}, 'WI-done', now(), ARRAY['work']),
        (${WS}, ${HARNESS}, ${root}, 'a.ts', ${OWNER}, ${SESSION}, 'WI-done', now(), ARRAY['work']),
        (${WS}, ${HARNESS}, ${root}, 'a.ts', ${OWNER}, ${SESSION}, 'WI-released', now(), ARRAY['work']),
        (${WS}, ${HARNESS}, ${root}, 'b.ts', ${OWNER}, ${SESSION}, 'WI-other-file', now(), ARRAY['work']),
        (${WS}, 'foreign', ${root}, 'a.ts', ${OWNER}, ${SESSION}, 'WI-other-harness', now(), ARRAY['work']),
        (${WS + '-other'}, ${HARNESS}, ${root}, 'a.ts', ${OWNER}, ${SESSION}, 'WI-other-workspace', now(), ARRAY['work']),
        (${WS}, ${HARNESS}, ${root + '-other'}, 'a.ts', ${OWNER}, ${SESSION}, 'WI-other-root', now(), ARRAY['work']),
        (${WS}, ${HARNESS}, ${root}, 'a.ts', ${OWNER}, ${SESSION}, 'WI-old', '2020-01-01', ARRAY['work']),
        (${WS}, ${HARNESS}, ${root}, 'a.ts', ${OWNER}, ${SESSION}, 'WI-other-symbol', now(), ARRAY['other'])`;
  });
  afterAll(async () => { await db?.cleanup(); if (root) await rm(root, { recursive: true, force: true }); });
  it('lists done and released items once, scoped to exact file, symbol, root, workspace, harness and time', async () => {
    const result = await read();
    expect(result.history).toHaveLength(1);
    expect(result.history[0]).toMatchObject({ status: 'measured', symbol: 'work', currentIdentity: 'unknown' });
    expect(result.history[0]!.workItems.sort()).toEqual(['WI-done', 'WI-released']);
    expect(result.fileEdits).toHaveLength(3);
    expect(result.symbols[0]).toMatchObject({ status: 'unknown', workItem: null });
    expect((await read({ path: 'b.ts' })).history[0]?.workItems).toEqual(['WI-other-file']);
    expect((await read({ workspaceId: WS + '-absent' })).fileEdits).toEqual([]);
  });
  it('exposes historical labels through graph:query and refuses a foreign harness', async () => {
    const args = { op: 'provenance', file_path: 'a.ts', harnesses: [HARNESS], name: 'work' };
    const ctx = { workspaceId: WS, harnessSlug: HARNESS, projectDir: root };
    const result = await graphQuery.handler(args as never, ctx as never) as { data: { history: { workItems: string[] }[] } };
    expect(result.data.history[0]?.workItems.sort()).toEqual(['WI-done', 'WI-released']);
    const denied = await graphQuery.handler({ ...args, harnesses: ['foreign'] } as never, ctx as never) as { data: { status: string } };
    expect(denied.data.status).toBe('unknown');
  });
  it('retains legacy NULL captures as file-level unknown and surfaces the 50-row cap', async () => {
    await db.adminSql`INSERT INTO harness_shared.edit_attribution_ledger
      (workspace_id, harness_slug, repo_root, file, agent_id, work_item_id, symbols)
      VALUES (${WS}, ${HARNESS}, ${root}, 'b.ts', ${OWNER}, NULL, NULL)`;
    const legacy = await read({ path: 'b.ts' });
    expect(legacy.fileEdits).toHaveLength(2); expect(legacy.symbolStatus).toBe('unknown');
    expect(legacy.history[0]?.workItems).toEqual(['WI-other-file']);
    await db.adminSql`INSERT INTO harness_shared.edit_attribution_ledger
      (workspace_id, harness_slug, repo_root, file, agent_id, work_item_id, symbols)
      SELECT ${WS}, ${HARNESS}, ${root}, 'cap.ts', ${OWNER}, 'WI-cap-' || n, ARRAY['work']
      FROM generate_series(1, 51) AS n`;
    const capped = await read({ path: 'cap.ts' });
    expect(capped).toMatchObject({ status: 'unknown', symbolStatus: 'unknown', truncated: true });
    expect(capped.fileEdits).toHaveLength(50); expect(capped.history[0]?.workItems).toHaveLength(50);
  });
  it('adds recorded provenance and an unanchored co-change through the actual claim adapter', async () => {
    const hash = (s: string) => createHash('sha256').update(s).digest('hex');
    const sourceVersion = hash(JSON.stringify([['a.ts', hash(source)]]));
    const report = coChangeFromCommits({ end: '2026-10-23T00:00:00Z', paths: ['a.ts'], commit: 'a'.repeat(40), complete: true,
      commits: [1, 2, 3].map(n => ({ sha: String(n), parents: ['parent'], at: `2026-10-0${n}T00:00:00Z`,
        files: [{ status: 'M', path: 'a.ts' }, { status: 'M', path: 'b.ts' }] })) });
    // P-008: the claim brief's provenance section is the shared prior-work reader (the first-touch note's source).
    const providers = changeHistoryProviders({ harness: HARNESS, cochange: async () => report, provenance: async ctx =>
      [await readPriorWork({ workspaceId: WS, root, path: 'a.ts', names: fileSymbolNames('a.ts', source),
        excludeWorkItem: ctx.workItem ?? null, since }, db.adminSql)] });
    const base: TaskBrief = { status: 'current', scope: { harness: HARNESS, paths: ['a.ts'] }, sourceFingerprint: sourceVersion,
      repository: { workspaceId: WS, rootPath: root }, commit: report.commit, files: [{ path: 'a.ts', sha256: hash(source), kind: 'implementation' }],
      excerpts: [], graph: { status: 'measured', consumers: [], relationships: [] }, exclusions: [],
      recover: { tool: 'code:pack', args: { op: 'pack', include: ['a.ts'], rootPath: root } } };
    const append = (brief: TaskBrief, contribution: { text: string }) => ({ ...brief, exclusions: [...brief.exclusions, contribution.text] });
    const observe = vi.fn();
    const deps = { root: async () => root, reuse: { providers,
      adapters: { coChange: append, whatChangedSincePlanning: append }, recordIssued: async () => true } } as unknown as TaskBriefDeps;
    const result = await enrichTaskBriefWithReuse(base, { workspaceId: WS, harness: HARNESS,
      workItem: { id: 'WI-recorded-edit', harness: HARNESS }, reuse: { owner: OWNER, invocation: 'claim-fixture', observe } }, deps, Date.now() + 6000);
    expect(result.files).toEqual(base.files); expect(result.exclusions.join('\n')).toContain('WI-done');
    expect(result.exclusions.join('\n')).toContain('WI-released');
    expect(result.exclusions.join('\n')).toContain('Prior work on `work`');
    // Ledger rows whose item is invisible to this workspace (WI-other-harness has no work_items row) never render.
    expect(result.exclusions.join('\n')).not.toContain('WI-other-harness');
    expect(result.exclusions.join('\n')).toContain('Unanchored b.ts');
    expect(observe.mock.calls[0]?.[0].observations.map((row: { status: string }) => row.status)).toEqual(['issued', 'issued']);
  });

  it('answers within 500ms on a migrated 300k-row hot-file ledger and actually uses the symbol index', async () => {
    // Most rows share the requested file; a repo/file index alone must still
    // filter a realistic hot history. Neither planner settings nor test-only
    // indexes may manufacture the production query plan.
    await db.adminSql`INSERT INTO harness_shared.edit_attribution_ledger
      (workspace_id, harness_slug, repo_root, file, agent_id, work_item_id, ts, symbols)
      SELECT ${WS}, ${HARNESS}, ${root}, CASE WHEN n <= 250000 THEN 'hot.ts' ELSE 'noise-' || n || '.ts' END,
        ${OWNER}, 'WI-noise', now() - n * interval '1 second', ARRAY['unrelated']
      FROM generate_series(1, 300000) AS n`;
    await db.adminSql`INSERT INTO harness_shared.edit_attribution_ledger
      (workspace_id, harness_slug, repo_root, file, agent_id, work_item_id, ts, symbols)
      VALUES (${WS}, ${HARNESS}, ${root}, 'hot.ts', ${OWNER}, 'WI-done', now() - interval '10 days', ARRAY['work']),
        (${WS}, ${HARNESS}, ${root}, 'hot.ts', ${OWNER}, 'WI-released', now() - interval '10 days', ARRAY['work']),
        (${WS}, ${HARNESS}, ${root}, 'hot.ts', ${OWNER}, NULL, now() - interval '10 days', NULL)`;
    await db.adminSql`ANALYZE harness_shared.edit_attribution_ledger`;
    const [{ count }] = await db.adminSql`SELECT count(*)::int AS count FROM harness_shared.edit_attribution_ledger`;
    expect(count).toBeGreaterThanOrEqual(300000);
    const captured: { query: string; params: unknown[] }[] = [];
    const measuredSql = applyRawSerializerFixes(postgres(db.adminDsn, { max: 1, prepare: false, onnotice: () => {},
      debug: (_connection, query, params) => {
        if (/SELECT[\s\S]*FROM harness_shared.edit_attribution_ledger/.test(query)) captured.push({ query, params });
      } }));
    try {
      await measuredSql`SELECT 1`; // connection establishment is outside the query budget
      const start = performance.now();
      const result = await readSymbolProvenance({ workspaceId: WS, harness: HARNESS, root, path: 'hot.ts', name: 'work', since }, measuredSql);
      const elapsedMs = performance.now() - start;
      expect(result.status, result.limitations.join('; ')).toBe('measured');
      expect(result.history[0]!.workItems.sort()).toEqual(['WI-done', 'WI-released']);
      expect(result.fileEdits).toHaveLength(3); expect(result.symbolStatus).toBe('unknown');
      expect(elapsedMs).toBeLessThanOrEqual(500);
      expect(captured).toHaveLength(1);
      const [{ 'QUERY PLAN': plan }] = await db.adminSql.unsafe(
        `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${captured[0]!.query}`, captured[0]!.params as never[]);
      const indexNames: string[] = [];
      const walk = (node: { 'Index Name'?: string; Plans?: typeof node[] }) => {
        if (node['Index Name']) indexNames.push(node['Index Name']);
        node.Plans?.forEach(walk);
      };
      walk(plan[0].Plan);
      expect(indexNames.some(name => /symbol/.test(name)), JSON.stringify(plan)).toBe(true);
      expect(plan[0]['Execution Time']).toBeLessThanOrEqual(500);
      console.info('P001 ledger query guard', { rows: count, elapsedMs, executionMs: plan[0]['Execution Time'], indexNames });
    } finally { await measuredSql.end({ timeout: 5 }); }
  });
});
