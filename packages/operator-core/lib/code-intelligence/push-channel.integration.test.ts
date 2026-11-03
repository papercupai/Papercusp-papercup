import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { codeIntelPushText, commitPushFacts, CODE_INTEL_PUSH_MAX_CHARS, CODE_INTEL_PUSH_TURN_CHARS, formatPushFact, recordCompletionTimeBrief, recordIntentTaskBrief, snapshotFirstTouchLeg, snapshotGrepLeg,
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
// P-005: each fixture push renders to exactly the per-push cap, so three spend the turn to zero.
const PUSH_OVERHEAD = formatPushFact({ leg: 'first-touch', subject: 'probe', text: 'x', citedPaths: ['target.ts'] }, snapshot()).length - 1;
const BODY = 'x'.repeat(CODE_INTEL_PUSH_MAX_CHARS - PUSH_OVERHEAD);
const fact = (subject: string): PushFact => ({ leg: 'first-touch', subject, text: BODY, citedPaths: ['target.ts'] });
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
      const phaseLines: string[] = [];
      const phasePrefix = '[code-intel-notes-context] ';
      const infoSpy = vi.spyOn(console, 'info').mockImplementation((...args: unknown[]) => {
        const line = args[0];
        if (typeof line === 'string' && line.startsWith(phasePrefix)) phaseLines.push(line);
      });
      const context = await readPushNotesContext({ ...input, workspace, root }, [path])
        .finally(() => infoSpy.mockRestore());
      type NotesPhaseLog = {
        event: string;
        phase?: string;
        readId: string;
        phaseMs: Record<string, number>;
        phaseOutcomes: Record<string, string>;
        anchorCount?: number;
      };
      const timing = phaseLines.map(line => JSON.parse(line.slice(phasePrefix.length)) as NotesPhaseLog)
        .find(row => row.event === 'phase-settled' && row.phase === 'anchorStaleness')!;

      expect(context.fresh).toEqual([{
        key: 'code-note:app-fold', body, paths: [path], scope: 'harness', scopeRef: 'papercusp',
      }]);
      expect(context.withheld).toEqual([]);
      expect(timing).toBeDefined();
      expect(timing.readId).toEqual(expect.any(String));
      expect(timing.phaseOutcomes).toMatchObject({
        acquisition: 'completed', factFold: 'completed', anchorStaleness: 'completed',
      });
      expect(timing.phaseMs).toEqual(expect.objectContaining({
        acquisition: expect.any(Number), factFold: expect.any(Number), anchorStaleness: expect.any(Number),
      }));
      expect(timing.anchorCount).toBe(1);
      expect(JSON.stringify(timing)).not.toContain(body);
      expect(timing).not.toHaveProperty('paths');
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

  it('serves open-on-path from the partial GIN index and still ignores non-array paths (P-002, migration 1595)', async () => {
    const [index] = await db.adminSql<{ indexdef: string }[]>`SELECT indexdef FROM pg_indexes
      WHERE schemaname = 'harness_shared' AND indexname = 'work_items_payload_paths_gin'`;
    expect(index?.indexdef).toMatch(/USING gin \(+payload -> 'paths'::text\)+ WHERE \(jsonb_typeof\(+payload -> 'paths'::text\)+ = 'array'::text\)/);
    const workspace = 'push-incident-gin';
    // `?|` also matches a scalar string or an object key, so the array predicate is
    // what keeps these two out, exactly as the old CASE ... ELSE '[]' did.
    for (const [id, paths] of [['WI-array', ['target.ts']], ['WI-scalar', 'target.ts'], ['WI-object', { 'target.ts': true }]] as const) {
      await db.adminSql`INSERT INTO harness_shared.work_items
        (workspace_id, harness_slug, feature_id, kind, title, status, payload)
        VALUES (${workspace}, 'papercusp', ${id}, 'feature', ${id}, 'open', ${JSON.stringify({ paths })}::jsonb)`;
    }
    const result = await readPushIncidentAttribution({ ...input, workspace }, ['target.ts'], db.adminSql);
    expect(result.workItems).toEqual([
      expect.objectContaining({ id: 'WI-array', relation: 'open-on-path', paths: ['target.ts'] }),
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
    const diagnostics: unknown[] = [];
    const trace = process.env.PAPERCUSP_PUSH_LEDGER_DIAGNOSTICS === '1';
    const waits = new Map<string, { count: number; firstMs: number; lastMs: number }>();
    const started = performance.now();
    let sampling = true;
    const sample = async () => {
      while (sampling) {
        const rows = await db.adminSql`SELECT pid, state, wait_event_type, wait_event, left(query, 100) AS query
          FROM pg_stat_activity WHERE datname = current_database() AND usename = 'harness_app' AND state <> 'idle'`;
        for (const row of rows) {
          const key = JSON.stringify(row);
          const at = performance.now() - started;
          const old = waits.get(key);
          waits.set(key, { count: (old?.count ?? 0) + 1, firstMs: old?.firstMs ?? at, lastMs: at });
        }
        if (sampling) await new Promise(resolve => setTimeout(resolve, 5));
      }
    };
    const sampler = trace
      ? sample().catch(error => { diagnostics.push({ samplerError: String(error) }); })
      : Promise.resolve();
    const previousOnResult = db.appSql.options.onresult;
    db.appSql.options.onresult = result => {
      previousOnResult?.(result);
      diagnostics.push({ pid: result.backendPid, command: result.command,
        query: result.query.replace(/\s+/g, ' ').trim().slice(0, 110),
        elapsedMs: result.elapsedMs, preBuildMs: result.preBuildMs,
        atMs: performance.now() - started,
        status: result.status, errorCode: result.errorCode, serverRoutine: result.serverRoutine });
    };
    let texts: string[];
    try {
      // Drain every worker before restoring diagnostics or letting the next test
      // reuse the fixture. A failed first worker must not leave its peers running.
      const results = await Promise.allSettled(Array.from({ length: 6 }, (_, i) => deliver([fact(`fact-${i}`)])));
      const failures = results.flatMap(result => result.status === 'rejected' ? [String(result.reason)] : []);
      if (trace) {
        console.info('PUSH_LEDGER_CONCURRENCY_DIAGNOSTICS', JSON.stringify({ statements: diagnostics, waits: [...waits] }));
      }
      expect(failures, JSON.stringify({ statements: diagnostics, waits: [...waits] })).toEqual([]);
      texts = results.flatMap(result => result.status === 'fulfilled' ? [result.value] : []);
    } finally {
      sampling = false;
      await sampler;
      db.appSql.options.onresult = previousOnResult;
    }
    const rows = await db.adminSql<{ chars: number }[]>`SELECT chars FROM harness_shared.code_intel_pushes WHERE workspace_id = ${input.workspace}`;
    // P-005: three cap-sized pushes spend the turn exactly; no worker can spend it twice.
    expect(rows.length).toBe(3);
    expect(texts.filter(Boolean)).toHaveLength(3);
    expect(rows.reduce((sum, row) => sum + row.chars, 0)).toBe(CODE_INTEL_PUSH_TURN_CHARS);
    expect(texts.filter(Boolean).every(text => text.startsWith('## Code intelligence (first-touch) @aaaaaaaaaaaa\n'))).toBe(true);
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

  it('delivers the same fact independently to separate owners and dedupes only its own owner', async () => {
    const workspace = 'push-integration-separate-owners';
    const shared = fact('same-eligible-fact');
    const send = (owner: string) => commitPushFacts({ ...input, workspace, owner }, snapshot(),
      [shared], CODE_INTEL_PUSH_TURN_CHARS, new AbortController().signal);

    expect(await send('owner-A')).not.toBe('');
    expect(await send('owner-B')).not.toBe('');
    expect(await send('owner-A')).toBe('');
    expect(await send('owner-B')).toBe('');
    const rows = await db.adminSql<{ owner_id: string; epoch: number; leg: string; subject: string }[]>`
      SELECT owner_id, epoch, leg, subject FROM harness_shared.code_intel_pushes
      WHERE workspace_id = ${workspace} ORDER BY owner_id`;
    expect(rows).toEqual([
      { owner_id: 'owner-A', epoch: 0, leg: shared.leg, subject: shared.subject },
      { owner_id: 'owner-B', epoch: 0, leg: shared.leg, subject: shared.subject },
    ]);
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
    // A request share smaller than what the turn has left is the binding limit (no
    // production caller passes one since P-005; the classification stays exact).
    expect(await deliver([fact('s-0')], workspace, 10)).toBe('');
    // P-005 R-5 boundary: three pushes of exactly the 500-char cap spend the 1,500-char
    // turn to exactly zero; the fourth does not fit what the turn has left.
    expect(await deliver([fact('s-1'), fact('s-2'), fact('s-3'), fact('s-4')], workspace)).not.toBe('');
    // Re-offering an already-delivered fact is not a budget loss, and a repeat drop in
    // the same turn is one row.
    expect(await deliver([fact('s-1'), fact('s-4')], workspace)).toBe('');
    // A fact the request dropped before the commit (over the per-push cap) is push-cap.
    const wide: PushFact = { ...fact('s-5'), text: `${BODY}x` };
    expect(await commitPushFacts({ ...input, workspace }, snapshot(), [], CODE_INTEL_PUSH_TURN_CHARS,
      new AbortController().signal, [wide])).toBe('');
    const skips = await skipsOf();
    expect(skips.map(s => [s.subject, s.site, s.chars, s.budget_left])).toEqual([
      ['s-0', 'request-budget', CODE_INTEL_PUSH_MAX_CHARS, 10],
      ['s-4', 'turn-budget', CODE_INTEL_PUSH_MAX_CHARS, 0],
      ['s-5', 'push-cap', CODE_INTEL_PUSH_MAX_CHARS + 1, 0]]);
    const pushed = await db.adminSql<{ subject: string; chars: number }[]>`SELECT subject, chars FROM harness_shared.code_intel_pushes
      WHERE workspace_id = ${workspace} ORDER BY subject`;
    expect(pushed.map(p => [p.subject, p.chars])).toEqual(
      [['s-1', CODE_INTEL_PUSH_MAX_CHARS], ['s-2', CODE_INTEL_PUSH_MAX_CHARS], ['s-3', CODE_INTEL_PUSH_MAX_CHARS]]);
    expect(pushed.reduce((sum, p) => sum + p.chars, 0)).toBe(CODE_INTEL_PUSH_TURN_CHARS);
    const leaked = await db.appSql.begin(async tx => {
      await tx`SELECT set_config('app.workspace_id', 'foreign-workspace', true)`;
      return tx`SELECT id FROM harness_shared.code_intel_push_skips WHERE workspace_id = ${workspace}`;
    });
    expect(leaked).toHaveLength(0);
    // The skip row never blocks the real delivery: next turn the dropped fact goes out.
    await db.adminSql`UPDATE harness_shared.identity_hook_turns SET turn_id = 'skips-next-turn' WHERE workspace_id = ${workspace}`;
    expect(await deliver([fact('s-4')], workspace)).toContain(BODY);
  });

  it('WI-6554700010030085: legs the push wall stopped land as wall skips beside the facts it gathered', async () => {
    const workspace = 'push-integration-wall';
    // One fact gathered before the gather deadline, two enabled legs the wall never ran.
    const text = await commitPushFacts({ ...input, workspace }, snapshot(), [fact('w-1')], CODE_INTEL_PUSH_TURN_CHARS,
      new AbortController().signal, [], ['incident', 'grep']);
    expect(text).toContain(BODY);
    // The same leg cut twice in one turn is still one row.
    await commitPushFacts({ ...input, workspace }, snapshot(), [], CODE_INTEL_PUSH_TURN_CHARS,
      new AbortController().signal, [], ['grep']);
    const skips = await db.adminSql<{ leg: string; subject: string; site: string; chars: number; budget_left: number }[]>`
      SELECT leg, subject, site, chars, budget_left FROM harness_shared.code_intel_push_skips
      WHERE workspace_id = ${workspace} ORDER BY leg`;
    const pushed = await db.adminSql<{ subject: string }[]>`SELECT subject FROM harness_shared.code_intel_pushes
      WHERE workspace_id = ${workspace}`;
    expect(pushed.map(p => p.subject)).toEqual(['w-1']);
    expect(skips.map(s => [s.leg, s.subject, s.site, s.chars])).toEqual([
      ['grep', 'leg-not-run:grep', 'wall', 0], ['incident', 'leg-not-run:incident', 'wall', 0]]);
    expect(skips.every(s => s.budget_left === CODE_INTEL_PUSH_TURN_CHARS)).toBe(true);
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
    expect(await deliver([fact('i-1'), fact('i-2')], workspace)).toContain(BODY);
    const hook = await db.adminSql<{ subject: string }[]>`SELECT subject FROM harness_shared.code_intel_pushes
      WHERE workspace_id = ${workspace} AND leg <> 'intent' ORDER BY subject`;
    expect(hook.map(row => row.subject)).toEqual(['i-1', 'i-2']);
  });

  it('code-intel-delivery-and-outcomes P-006 (SPEC-P-006-B): a brief whose recovery call was withheld records no suggested call', async () => {
    const workspace = 'push-integration-withheld-recover';
    const intent = {
      status: 'current' as const, intent: { text: 'fix target', fingerprint: 'w'.repeat(64) }, sourceFingerprint: 'v'.repeat(64),
      commit: 'a'.repeat(40), files: [{ path: 'target.ts', sha256: 'b'.repeat(64), kind: 'implementation' as const }],
    };
    const completion = {
      status: 'measured' as const,
      changes: [{ file: 'target.ts', symbol: 'run', sourceFingerprint: 'q'.repeat(64), consumers: ['caller.ts'] }],
      limitations: [],
    };
    expect(await recordIntentTaskBrief({ workspace, owner: input.owner }, intent)).toBe(true);
    expect(await recordCompletionTimeBrief({ workspace, owner: input.owner, workItem: 'WI-withheld' }, completion)).toBe(true);
    const rows = await db.adminSql<{ leg: string; suggested_call: string | null }[]>`
      SELECT leg, suggested_call FROM harness_shared.code_intel_pushes WHERE workspace_id = ${workspace} ORDER BY leg`;
    expect(rows).toEqual([{ leg: 'completion', suggested_call: null }, { leg: 'intent', suggested_call: null }]);
  });

  it('code-intel-delivery-and-outcomes P-002: a delivered completion brief is one completion row that never spends the hook budget', async () => {
    const workspace = 'push-integration-completion';
    const brief = {
      status: 'measured' as const,
      changes: [{ file: 'target.ts', symbol: 'run', sourceFingerprint: 's'.repeat(64), consumers: ['caller.ts'] },
        { file: '/etc/passwd', symbol: 'x', sourceFingerprint: 't'.repeat(64), consumers: [] }],
      limitations: ['z'.repeat(2_000)],
      recover: { tool: 'code:pack' as const, args: { op: 'diff' as const, include: ['target.ts'], rootPath: '/repo' } },
    };
    const owner = { workspace, owner: input.owner, workItem: 'WI-1' };
    expect(await recordCompletionTimeBrief(owner, brief)).toBe(true);
    expect(await recordCompletionTimeBrief(owner, brief)).toBe(false);
    // Nothing measured, no change, or no work item: no code facts were delivered, so no row.
    expect(await recordCompletionTimeBrief(owner, { ...brief, status: 'unknown' })).toBe(false);
    expect(await recordCompletionTimeBrief(owner, { ...brief, changes: [] })).toBe(false);
    expect(await recordCompletionTimeBrief({ ...owner, workItem: '' }, brief)).toBe(false);
    const rows = await db.adminSql<{ leg: string; subject: string; chars: number; cited_paths: string[]; suggested_call: string }[]>`
      SELECT leg, subject, chars, cited_paths, suggested_call FROM harness_shared.code_intel_pushes WHERE workspace_id = ${workspace}`;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ leg: 'completion', cited_paths: ['target.ts'],
      suggested_call: 'code:pack {"op":"diff","include":["target.ts"],"rootPath":"/repo"}' });
    // JSON subject: per-owner readers cast subject::jsonb without filtering by leg.
    expect(JSON.parse(rows[0].subject)).toEqual({ schema: 'completion-brief-v1', workItem: 'WI-1',
      changes: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(rows[0].chars).toBeGreaterThan(CODE_INTEL_PUSH_TURN_CHARS);
    // A different change set on the same item is a new delivery.
    expect(await recordCompletionTimeBrief(owner, { ...brief, changes: [{ ...brief.changes[0], sourceFingerprint: 'u'.repeat(64) }] }))
      .toBe(true);
    // Same turn: the ~2k-char brief rode in a tool result, so the hook still has its 1,500 chars.
    expect(await deliver([fact('c-1'), fact('c-2')], workspace)).toContain(BODY);
    const hook = await db.adminSql<{ subject: string }[]>`SELECT subject FROM harness_shared.code_intel_pushes
      WHERE workspace_id = ${workspace} AND leg <> 'completion' ORDER BY subject`;
    expect(hook.map(row => row.subject)).toEqual(['c-1', 'c-2']);
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
      codeIntelPushText({ owner, workspace, harness: 'papercusp', root, calls }, {
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
