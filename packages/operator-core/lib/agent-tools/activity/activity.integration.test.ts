/**
 * activity.integration.test.ts — real testcontainer PG for the cross-CLI activity
 * bridge tools (papercusp-worker-integration-2026-06-04, D-003).
 *
 * Exercises the activity:report write + activity:recent read against the real
 * migration-143 table shape (so a column/JSONB drift is caught), the server-side
 * summary derivation, and the NOTIFY agent_activity trigger (the wake-up rail the
 * /api/activity/stream SSE rides).
 *
 * Table+trigger DDL applied inline WITHOUT the GRANTs — the throwaway container has
 * no harness_app/harness_zero roles (the tui-workbench-store integration pattern).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFreshPgDb, type FreshPgDb } from '../../../test/_pg-helpers';

const h = vi.hoisted(() => ({
  sql: null as unknown as import('postgres').Sql,
  hookBundle: vi.fn(async () => ({ generation: 'integration-generation', glance: {} })),
}));

vi.mock('./hook-bundle', () => ({ buildActivityHookBundle: h.hookBundle }));

vi.mock('@papercusp/db-org', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@papercusp/db-org')>();
  return { ...actual, getOrgPg: () => ({ sql: h.sql }) };
});

// activity:report WRITES workspace_id from ctx.principal.workspaceId ('ws-test' below),
// but activity:recent READS scoped by activeWorkspaceId() — the process-GLOBAL active
// workspace (request-ALS → PAPERCUSP_WORKSPACE_ID → registry default 'default'). In
// production these align (a request's workspace IS the principal's); in this isolated
// test nothing sets the global, so the read filtered workspace_id='default' (or whatever
// a sibling test leaked into the worker) and returned 0 rows — an INTERMITTENT failure
// keyed on uncontrolled process-global state, not the read logic under test. Pin the
// active workspace to the same id WORKER_CTX writes under so the read sees its own rows.
vi.mock('../../workspace-registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../workspace-registry')>();
  return { ...actual, activeWorkspaceId: () => 'ws-test' };
});

const { default: reportTool } = await import('./report');
const { default: recentTool } = await import('./recent');
const { toolCallRowsFor } = await import('../../tool-call-log-store');

// A principal-only worker exercises the omitted-owner fallback. Positive hook
// reports below each get their own attributed session, as real worker hooks do.
const WORKER_CTX = { isSuperuser: false, role: 'worker', principal: { workspaceId: 'ws-test', slug: 'agent:worker' } } as never;

function attributedWorkerCtx(owner: string) {
  return {
    isSuperuser: true, uiClientId: owner, clientId: owner,
    principal: { workspaceId: 'ws-test', slug: 'system:operator' },
  } as never;
}

const HARNESS_CONTEXT_CTX = {
  isSuperuser: true,
  uiClientId: 'su-context-harness',
  clientId: 'su-context-harness',
  role: 'worker',
  harnessSlug: 'papercup',
  principal: { workspaceId: 'ws-test', slug: 'agent:worker' },
} as never;

// An unscoped superuser request carries the '*' principal sentinel while the
// request context still identifies the concrete workspace. The writer must
// persist the latter so concrete readers and the workspace-leading index agree.
const WILDCARD_PRINCIPAL_CTX = {
  isSuperuser: true,
  uiClientId: 'su-concrete',
  clientId: 'su-concrete',
  role: 'operator',
  workspaceId: 'ws-concrete',
  principal: { workspaceId: '*', slug: 'system:operator' },
} as never;

// Table + the migration-143 NOTIFY trigger, no GRANTs (no roles in the container).
const DDL = `
  CREATE TABLE IF NOT EXISTS harness_shared.agent_activity (
    id BIGSERIAL PRIMARY KEY,
    workspace_id text NOT NULL DEFAULT '*',
    owner_id text NOT NULL,
    agent text, session_id text, harness_slug text,
    kind text NOT NULL, tool_name text, phase text, tool_use_id text,
    summary text, status text, detail jsonb, cwd text,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE OR REPLACE FUNCTION harness_shared.notify_agent_activity() RETURNS trigger
    LANGUAGE plpgsql AS $fn$
  BEGIN
    PERFORM pg_notify('agent_activity', COALESCE(NEW.workspace_id, '') || '::' || COALESCE(NEW.owner_id, ''));
    RETURN NEW;
  END;
  $fn$;
  DROP TRIGGER IF EXISTS agent_activity_notify_trg ON harness_shared.agent_activity;
  CREATE TRIGGER agent_activity_notify_trg
    AFTER INSERT ON harness_shared.agent_activity
    FOR EACH ROW EXECUTE FUNCTION harness_shared.notify_agent_activity();
`;

async function report(
  args: Record<string, unknown>,
  ctx: never = typeof args.owner === 'string' ? attributedWorkerCtx(args.owner) : WORKER_CTX,
) {
  const res = (await reportTool.handler(args as never, ctx)) as { content: { text: string }[]; isError?: boolean };
  return { parsed: JSON.parse(res.content[0]!.text), isError: res.isError };
}
async function recent(args: Record<string, unknown>) {
  // activity:recent declares a `delta` surface, so its handler returns { data } — the
  // render into { content: [{ text }] } happens in the dispatch wrapper this suite
  // deliberately bypasses by calling `handler` directly. This helper still read the
  // RENDERED shape, so `res.content` was undefined and all NINE activity:recent cases
  // below failed with "Cannot read properties of undefined (reading '0')" — a stale
  // helper reading as nine broken assertions. Read the shape the handler actually
  // returns, and do NOT fall back to the other one: a tolerant `??` here would hide
  // the next shape change exactly the way this one hid.
  const res = (await recentTool.handler(args as never, WORKER_CTX)) as {
    data: { activity: Array<Record<string, unknown>>; count: number };
  };
  return res.data;
}

let db: FreshPgDb;

beforeAll(async () => {
  db = await createFreshPgDb('activity');
  h.sql = db.sql;
  await db.sql.unsafe(DDL);
}, 60_000);

afterAll(async () => {
  await db?.cleanup();
});

beforeEach(async () => {
  await db.sql.unsafe('TRUNCATE harness_shared.agent_activity RESTART IDENTITY');
});

describe('activity:report — write + server-side summary', () => {
  it('refuses an attributed caller reporting another owner before inserting a row', async () => {
    const res = await reportTool.handler({
      owner: 'su-victim', tool_name: 'Read', phase: 'post',
    }, attributedWorkerCtx('su-caller'));
    expect(res).toMatchObject({
      isError: true,
      content: [{ type: 'text', text: expect.stringContaining('owner_mismatch') }],
    });
    const rows = await db.sql`SELECT * FROM harness_shared.agent_activity`;
    expect(rows).toHaveLength(0);
  });

  it('inserts an edit with a derived ✎ summary + {file} detail', async () => {
    const { parsed } = await report({
      owner: 'su-w1', agent: 'claude', phase: 'post',
      tool_name: 'Edit', tool_input: { file_path: '/repo/src/gen.ts' },
      session_id: 'sess-1', cwd: '/repo',
    });
    expect(parsed.ok).toBe(true);
    expect(parsed.summary).toBe('✎ gen.ts');

    const rows = await db.sql<Array<Record<string, unknown>>>`SELECT * FROM harness_shared.agent_activity`;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      workspace_id: 'ws-test', owner_id: 'su-w1', agent: 'claude',
      kind: 'tool', tool_name: 'Edit', phase: 'post', summary: '✎ gen.ts',
    });
    expect(rows[0]!.detail).toEqual({ file: '/repo/src/gen.ts' });
  });

  it('derives ▶ for a shell call and carries status', async () => {
    const { parsed } = await report({ owner: 'su-w1', tool_name: 'Bash', tool_input: { command: 'npm test' }, status: 'error' });
    expect(parsed.summary).toBe('▶ npm test');
    const rows = await db.sql<Array<{ summary: string; status: string; kind: string }>>`SELECT summary, status, kind FROM harness_shared.agent_activity`;
    expect(rows[0]).toMatchObject({ summary: '▶ npm test', status: 'error', kind: 'tool' });
  });

  it('summarises a TodoWrite snapshot as kind=todos', async () => {
    await report({
      owner: 'su-w1', tool_name: 'TodoWrite',
      todos: [{ content: 'a', status: 'completed' }, { content: 'b', status: 'in_progress', activeForm: 'Bing' }],
    });
    const rows = await db.sql<Array<{ kind: string; summary: string; detail: { count: number; done: number } }>>`SELECT kind, summary, detail FROM harness_shared.agent_activity`;
    expect(rows[0]!.kind).toBe('todos');
    expect(rows[0]!.summary).toBe('⇄ Bing (1/2)');
    expect(rows[0]!.detail.count).toBe(2);
    expect(rows[0]!.detail.done).toBe(1);
  });

  it('honors an explicit pre-formatted summary over the derived one', async () => {
    const { parsed } = await report({ owner: 'su-w1', tool_name: 'Edit', tool_input: { file_path: '/x.ts' }, summary: 'custom marker' });
    expect(parsed.summary).toBe('custom marker');
  });

  it('accepts the installed hook glance_stale payload through schema, write and bundle dispatch', async () => {
    const args = reportTool.args.parse({
      owner: 'su-hook-compat', agent: 'codex', tool_name: 'Read', phase: 'post',
      tool_input: { file_path: '/hook-compat.ts' },
      hook_bundle: { generation: 'previous-generation', glance_stale: true },
    });
    expect(args.hook_bundle?.glance_stale).toBe(true);
    const { parsed } = await report(args);
    expect(parsed.ok).toBe(true);
    expect(parsed.hook_bundle).toMatchObject({ generation: 'integration-generation' });
    expect(h.hookBundle).toHaveBeenCalledWith(
      'su-hook-compat', { generation: 'previous-generation', glance_stale: true }, attributedWorkerCtx('su-hook-compat'),
    );
    const rows = await db.sql<Array<{ owner_id: string; tool_name: string }>>`
      SELECT owner_id, tool_name FROM harness_shared.agent_activity
       WHERE owner_id = 'su-hook-compat'
    `;
    expect(rows).toEqual([{ owner_id: 'su-hook-compat', tool_name: 'Read' }]);
  });

  it('falls back to the principal slug when owner is omitted', async () => {
    const { parsed } = await report({ tool_name: 'Read', tool_input: { file_path: '/r.md' } });
    expect(parsed.owner).toBe('agent:worker');
  });

  it('stores the concrete request workspace when the principal is wildcard-scoped', async () => {
    const { parsed } = await report(
      { owner: 'su-concrete', tool_name: 'Read', tool_input: { file_path: '/scope.md' } },
      WILDCARD_PRINCIPAL_CTX,
    );
    expect(parsed.ok).toBe(true);

    const rows = await db.sql<Array<{ workspace_id: string }>>`
      SELECT workspace_id
        FROM harness_shared.agent_activity
       WHERE owner_id = 'su-concrete'
    `;
    expect(rows).toEqual([{ workspace_id: 'ws-concrete' }]);
  });

  it('uses the concrete request harness when the hook omits harness_slug', async () => {
    await report(
      { owner: 'su-context-harness', tool_name: 'Read', tool_input: { file_path: '/context.md' } },
      HARNESS_CONTEXT_CTX,
    );

    const rows = await db.sql<Array<{ harness_slug: string | null }>>`
      SELECT harness_slug
        FROM harness_shared.agent_activity
       WHERE owner_id = 'su-context-harness'
    `;
    expect(rows).toEqual([{ harness_slug: 'papercup' }]);
    expect((await recent({ owner: 'su-context-harness', harness: 'papercup' })).count).toBe(1);
  });
});

describe('activity:recent — read + filters', () => {
  beforeEach(async () => {
    await report({ owner: 'su-a', agent: 'claude', tool_name: 'Edit', tool_input: { file_path: '/a.ts' }, harness_slug: 'papercup' });
    await report({ owner: 'su-a', agent: 'claude', tool_name: 'Bash', tool_input: { command: 'ls' }, harness_slug: 'papercup' });
    await report({ owner: 'su-b', agent: 'codex', tool_name: 'apply_patch', tool_input: { files: ['/b.ts'] }, harness_slug: 'restart' });
    await report({ owner: 'su-a', tool_name: 'TodoWrite', todos: [{ content: 'x', status: 'pending' }] });
  });

  it('returns newest-first by default', async () => {
    const r = await recent({});
    expect(r.count).toBe(4);
    expect(Number(r.activity[0]!.id)).toBeGreaterThan(Number(r.activity[3]!.id));
  });

  it('filters by owner', async () => {
    const r = await recent({ owner: 'su-a' });
    expect(r.count).toBe(3);
    expect(r.activity.every((x) => x.owner_id === 'su-a')).toBe(true);
  });

  it('filters by agent + kind + harness', async () => {
    expect((await recent({ agent: 'codex' })).count).toBe(1);
    expect((await recent({ kind: 'todos' })).count).toBe(1);
    expect((await recent({ harness: 'papercup' })).count).toBe(2);
  });

  it('keeps legacy wildcard rows visible without leaking another workspace', async () => {
    const before = Number((await recent({ limit: 1 })).activity[0]!.id);
    await db.sql`
      INSERT INTO harness_shared.agent_activity (workspace_id, owner_id, kind, summary)
      VALUES ('*', 'legacy-owner', 'tool', 'legacy wildcard'),
             ('ws-other', 'other-owner', 'tool', 'other workspace')
    `;

    const latest = await recent({});
    expect(latest.activity.some((row) => row.summary === 'legacy wildcard')).toBe(true);
    expect(latest.activity.some((row) => row.summary === 'other workspace')).toBe(false);

    const catchUp = await recent({ since_id: before });
    expect(catchUp.activity.some((row) => row.summary === 'legacy wildcard')).toBe(true);
    expect(catchUp.activity.some((row) => row.summary === 'other workspace')).toBe(false);
  });

  it('since_id pages forward oldest-first', async () => {
    const all = await recent({});
    const oldest = Number(all.activity[all.activity.length - 1]!.id);
    const r = await recent({ since_id: oldest });
    expect(r.count).toBe(3);
    // ascending after the cursor
    expect(Number(r.activity[0]!.id)).toBeLessThan(Number(r.activity[2]!.id));
  });

  it('respects limit', async () => {
    expect((await recent({ limit: 2 })).count).toBe(2);
  });

  // EI-20309400427356782: session_id came back on every row but could not be filtered
  // BY. It is a different grain from owner — one owner spans many CLI sessions across
  // respawns — so `owner` cannot stand in for it.
  it('filters by session_id, at a finer grain than owner', async () => {
    await report({ owner: 'su-a', agent: 'claude', tool_name: 'Read', tool_input: { file_path: '/s1.ts' }, session_id: 'sess-1' });
    await report({ owner: 'su-a', agent: 'claude', tool_name: 'Read', tool_input: { file_path: '/s2.ts' }, session_id: 'sess-2' });
    const r = await recent({ session_id: 'sess-1' });
    expect(r.count).toBe(1);
    expect(r.activity[0]!.session_id).toBe('sess-1');
    // The same owner covers both sessions — which is the whole reason the filter exists.
    expect((await recent({ owner: 'su-a' })).count).toBe(5);
  });

  // The handler has TWO SQL branches; the since_id one is easy to leave un-filtered.
  it('ANDs session_id into the since_id catch-up branch too', async () => {
    const cursor = Number((await recent({ limit: 1 })).activity[0]!.id);
    await report({ owner: 'su-a', tool_name: 'Read', tool_input: { file_path: '/s1.ts' }, session_id: 'sess-1' });
    await report({ owner: 'su-a', tool_name: 'Read', tool_input: { file_path: '/s2.ts' }, session_id: 'sess-2' });
    const r = await recent({ since_id: cursor, session_id: 'sess-2' });
    expect(r.count).toBe(1);
    expect(r.activity[0]!.session_id).toBe('sess-2');
  });

  it('rejects non-numeric since_id values before the bigint query', () => {
    expect(recentTool.args.safeParse({ since_id: 'NaN' }).success).toBe(false);
    expect(recentTool.args.safeParse({ since_id: 'not-a-number' }).success).toBe(false);
    expect(recentTool.args.safeParse({ since_id: -1 }).success).toBe(false);
    expect(recentTool.args.safeParse({ since_id: '123' }).success).toBe(true);
    expect(recentTool.args.safeParse({ since_id: 123 }).success).toBe(true);
  });
});

describe('activity:recent — numeric id ordering across digit boundaries (regression)', () => {
  // Regression for the silent freeze where `SELECT id::text AS id … ORDER BY id`
  // bound to the TEXT output alias and sorted lexicographically, so once the
  // sequence crossed 999→1000 the read pinned to id 999 forever (lexically
  // "999" > "1000"). Insert explicit ids straddling the boundary and assert true
  // numeric order in BOTH the default-DESC and since_id-ASC branches.
  beforeEach(async () => {
    await db.sql.unsafe(`
      INSERT INTO harness_shared.agent_activity (id, workspace_id, owner_id, kind, summary) VALUES
        (8,    'ws-test', 'su-x', 'tool', 'r8'),
        (9,    'ws-test', 'su-x', 'tool', 'r9'),
        (10,   'ws-test', 'su-x', 'tool', 'r10'),
        (998,  'ws-test', 'su-x', 'tool', 'r998'),
        (999,  'ws-test', 'su-x', 'tool', 'r999'),
        (1000, 'ws-test', 'su-x', 'tool', 'r1000'),
        (1500, 'ws-test', 'su-x', 'tool', 'r1500')
    `);
  });

  it('default read returns the true numeric max first, not lexical "999"', async () => {
    const r = await recent({});
    // The bug returned "999" here (lexical max); the correct head is the numeric max.
    expect(r.activity[0]!.id).toBe('1500');
    const ids = r.activity.map((x) => Number(x.id));
    expect(ids).toEqual([1500, 1000, 999, 998, 10, 9, 8]);
  });

  it('since_id branch pages forward in numeric (not lexical) ascending order', async () => {
    // Lexical asc of "8","9","10","998","999","1000","1500" would lead with "10"/"1000";
    // numeric asc must lead with 9 (first id > 8) and end at 1500.
    const r = await recent({ since_id: '8' });
    const ids = r.activity.map((x) => Number(x.id));
    expect(ids).toEqual([9, 10, 998, 999, 1000, 1500]);
  });
});

describe('activity:tool-log — workspace visibility parity', () => {
  it('matches activity:recent visibility and retains legacy wildcard rows', async () => {
    await db.sql.unsafe(`
      INSERT INTO harness_shared.agent_activity (workspace_id, owner_id, kind, summary) VALUES
        ('ws-test', 'su-parity', 'tool', 'current workspace'),
        ('*', 'su-parity', 'tool', 'legacy wildcard'),
        ('ws-other', 'su-parity', 'tool', 'other workspace')
    `);

    const recentRows = await recent({ owner: 'su-parity' });
    const logRows = await toolCallRowsFor({ ownerId: 'su-parity', workspaceId: 'ws-test' });

    expect(logRows.map((row) => row.summary).sort()).toEqual(
      recentRows.activity.map((row) => row.summary).sort(),
    );
    expect(logRows.map((row) => row.summary).sort()).toEqual(
      ['current workspace', 'legacy wildcard'].sort(),
    );
  });
});

describe('migration-143 NOTIFY trigger — the wake-up rail', () => {
  it('fires NOTIFY agent_activity with <workspace_id>::<owner_id> on insert', async () => {
    const got: string[] = [];
    const conn = await db.sql.listen('agent_activity', (payload) => { got.push(payload); });
    try {
      await report({ owner: 'su-notify', tool_name: 'Read', tool_input: { file_path: '/n.md' } });
      // Give the LISTEN/NOTIFY round-trip a moment.
      await new Promise((r) => setTimeout(r, 300));
      expect(got).toContain('ws-test::su-notify');
    } finally {
      await conn.unlisten();
    }
  });
});
