/**
 * read-tools.integration.test.ts — plan harness-test-coverage-for-launch P-025.
 *
 * Handler-level coverage for the agent-mcp READ tools — features:*, harness:*,
 * tasks:*, issues:* — which had ZERO tests (only artifacts:* was covered). These
 * are the read surface every agent + the operator chat depend on.
 *
 * They are the LEGACY projected-tool shape (`defineTool` w/ capability): the
 * dispatcher requires `ctx.principal` + `ctx.tx`, runs the handler against that
 * transaction, and serialises `response.data ?? response` into `content[0].text`
 * (define-tool.ts). So a not-found (`data:null`) surfaces the full envelope
 * (incl. degradedReasons); a `data:[]`/object/string surfaces the value.
 *
 * Most read handlers run real SQL via `drizzle(ctx.tx)` or `ctx.tx` template
 * tags, so this is a true integration test against a throwaway Postgres. The
 * three queried `harness_shared` tables (harness_features_consolidated, projects,
 * audit_log) are created HEAD-FAITHFULLY by introspecting the generated drizzle
 * schema (`getTableConfig`) — so `.select()` (all columns) never references a
 * missing column, sidestepping the D-004 prefix-only-migration limitation. The
 * three feature-history side tables are created with the minimal columns their
 * queries read.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { randomBytes } from 'node:crypto';
import { getTableConfig, type PgTable } from 'drizzle-orm/pg-core';
import { getTestPg, markManagedTestDatabase } from '@papercusp/test-config/pg';

// Register Papercusp's capability→tier policy BEFORE the tools self-register, so
// their agentRoles resolve (mirrors agent-mcp's vitest test-setup).
// eslint-disable-next-line import/no-relative-packages
import '../../../packages/agent-mcp/src/capability-tiers-papercusp';
// eslint-disable-next-line import/no-relative-packages
import { generated } from '@papercusp/db-org';
import { lookupByMcpName, dispatchProjectedTool, type UnifiedToolContext } from '@papercusp/tooldef';

// Side-effect imports — each module self-registers into the projection registry.
/* eslint-disable import/no-relative-packages */
import '../../../packages/agent-mcp/src/tools/features/get';
import '../../../packages/agent-mcp/src/tools/features/search';
import '../../../packages/agent-mcp/src/tools/features/history';
import '../../../packages/agent-mcp/src/tools/features/list_related';
import '../../../packages/agent-mcp/src/tools/features/tag_vocabulary';
import '../../../packages/agent-mcp/src/tools/harness/list';
import '../../../packages/agent-mcp/src/tools/harness/get';
import '../../../packages/agent-mcp/src/tools/harness/status';
import '../../../packages/agent-mcp/src/tools/tasks/list';
import '../../../packages/agent-mcp/src/tools/tasks/get';
/* eslint-enable import/no-relative-packages */

const WS = 'ws-read';
let pg: postgres.Sql;
let adminUri: string;
let dbName: string;

/** Builtin-ish SQL types we keep verbatim; everything else (enums, domains) →
 *  text, since the read paths only compare/serialise those columns as text. */
function coerceType(sqlType: string): string {
  const t = sqlType.toLowerCase();
  const keep = ['json', 'tsvector', 'timestamp', 'date', 'bool', 'int', 'numeric', 'double', 'real', 'text', 'varchar', 'char', 'uuid', 'bytea', '[]'];
  return keep.some((k) => t.includes(k)) ? sqlType : 'text';
}

/** CREATE a head-faithful copy of a generated drizzle table (all columns, all
 *  nullable, no constraints) so `.select()` matches the real column set. */
async function createGenTable(table: PgTable): Promise<void> {
  const cfg = getTableConfig(table);
  const schema = cfg.schema ?? 'public';
  const cols = cfg.columns.map((c) => `"${c.name}" ${coerceType(c.getSQLType())}`).join(', ');
  await pg.unsafe(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
  await pg.unsafe(`CREATE TABLE IF NOT EXISTS "${schema}"."${cfg.name}" (${cols})`);
}

const MAKE_CTX = (over: Partial<UnifiedToolContext> = {}): UnifiedToolContext =>
  ({
    log: vi.fn(),
    signal: new AbortController().signal,
    progress: vi.fn(),
    emit: vi.fn(),
    workspaceId: WS,
    harnessSlug: 'h1',
    role: 'architect',
    runId: 'run_T',
    spawnId: 'spw_T',
    principal: {
      workspaceId: WS,
      capabilities: new Set(['features:read', 'harness:read', 'tasks:read', 'issues:read']),
    },
    tx: pg,
    ...over,
  }) as unknown as UnifiedToolContext;

/** Dispatch a read tool with a role it ALLOWS, returning the parsed payload. */
async function call(mcpName: string, args: Record<string, unknown>, ctxOver: Partial<UnifiedToolContext> = {}) {
  const tool = lookupByMcpName(mcpName)!;
  expect(tool, `tool ${mcpName} registered`).toBeDefined();
  const role = (tool.agentRoles?.[0] as string) ?? 'architect';
  const r = await dispatchProjectedTool(tool, mcpName, args, MAKE_CTX({ role, ...ctxOver }), {});
  return { r, tool };
}

function payload(r: Awaited<ReturnType<typeof call>>['r']): unknown {
  expect(r.ok, `dispatch ok (err=${JSON.stringify(r.error)})`).toBe(true);
  return JSON.parse((r.result!.content[0] as { text: string }).text);
}

beforeAll(async () => {
  adminUri = await getTestPg();
  dbName = `read_${randomBytes(5).toString('hex')}`;
  const admin = postgres(adminUri, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`CREATE DATABASE "${dbName}"`);
    await markManagedTestDatabase(admin, dbName);
  } finally {
    await admin.end({ timeout: 5 });
  }
  const u = new URL(adminUri);
  u.pathname = `/${dbName}`;
  pg = postgres(u.toString(), { max: 4, onnotice: () => {} });

  // Head-faithful copies of the queried generated relations.
  //
  // work-items-base-table (~migration 135): `harness_shared.work_items` is now
  // the BASE TABLE (the canonical feature/work-item store) and
  // `harness_shared.harness_features_consolidated` is a VIEW over it (the codegen
  // emits it via `harnessShared.view(...)`, NOT `.table(...)` — so it is no
  // longer a `PgTable` and `getTableConfig()` throws on it). The read handlers
  // still query the compat VIEW, so we create the base table head-faithfully and
  // recreate the view over it exactly as head does (filtering out bug/change/task
  // item_kinds → only feature-shaped rows surface).
  await createGenTable(generated.workItemsInHarnessShared as unknown as PgTable);
  await createGenTable(generated.projectsInHarnessShared as unknown as PgTable);
  await createGenTable(generated.auditLogInHarnessShared as unknown as PgTable);
  // createGenTable mirrors `_search` (a GENERATED tsvector in prod) as a plain,
  // populatable tsvector column (codegen drops the GENERATED clause; coerceType
  // keeps the `tsvector` type) — so the FTS `@@` operator works and we can seed it
  // by UPDATE below. tags (jsonb) + see_also (text[]) are already native columns
  // of the base table, so no compat ALTERs are needed.
  //
  // Recreate the compat view over the base table, matching head's definition
  // (CHECK item_kind <> ALL (bug,change,task) — features carry item_kind='feature').
  await pg.unsafe(`
    CREATE OR REPLACE VIEW harness_shared.harness_features_consolidated AS
      SELECT * FROM harness_shared.work_items
       WHERE item_kind <> ALL (ARRAY['bug', 'change', 'task']);
  `);
  // feature-history side tables (minimal columns their queries read; ts = epoch ms).
  await pg.unsafe(`
    CREATE TABLE IF NOT EXISTS harness_shared.harness_feature_notes
      (workspace_id text, harness_slug text, feature_id text, content text);
    CREATE TABLE IF NOT EXISTS harness_shared.harness_feature_debug_notes
      (workspace_id text, harness_slug text, feature_id text, content text);
    CREATE TABLE IF NOT EXISTS harness_shared.feature_audit_consolidated
      (workspace_id text, harness_slug text, feature_id text, ts bigint, field text, old_value text, new_value text, actor text);
  `);
  // harness_registry — autoloop-pot-operator-rebuild P-004 made harness:list/status
  // MERGE the registry (which harnesses exist) with projects (Pot metadata) so the
  // operator sees registry-only harnesses. registry-read SELECTs payload here.
  // Created EMPTY (no workspace row) → readRegistryProjects returns [] → the merge
  // falls back to projects-only, matching this test's project-based assertions.
  await pg.unsafe(`
    CREATE TABLE IF NOT EXISTS harness_shared.harness_registry
      (workspace_id text PRIMARY KEY, payload jsonb NOT NULL, updated_at bigint NOT NULL DEFAULT 0);
  `);

  // ── Seed features: h1 has F-1 (todo) + F-2 (passed); h2 has F-9 (scope guard).
  const feat = async (slug: string, id: string, title: string, summary: string, status: string, tags: string[], order: number, seeAlso: string[]) => {
    // item_kind='feature' is REQUIRED post-374: harness_features_consolidated is now
    // a VIEW (`… WHERE item_kind <> ALL('bug','change','task')`) over the work_items
    // base table. A seed that omits item_kind lands NULL in the base row, and
    // `NULL <> ALL(…)` is NULL (not true) → the row is invisible through the view, so
    // every features:get/search read returns empty. Features carry item_kind='feature'.
    await pg`
      INSERT INTO harness_shared.harness_features_consolidated
        (workspace_id, harness_slug, feature_id, title, summary, status, tags, see_also, updated_ts, item_kind)
      VALUES (${WS}, ${slug}, ${id}, ${title}, ${summary}, ${status}, ${pg.json(tags)}, ${seeAlso}, ${order}, 'feature')`;
  };
  await feat('h1', 'F-1', 'Auth login', 'auth and api login work', 'todo', ['auth', 'api'], 2, ['F-2']);
  await feat('h1', 'F-2', 'Auth tokens', 'more auth token handling', 'passed', ['auth'], 1, []);
  await feat('h2', 'F-9', 'Other harness', 'unrelated', 'todo', ['misc'], 1, []);
  await pg.unsafe(`UPDATE harness_shared.harness_features_consolidated
                     SET _search = to_tsvector('english', coalesce(title,'')||' '||coalesce(summary,''))`);

  // projects (the harness registry rows harness:* read).
  await pg`INSERT INTO harness_shared.projects (slug, name, status, updated_ts, spent_cents, budget_cents)
           VALUES ('h1', 'Harness One', 'active', 200, 50, 1000), ('h2', 'Harness Two', 'paused', 100, 0, 0)`;

  // audit_log for harness:status recentActivity (subject = harness slug).
  await pg.unsafe(`INSERT INTO harness_shared.audit_log (ts, action, actor, subject)
           VALUES ((extract(epoch from now())*1000)::bigint, 'feature.passed', 'validator', 'h1')`);

  // feature-history side tables for F-1.
  await pg`INSERT INTO harness_shared.harness_feature_notes (workspace_id, harness_slug, feature_id, content)
           VALUES (${WS}, 'h1', 'F-1', 'The implementation note body.')`;
  await pg`INSERT INTO harness_shared.harness_feature_debug_notes (workspace_id, harness_slug, feature_id, content)
           VALUES (${WS}, 'h1', 'F-1', 'Root-cause: null deref.')`;
  await pg.unsafe(`INSERT INTO harness_shared.feature_audit_consolidated
             (workspace_id, harness_slug, feature_id, ts, field, old_value, new_value, actor)
           VALUES ('${WS}', 'h1', 'F-1', (extract(epoch from now())*1000)::bigint, 'status', 'todo', 'passed', 'reviewer')`);
}, 120_000);

afterAll(async () => {
  await pg?.end({ timeout: 5 }).catch(() => {});
  const admin = postgres(adminUri, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
  } catch {
    /* best-effort */
  } finally {
    await admin.end({ timeout: 5 });
  }
});

// features:get/history/list_related are bulk-standardized (the house keyed-array
// contract, bulk-endpoint-standardization-2026-06-21): the n=1 single-call shape
// these tests use yields `{ ok, results:[{ ok, slug, feature_id, … | error }], counts }`.
describe('features:get', () => {
  it('returns the full row for an existing (slug, feature_id)', async () => {
    // drizzle `.select()` returns rows keyed by schema PROPERTY names (camelCase).
    const { r } = await call('features:get', { slug: 'h1', feature_id: 'F-1' });
    const env = payload(r) as { results: Array<{ ok: boolean; feature: { featureId: string; title: string; status: string } }> };
    expect(env.results[0].ok).toBe(true);
    const row = env.results[0].feature;
    expect(row.featureId).toBe('F-1');
    expect(row.title).toBe('Auth login');
    expect(row.status).toBe('todo');
  });
  it('not-found → that item fails (ok:false + error), envelope ok reflects the failure', async () => {
    const { r } = await call('features:get', { slug: 'h1', feature_id: 'F-NOPE' });
    const env = payload(r) as { ok: boolean; results: Array<{ ok: boolean; error: string }>; counts: { failed: number } };
    expect(env.ok).toBe(false);
    expect(env.counts.failed).toBe(1);
    expect(env.results[0].ok).toBe(false);
    expect(env.results[0].error).toMatch(/not found/i);
  });
  it('invalid slug → that item fails before any query', async () => {
    const { r } = await call('features:get', { slug: 'has space', feature_id: 'F-1' });
    const env = payload(r) as { results: Array<{ ok: boolean; error: string }> };
    expect(env.results[0].ok).toBe(false);
    expect(env.results[0].error).toMatch(/invalid slug/i);
  });
  it('fetches MANY via items:[…]; a not-found item fails only itself', async () => {
    const { r } = await call('features:get', {
      items: [
        { slug: 'h1', feature_id: 'F-1' },
        { slug: 'h1', feature_id: 'F-NOPE' },
      ],
    });
    const env = payload(r) as { ok: boolean; results: Array<{ ok: boolean; feature_id: string }>; counts: { ok: number; failed: number } };
    expect(env.ok).toBe(false);
    expect(env.counts).toEqual({ ok: 1, failed: 1 });
    expect(env.results.map((x) => [x.feature_id, x.ok])).toEqual([
      ['F-1', true],
      ['F-NOPE', false],
    ]);
  });
  it('rejects a principal lacking the features:read capability', async () => {
    // The legacy projected read tools gate on capability (principal.capabilities),
    // not on a role allowlist — strip the cap and the dispatcher refuses.
    const tool = lookupByMcpName('features:get')!;
    const ctx = MAKE_CTX();
    ctx.principal!.capabilities = new Set();
    const r = await dispatchProjectedTool(tool, 'features:get', { slug: 'h1', feature_id: 'F-1' }, ctx, {});
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('missing_capability');
  });
});

describe('features:search', () => {
  it('FTS query ranks matching features, scoped to the harness', async () => {
    const { r } = await call('features:search', { slug: 'h1', query: 'auth' });
    const rows = payload(r) as Array<{ feature_id: string }>;
    const ids = rows.map((x) => x.feature_id).sort();
    expect(ids).toEqual(['F-1', 'F-2']);
  });
  it('status filter narrows the result', async () => {
    const { r } = await call('features:search', { slug: 'h1', query: 'auth', status: 'passed' });
    const rows = payload(r) as Array<{ feature_id: string }>;
    expect(rows.map((x) => x.feature_id)).toEqual(['F-2']);
  });
  it('no query → recency-ordered list (updated_ts DESC)', async () => {
    const { r } = await call('features:search', { slug: 'h1' });
    const rows = payload(r) as Array<{ feature_id: string }>;
    expect(rows.map((x) => x.feature_id)).toEqual(['F-1', 'F-2']); // order 2 then 1
  });
  it('does not leak another harness', async () => {
    const { r } = await call('features:search', { slug: 'h2', query: 'auth' });
    expect(payload(r)).toEqual([]);
  });
});

describe('features:list_related', () => {
  it('finds tag/see_also-related features of a source', async () => {
    const { r } = await call('features:list_related', { slug: 'h1', feature_id: 'F-1' });
    const env = payload(r) as { results: Array<{ ok: boolean; related: Array<{ feature_id: string; relation_kind: string }> }> };
    expect(env.results[0].ok).toBe(true);
    const f2 = env.results[0].related.find((x) => x.feature_id === 'F-2');
    expect(f2).toBeDefined();
    expect(f2!.relation_kind).toBe('both'); // F-2 is in see_also AND shares tag 'auth'
  });
  it('unknown source → that item fails (ok:false + error)', async () => {
    const { r } = await call('features:list_related', { slug: 'h1', feature_id: 'F-NOPE' });
    const env = payload(r) as { ok: boolean; results: Array<{ ok: boolean; error: string }> };
    expect(env.ok).toBe(false);
    expect(env.results[0].ok).toBe(false);
    expect(env.results[0].error).toMatch(/not found/i);
  });
});

describe('features:tag_vocabulary', () => {
  it('counts distinct tags across the harness, most-frequent first', async () => {
    const { r } = await call('features:tag_vocabulary', { slug: 'h1' });
    const rows = payload(r) as Array<{ tag: string; count: number }>;
    expect(rows[0]).toEqual({ tag: 'auth', count: 2 });
    expect(rows.find((x) => x.tag === 'api')).toEqual({ tag: 'api', count: 1 });
  });
});

describe('features:history', () => {
  it('renders notes + debugger findings + recent activity', async () => {
    const { r } = await call('features:history', { slug: 'h1', feature_id: 'F-1' });
    const env = payload(r) as { results: Array<{ ok: boolean; history: string }> };
    expect(env.results[0].ok).toBe(true);
    const md = env.results[0].history;
    expect(md).toContain('Notes');
    expect(md).toContain('implementation note body');
    expect(md).toContain('Debugger findings');
    expect(md).toContain('Recent activity');
  });
  it('no history → that item fails (ok:false + "no history yet")', async () => {
    const { r } = await call('features:history', { slug: 'h1', feature_id: 'F-2' });
    const env = payload(r) as { ok: boolean; results: Array<{ ok: boolean; error: string }> };
    expect(env.ok).toBe(false);
    expect(env.results[0].ok).toBe(false);
    expect(env.results[0].error).toMatch(/no history yet/i);
  });
});

describe('harness:list', () => {
  it('lists harnesses (full)', async () => {
    const { r } = await call('harness:list', {});
    const rows = payload(r) as Array<{ slug: string; status: string }>;
    expect(rows.map((x) => x.slug).sort()).toEqual(['h1', 'h2']);
  });
  it('summary detail → slug+status+source', async () => {
    // autoloop-pot-operator-rebuild P-004: harness:list now MERGES the registry
    // with projects and tags each row's `source` ('registry' | 'project') so the
    // operator can tell where a harness came from. Summary projects slug+status+source.
    const { r } = await call('harness:list', { detail: 'summary' });
    const rows = payload(r) as Array<Record<string, unknown>>;
    expect(Object.keys(rows[0]).sort()).toEqual(['slug', 'source', 'status']);
  });
});

describe('harness:get', () => {
  it('returns the harness + per-status featureCounts (detail:full)', async () => {
    const { r } = await call('harness:get', { slug: 'h1', detail: 'full' });
    const row = payload(r) as { slug: string; featureCounts: Record<string, number> };
    expect(row.slug).toBe('h1');
    expect(row.featureCounts).toEqual({ todo: 1, passed: 1 });
  });
  it('not-found → null + degraded', async () => {
    const { r } = await call('harness:get', { slug: 'nope' });
    const p = payload(r) as { data: null; degraded: boolean };
    expect(p.data).toBeNull();
    expect(p.degraded).toBe(true);
  });
});

describe('harness:status', () => {
  it('returns project status + recent audit activity', async () => {
    const { r } = await call('harness:status', { slug: 'h1' });
    // harness:status is bulk-standardized → the per-slug status is results[0]
    // (same envelope as features:get above), not a flat top-level object.
    const env = payload(r) as { results: Array<{ slug: string; recentActivity: Array<{ subject: string }> }> };
    const row = env.results[0];
    expect(row.slug).toBe('h1');
    expect(row.recentActivity.length).toBeGreaterThan(0);
    expect(row.recentActivity[0].subject).toBe('h1');
  });
  it('not-found → that item fails (ok:false), envelope ok reflects the failure', async () => {
    const { r } = await call('harness:status', { slug: 'nope' });
    const env = payload(r) as { ok: boolean; results: Array<{ ok: boolean }> };
    expect(env.ok).toBe(false);
    expect(env.results[0].ok).toBe(false);
  });
});

describe('tasks:list / tasks:get (features-backed)', () => {
  it('tasks:list scopes by harness (detail:full → snake_case alias keys)', async () => {
    const { r } = await call('tasks:list', { harnessSlug: 'h1', detail: 'full' });
    const rows = payload(r) as Array<{ feature_id: string }>;
    expect(rows.map((x) => x.feature_id).sort()).toEqual(['F-1', 'F-2']);
  });
  it('tasks:list status filter', async () => {
    const { r } = await call('tasks:list', { harnessSlug: 'h1', status: 'todo', detail: 'full' });
    const rows = payload(r) as Array<{ feature_id: string }>;
    expect(rows.map((x) => x.feature_id)).toEqual(['F-1']);
  });
  it('tasks:get returns one feature (detail:full → .select() camelCase)', async () => {
    const { r } = await call('tasks:get', { harnessSlug: 'h1', id: 'F-1', detail: 'full' });
    const row = payload(r) as { featureId: string; status: string };
    expect(row.featureId).toBe('F-1');
  });
  it('tasks:get not-found → null + degraded', async () => {
    const { r } = await call('tasks:get', { harnessSlug: 'h1', id: 'F-NOPE' });
    expect((payload(r) as { data: null }).data).toBeNull();
  });
});

// NOTE: the old agent-mcp `issues:list` v1 STUB (a degraded placeholder that
// returned [] and pointed at per-harness reads) is gone. `issues:list` is now a
// real, kind-aware tool in operator-core (lib/agent-tools/issues/list.ts), on its
// way to folding into `work_items:*` (unify-work-items D-007). Its coverage lives
// with operator-core (issues-engineer + work-items integration tests); it is NOT
// an agent-mcp read-tool, so this agent-mcp-only suite no longer tests it.
