import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { codeIntelPushText, commitPushFacts, CODE_INTEL_PUSH_TURN_CHARS, recordIntentTaskBrief, snapshotFirstTouchLeg, snapshotGrepLeg,
  readNoteAnchorStaleness, readPushNotesContext, type PushFact, type PushInput, type PushLeg, type PushLegId } from './push-channel';
import { parsePushSnapshot, type PushSnapshot } from './push-snapshot';
import { readPushIncidentAttribution } from './push-channel';
import { resolveCurrentTokens } from '../freshness/resolvers';
import { buildSymbolSnapshot, relativeSymbolModule } from '../../../../scripts/lib/code-intel-symbol-snapshot.mjs';

let db: OrgTestDb;
const dbOrgSpies = vi.hoisted(() => ({ getOrgPg: vi.fn(), withWorkspace: vi.fn() }));
vi.mock('@papercusp/db-org', async importOriginal => ({
  ...(await importOriginal<object>()),
  getOrgPg: () => { dbOrgSpies.getOrgPg(); return { sql: db.adminSql }; },
  withWorkspace: (ws: string, cb: (tx: unknown) => Promise<unknown>) => {
    dbOrgSpies.withWorkspace(ws);
    return db.appSql.begin(async tx => {
      await tx`SELECT set_config('app.workspace_id', ${ws}, true)`;
      return cb(tx);
    });
  },
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
    await db.adminSql.unsafe(await readFile(new URL('../../../../libs/papercusp/libs/db/sql/1544-code-intel-push-skips.sql', import.meta.url), 'utf8'));
  }, 120_000);
  afterAll(async () => { await db?.cleanup(); });

  it('WI-6554700010020557: folds first-touch notes through the workspace app transaction', async () => {
    const workspace = 'push-notes-app-fold';
    const path = 'pkg/target.ts';
    const root = await mkdtemp(join(tmpdir(), 'code-intel-notes-app-'));
    try {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), 'export const retries = 3; // deliberate\n');
      await readNoteAnchorStaleness([], { ...input, workspace, root }); // warm the production resolver before measuring the fold
      const token = (await resolveCurrentTokens([`file:${path}`], {
        workspaceId: workspace, harness: 'papercusp', repoRoot: root,
      })).get(`file:${path}`);
      expect(token).toBeTruthy();
      const body = 'The retry count is deliberate and anchored to the current file.';
      const dependency = { cell: `file:${path}`, observedAt: new Date().toISOString(), digest: token, observed: token };
      await db.adminSql`INSERT INTO harness_shared.agent_facts
        (workspace_id, scope, scope_ref, key, body, created_by, expires_at, depends_on)
        VALUES (${workspace}, 'harness', 'papercusp', 'code-note:app-fold', ${body}, 'push-test',
          now() + interval '1 day', ${JSON.stringify([dependency])}::jsonb)`;

      dbOrgSpies.getOrgPg.mockClear();
      dbOrgSpies.withWorkspace.mockClear();
      const context = await readPushNotesContext({ ...input, workspace, root }, [path]);

      expect(context.fresh).toEqual([{
        key: 'code-note:app-fold', body, paths: [path], scope: 'harness', scopeRef: 'papercusp',
      }]);
      expect(context.withheld).toEqual([]);
      expect(dbOrgSpies.withWorkspace).toHaveBeenCalledWith(workspace);
      expect(dbOrgSpies.getOrgPg).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

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

  it('WI-6554700010018440: budget drops land in the skips ledger, never the delivery ledger, and stay deliverable', async () => {
    const workspace = 'push-integration-skips';
    const skipsOf = () => db.adminSql<{ subject: string; site: string; chars: number; budget_left: number }[]>`
      SELECT subject, site, chars, budget_left FROM harness_shared.code_intel_push_skips
      WHERE workspace_id = ${workspace} ORDER BY subject`;
    // Two ~640-char facts fit the 1,500-char turn; a third does not fit what the turn has left.
    expect(await deliver([fact('s-1'), fact('s-2'), fact('s-3')], workspace)).not.toBe('');
    // A small request share (memory took the rest) drops a fact the turn could still hold...
    expect(await deliver([fact('s-4')], workspace, 10)).toBe('');
    // ...but re-offering an already-delivered fact is not a budget loss, and a repeat
    // drop in the same turn is one row.
    expect(await deliver([fact('s-1'), fact('s-3')], workspace, 10)).toBe('');
    // A fact the request dropped before the commit is classified against the turn too.
    expect(await commitPushFacts({ ...input, workspace }, snapshot(), [], 20, new AbortController().signal, [fact('s-5')])).toBe('');
    const skips = await skipsOf();
    expect(skips.map(s => [s.subject, s.site])).toEqual(
      [['s-3', 'turn-budget'], ['s-4', 'request-budget'], ['s-5', 'request-budget']]);
    expect(skips[0].budget_left).toBeLessThan(skips[0].chars);
    expect(skips[0].budget_left).toBe(CODE_INTEL_PUSH_TURN_CHARS - 2 * skips[0].chars);
    expect(skips.slice(1).map(s => s.budget_left)).toEqual([10, 20]);
    const pushed = await db.adminSql<{ subject: string }[]>`SELECT subject FROM harness_shared.code_intel_pushes
      WHERE workspace_id = ${workspace} ORDER BY subject`;
    expect(pushed.map(p => p.subject)).toEqual(['s-1', 's-2']);
    const leaked = await db.appSql.begin(async tx => {
      await tx`SELECT set_config('app.workspace_id', 'foreign-workspace', true)`;
      return tx`SELECT id FROM harness_shared.code_intel_push_skips WHERE workspace_id = ${workspace}`;
    });
    expect(leaked).toHaveLength(0);
    // The skip row never blocks the real delivery: next turn the dropped fact goes out.
    await db.adminSql`UPDATE harness_shared.identity_hook_turns SET turn_id = 'skips-next-turn' WHERE workspace_id = ${workspace}`;
    expect(await deliver([fact('s-3')], workspace)).toContain('x'.repeat(550));
  });

  it('WI-6554700010018439: a delivered intent-time brief is one intent row that never spends the hook budget', async () => {
    const workspace = 'push-integration-intent';
    const brief = {
      status: 'current' as const, intent: { text: 'fix target', fingerprint: 'f'.repeat(64) }, sourceFingerprint: 's'.repeat(64),
      commit: 'a'.repeat(40), files: [{ path: 'target.ts', sha256: 'b'.repeat(64), kind: 'implementation' as const },
        { path: '/etc/passwd', sha256: 'c'.repeat(64), kind: 'doc' as const }],
      excerpts: [{ path: 'target.ts', text: 'y'.repeat(2_000) }],
      recover: { tool: 'code:pack' as const, args: { op: 'pack' as const, include: ['target.ts'], rootPath: '/repo' } },
    };
    const owner = { workspace, owner: input.owner };
    expect(await recordIntentTaskBrief(owner, brief)).toBe(true);
    expect(await recordIntentTaskBrief(owner, brief)).toBe(false);
    expect(await recordIntentTaskBrief(owner, { ...brief, status: 'unknown', sourceFingerprint: null })).toBe(false);
    const rows = await db.adminSql<{ leg: string; subject: string; chars: number; cited_paths: string[]; suggested_call: string }[]>`
      SELECT leg, subject, chars, cited_paths, suggested_call FROM harness_shared.code_intel_pushes WHERE workspace_id = ${workspace}`;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ leg: 'intent', subject: `${'f'.repeat(64)}:${'s'.repeat(64)}`, cited_paths: ['target.ts'],
      suggested_call: 'code:pack {"op":"pack","include":["target.ts"],"rootPath":"/repo"}' });
    expect(rows[0].chars).toBeGreaterThan(CODE_INTEL_PUSH_TURN_CHARS);
    // Same turn: the ~2k-char brief rode in a tool result, so the hook still has its 1,500 chars.
    expect(await deliver([fact('i-1'), fact('i-2')], workspace)).toContain('x'.repeat(550));
    const hook = await db.adminSql<{ subject: string }[]>`SELECT subject FROM harness_shared.code_intel_pushes
      WHERE workspace_id = ${workspace} AND leg <> 'intent' ORDER BY subject`;
    expect(hook.map(row => row.subject)).toEqual(['i-1', 'i-2']);
  });

  // plan-item-code-anchors-2026-10-20 P-001: replay real tool calls through the push channel
  // (real legs, real proof corroboration against a fixture checkout, real ledger) and read
  // back what each session recorded.
  describe('recorded pushes per session (P-001)', () => {
    const workspace = 'push-integration-sessions';
    const manifest = JSON.stringify({ name: '@fx/pkg', scripts: { test: 'vitest' } });
    const files: Record<string, string> = { 'pkg/package.json': manifest,
      'pkg/lib/target.ts': 'export function target() {}\n',
      'pkg/app/use.ts': 'import { target } from "../lib/target";\ntarget();\n' };
    const paths = Object.keys(files);
    let root = '';
    let fixture: PushSnapshot;
    beforeAll(async () => {
      root = await mkdtemp(join(tmpdir(), 'code-intel-push-sessions-'));
      for (const path of paths) {
        await mkdir(dirname(join(root, path)), { recursive: true });
        await writeFile(join(root, path), files[path]!);
      }
      const symbols = buildSymbolSnapshot({ files: paths, readSource: (file: string) => files[file] ?? null,
        resolveModule: (file: string, spec: string) => relativeSymbolModule(file, spec, new Set(paths)),
        workspacePackages: [['@fx/pkg', ['pkg']]] });
      fixture = parsePushSnapshot(JSON.stringify({ schema: 'graph-dependency-snapshot-v1',
        index: { backend: 'first-party-imports', lastCommit: 'd'.repeat(40) }, generatedAt: new Date().toISOString(),
        edges: [{ importer: 'pkg/app/use.ts', imported: 'pkg/lib/target.ts', importerSha256: 'e'.repeat(64) }], symbols }))!;
      // Warm the app-role pool under another owner so the channel's 250ms wall times the channel, not a cold connect.
      await commitPushFacts({ ...input, workspace, owner: 'warm-up' }, fixture, [fact('warm-up')],
        CODE_INTEL_PUSH_TURN_CHARS, new AbortController().signal);
    }, 60_000);
    afterAll(async () => { if (root) await rm(root, { recursive: true, force: true }); });

    const replay = (owner: string, calls: PushInput['calls']) =>
      codeIntelPushText({ owner, workspace, harness: 'papercusp', root, calls }, 0, {
        snapshot: async () => fixture, enabled: async () => true, commit: commitPushFacts,
        legs: () => new Map<PushLegId, PushLeg>([['grep', snapshotGrepLeg], ['first-touch', snapshotFirstTouchLeg]]) });
    const recorded = (owner: string) => db.adminSql<{ leg: string; subject: string }[]>`SELECT leg, subject
      FROM harness_shared.code_intel_pushes WHERE workspace_id = ${workspace} AND owner_id = ${owner} ORDER BY id`;
    const search = { tool: 'Bash', toolInput: { command: 'rg -n "target" pkg' } };

    it('SPEC-P-001: an eligible symbol search records one grep answer for that symbol', async () => {
      const text = await replay('session-search', [search]);
      expect(text.match(/## Code intelligence \(grep\)/g)).toHaveLength(1);
      expect(text).toContain('target: definition pkg/lib/target.ts:1');
      expect(await replay('session-search', [search])).toBe('');
      expect(await recorded('session-search')).toEqual([{ leg: 'grep', subject: 'target' }]);
    });

    it('SPEC-P-001-FIRST-READ: a first read of a covered file records one first-touch answer for that file', async () => {
      const read = { tool: 'Read', toolInput: { file_path: join(root, 'pkg/lib/target.ts') } };
      expect(await replay('session-read', [read])).toContain('pkg/lib/target.ts: 1 static file importers');
      expect(await replay('session-read', [read])).toBe('');
      expect(await recorded('session-read')).toEqual([{ leg: 'first-touch', subject: 'pkg/lib/target.ts' }]);
    });

    it.each([
      ['tools:invoke-wrapped capability:read', () => ({ tool: 'mcp__papercusp-su__tools_invoke',
        toolInput: JSON.stringify({ name: 'capability:read', args: { file_path: join(root, 'pkg/lib/target.ts') } }) })],
      ['shell sed range read', () => ({ tool: 'Bash', toolInput: { command: `cd ${root} || exit 1; sed -n '1,20p' pkg/lib/target.ts` } })],
      ['tools:invoke-wrapped capability:bash cat', () => ({ tool: 'mcp__papercusp-su__tools_invoke',
        toolInput: { name: 'capability:bash', args: { cmd: 'cat lib/target.ts', cwd: join(root, 'pkg') } } })],
    ])('SPEC-P-001-FIRST-READ (WI-6554700010018441): a first read via %s records one first-touch answer', async (label, call) => {
      const owner = 'session-read-' + label.replace(/\W+/g, '-');
      expect(await replay(owner, [call()])).toContain('pkg/lib/target.ts: 1 static file importers');
      expect(await replay(owner, [call()])).toBe('');
      expect(await recorded(owner)).toEqual([{ leg: 'first-touch', subject: 'pkg/lib/target.ts' }]);
    });

    it('SPEC-P-001 (WI-6554700010018441): a symbol search dispatched through tools:invoke records its grep answer', async () => {
      const wrapped = { tool: 'mcp__papercusp-su__tools_invoke', toolInput: { name: 'capability:bash', args: { cmd: 'rg -n "target" pkg' } } };
      expect(await replay('session-search-wrapped', [wrapped])).toContain('target: definition pkg/lib/target.ts:1');
      expect(await recorded('session-search-wrapped')).toEqual([{ leg: 'grep', subject: 'target' }]);
    });

    it('SPEC-P-001-CAUSE (D-012): a search after a workspace package.json edit still records its grep answer', async () => {
      await writeFile(join(root, 'pkg/package.json'),
        JSON.stringify({ name: '@fx/pkg', version: '2.0.0', scripts: { test: 'vitest run' } }, null, 2));
      try {
        expect(await replay('session-manifest-edit', [search])).toContain('target: definition pkg/lib/target.ts:1');
        expect(await recorded('session-manifest-edit')).toEqual([{ leg: 'grep', subject: 'target' }]);
      } finally { await writeFile(join(root, 'pkg/package.json'), manifest); }
    });
  });
});
