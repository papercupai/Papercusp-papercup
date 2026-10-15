/**
 * P-017 (plan blueprint-backed-work-item-execution-2026-09-23, D-009) — the
 * seven public `blueprint:*` lifecycle tools, driven through REAL projected
 * dispatch on BOTH transports against a fresh PostgreSQL:
 *
 *   • HTTP — `handleHttpToolRequest` (the /api/agent-tools catch-all engine)
 *     with a bearer → principal resolver shaped like the operator host's;
 *   • MCP  — `dispatchProjectedToolToMcp` with the ctx the operator's MCP host
 *     builds for an authenticated PI principal mount.
 *
 * Every case runs on both transports and asserts the SAME outcome: the valid
 * lifecycle (submit → replay → status/events/result → signal/resume/cancel →
 * terminal result), matched invalid inputs, and the scope/caller isolation
 * matrix — including a principal that names another caller through the
 * unverified transport client id (`?client=`).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import { fileURLToPath } from 'node:url';
import {
  assembleOpenApiDocument,
  handleHttpToolRequest,
  listAllProjectedTools,
  listMcpProjections,
  lookupByHttpPath,
  lookupByMcpName,
  type HttpToolHostExtras,
  type UnifiedToolContext,
} from '@papercusp/agent-mcp';
import { dispatchProjectedToolToMcp } from '@papercusp/tooldef-mcp';
import { unwrapToolResult, type ToolResult } from '@papercusp/tooldef';
import { ensureCoordCapabilityTables } from '@papercusp/coordination/capabilities';
import { BlueprintSchema, compileAgentSpecification, operationFromSpecification } from '@papercusp/orchestrator/blueprint';
import { applyEventSubstrateMigrationsForTest, createFreshPgDb, type FreshPgDb } from '../../test/_pg-helpers';
import {
  HARNESS_FEATURES_CONSOLIDATED_DDL,
  USER_TRUST_LIST_DDL,
  WATCHDOG_TICKS_DDL,
  WORK_ITEM_DEPS_DDL,
} from '../../test/_work-items-schema';
import { projectBlueprintToPg, readBlueprintHashFromPg, readBlueprintSpecificationSnapshot } from './project-to-pg';
import { openBlueprintOperationWait, type BlueprintOperationHandle } from './operation-service';
import { BLUEPRINT_OPERATION_TOOLS, BlueprintOperationStatusSchema } from './operation-contract';
import { BlueprintOperationClient, createProjectedBlueprintOperationPort } from './operation-client';
import { resolveAgentIdentity } from '../agent-tools/coordination/identity';
import { canonicalPotSlug } from '../platform-pot-slug';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SQL_DIR = resolve(__dirname, '../../../../libs/papercusp/libs/db/sql');
const readMigration = (f: string) =>
  readFileSync(resolve(SQL_DIR, f), 'utf8')
    .split('\n')
    .filter((line) => !/^\s*\\/.test(line) && !/\bGRANT\b/.test(line) && !/^\s*(BEGIN|COMMIT);\s*$/.test(line))
    .join('\n');

const h = vi.hoisted(() => ({
  sql: undefined as unknown as postgres.Sql,
  // WI-10004360: member harness -> pot home slug, read by the potHomeSlugForHarness mock.
  potHomes: {} as Record<string, string>,
}));
// WI-10004360: potHomeSlugForHarness is a harness-REGISTRY read. Overriding only it makes a
// harness a pot MEMBER while the real resolveWorkItemPot / potExists / createWorkItem path runs.
vi.mock('../hive-federation', async () => {
  const actual = await vi.importActual<typeof import('../hive-federation')>('../hive-federation');
  return {
    ...actual,
    potHomeSlugForHarness: async (...args: Parameters<typeof actual.potHomeSlugForHarness>) =>
      h.potHomes[args[1]] ?? actual.potHomeSlugForHarness(...args),
  };
});
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual, getOrgPg: () => ({ sql: h.sql }) };
});
vi.mock('../workspace-registry', async () => {
  const actual = await vi.importActual<typeof import('../workspace-registry')>('../workspace-registry');
  const { currentRequestWorkspaceId } = await vi.importActual<typeof import('../workspace-als')>('../workspace-als');
  return { ...actual, activeWorkspaceId: () => currentRequestWorkspaceId() ?? 'default' };
});
vi.mock('../harness-core', async () => {
  const actual = await vi.importActual<typeof import('../harness-core')>('../harness-core');
  return { ...actual, resolveProject: async (slug: string) => ({ slug, path: `/tmp/${slug}` }) };
});
// Subscriber fan-out is covered by the coordination tests; keep it inert here.
vi.mock('../sync/hyperbee/fanout-projection', async () => {
  const actual = await vi.importActual<typeof import('../sync/hyperbee/fanout-projection')>('../sync/hyperbee/fanout-projection');
  return { ...actual, fanoutForObject: async () => 0 };
});

// Side-effect registration of the seven projected tools (defineTool).
await import('../agent-tools/blueprint/submit-operation');
await import('../agent-tools/blueprint/status-operation');
await import('../agent-tools/blueprint/result-operation');
await import('../agent-tools/blueprint/events-operation');
await import('../agent-tools/blueprint/cancel-operation');
await import('../agent-tools/blueprint/signal-operation');
await import('../agent-tools/blueprint/resume-operation');

const COORD_EVENT_LOG_DDL = `
  CREATE TABLE IF NOT EXISTS harness_shared.coord_event_log (
    id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    workspace_id text NOT NULL DEFAULT 'default',
    surface text NOT NULL, writer_key text, msg_id text NOT NULL,
    body jsonb NOT NULL, ts timestamptz NOT NULL DEFAULT now())`;
const FIXTURE_DDL = `
  CREATE TABLE harness_shared.harness_plans (
    workspace_id text NOT NULL, harness_slug text NOT NULL, plan_slug text NOT NULL, goal_id text,
    PRIMARY KEY (workspace_id, harness_slug, plan_slug));
  CREATE TABLE harness_shared.plan_runs (
    id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    workspace_id text NOT NULL, harness_slug text NOT NULL,
    instance_plan_slug text, status text, outcome text, outputs jsonb);
  CREATE TABLE harness_shared.blueprints (
    workspace_id text NOT NULL, harness_slug text NOT NULL, blueprint_id text NOT NULL,
    version text NOT NULL, resolved jsonb NOT NULL, content_hash text NOT NULL,
    source_path text, source_commit text, projected_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, harness_slug));
  CREATE TABLE harness_shared.blueprint_specifications (
    workspace_id text NOT NULL, harness_slug text NOT NULL,
    specification_revision text NOT NULL, artifact jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, harness_slug, specification_revision),
    CHECK (artifact->>'specificationRevision' = specification_revision));
  CREATE TABLE harness_shared.adv_sessions (
    id bigserial PRIMARY KEY, workspace_id text NOT NULL, feature text,
    agent text, session_id text, launch_spec jsonb, coord_owner_id text,
    role text, started_at timestamptz NOT NULL DEFAULT now(), ended_at timestamptz, ended_by text);
  CREATE TABLE harness_shared.session_briefs (
    workspace_id text NOT NULL, owner_id text NOT NULL, control_state jsonb,
    PRIMARY KEY (workspace_id, owner_id));
  CREATE TABLE harness_shared.agent_usage_samples (
    id bigserial PRIMARY KEY, workspace_id text NOT NULL, session_id text,
    source text NOT NULL, provider text NOT NULL, model text,
    input_tokens bigint, output_tokens bigint,
    cache_read_tokens bigint, cache_creation_tokens bigint, usage_provenance jsonb);
  CREATE TABLE IF NOT EXISTS harness_shared.work_item_claims (
    workspace_id text NOT NULL, harness_slug text NOT NULL, work_item_id text NOT NULL,
    pot_slug text, claim_id uuid DEFAULT gen_random_uuid() NOT NULL,
    owner text NOT NULL, owner_label text, holder_pubkey text,
    intent text DEFAULT ''::text NOT NULL, ttl_sec integer DEFAULT 1800 NOT NULL,
    acquired_ts timestamptz DEFAULT clock_timestamp() NOT NULL, expires_ts timestamptz NOT NULL,
    last_activity_ts timestamptz DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT work_item_claims_pkey PRIMARY KEY (workspace_id, harness_slug, work_item_id))`;

const WORKSPACE = 'default';
const HARNESS = 'papercup';
const RW = ['work_items:read', 'work_items:write'];
const PRINCIPALS: Record<string, { slug: string; workspaceId: string; capabilities: string[] }> = {
  alpha: { slug: 'pi:alpha', workspaceId: WORKSPACE, capabilities: RW },
  beta: { slug: 'pi:beta', workspaceId: WORKSPACE, capabilities: RW },
  gamma: { slug: 'pi:gamma', workspaceId: 'other-ws', capabilities: RW },
  reader: { slug: 'pi:reader', workspaceId: WORKSPACE, capabilities: ['work_items:read'] },
};

interface Caller {
  principal: keyof typeof PRINCIPALS | null;
  /** Unverified transport client id (`?client=` / the MCP mount's client param). */
  client?: string;
  /** Transport-supplied workspace (`?workspace=`); defaults to none (HTTP) / the principal's (MCP). */
  workspace?: string;
  /** Session harness scope (`?harness=` / a harness-bound mount). */
  harness?: string;
}
type Outcome = { ok: true; data: unknown } | { ok: false; code: string; message: string; status?: number };
type Transport = 'http' | 'mcp';

const HTTP_EXTRAS: HttpToolHostExtras = {
  validateSuperuser: () => false,
  resolvePrincipalAndTx: async (bearer) => {
    const principal = PRINCIPALS[bearer.replace(/^token-/, '')];
    if (!principal) return null;
    return {
      principal: { slug: principal.slug, workspaceId: principal.workspaceId, capabilities: new Set(principal.capabilities) },
      tx: h.sql,
    };
  },
  deps: {},
};

function toolPath(name: string): string {
  const projected = lookupByMcpName(name);
  if (!projected?.expose.http) throw new Error(`${name} is not HTTP-projected`);
  return projected.expose.http.path;
}

async function viaHttp(caller: Caller, name: string, args: Record<string, unknown>): Promise<Outcome> {
  const params = new URLSearchParams();
  if (caller.workspace) params.set('workspace', caller.workspace);
  if (caller.client) params.set('client', caller.client);
  if (caller.harness) params.set('harness', caller.harness);
  const res = await handleHttpToolRequest({
    method: 'POST', pathname: toolPath(name), searchParams: params,
    headers: caller.principal ? { authorization: `Bearer token-${caller.principal}` } : {},
    body: args,
  }, HTTP_EXTRAS);
  const body = res.body as { error?: { code: string; message: string } } & ToolResult;
  if (res.status !== 200) return { ok: false, status: res.status, code: body.error!.code, message: body.error!.message };
  return { ok: true, data: unwrapToolResult(body) };
}

async function viaMcp(caller: Caller, name: string, args: Record<string, unknown>): Promise<Outcome> {
  const principal = caller.principal ? PRINCIPALS[caller.principal] : null;
  // The operator MCP host's authenticated PI-principal mount (tryBuildSpawnContext §1a).
  const ctx = {
    workspaceId: caller.workspace ?? principal?.workspaceId,
    harnessSlug: caller.harness ?? '*',
    role: 'papercup', featureId: null, chunkId: null,
    runId: globalThis.crypto.randomUUID(), spawnId: principal?.slug ?? 'anonymous', parentSpawnId: null,
    uiClientId: caller.client ?? null,
    ...(principal ? {
      principal: { kind: 'pi', slug: principal.slug, workspaceId: principal.workspaceId,
        capabilities: new Set(principal.capabilities) },
    } : {}),
    tx: h.sql, isSuperuser: false, transport: 'mcp',
    log: () => {}, progress: () => {}, emit: () => {}, signal: new AbortController().signal,
  } as unknown as UnifiedToolContext;
  const out = await dispatchProjectedToolToMcp(lookupByMcpName(name)!, name, args, ctx, {});
  const text = (out.content?.[0] as { text?: string } | undefined)?.text ?? '';
  if (out.isError) {
    const split = text.indexOf(': ');
    return { ok: false, code: text.slice(0, split), message: text.slice(split + 2) };
  }
  return { ok: true, data: unwrapToolResult(out as ToolResult) };
}

const call = (transport: Transport, caller: Caller, name: string, args: Record<string, unknown>) =>
  transport === 'http' ? viaHttp(caller, name, args) : viaMcp(caller, name, args);

async function ok<T = Record<string, unknown>>(p: Promise<Outcome>): Promise<T> {
  const r = await p;
  if (!r.ok) throw new Error(`expected success, got ${r.code}: ${r.message}`);
  return r.data as T;
}

/** A refusal, normalised across transports (HTTP additionally carries a status). */
async function refused(p: Promise<Outcome>): Promise<{ code: string; message: string }> {
  const r = await p;
  if (r.ok) throw new Error(`expected refusal, got ${JSON.stringify(r.data)}`);
  return { code: r.code, message: r.message };
}

const OPERATION_SOURCE = {
  id: 'operation-tools-fixture', workItem: { kind: 'feature' },
  roles: [{ id: 'worker' }], spine: { steps: [{ id: 'open', op: 'coord:thread-open', args: { title: 'Extract' } }] },
  operations: [{
    id: 'extract', version: 'A', target: { kind: 'work-item', itemKind: 'feature' },
    execution: { kind: 'agent', role: 'worker' },
    policy: { identity: { kind: 'identity', ref: 'operation-tools-worker', revision: '1.0.0', contentHash: 'b'.repeat(64) } },
    inputSchema: { type: 'object', required: ['value'], properties: { value: { type: 'string' } }, additionalProperties: false },
    acceptance: { resultSchema: { type: 'object', required: ['answer'], properties: { answer: { type: 'string' } }, additionalProperties: false } },
    signals: { note: { payloadSchema: { type: 'object', required: ['text'], properties: { text: { type: 'string' } } } } },
    waits: { approve: { responseSchema: { type: 'object', required: ['approved'], properties: { approved: { type: 'boolean' } } } } },
  }, {
    id: 'extract-program', version: 'A', target: { kind: 'work-item', itemKind: 'feature' },
    execution: { kind: 'program' },
    inputSchema: { type: 'object', required: ['value'], properties: { value: { type: 'string' } }, additionalProperties: false },
    acceptance: { resultSchema: { type: 'object', required: ['answer'], properties: { answer: { type: 'string' } }, additionalProperties: false } },
  }],
};

let db: FreshPgDb;

beforeAll(async () => {
  db = await createFreshPgDb('blueprint-operation-tools');
  h.sql = db.sql;
  await ensureCoordCapabilityTables(db.sql);
  await db.sql.unsafe(COORD_EVENT_LOG_DDL);
  // Plan/blueprint projections first: the operation migrations reference them.
  await db.sql.unsafe(FIXTURE_DDL).simple();
  // Shared, audited event-substrate list (WI-10004700); it includes 1216.
  await applyEventSubstrateMigrationsForTest(db.sql, { label: 'blueprint/operation-tools.integration.test.ts' });
  await db.sql.unsafe(HARNESS_FEATURES_CONSOLIDATED_DDL);
  await db.sql.unsafe(readMigration('1219-blueprint-operation-invocations.sql')).simple();
  await db.sql.unsafe(readMigration('1223-blueprint-operation-event-replay.sql')).simple();
  await db.sql.unsafe(readMigration('698-work-items-closed-ts.sql')).simple();
  await db.sql.unsafe(USER_TRUST_LIST_DDL);
  await db.sql.unsafe(WORK_ITEM_DEPS_DDL).simple();
  await db.sql.unsafe(WATCHDOG_TICKS_DDL).simple();
  await db.sql.unsafe(readMigration('1214-work-item-completion-event-intent.sql')).simple();
  await db.sql.unsafe(readMigration('1215-event-await-delivery-intent-recovery-index.sql')).simple();
  // WI-10004562 / D-045: receipts record the work item's storage slug.
  await db.sql.unsafe(readMigration('1282-blueprint-receipt-target-harness-slug.sql')).simple();
  await db.sql.unsafe(`
    ALTER TABLE harness_shared.work_items
      ADD COLUMN IF NOT EXISTS assignee_rank integer, ADD COLUMN IF NOT EXISTS rank_writer text,
      ADD COLUMN IF NOT EXISTS rank_updated_at timestamptz,
      ADD COLUMN IF NOT EXISTS signal_origin text NOT NULL DEFAULT 'organic';`).simple();
}, 120_000);

afterAll(async () => {
  await db?.cleanup();
}, 30_000);

beforeEach(async () => {
  await db.sql`TRUNCATE harness_shared.work_items, harness_shared.coord_event_log,
                        harness_shared.blueprints, harness_shared.blueprint_specifications,
                        harness_shared.blueprint_operation_invocations, harness_shared.plan_runs RESTART IDENTITY`;
  await projectBlueprintToPg(db.sql, {
    workspaceId: WORKSPACE, harnessSlug: HARNESS,
    blueprint: BlueprintSchema.parse(OPERATION_SOURCE), specification: compileAgentSpecification({ source: OPERATION_SOURCE }),
  });
});

const ALPHA: Caller = { principal: 'alpha' };
const submitArgs = (requestKey: string, input: Record<string, unknown> = { value: 'one' }) =>
  ({ harness: HARNESS, operationId: 'extract', requestKey, input, title: 'Extract' });
const T = BLUEPRINT_OPERATION_TOOLS;

async function settleWithOutput(handle: BlueprintOperationHandle, answer: string): Promise<void> {
  if (handle.target.kind !== 'work-item') throw new Error('expected direct target');
  await db.sql`
    UPDATE harness_shared.work_items
       SET status = 'passed', authority = 'committed',
           payload = payload || ${JSON.stringify({ blueprintResult: {
             operationId: 'extract', specificationRevision: handle.specificationRevision,
             output: { answer }, evidenceRef: 'verification:operation-tools',
           } })}::text::jsonb
     WHERE feature_id = ${handle.target.id} AND workspace_id = ${WORKSPACE} AND harness_slug = ${HARNESS}`;
}

describe('P-017 blueprint:* registration and contract projection', () => {
  it('registers all seven lifecycle tools on MCP, HTTP and the OpenAPI document with typed schemas', () => {
    const names = Object.values(T);
    expect(names).toHaveLength(7);
    for (const name of names) {
      const projected = lookupByMcpName(name);
      expect(projected, name).toBeDefined();
      expect(lookupByHttpPath(toolPath(name))).toBe(projected);
    }
    const doc = assembleOpenApiDocument(
      listAllProjectedTools().filter((tool) => names.includes(tool.expose.mcp?.name as typeof names[number])),
      { title: 'P-017' },
    ) as { paths: Record<string, unknown> };
    for (const name of names) {
      const key = Object.keys(doc.paths).find((path) => path.endsWith(toolPath(name)));
      expect(key, `${name} missing from OpenAPI`).toBeDefined();
    }
    const submitPath = Object.keys(doc.paths).find((path) => path.endsWith(toolPath(T.submit)))!;
    expect((doc.paths[submitPath] as { post?: { requestBody?: unknown } }).post?.requestBody).toBeDefined();
    // The shared contract's request fields reach the document (inline or via components).
    for (const field of ['requestKey', 'operationId', 'channel', 'token', 'cursor']) {
      expect(JSON.stringify(doc), field).toContain(`"${field}"`);
    }
    // The typed RESULT contract projects to MCP `outputSchema` (the OpenAPI assembler
    // references a generic ToolResult for Event.done, so output fields never reach
    // the document). Assert what tools/list actually advertises — including
    // blueprint:result, whose state-discriminated union roots at `anyOf`.
    const listings = new Map(listMcpProjections().map((listing) => [listing.name, listing]));
    for (const name of names) {
      expect(listings.get(name)?.outputSchema?.type, `${name} advertised outputSchema`).toBe('object');
    }
    expect(JSON.stringify(listings.get(T.status)?.outputSchema)).toContain('"cancellationRequested"');
    expect(JSON.stringify(listings.get(T.result)?.outputSchema)).toContain('"evidenceRef"');
  });
});

describe.each<Transport>(['http', 'mcp'])('P-017 blueprint:* lifecycle over %s', (transport) => {
  it('refuses changed approved revisions while preserving accepted runs through promotion and rollback', async () => {
    const original = await readBlueprintHashFromPg(db.sql, WORKSPACE, HARNESS);
    const approved = { ...submitArgs('approved'), expectedSpecificationRevision: original };
    const { handle } = await ok<{ handle: BlueprintOperationHandle }>(call(transport, ALPHA, T.submit, approved));
    expect(handle.specificationRevision).toBe(original);
    const promoted = structuredClone(OPERATION_SOURCE);
    promoted.operations[0]!.version = 'B';
    await projectBlueprintToPg(db.sql, {
      workspaceId: WORKSPACE, harnessSlug: HARNESS,
      blueprint: BlueprintSchema.parse(promoted), specification: compileAgentSpecification({ source: promoted }),
    });
    const next = await readBlueprintHashFromPg(db.sql, WORKSPACE, HARNESS);
    expect(next).not.toBe(original);
    expect(await refused(call(transport, ALPHA, T.submit, {
      ...approved, requestKey: 'stale-new-run',
    }))).toMatchObject({ code: 'invalid_input', message: expect.stringContaining('revision changed') });
    expect((await ok<{ handle: BlueprintOperationHandle }>(call(transport, ALPHA, T.submit, approved))).handle).toEqual(handle);
    const fresh = await ok<{ handle: BlueprintOperationHandle }>(call(transport, ALPHA, T.submit, {
      ...submitArgs('new-approved'), expectedSpecificationRevision: next,
    }));
    expect(fresh.handle.specificationRevision).toBe(next);
    await projectBlueprintToPg(db.sql, {
      workspaceId: WORKSPACE, harnessSlug: HARNESS,
      blueprint: BlueprintSchema.parse(OPERATION_SOURCE), specification: compileAgentSpecification({ source: OPERATION_SOURCE }),
    });
    const stillPinned = await ok<{ handle: BlueprintOperationHandle }>(call(transport, ALPHA, T.status, { handle: fresh.handle }));
    expect(stillPinned.handle.specificationRevision).toBe(next);
    const [{ count }] = await db.sql<{ count: number }[]>`SELECT count(*)::int AS count FROM harness_shared.blueprint_operation_invocations`;
    expect(count).toBe(2);
  });

  it('drives submit/replay/status/events/signal/resume/cancel/result through the shared contract', async () => {
    const { handle } = await ok<{ handle: BlueprintOperationHandle }>(
      call(transport, ALPHA, T.submit, submitArgs('lifecycle')));
    expect(handle).toMatchObject({ workspaceId: WORKSPACE, harnessSlug: HARNESS, operationId: 'extract',
      target: { kind: 'work-item' } });
    if (handle.target.kind !== 'work-item') throw new Error('expected direct target');
    // The typed reference identifies the actual durable work item.
    const rows = await db.sql`SELECT status FROM harness_shared.work_items
      WHERE workspace_id = ${WORKSPACE} AND harness_slug = ${HARNESS} AND feature_id = ${handle.target.id}`;
    expect(rows).toHaveLength(1);
    // Same key + same input replays one execution; different input is refused.
    expect((await ok<{ handle: unknown }>(call(transport, ALPHA, T.submit, submitArgs('lifecycle')))).handle).toEqual(handle);
    expect(await refused(call(transport, ALPHA, T.submit, submitArgs('lifecycle', { value: 'changed' })))).toEqual({
      code: 'invalid_input', message: 'input_conflict: blueprint operation request key was reused with different input or target',
    });
    const [{ count }] = await db.sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM harness_shared.work_items WHERE workspace_id = ${WORKSPACE}`;
    expect(count).toBe(1);

    const status = await ok(call(transport, ALPHA, T.status, { handle }));
    expect(BlueprintOperationStatusSchema.parse(status)).toMatchObject({ phase: 'accepted', outcome: null, wait: null });
    expect(await ok(call(transport, ALPHA, T.result, { handle }))).toMatchObject({ state: 'pending' });
    const firstPage = await ok<{ events: unknown[]; cursor: string; hasMore: boolean }>(
      call(transport, ALPHA, T.events, { handle }));
    expect(firstPage.events).toMatchObject([{ kind: 'work-item', state: 'open', workItemId: handle.target.id }]);

    const signalArgs = { handle, channel: 'note', payload: { text: 'go' }, requestKey: 'note-1' };
    const signal = await ok<{ eventId: string }>(call(transport, ALPHA, T.signal, signalArgs));
    expect(signal).toMatchObject({ accepted: true, handled: false, replayed: false });
    expect(await ok(call(transport, ALPHA, T.signal, signalArgs))).toMatchObject({ eventId: signal.eventId, replayed: true });

    await openBlueprintOperationWait(db.sql, handle, 'pi:alpha', { waitName: 'approve', token: 'wait-1' });
    expect(await ok(call(transport, ALPHA, T.status, { handle })))
      .toMatchObject({ phase: 'waiting', wait: { name: 'approve', token: 'wait-1' } });
    const resumeArgs = { handle, token: 'wait-1', response: { approved: true }, requestKey: 'resume-1' };
    expect(await ok(call(transport, ALPHA, T.resume, resumeArgs)))
      .toMatchObject({ accepted: true, handled: false, replayed: false });
    expect(await ok(call(transport, ALPHA, T.status, { handle }))).toMatchObject({ phase: 'accepted', wait: null });

    expect(await ok(call(transport, ALPHA, T.cancel, { handle, requestKey: 'cancel-1', reason: 'stop' })))
      .toMatchObject({ accepted: true, handled: false });
    expect(await ok(call(transport, ALPHA, T.status, { handle }))).toMatchObject({ cancellationRequested: true });

    // Settlement: a late reader observes the current terminal state and the
    // validated output; the event log carries every accepted control input.
    await settleWithOutput(handle, 'done');
    expect(await ok(call(transport, ALPHA, T.status, { handle })))
      .toMatchObject({ phase: 'terminal', outcome: 'succeeded' });
    expect(await ok(call(transport, ALPHA, T.result, { handle }))).toMatchObject({
      state: 'ready', output: { answer: 'done' }, evidenceRef: 'verification:operation-tools',
    });
    const later = await ok<{ events: unknown[] }>(call(transport, ALPHA, T.events, { handle, cursor: firstPage.cursor }));
    expect(later.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'signal', channel: 'note' }),
      expect.objectContaining({ kind: 'resume', token: 'wait-1' }),
      expect.objectContaining({ kind: 'cancel', reason: 'stop' }),
    ]));
  });

  it('refuses matched invalid inputs with typed invalid_input codes', async () => {
    const { handle } = await ok<{ handle: BlueprintOperationHandle }>(call(transport, ALPHA, T.submit, submitArgs('invalid')));
    // Contract (schema) refusals — the handler never runs.
    const missingKey = await refused(call(transport, ALPHA, T.submit,
      { harness: HARNESS, operationId: 'extract', input: { value: 'x' } }));
    expect(missingKey.code).toBe('invalid_input');
    expect((await refused(call(transport, ALPHA, T.status, { handle, extra: true }))).code).toBe('invalid_input');
    expect((await refused(call(transport, ALPHA, T.events, { handle, cursor: 'abc' }))).code).toBe('invalid_input');
    // Service refusals, typed.
    expect((await refused(call(transport, ALPHA, T.submit, submitArgs('bad-payload', { value: 3 })))).message)
      .toMatch(/^invalid_payload: /);
    expect(await refused(call(transport, ALPHA, T.signal,
      { handle, channel: 'undeclared', payload: {}, requestKey: 'n-1' }))).toEqual({
      code: 'invalid_input', message: 'undeclared: blueprint operation signal channel is not declared',
    });
    expect((await refused(call(transport, ALPHA, T.signal,
      { handle, channel: 'note', payload: { text: 4 }, requestKey: 'n-2' }))).message).toMatch(/^invalid_payload: /);
    expect(await refused(call(transport, ALPHA, T.resume,
      { handle, token: 'never-opened', response: { approved: true }, requestKey: 'r-1' }))).toEqual({
      code: 'invalid_input', message: 'stale_wait: blueprint operation wait token is stale or outside this operation',
    });
    await settleWithOutput(handle, 'done');
    expect(await refused(call(transport, ALPHA, T.cancel, { handle, requestKey: 'c-late', reason: 'late' }))).toEqual({
      code: 'invalid_input', message: 'terminal: cannot cancel a terminal blueprint operation',
    });
  });

  it('isolates handles by caller, workspace and harness — including a forged transport client id', async () => {
    const { handle } = await ok<{ handle: BlueprintOperationHandle }>(call(transport, ALPHA, T.submit, submitArgs('isolation')));
    const mismatch = { code: 'invalid_input', message: 'handle_mismatch: blueprint operation handle does not match its durable receipt' };
    const handleCalls: Array<[string, Record<string, unknown>]> = [
      [T.status, { handle }], [T.result, { handle }], [T.events, { handle }],
      [T.cancel, { handle, requestKey: 'x-cancel', reason: 'x' }],
      [T.signal, { handle, channel: 'note', payload: { text: 'x' }, requestKey: 'x-note' }],
      [T.resume, { handle, token: 'x', response: { approved: true }, requestKey: 'x-resume' }],
    ];
    // The shared identity resolver and operation rail both bind an unverified
    // transport client id beneath the authenticated principal.
    expect(resolveAgentIdentity({ principal: { slug: 'pi:beta', workspaceId: WORKSPACE, capabilities: new Set() },
      uiClientId: 'pi:alpha' } as never).ownerId).toBe('pi:beta/pi:alpha');
    for (const [name, args] of handleCalls) {
      // Another caller in the same workspace cannot read or drive the handle…
      expect(await refused(call(transport, { principal: 'beta' }, name, args)), `${name} beta`).toEqual(mismatch);
      // …even when it names the owner through the unverified client id.
      expect(await refused(call(transport, { principal: 'beta', client: 'pi:alpha' }, name, args)), `${name} forged`)
        .toEqual(mismatch);
      // A principal in another workspace is refused before the service runs.
      expect(await refused(call(transport, { principal: 'gamma' }, name, args)), `${name} gamma`).toEqual({
        code: 'invalid_input', message: 'scope_mismatch: blueprint operation handle belongs to a different workspace',
      });
      // A transport-supplied workspace cannot widen a principal into the handle's workspace.
      expect(await refused(call(transport, { principal: 'gamma', workspace: WORKSPACE }, name, args)), `${name} widen`)
        .toEqual({ code: 'invalid_input', message: 'scope_mismatch: blueprint operation handle belongs to a different workspace' });
    }
    // The principal's own workspace governs; a foreign transport workspace is ignored.
    expect(await ok(call(transport, { principal: 'alpha', workspace: 'other-ws' }, T.status, { handle })))
      .toMatchObject({ phase: 'accepted' });
    // A tampered handle is refused by scope, then by its durable receipt.
    expect((await refused(call(transport, ALPHA, T.status, { handle: { ...handle, workspaceId: 'other-ws' } }))).message)
      .toBe('scope_mismatch: blueprint operation handle belongs to a different workspace');
    expect(await refused(call(transport, ALPHA, T.status, { handle: { ...handle, receiptId: handle.receiptId + 99 } })))
      .toEqual(mismatch);
    // Submission names its harness explicitly (the contract requires it).
    const noHarness: Record<string, unknown> = { ...submitArgs('no-harness') };
    delete noHarness.harness;
    expect((await refused(call(transport, ALPHA, T.submit, noHarness))).code).toBe('invalid_input');
    // Capability gate: a read-only principal cannot submit.
    expect((await refused(call(transport, { principal: 'reader' }, T.submit, submitArgs('reader')))).code)
      .toBe('missing_capability');
    // The owner still reads it; nothing above mutated the operation.
    expect(await ok(call(transport, ALPHA, T.status, { handle })))
      .toMatchObject({ phase: 'accepted', cancellationRequested: false });
  });
});

describe('P-017 transport parity', () => {
  it('returns byte-identical outcomes for the same caller over HTTP and MCP, and shares one durable handle', async () => {
    const viaHttpHandle = (await ok<{ handle: BlueprintOperationHandle }>(
      viaHttp(ALPHA, T.submit, submitArgs('parity')))).handle;
    const viaMcpHandle = (await ok<{ handle: BlueprintOperationHandle }>(
      viaMcp(ALPHA, T.submit, submitArgs('parity')))).handle;
    expect(viaMcpHandle).toEqual(viaHttpHandle);
    for (const name of [T.status, T.result, T.events]) {
      expect(await ok(viaMcp(ALPHA, name, { handle: viaHttpHandle }))).toEqual(
        await ok(viaHttp(ALPHA, name, { handle: viaHttpHandle })));
    }
    const conflict = submitArgs('parity', { value: 'other' });
    const httpRefusal = await viaHttp(ALPHA, T.submit, conflict);
    expect(httpRefusal).toMatchObject({ ok: false, status: 400 });
    expect(await refused(viaMcp(ALPHA, T.submit, conflict))).toEqual(await refused(Promise.resolve(httpRefusal)));
    expect(await viaHttp({ principal: 'reader' }, T.submit, submitArgs('reader'))).toMatchObject({ status: 403 });
  });

  it('serves the generic typed client through the projected port on either transport', async () => {
    type Ops = { extract: { input: { value: string }; output: { answer: string }; signals: { note: { text: string } } } };
    const invoker = (transport: Transport, caller: Caller) => async (name: string, args: Record<string, unknown>) => {
      const r = await call(transport, caller, name, args);
      if (!r.ok) throw new Error(`${r.code}: ${r.message}`);
      return r.data;
    };
    const scope = { workspaceId: WORKSPACE, harnessSlug: HARNESS, callerId: 'pi:alpha' };
    const overMcp = new BlueprintOperationClient<Ops>(createProjectedBlueprintOperationPort(invoker('mcp', ALPHA)), scope);
    const overHttp = new BlueprintOperationClient<Ops>(createProjectedBlueprintOperationPort(invoker('http', ALPHA)), scope);
    const handle = await overMcp.submit({ operationId: 'extract', input: { value: 'typed' }, requestKey: 'client' });
    expect(await overHttp.submit({ operationId: 'extract', input: { value: 'typed' }, requestKey: 'client' })).toEqual(handle);
    expect(await overHttp.status(handle)).toMatchObject({ phase: 'accepted' });
    expect(await overMcp.signal(handle, { channel: 'note', payload: { text: 'hi' }, requestKey: 'client-note' }))
      .toMatchObject({ accepted: true });
    await settleWithOutput(handle, 'typed-answer');
    const result = await overHttp.result(handle);
    expect(result.state).toBe('ready');
    if (result.state === 'ready') expect(result.output.answer).toBe('typed-answer');
    // A client bound to another caller is refused by the transport identity.
    const foreign = new BlueprintOperationClient<Ops>(
      createProjectedBlueprintOperationPort(invoker('mcp', { principal: 'beta', client: 'pi:alpha' })), scope);
    await expect(foreign.status(handle)).rejects.toThrow('handle_mismatch');
  });
});

describe.each<Transport>(['http', 'mcp'])('P-012b business review over %s', transport => {
  async function reviewedOperation() {
    const source = { ...OPERATION_SOURCE, operations: OPERATION_SOURCE.operations.map(op => ({
      ...op, acceptance: { ...op.acceptance, businessReview: {
        accountableOwner: 'engineering-owner', reviewerPrincipals: ['pi:beta', 'pi:alpha'],
      } },
    })) };
    await projectBlueprintToPg(db.sql, { workspaceId: WORKSPACE, harnessSlug: HARNESS,
      blueprint: BlueprintSchema.parse(source), specification: compileAgentSpecification({ source }) });
    const { handle } = await ok<{ handle: BlueprintOperationHandle }>(call(transport,
      { principal: 'alpha', client: 'employee-session' }, T.submit, submitArgs('business')));
    return handle;
  }
  async function complete(handle: BlueprintOperationHandle, answer: string, attempt = 'completion:1') {
    await settleWithOutput(handle, answer);
    if (handle.target.kind !== 'work-item') throw new Error('expected work item');
    await db.sql`UPDATE harness_shared.work_items SET terminal_owner = 'worker', terminal_completion_ref = ${attempt}
      WHERE workspace_id = ${WORKSPACE} AND harness_slug = ${HARNESS} AND feature_id = ${handle.target.id}`;
  }
  const employee: Caller = { principal: 'alpha', client: 'employee-session' };
  const reviewer: Caller = { principal: 'beta', client: 'review-session' };

  it.each(['accept', 'reject', 'rework'] as const)('retains a distinct %s decision, exact output and replay receipt', async decision => {
    const handle = await reviewedOperation();
    const premature = { handle, channel: 'business-review', requestKey: 'review:1',
      payload: { decision, reason: 'Reviewed the cited output', resultFingerprint: 'a'.repeat(64) } };
    expect((await refused(call(transport, reviewer, T.signal, premature))).message).toMatch(/^terminal:/);
    await complete(handle, 'Prepared engineering handoff');
    const prepared = await ok<{ businessReview: { state: string; resultFingerprint: string } }>(
      call(transport, employee, T.result, { handle }));
    expect(prepared.businessReview.state).toBe('pending');
    expect(await ok(call(transport, reviewer, T.result, { handle, review: true }))).toMatchObject({ state: 'ready' });
    // A client alias cannot grant another principal's access or bypass separation.
    for (const caller of [{ principal: 'alpha', client: 'different-session' },
      { principal: 'reader', client: 'pi:beta' }] as Caller[]) {
      expect((await refused(call(transport, caller, T.result, { handle, review: true }))).message).toMatch(/^handle_mismatch:/);
    }
    expect((await refused(call(transport, { principal: 'gamma' }, T.result, { handle, review: true }))).message).toMatch(/^scope_mismatch:/);
    expect((await refused(call(transport, reviewer, T.result, { handle }))).message).toMatch(/^handle_mismatch:/);
    const request = { ...premature, payload: { ...premature.payload, resultFingerprint: prepared.businessReview.resultFingerprint } };
    expect((await refused(call(transport, { principal: 'alpha', client: 'different-session' }, T.signal, request))).message).toMatch(/^handle_mismatch:/);
    const saved = await ok<{ eventId: string }>(call(transport, reviewer, T.signal, request));
    expect(await ok(call(transport, reviewer, T.signal, request))).toMatchObject({ replayed: true, eventId: saved.eventId });
    expect((await refused(call(transport, reviewer, T.signal, { ...request,
      payload: { ...request.payload, reason: 'Changed reason' } }))).message).toMatch(/^input_conflict:/);
    const result = await ok(call(transport, employee, T.result, { handle }));
    expect(result).toMatchObject({ state: 'ready', output: { answer: 'Prepared engineering handoff' },
      businessReview: { state: decision === 'accept' ? 'accepted' : decision === 'reject' ? 'rejected' : 'rework',
        accountableOwner: 'engineering-owner', decision: { reviewerPrincipal: 'pi:beta', eventId: saved.eventId } } });
    const events = await ok<{ events: Array<{ kind: string }> }>(call(transport, reviewer, T.events, { handle, review: true }));
    expect(events.events.filter(event => event.kind === 'business-review')).toHaveLength(1);
    // Review authorization gives no access to ordinary control inputs.
    expect((await refused(call(transport, reviewer, T.signal, { handle, channel: 'note',
      payload: { text: 'foreign' }, requestKey: 'foreign' }))).message).toMatch(/^handle_mismatch:/);
  });

  it('refuses stale result decisions, worker self-review, and prior-attempt acceptance', async () => {
    const handle = await reviewedOperation();
    await complete(handle, 'First output');
    const first = await ok<{ businessReview: { resultFingerprint: string } }>(call(transport, employee, T.result, { handle }));
    const input = { handle, channel: 'business-review', requestKey: 'decision',
      payload: { decision: 'accept', reason: 'Accepted', resultFingerprint: first.businessReview.resultFingerprint } };
    await ok(call(transport, reviewer, T.signal, input));
    await complete(handle, 'First output', 'completion:2');
    expect((await refused(call(transport, reviewer, T.signal, input))).message).toMatch(/^invalid_payload:/);
    const next = await ok<{ businessReview: { state: string; resultFingerprint: string } }>(call(transport, employee, T.result, { handle }));
    expect(next.businessReview.state).toBe('pending');
    expect(next.businessReview.resultFingerprint).not.toBe(first.businessReview.resultFingerprint);
    expect((await refused(call(transport, reviewer, T.signal, { ...input,
      payload: { ...input.payload, resultFingerprint: next.businessReview.resultFingerprint } }))).message).toMatch(/^input_conflict:/);
    if (handle.target.kind !== 'work-item') throw new Error('expected work item');
    await db.sql`UPDATE harness_shared.work_items SET terminal_owner = 'pi:beta/worker-client'
      WHERE workspace_id = ${WORKSPACE} AND feature_id = ${handle.target.id}`;
    expect((await refused(call(transport, reviewer, T.result, { handle, review: true }))).message).toMatch(/^handle_mismatch:/);
  });
});

describe.each<Transport>(['http', 'mcp'])('P-011 neutral consumers over %s', (transport) => {
  it('uses one public lifecycle for independent schemas and scopes without creating plans', async () => {
    const secondHarness = 'neutral-consumer-b';
    const secondSource = {
      id: 'neutral-consumer-b', workItem: { kind: 'feature' },
      roles: [{ id: 'worker' }], spine: { steps: [{ id: 'open', op: 'coord:thread-open', args: { title: 'Score' } }] },
      operations: [{
        id: 'score', version: 'B', target: { kind: 'work-item', itemKind: 'feature' },
        execution: { kind: 'agent', role: 'worker' },
        policy: { identity: { kind: 'identity', ref: 'operation-tools-worker', revision: '1.0.0', contentHash: 'b'.repeat(64) } },
        inputSchema: { type: 'object', required: ['count'],
          properties: { count: { type: 'integer' } }, additionalProperties: false },
        acceptance: { resultSchema: { type: 'object', required: ['score'],
          properties: { score: { type: 'integer' } }, additionalProperties: false } },
        signals: { adjust: { payloadSchema: { type: 'object', required: ['delta'],
          properties: { delta: { type: 'integer' } } } } },
        waits: { review: { responseSchema: { type: 'object', required: ['accepted'],
          properties: { accepted: { type: 'boolean' } } } } },
      }, {
        id: 'score-program', version: 'B', target: { kind: 'work-item', itemKind: 'feature' },
        execution: { kind: 'program' },
        inputSchema: { type: 'object', required: ['count'],
          properties: { count: { type: 'integer' } }, additionalProperties: false },
        acceptance: { resultSchema: { type: 'object', required: ['score'],
          properties: { score: { type: 'integer' } }, additionalProperties: false } },
      }],
    };
    await projectBlueprintToPg(db.sql, {
      workspaceId: 'other-ws', harnessSlug: secondHarness,
      blueprint: BlueprintSchema.parse(secondSource),
      specification: compileAgentSpecification({ source: secondSource }),
    });

    const first = (await ok<{ handle: BlueprintOperationHandle }>(call(transport, ALPHA, T.submit,
      submitArgs('neutral-a', { value: 'alpha' })))).handle;
    const secondArgs = { harness: secondHarness, operationId: 'score',
      requestKey: 'neutral-b', input: { count: 7 }, title: 'Score' };
    const second = (await ok<{ handle: BlueprintOperationHandle }>(call(transport,
      { principal: 'gamma' }, T.submit, secondArgs))).handle;
    expect(first.target.kind).toBe('work-item');
    expect(second.target.kind).toBe('work-item');
    expect(first).toMatchObject({ workspaceId: WORKSPACE, harnessSlug: HARNESS, operationId: 'extract' });
    expect(second).toMatchObject({ workspaceId: 'other-ws', harnessSlug: secondHarness, operationId: 'score' });
    expect((await ok<{ handle: unknown }>(call(transport, { principal: 'gamma' }, T.submit, secondArgs))).handle)
      .toEqual(second);
    expect((await refused(call(transport, { principal: 'gamma' }, T.submit,
      { ...secondArgs, input: { count: 8 } }))).message).toContain('input_conflict');
    expect((await refused(call(transport, { principal: 'gamma' }, T.submit,
      { ...secondArgs, input: { value: 'wrong schema' }, requestKey: 'wrong-schema' }))).message)
      .toMatch(/^invalid_payload: /);

    for (const [caller, own, foreign] of [
      [ALPHA, first, second], [{ principal: 'gamma' } as Caller, second, first],
    ] as const) {
      expect(await ok(call(transport, caller, T.status, { handle: own })))
        .toMatchObject({ phase: 'accepted' });
      for (const name of [T.status, T.result, T.events]) {
        expect((await refused(call(transport, caller, name, { handle: foreign }))).message)
          .toMatch(/^scope_mismatch:/);
      }
      expect((await refused(call(transport, caller, T.cancel,
        { handle: foreign, requestKey: 'foreign-cancel', reason: 'foreign' }))).message)
        .toMatch(/^scope_mismatch:/);
      expect((await refused(call(transport, caller, T.resume,
        { handle: foreign, token: 'foreign-wait', response: {}, requestKey: 'foreign-resume' }))).message)
        .toMatch(/^scope_mismatch:/);
    }
    const signal = await ok<{ accepted: boolean }>(call(transport, { principal: 'gamma' }, T.signal,
      { handle: second, channel: 'adjust', payload: { delta: 2 }, requestKey: 'adjust-1' }));
    expect(signal.accepted).toBe(true);
    await openBlueprintOperationWait(db.sql, second, 'pi:gamma', { waitName: 'review', token: 'review-1' });
    expect(await ok(call(transport, { principal: 'gamma' }, T.resume,
      { handle: second, token: 'review-1', response: { accepted: true }, requestKey: 'review-1' })))
      .toMatchObject({ accepted: true });

    if (first.target.kind !== 'work-item' || second.target.kind !== 'work-item') {
      throw new Error('neutral direct consumers must create work items');
    }
    await settleWithOutput(first, 'alpha-result');
    await db.sql`
      UPDATE harness_shared.work_items
         SET status = 'passed', authority = 'committed',
             payload = payload || ${JSON.stringify({ blueprintResult: {
               operationId: 'score', specificationRevision: second.specificationRevision,
               output: { score: 9 }, evidenceRef: 'verification:neutral-consumer-b',
             } })}::text::jsonb
       WHERE workspace_id = ${'other-ws'} AND harness_slug = ${secondHarness}
         AND feature_id = ${second.target.id}`;
    expect(await ok(call(transport, ALPHA, T.result, { handle: first })))
      .toMatchObject({ state: 'ready', output: { answer: 'alpha-result' } });
    expect(await ok(call(transport, { principal: 'gamma' }, T.result, { handle: second })))
      .toMatchObject({ state: 'ready', output: { score: 9 } });
    const [counts] = await db.sql<Array<{ items: number; plans: number; runs: number }>>`
      SELECT (SELECT count(*)::int FROM harness_shared.work_items
               WHERE workspace_id IN (${WORKSPACE}, ${'other-ws'})) AS items,
             (SELECT count(*)::int FROM harness_shared.harness_plans
               WHERE workspace_id IN (${WORKSPACE}, ${'other-ws'})) AS plans,
             (SELECT count(*)::int FROM harness_shared.plan_runs
               WHERE workspace_id IN (${WORKSPACE}, ${'other-ws'})) AS runs`;
    expect(counts).toEqual({ items: 2, plans: 0, runs: 0 });
  });

  it('admits different typed program roots through the same public tool without creating plans', async () => {
    const secondHarness = 'neutral-consumer-b';
    const secondSource = {
      id: 'neutral-consumer-b', workItem: { kind: 'feature' },
      roles: [{ id: 'worker' }], spine: { steps: [{ id: 'open', op: 'coord:thread-open', args: { title: 'Score' } }] },
      operations: [{
        id: 'score-program', version: 'B', target: { kind: 'work-item', itemKind: 'feature' },
        execution: { kind: 'program' },
        inputSchema: { type: 'object', required: ['count'],
          properties: { count: { type: 'integer' } }, additionalProperties: false },
        acceptance: { resultSchema: { type: 'object', required: ['score'],
          properties: { score: { type: 'integer' } }, additionalProperties: false } },
      }],
    };
    await projectBlueprintToPg(db.sql, {
      workspaceId: 'other-ws', harnessSlug: secondHarness,
      blueprint: BlueprintSchema.parse(secondSource),
      specification: compileAgentSpecification({ source: secondSource }),
    });
    const cases = [
      { caller: ALPHA, harness: HARNESS, operationId: 'extract-program', input: { value: 'alpha' } },
      { caller: { principal: 'gamma' } as Caller, harness: secondHarness,
        operationId: 'score-program', input: { count: 7 } },
    ];
    for (const [index, fixture] of cases.entries()) {
      const args = { harness: fixture.harness, operationId: fixture.operationId,
        input: fixture.input, requestKey: `program-${index}`, title: `Program ${index}` };
      const first = (await ok<{ handle: BlueprintOperationHandle }>(
        call(transport, fixture.caller, T.submit, args))).handle;
      expect(first.target.kind).toBe('work-item');
      expect((await ok<{ handle: BlueprintOperationHandle }>(
        call(transport, fixture.caller, T.submit, args))).handle).toEqual(first);
      expect((await refused(call(transport, fixture.caller, T.submit,
        { ...args, input: index === 0 ? { value: 'changed' } : { count: 8 } }))).message)
        .toContain('input_conflict');
      const [stored] = await db.sql<Array<{ pin: { operationId: string; specificationRevision: string; input: unknown } }>>`
        SELECT payload->'blueprintOperation' AS pin
          FROM harness_shared.work_items
         WHERE workspace_id = ${first.workspaceId} AND harness_slug = ${first.harnessSlug}
           AND feature_id = ${(first.target as { id: string }).id}`;
      expect(stored?.pin).toMatchObject({ operationId: fixture.operationId, input: fixture.input,
        specificationRevision: first.specificationRevision });
      const specification = await readBlueprintSpecificationSnapshot(
        db.sql, first.workspaceId, first.harnessSlug, stored.pin.specificationRevision);
      expect(specification).not.toBeNull();
      const operation = operationFromSpecification(specification!, stored.pin.operationId).operation;
      expect(operation.execution?.kind).toBe('program');
      expect(operation.target).toMatchObject({ kind: 'work-item', itemKind: 'feature' });
    }
    const [counts] = await db.sql<Array<{ items: number; plans: number; runs: number }>>`
      SELECT (SELECT count(*)::int FROM harness_shared.work_items) AS items,
             (SELECT count(*)::int FROM harness_shared.harness_plans) AS plans,
             (SELECT count(*)::int FROM harness_shared.plan_runs) AS runs`;
    expect(counts).toEqual({ items: 2, plans: 0, runs: 0 });
  });
});

// WI-10004001: harness:create writes .papercusp/blueprint.yaml and leaves the PG projection
// lazy, so a harness that declares operations must accept its first submit without an
// orchestrator tick having projected it first.
describe.each<Transport>(['http', 'mcp'])('WI-10004001 lazy blueprint projection on submit over %s', (transport) => {
  const created: string[] = [];
  const freshSlug = (tag: string) => {
    const slug = `wi10004001-${tag}-${transport}-${globalThis.crypto.randomUUID().slice(0, 8)}`;
    created.push(slug);
    return slug;
  };
  afterAll(() => {
    for (const slug of created) rmSync(`/tmp/${slug}`, { recursive: true, force: true });
  });

  it('projects the git-canonical .papercusp/blueprint.yaml on first submit instead of refusing a fresh harness', async () => {
    // The state harness:create leaves behind: the file is written, nothing is projected yet.
    const slug = freshSlug('lazy');
    mkdirSync(`/tmp/${slug}/.papercusp`, { recursive: true });
    writeFileSync(`/tmp/${slug}/.papercusp/blueprint.yaml`, stringifyYaml(OPERATION_SOURCE));
    expect(await readBlueprintHashFromPg(db.sql, WORKSPACE, slug)).toBeNull();

    const args = { ...submitArgs('lazy-first'), harness: slug };
    const { handle } = await ok<{ handle: BlueprintOperationHandle }>(call(transport, ALPHA, T.submit, args));

    // Separates the root cause (submit read PG without the lazy projector) from the
    // alternative (projection itself fails for an operation-bearing blueprint): submit
    // succeeds AND its handle is pinned to exactly the revision the lazy path projected.
    const projected = await readBlueprintHashFromPg(db.sql, WORKSPACE, slug);
    expect(projected).toMatch(/^[0-9a-f]{64}$/);
    expect(handle).toMatchObject({
      workspaceId: WORKSPACE, harnessSlug: slug, operationId: 'extract',
      specificationRevision: projected, target: { kind: 'work-item' },
    });
    expect(await readBlueprintSpecificationSnapshot(db.sql, WORKSPACE, slug, projected!)).not.toBeNull();

    // A replayed submit returns the same handle from its receipt: one work item, not two.
    expect((await ok<{ handle: unknown }>(call(transport, ALPHA, T.submit, args))).handle).toEqual(handle);
    const [{ count }] = await db.sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM harness_shared.work_items
       WHERE workspace_id = ${WORKSPACE} AND harness_slug = ${slug}`;
    expect(count).toBe(1);
  });

  it('refuses a harness with neither a projection nor a blueprint file with the typed undeclared code', async () => {
    const slug = freshSlug('none');
    const refusal = await refused(call(transport, ALPHA, T.submit, { ...submitArgs('lazy-none'), harness: slug }));
    expect(refusal.code).toBe('invalid_input');
    expect(refusal.message).toMatch(/^undeclared: harness declares no blueprint operations/);
    expect(await readBlueprintHashFromPg(db.sql, WORKSPACE, slug)).toBeNull();
  });
});

// WI-10004360: createWorkItem re-homes a pot MEMBER harness's item to the pot home slug.
// Replay (same key + input) and status used to read it back by the MEMBER slug and answer
// "receipt points to a missing work item" / "missing or outside its harness".
describe.each<Transport>(['http', 'mcp'])('WI-10004360 pot member harness over %s', (transport) => {
  it('replays one item and reads its status when the item is stored under the pot home', async () => {
    const POT_HOME = 'papercup-pot-home';
    await db.sql`CREATE TABLE IF NOT EXISTS harness_shared.pots (
      workspace_id text NOT NULL, pot_home_slug text NOT NULL, PRIMARY KEY (workspace_id, pot_home_slug))`;
    await db.sql`INSERT INTO harness_shared.pots (workspace_id, pot_home_slug)
      VALUES (${WORKSPACE}, ${POT_HOME}) ON CONFLICT DO NOTHING`;
    // resolveRealPot canonicalizes BEFORE the member lookup, and HARNESS ('papercup') is a
    // legacy platform-pot spelling that folds to 'papercusp', so key the member map on both.
    const memberKeys = [HARNESS, canonicalPotSlug(HARNESS)];
    for (const k of memberKeys) h.potHomes[k] = POT_HOME;
    try {
      const { handle } = await ok<{ handle: BlueprintOperationHandle }>(
        call(transport, ALPHA, T.submit, submitArgs('pot-member')));
      if (handle.target.kind !== 'work-item') throw new Error('expected direct target');
      expect(handle.harnessSlug).toBe(HARNESS);
      // Positive control: the item really was re-homed, so this case exercises the bug.
      const stored = await db.sql<{ harness_slug: string }[]>`SELECT harness_slug FROM harness_shared.work_items
        WHERE workspace_id = ${WORKSPACE} AND feature_id = ${handle.target.id}`;
      expect(stored.map((r) => r.harness_slug)).toEqual([POT_HOME]);
      // Replay with the same key and input returns the same handle instead of a handler_error.
      expect((await ok<{ handle: unknown }>(call(transport, ALPHA, T.submit, submitArgs('pot-member')))).handle)
        .toEqual(handle);
      // Status reads the re-homed item.
      expect(await ok(call(transport, ALPHA, T.status, { handle }))).toMatchObject({ phase: 'accepted' });
    } finally {
      for (const k of memberKeys) delete h.potHomes[k];
      await db.sql`DELETE FROM harness_shared.pots WHERE workspace_id = ${WORKSPACE} AND pot_home_slug = ${POT_HOME}`;
    }
  });
});
