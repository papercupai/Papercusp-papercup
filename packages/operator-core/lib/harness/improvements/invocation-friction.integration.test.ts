import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createFreshPgDb, type FreshPgDb } from '../../../test/_pg-helpers';
import {
  buildExpiredInvocationFrictionQuery, captureInvocationFriction, recoverInvocationFriction,
} from './invocation-friction';
import { captureToolInvocationFriction, type CaptureDeps, type CaptureImprovementResult } from './capture-core';
import type { EngineerIssue } from '../../issues-engineer';
import type { RecordIssueOccurrenceInput } from '../../issue-occurrence-ledger';

vi.mock('../../sync-sse', () => ({ notifySyncInvalidate: vi.fn(async () => {}) }));
vi.mock('../../system-health/compute', () => ({ refreshHealthPanel: vi.fn(async () => {}) }));
// capture-core's best-effort `work-item:tool-failure-reporter` emit would otherwise open
// the protected live org-admin pool (refused since WI-10006585, which surfaced as a
// console.warn failure). No assertion here observes the wake, so keep it in-process.
vi.mock('../../events/await/engine', () => ({ emitAwaitedEvent: async () => ({}) }));
let db: FreshPgDb;
const source = (name: string) => readFile(fileURLToPath(new URL(
  `../../../../../libs/papercusp/libs/db/sql/${name}`, import.meta.url)), 'utf8');
beforeAll(async () => {
  db = await createFreshPgDb('invocation-friction');
  await db.sql.unsafe(`CREATE TABLE harness_shared.tool_invocations (
    id bigserial PRIMARY KEY, workspace_id text NOT NULL, harness_slug text NOT NULL,
    coord_owner_id text, invoked_at timestamptz NOT NULL DEFAULT now(), tool_name text,
    status text, error_code text, error_message text, serving_build_sha text, metadata_json jsonb);
    CREATE TABLE harness_shared.work_items (workspace_id text, harness_slug text,
    feature_id text PRIMARY KEY, item_kind text, status text, payload jsonb)`);
  // Apply the ARMED migration, never a .DRAFT (WI-10007741). This guard loaded the
  // 1148 draft for weeks, so its EXPLAIN assertions passed while no real database had
  // either index and the expiry sweep scanned all of tool_invocations (mean 124 s).
  // A missing armed file now fails here instead of passing vacuously.
  await db.sql.unsafe(await source('1454-tool-invocation-friction-pending-index.sql'));
  const identityMigration = await source('865-work-items-watchdog-key-identity-guard.sql');
  // Apply the real arbiter DDL, without the unrelated legacy repair population.
  const index = identityMigration.match(/CREATE UNIQUE INDEX IF NOT EXISTS work_items_watchdog_identity_uq[\s\S]*?;/);
  expect(index).not.toBeNull();
  await db.sql.unsafe(index![0]);
}, 120_000);
afterAll(async () => { await db?.cleanup(); });
beforeEach(async () => { await db.sql.unsafe('TRUNCATE harness_shared.tool_invocations, harness_shared.work_items RESTART IDENTITY'); });

const sql = () => db.sql as unknown as NonNullable<Parameters<typeof recoverInvocationFriction>[1]>['sql'];
async function seed(workspace = 'ws-a') {
  const [row] = await db.sql`INSERT INTO harness_shared.tool_invocations
    (workspace_id,harness_slug,coord_owner_id,tool_name,status,error_code,error_message,serving_build_sha,metadata_json)
    VALUES (${workspace},'papercusp','su-a','coord:send','invalid-input','invalid_input','body: must be an array',
      'loaded-build','{"frictionCapture":"pending","retained":"evidence"}') RETURNING id::text`;
  return { id: row.id, workspaceId: workspace };
}
const success = async (): Promise<CaptureImprovementResult> => ({
  ok: true, created: false, issue: { id: 'EI-1' } as EngineerIssue, possibleDuplicates: [],
});
const coalesced = async (): Promise<CaptureImprovementResult> => ({
  ok: true, created: false, reason: 'coalesced', possibleDuplicates: [],
});

/** Exercise the real correlation/promotion logic against persisted payloads.
 * Only issue storage/tagging seams are injected; no application DB or scheduler.
 * Read payloads back on every call so an in-memory mutation cannot fake a write. */
function persistedCapture() {
  const metadata = new Map<string, EngineerIssue>();
  const occurrences: RecordIssueOccurrenceInput[] = [];
  async function rows(workspace: string) {
    const persisted = await db.sql`SELECT feature_id, payload FROM harness_shared.work_items
      WHERE workspace_id=${workspace} ORDER BY feature_id`;
    return persisted.map(row => ({ ...metadata.get(row.feature_id)!, payload: row.payload }));
  }
  const capture: typeof captureToolInvocationFriction = async input => {
    const workspace = input.workspaceId;
    const deps: CaptureDeps = {
      searchIssues: async () => [],
      resolvePotScope: async ({ rawSlug }) => rawSlug,
      findIssuesByWatchdogKeys: async keys => (await rows(workspace))
        .filter(row => keys.includes(String(row.payload?.watchdogKey))),
      // Deliberately return other contracts too: the production classifier
      // must reject them, rather than relying on a helpful fixture filter.
      findIssuesByToolFailureClassKeys: async () => rows(workspace),
      createIssue: async issue => {
        const id = `EI-${metadata.size + 1}`;
        const row = { ...issue, id, state: 'open', signalOrigin: 'organic' } as EngineerIssue;
        metadata.set(id, row);
        await db.sql`INSERT INTO harness_shared.work_items
          (workspace_id,harness_slug,feature_id,item_kind,status,payload)
          VALUES (${workspace},${issue.scope ?? 'operator'},${id},${issue.kind ?? 'change'},'open',${db.sql.json(issue.payload as never)})`;
        return row;
      },
      updateIssuePatch: async (id, patch) => {
        metadata.set(id, { ...metadata.get(id)!, ...patch });
        return (await rows(workspace)).find(row => row.id === id)!;
      },
      mergeIssuePayload: async (id, patch, opts) => {
        const row = (await rows(workspace)).find(row => row.id === id)!;
        const payload = { ...row.payload, ...patch };
        for (const key of opts?.unset ?? []) delete payload[key];
        await db.sql`UPDATE harness_shared.work_items SET payload=${db.sql.json(payload as never)}
          WHERE workspace_id=${workspace} AND feature_id=${id}`;
        return (await rows(workspace)).find(row => row.id === id)!;
      },
      recordIssueOccurrence: async occurrence => { occurrences.push(occurrence); return null; },
      tagIssue: async () => {}, untagIssue: async () => {},
    };
    return captureToolInvocationFriction(input, deps);
  };
  async function invoke(change: {
    workspace?: string; owner?: string; schema?: string; build?: string; tool?: string; harness?: string;
  } = {}) {
    const workspace = change.workspace ?? 'ws-a';
    const tool = change.tool ?? 'coord:send';
    const metadataJson = { frictionCapture: 'pending',
      invalidInput: { source: 'projected-tool-registry', toolName: tool, registryRevision: change.schema ?? 'schema-one' },
      toolFailure: { reproduced: true, hardInternal: true } };
    const [ref] = await db.sql`INSERT INTO harness_shared.tool_invocations
      (workspace_id,harness_slug,coord_owner_id,tool_name,status,error_code,error_message,serving_build_sha,metadata_json)
      VALUES (${workspace},${change.harness ?? 'papercusp'},${change.owner ?? 'su-a'},${tool},
        'invalid-input','invalid_input','body: must be an array',${change.build ?? 'loaded-build'},
        ${db.sql.json(metadataJson)}) RETURNING id::text`;
    expect(await captureInvocationFriction({ id: ref.id, workspaceId: workspace }, { sql: sql(), capture })).toBe(true);
    expect((await db.sql`SELECT metadata_json FROM harness_shared.tool_invocations WHERE id=${ref.id}`)[0].metadata_json)
      .toHaveProperty('frictionCapture', 'delivered');
  }
  return { rows, invoke, occurrences };
}

describe('R7 private PostgreSQL delivery contract', () => {
  it('correlates actual invocation retries and promotes only an independent reporter without losing identity', async () => {
    const f = persistedCapture();
    await f.invoke();
    await f.invoke();
    const repeated = await f.rows('ws-a');
    expect(repeated).toHaveLength(1);
    const id = repeated[0].id;
    expect(repeated[0]).toMatchObject({ kind: 'change', severity: 'nit', payload: {
      lane: 'observation', toolFailureProbation: { class: 'caller', state: 'probation',
        direct: false, reporters: ['su-a'] },
    } });
    expect(repeated[0].payload?.toolFailureProbation).not.toHaveProperty('report.reproduced');
    await f.invoke({ owner: 'su-b' });
    const promoted = await f.rows('ws-a');
    expect(promoted).toHaveLength(1);
    expect(promoted[0]).toMatchObject({ id, kind: 'change', payload: {
      toolFailureProbation: { class: 'caller', state: 'promoted', reporters: ['su-a', 'su-b'] },
      implementationReadiness: { status: 'unknown', reason: 'awaiting-agent-review' },
    } });
    expect(promoted[0].payload).not.toHaveProperty('lane', 'observation');
    // A further automatic report appends evidence; it cannot downgrade the
    // accountable row, clear its readiness, or manufacture another issue.
    await f.invoke();
    expect(await f.rows('ws-a')).toEqual(promoted);
    expect(f.occurrences.filter(row => row.canonicalId === id)).toHaveLength(4);
  });

  it('keeps changed tool, harness and workspace reports separate through delivery', async () => {
    const f = persistedCapture();
    await f.invoke();
    const original = (await f.rows('ws-a'))[0];
    for (const change of [{ tool: 'coord:handoff' }, { harness: 'other-pot' }, { workspace: 'ws-b' }]) {
      await f.invoke({ ...change, owner: 'su-b' });
    }
    const local = await f.rows('ws-a');
    const other = await f.rows('ws-b');
    expect(local).toHaveLength(3);
    expect(other).toHaveLength(1);
    expect(local.find(row => row.id === original.id)).toEqual(original);
    for (const row of [...local, ...other]) expect(row.payload).toMatchObject({
      lane: 'observation', toolFailureProbation: { state: 'probation', direct: false },
    });
  });

  it('D-010: a changed schema or loaded build counts onto the signature row without corroborating it', async () => {
    const f = persistedCapture();
    await f.invoke();
    const original = (await f.rows('ws-a'))[0];
    // su-b is independent of su-a, but each report is a different contract/build
    // class, so neither may promote or rewrite su-a's probation observation.
    for (const change of [{ schema: 'schema-two' }, { build: 'other-build' }]) {
      await f.invoke({ ...change, owner: 'su-b' });
    }
    const local = await f.rows('ws-a');
    expect(local).toHaveLength(1);
    expect(local[0].id).toBe(original.id);
    expect(local[0].payload).toMatchObject({ lane: 'observation', repeatCount: 3,
      watchdogKey: original.payload?.watchdogKey });
    expect(local[0].payload?.toolFailureProbation).toEqual(original.payload?.toolFailureProbation);
    const classes = Object.values((local[0].payload?.toolFailureSignature as { classes: object }).classes);
    expect(classes).toHaveLength(3);
    // One occurrence for the first filing, one per folded report.
    expect(f.occurrences.filter(row => row.canonicalId === original.id)).toHaveLength(3);
  });

  it('rolls back failure, recovers below-threshold invalid calls and preserves other metadata', async () => {
    const ref = await seed();
    await expect(captureInvocationFriction(ref, { sql: sql(), capture: async () => { throw new Error('fixture failure'); } })).rejects.toThrow('fixture failure');
    expect((await db.sql`SELECT metadata_json FROM harness_shared.tool_invocations`)[0].metadata_json.frictionCapture).toBe('pending');
    expect(await recoverInvocationFriction('ws-a', { sql: sql(), capture: success })).toEqual({ delivered: 1, pending: 0, expired: 0 });
    expect((await db.sql`SELECT metadata_json FROM harness_shared.tool_invocations`)[0].metadata_json)
      .toEqual({ frictionCapture: 'delivered', retained: 'evidence' });
    expect(await captureInvocationFriction(ref, { sql: sql(), capture: success })).toBe(false);
  });

  it('expires older-than-24-hour pending rows while recovering recent rows', async () => {
    const stale = await seed();
    await db.sql`UPDATE harness_shared.tool_invocations
      SET invoked_at = now() - interval '25 hours'
      WHERE workspace_id='ws-a' AND id=${stale.id}`;
    const recent = await seed();
    const capture = vi.fn(success);
    expect(await recoverInvocationFriction('ws-a', { sql: sql(), capture })).toEqual({ delivered: 1, pending: 0, expired: 1 });
    const rows = await db.sql`SELECT id::text, metadata_json FROM harness_shared.tool_invocations ORDER BY invoked_at,id`;
    expect(rows).toHaveLength(2);
    expect(rows[0].metadata_json).toMatchObject({ frictionCapture: 'expired', frictionExpiredReason: 'older-than-24-hours' });
    expect(rows[0].metadata_json.frictionExpiredAt).toBeTypeOf('string');
    expect(rows[1]).toMatchObject({ id: recent.id, metadata_json: { frictionCapture: 'delivered' } });
    expect(capture).toHaveBeenCalledTimes(1);
    expect(await recoverInvocationFriction('ws-a', { sql: sql(), capture })).toEqual({ delivered: 0, pending: 0, expired: 0 });
  });

  it('persists safe failure class/code for retry and clears them after successful delivery', async () => {
    const ref = await seed();
    const failure = Object.assign(new Error('sensitive invocation detail'), {code:'23505'});
    const failCapture = vi.fn(async () => { throw failure; });
    await expect(recoverInvocationFriction('ws-a', { sql: sql(), capture: failCapture }))
      .rejects.toThrow('failure classes: Error/23505=1');
    const [failed] = await db.sql`SELECT metadata_json FROM harness_shared.tool_invocations
      WHERE workspace_id='ws-a' AND id=${ref.id}`;
    expect(failed.metadata_json).toMatchObject({frictionCapture:'pending',frictionFailureClass:'Error',frictionFailureCode:'23505'});
    expect(JSON.stringify(failed.metadata_json)).not.toContain('sensitive invocation detail');

    expect(await recoverInvocationFriction('ws-a', {sql:sql(),capture:coalesced}))
      .toEqual({delivered:1,pending:0,expired:0});
    const [delivered] = await db.sql`SELECT metadata_json FROM harness_shared.tool_invocations
      WHERE workspace_id='ws-a' AND id=${ref.id}`;
    expect(delivered.metadata_json).toMatchObject({frictionCapture:'delivered'});
    expect(delivered.metadata_json).not.toHaveProperty('frictionFailureClass');
    expect(delivered.metadata_json).not.toHaveProperty('frictionFailureCode');
  });

  it('concurrent delivery skips the row lock and never crosses workspace scope', async () => {
    const ref = await seed();
    await seed('ws-b');
    let enter!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const capture = vi.fn(async () => { enter(); await held; return success(); });
    const first = captureInvocationFriction(ref, { sql: sql(), capture });
    await entered;
    try {
      expect(await captureInvocationFriction(ref, { sql: sql(), capture: success })).toBe(false);
      expect(await captureInvocationFriction({ ...ref, workspaceId: 'ws-b' }, { sql: sql(), capture: success })).toBe(false);
    } finally { release(); }
    expect(await first).toBe(true);
    expect(capture).toHaveBeenCalledTimes(1);
    expect((await db.sql`SELECT metadata_json FROM harness_shared.tool_invocations WHERE workspace_id='ws-b'`)[0].metadata_json.frictionCapture).toBe('pending');
  });

  it('the pending-index predicate matches the actual recovery query', async () => {
    await seed();
    const [{ plan }] = await db.sql.begin(async tx => {
      await tx.unsafe('SET LOCAL enable_seqscan = off');
      const rows = await tx.unsafe(`EXPLAIN (FORMAT JSON) SELECT id::text FROM harness_shared.tool_invocations
        WHERE workspace_id='ws-a' AND metadata_json->>'frictionCapture'='pending'
        ORDER BY COALESCE(metadata_json->>'frictionAttemptAt',''),invoked_at,id LIMIT 100`);
      return [{ plan: rows[0]['QUERY PLAN'] }];
    });
    expect(JSON.stringify(plan)).toContain('tool_invocations_friction_pending_idx');
  });

  it('uses the expiry index for the exact bounded stale-expiry CTE and update', async () => {
    await seed();
    const staleBefore = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const query = buildExpiredInvocationFrictionQuery();
    const [{ plan }] = await db.sql.begin(async tx => {
      await tx.unsafe('SET LOCAL enable_seqscan = off');
      const rows = await tx.unsafe(`EXPLAIN (FORMAT JSON) ${query}`, ['ws-a', staleBefore]);
      return [{ plan: rows[0]['QUERY PLAN'] }];
    });
    expect(JSON.stringify(plan)).toContain('tool_invocations_friction_pending_expiry_idx');
  });

  it('D-010: incomplete metadata keeps changed contracts on the exact-message row without promoting it', async () => {
    const f = persistedCapture();
    await f.invoke({ schema: 'schema-one', owner: 'schema-one' });
    const original = (await f.rows('ws-a'))[0];
    await f.invoke({ schema: 'schema-two', owner: 'schema-two' });
    const persisted = await db.sql`SELECT payload FROM harness_shared.work_items ORDER BY feature_id`;
    expect(persisted).toHaveLength(1);
    expect(persisted[0].payload.watchdogKey).toBe(original.payload?.watchdogKey);
    expect(String(persisted[0].payload.watchdogKey)).toMatch(/^repeated-tool-error:/);
    expect(persisted[0].payload.toolFailureProbation).toMatchObject({ state: 'probation', reporters: ['schema-one'] });
    expect(persisted[0].payload.repeatCount).toBe(2);
    expect(Object.keys(persisted[0].payload.toolFailureSignature.classes)).toHaveLength(2);
    // Prove the real arbiter can refuse, rather than merely reading two rows
    // from a fixture whose JSON was accidentally encoded as a string.
    await expect(db.sql`INSERT INTO harness_shared.work_items (workspace_id,harness_slug,feature_id,item_kind,status,payload)
      SELECT workspace_id,harness_slug,'EI-conflict',item_kind,status,payload FROM harness_shared.work_items LIMIT 1`)
      .rejects.toMatchObject({ code: '23505', constraint_name: 'work_items_watchdog_identity_uq' });
  });
});
