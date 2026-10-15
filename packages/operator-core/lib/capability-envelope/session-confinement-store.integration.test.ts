/** Real PostgreSQL and shared dispatch regression for launch-declared ceilings. */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFreshTestDb, type MigratedTestDb } from '@papercusp/test-config/pg';
import { dispatchProjectedTool, lookupByMcpName, type ProjectedTool,
  type UnifiedToolContext } from '@papercusp/agent-mcp';

// Redirect only the connection provider. Production read/update SQL and the
// migration run unchanged against a private database, never the product DB.
const connection = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql, unavailable: false }));
vi.mock('@papercusp/db-org', async importOriginal => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => {
    if (connection.unavailable) throw new Error('private policy database unavailable');
    return { sql: connection.sql };
  },
}));
// These independent policies are outside the confinement contract.
vi.mock('./audit-mode-guard', () => ({ checkAuditModeMutationGuard: async () => null }));
vi.mock('../telemetry-dispatch-wrapper', () => ({ dispatchWrapperMarkEnabled: async () => false }));

import { PROJECTED_DEPS } from '../projected-tool-deps';
import '../agent-tools/tools/invoke';
import { __markSessionConfinementsPrimedForTest, __setSessionConfinementCacheForTest,
  declareSessionConfinement, readSessionConfinement, refreshSessionConfinements,
  releaseSessionConfinement } from './session-confinement-store';
import type { SessionToolConfinement } from './session-confinement';
import { BLIND_REVIEW_TOOL } from '../blind-review-gate';
import { blindReviewerConfinement } from '../blind-reviewer-mint';

const WORKSPACE = 'private-benchmark-confinement';
const OWNER = 'su-private-benchmark';
const ceiling = (denyOutside = ['coord:whoami']): SessionToolConfinement => ({
  denyTools: [], denyOutside, reason: 'private metered benchmark', imposedBy: 'benchmark-host',
});
let db: MigratedTestDb;
let sql: postgres.Sql;
const target = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'target executed' }] }));

function context(workspaceId = WORKSPACE, uiClientId = OWNER): UnifiedToolContext {
  return { workspaceId, uiClientId, isSuperuser: true, isPowerUser: true, role: 'operator',
    signal: new AbortController().signal, log: vi.fn(), progress: vi.fn(), emit: vi.fn(),
    runId: randomUUID(), spawnId: randomUUID(), parentSpawnId: null } as UnifiedToolContext;
}

// Use the actual generic dispatcher and the host's actual envelope binding.
// The spend handler is harmless; its call count witnesses whether a denial
// happened before execution. Other admission policies retain their own suites.
async function dispatch(name: string, args: unknown = {}, ctx = context()) {
  const tool: ProjectedTool = name === 'tools:invoke' ? lookupByMcpName(name)! : {
    pluginName: 'private-confinement-fixture', description: 'harmless execution witness',
    inputSchema: { type: 'object' }, capabilities: [], requirePrincipal: false,
    expose: { mcp: { name } }, fn: target,
  };
  expect(tool).toBeDefined();
  ctx.dispatchTool = async (nestedName, nestedArgs) => {
    const result = await dispatch(nestedName, nestedArgs, ctx);
    if (result.ok && result.result) return { ...result.result, content: result.result.content ?? [] };
    return { isError: true,
      content: [{ type: 'text', text: result.error?.message ?? 'dispatcher produced no terminal result' }],
      _meta: { dispatchError: result.error } };
  };
  return dispatchProjectedTool(tool, name, args, ctx, {
    checkCapabilityEnvelope: PROJECTED_DEPS.checkCapabilityEnvelope,
  });
}

async function declare(ownerId = OWNER, confinement = ceiling(), workspaceId = WORKSPACE) {
  return declareSessionConfinement({ ownerId, confinement, workspaceId });
}

beforeAll(async () => {
  db = await createFreshTestDb({ prefix: 'sessionceiling' });
  sql = postgres(db.url, { max: 8, onnotice: () => {} });
  connection.sql = sql;
  await sql.unsafe(`CREATE SCHEMA harness_shared;
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'harness_app') THEN
        CREATE ROLE harness_app;
      END IF;
    END $$;
    GRANT USAGE ON SCHEMA harness_shared TO harness_app;`);
  await sql.unsafe(readFileSync(new URL(
    '../../../../libs/papercusp/libs/db/sql/967-operator-session-confinements.sql', import.meta.url), 'utf8'));
  __markSessionConfinementsPrimedForTest();
}, 120_000);

beforeEach(async () => {
  connection.unavailable = false;
  target.mockClear();
  __setSessionConfinementCacheForTest({});
  await sql`TRUNCATE harness_shared.operator_session_confinements`;
});

afterAll(async () => {
  await sql?.end({ timeout: 5 });
  await db?.drop();
});

describe('durable launch confinement at the dispatch boundary', () => {
  it('enforces assigned read/checkpoint/complete arguments at the real dispatch seat and nested invoke', async () => {
    const own = { id: 'F-own', harness: 'bench-assignment' };
    const checkout = mkdtempSync(join(tmpdir(), 'assignment-dispatch-'));
    writeFileSync(join(checkout, 'task.ts'), 'assignment source');
    const verbs = ['work_items:get', 'work_items:checkpoint', 'work_items:complete'];
    await declare(OWNER, { ...ceiling([...verbs, 'tools:invoke']), denyWorkItemsOutside: { ...own, checkout } });
    const requests = [{ ...own, resume: true }, { ...own, checkpoint: { did: 'implemented', next: 'test' } },
      { ...own, state: 'done', assumptions: 'none', completion: { summary: 'implemented', testsRun: ['npm test'],
        testResult: 'pass', verifiedHow: 'tests', filesChanged: ['task.ts'] } }];
    try { for (let i = 0; i < verbs.length; i++) {
      expect(await dispatch(verbs[i], requests[i])).toMatchObject({ ok: true });
      const calls = target.mock.calls.length;
      expect(await dispatch(verbs[i], { ...requests[i], id: 'F-neighbor' })).toMatchObject({ ok: false });
      expect(await dispatch(verbs[i], { ...requests[i], harness: 'bench-neighbor' })).toMatchObject({ ok: false });
      expect(await dispatch('tools:invoke', { name: verbs[i], args: { ...requests[i], id: 'F-neighbor' } })).toMatchObject({ ok: false });
      expect(target).toHaveBeenCalledTimes(calls);
      expect(await dispatch('tools:invoke', { name: verbs[i], args: requests[i] })).toMatchObject({ ok: true });
    }
    expect(target).toHaveBeenCalledTimes(6);
    expect((await readSessionConfinement(OWNER, WORKSPACE))?.denyWorkItemsOutside).toEqual({ ...own, checkout });
    } finally { rmSync(checkout, { recursive: true, force: true }); }
  });
  it('round-trips an object through the real transactional JSONB writer', async () => {
    expect(await declare()).toEqual({ ok: true });
    const [row] = await sql`SELECT jsonb_typeof(payload) AS type, payload
      FROM harness_shared.operator_session_confinements WHERE workspace_id = ${WORKSPACE}`;
    expect(row.type).toBe('object');
    expect(row.payload.sessions[OWNER].confinement).toEqual(ceiling());
    expect(await readSessionConfinement(OWNER, WORKSPACE)).toEqual(ceiling());
  });

  it('serializes concurrent declarations and release without losing another session', async () => {
    await declare('su-ended');
    const owners = Array.from({ length: 6 }, (_, n) => `su-concurrent-${n}`);
    await Promise.all([...owners.map(owner => declare(owner)), releaseSessionConfinement('su-ended', WORKSPACE)]);
    const [row] = await sql`SELECT payload FROM harness_shared.operator_session_confinements
      WHERE workspace_id = ${WORKSPACE}`;
    expect(Object.keys(row.payload.sessions).sort()).toEqual(owners.sort());
    for (const owner of owners) expect(await readSessionConfinement(owner, WORKSPACE)).toEqual(ceiling());
  });

  it('allows only one conflicting initial ceiling to win and refuses subsequent widening', async () => {
    const outcomes = await Promise.allSettled([declare(), declare(OWNER, ceiling(['coord:whoami', 'benchmark:spend']))]);
    expect(outcomes.filter(outcome => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter(outcome => outcome.status === 'rejected')).toHaveLength(1);
    const stored = await readSessionConfinement(OWNER, WORKSPACE);
    await expect(declare(OWNER, { ...stored!, denyOutside: [...stored!.denyOutside!, 'capability:bash'] }))
      .rejects.toThrow(/cannot be replaced/);
    expect(await readSessionConfinement(OWNER, WORKSPACE)).toEqual(stored);
  });

  it('keeps the same owner independent across workspace rows and enforces RLS', async () => {
    await declare();
    await declare(OWNER, ceiling(['benchmark:spend']), 'private-other-workspace');
    expect(await readSessionConfinement(OWNER, WORKSPACE)).toEqual(ceiling());
    expect(await readSessionConfinement(OWNER, 'private-other-workspace')).toEqual(ceiling(['benchmark:spend']));
    await sql.begin(async tx => {
      await tx.unsafe('SET LOCAL ROLE harness_app');
      await tx`SELECT set_config('app.workspace_id', ${WORKSPACE}, true)`;
      const rows = await tx`SELECT workspace_id FROM harness_shared.operator_session_confinements`;
      expect(rows.map(row => row.workspace_id)).toEqual([WORKSPACE]);
    });
    // A denied statement aborts its transaction: assert at the outer boundary
    // rather than swallowing the statement error and attempting to commit it.
    await expect(sql.begin(async tx => {
      await tx.unsafe('SET LOCAL ROLE harness_app');
      await tx`SELECT set_config('app.workspace_id', ${WORKSPACE}, true)`;
      await tx`UPDATE harness_shared.operator_session_confinements
        SET workspace_id = 'private-other-workspace' WHERE workspace_id = ${WORKSPACE}`;
    })).rejects.toMatchObject({ code: '42501' });
  });

  it('denies a direct spend call before execution even for SU and power-user callers', async () => {
    await declare();
    expect(await dispatch('benchmark:spend')).toMatchObject({ ok: false, error: { code: 'capability_denied' } });
    expect(target).not.toHaveBeenCalled();
    expect(await dispatch('coord:whoami')).toMatchObject({ ok: true });
    expect(await dispatch('benchmark:spend', {}, context(WORKSPACE, 'su-neighbor'))).toMatchObject({ ok: true });
    expect(target).toHaveBeenCalledTimes(2);
  });

  it('refuses tools:invoke when the launch ceiling excludes the wrapper itself', async () => {
    await declare();
    expect(await dispatch('tools:invoke', { name: 'benchmark:spend' })).toMatchObject({
      ok: false, error: { code: 'capability_denied' },
    });
    expect(target).not.toHaveBeenCalled();
  });

  it('rechecks the target through the real tools:invoke handler when the wrapper is permitted', async () => {
    await declare(OWNER, ceiling(['coord:whoami', 'tools:invoke']));
    const denied = await dispatch('tools:invoke', { name: 'benchmark:spend' });
    expect(denied.ok).toBe(false);
    expect(JSON.stringify(denied)).toContain('outside the launch-declared ceiling');
    expect(target).not.toHaveBeenCalled();
    expect(await dispatch('tools:invoke', { name: 'coord:whoami' })).toMatchObject({ ok: true });
    expect(target).toHaveBeenCalledTimes(1);
  });

  // WI-6554700010008492 / verification-system-improvements-2026-10-10#D-042: the blind gap
  // reviewer's real ceiling, through the same seat and the same nested invoke.
  it('confines the blind gap reviewer: plan reads refused direct and nested, the door reachable', async () => {
    await declare(OWNER, blindReviewerConfinement('demo-plan'));
    for (const name of ['plans:get', 'rubrics:get', 'scorecards:list', 'sessions:search', 'work_items:get']) {
      expect(await dispatch(name), name).toMatchObject({ ok: false, error: { code: 'capability_denied' } });
      const nested = await dispatch('tools:invoke', { name });
      expect(nested.ok, `tools:invoke ${name}`).toBe(false);
      expect(JSON.stringify(nested)).toContain('outside the launch-declared ceiling');
    }
    expect(target).not.toHaveBeenCalled();
    expect(await dispatch('tools:invoke', { name: BLIND_REVIEW_TOOL, args: { op: 'brief', slug: 'demo-plan' } }))
      .toMatchObject({ ok: true });
    expect(await dispatch('coord:whoami')).toMatchObject({ ok: true });
    expect(target).toHaveBeenCalledTimes(2);
  });

  it('reads another process connection immediately and ignores a stale or empty local cache', async () => {
    await declare(OWNER, ceiling(['benchmark:spend']));
    const other = postgres(db.url, { max: 1, onnotice: () => {} });
    try {
      await other`UPDATE harness_shared.operator_session_confinements SET payload =
        jsonb_set(payload, ${['sessions', OWNER, 'confinement']}::text[], ${JSON.stringify(ceiling())}::text::jsonb)
        WHERE workspace_id = ${WORKSPACE}`;
      expect(await dispatch('benchmark:spend')).toMatchObject({ ok: false });
      __setSessionConfinementCacheForTest({});
      expect(await dispatch('benchmark:spend')).toMatchObject({ ok: false });
      expect(target).not.toHaveBeenCalled();
    } finally { await other.end({ timeout: 5 }); }
  });

  it('retains expired strict ceilings through refresh and other writes, denying every tool', async () => {
    await declare();
    await sql`UPDATE harness_shared.operator_session_confinements SET payload =
      jsonb_set(payload, ${['sessions', OWNER, 'expiresAt']}::text[], '"2000-01-01T00:00:00Z"'::jsonb)
      WHERE workspace_id = ${WORKSPACE}`;
    await refreshSessionConfinements(WORKSPACE);
    await declare('su-other');
    expect((await readSessionConfinement(OWNER, WORKSPACE))?.denyOutside).toEqual([]);
    expect(await dispatch('coord:whoami')).toMatchObject({ ok: false, error: { code: 'capability_denied' } });
    expect(target).not.toHaveBeenCalled();
  });

  it('turns unreadable authority into an explicit denial at the actual dispatch seat', async () => {
    await declare();
    connection.unavailable = true;
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await dispatch('coord:whoami')).toMatchObject({ ok: false, error: { code: 'capability_denied' } });
      expect(target).not.toHaveBeenCalled();
    } finally { connection.unavailable = false; log.mockRestore(); }
  });
});
