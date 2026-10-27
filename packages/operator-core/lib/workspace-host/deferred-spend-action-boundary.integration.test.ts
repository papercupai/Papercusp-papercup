/** P008 source controls: migrated private Postgres, RLS and repeatable-read/read-only.
 * Native evidence below is a stored fixture artifact; no native/provider action runs.
 */
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { deferredSpendEvidenceIdentitySchema, deferredSpendFingerprint, type DeferredSpendEvidence, type DeferredSpendEvidenceIdentity } from './deferred-spend-acceptance-contract';
import { collectDeferredSpendActionBoundary, type DeferredSpendActionBoundaryRequest, type DeferredSpendActionDependencies,
  type DeferredSpendActionLineage, type DeferredSpendActionRecord, type DeferredSpendActionSnapshot, type DeferredSpendActionStream } from './deferred-spend-action-boundary';

const START = '2026-09-01T00:00:00Z', END = '2026-10-01T00:00:00Z', AT = '2026-09-15T00:00:00Z';
const target = { ref: 'p018-canary-20260905-r7', generation: '1' };
const scopeIds = ['original', 'acceptance', 'successor', 'child'];
const refs = ['fixture:independently-reviewed-population'];

function identity(workspaceId: string) {
  const scope = { workspaceId, harness: 'papercusp', planSlug: 'deferred-spend', rubricRef: 'acceptance', rubricRevision: 7, criteriaHash: 'a'.repeat(64) };
  const provenance = { method: 'independent-reviewed-fixture', selector: 'full-operation-event-invocation-fixture', evidenceRefs: refs };
  const hash = 'a'.repeat(64), base = 'a'.repeat(40), candidate = 'b'.repeat(40);
  const content = (path: string) => ({ path, contentHash: hash, provenance });
  return deferredSpendEvidenceIdentitySchema.parse({ schemaVersion: 'deferred-spend-evidence-v1', scope,
    subject: { kind: 'source', ref: 'integration:action-boundary' }, observation: { id: 'observation', observedAt: '2026-10-01T00:00:02Z',
      window: { startAt: START, endAt: END }, serving: { hostId: 'private-pg', processId: 'fixture:1', buildId: 'test-source', runtimeGeneration: '1' },
      snapshot: { id: 'snapshot:pg', acquiredAt: '2026-10-01T00:00:01Z', scopeHash: deferredSpendFingerprint(scope), consistency: 'consistent-read-only', evidenceRefs: refs } },
    sourceManifestHash: hash, configurationHash: hash,
    censusSelectors: { base: { revision: base, treeHash: hash, provenance }, candidate: { revision: candidate, treeHash: hash, provenance },
      roots: { repositoryRoot: '/repo', workspaceRoot: '/workspace', contentHash: hash, provenance },
      projectConfiguration: { contentHash: hash, provenance, tsconfigs: [content('tsconfig.json')], projectReferences: [] },
      migrationRegistry: { revision: candidate, contentHash: hash, provenance, entries: [] }, productionRoots: [content('src')],
      changedPaths: { method: 'reviewed-base-to-candidate-diff', baseRevision: base, candidateRevision: candidate, populationHash: deferredSpendFingerprint([]), provenance, entries: [] } } });
}
function record(workspaceId: string, id: string, actorId: string, action: DeferredSpendActionRecord['action']): DeferredSpendActionRecord {
  return { id, workspaceId, occurredAt: AT, action, target, operationId: null, invocationId: null,
    writeTime: { actorId, actorGeneration: '1', principalId: `principal:${actorId}`, sessionId: `session:${actorId}`, workItemId: `WI:${actorId}`,
      sourceRef: 'fixture:write-time-provenance', processId: 'fixture:writer', buildId: 'fixture:writer-build' },
    authorization: actorId !== 'independent' ? null : { id: 'auth:separate-later-cleanup', actorId, workItemId: 'WI:independent', issuedAt: '2026-09-10T00:00:00Z',
      action, target, independentOf: ['original', 'acceptance'], separateCausalRoot: true, lineageRefs: ['fixture:independent-causal-root'], evidenceRefs: refs },
    audit: { complete: true, evidenceRefs: refs }, evidenceRefs: refs };
}

describe('P008 action boundary (isolated PostgreSQL)', () => {
  let db: OrgTestDb;
  const workspaceId = `action_${randomBytes(6).toString('hex')}`;
  const expectedIdentity = identity(workspaceId);
  const request: DeferredSpendActionBoundaryRequest = { expectedIdentity,
    implementation: [{ actorId: 'original', startedAt: START, evidenceRefs: refs }],
    acceptance: [{ actorId: 'acceptance', startedAt: '2026-09-02T00:00:00Z', evidenceRefs: refs }],
    boundaries: { r7: target, g6: { ref: 'conv-mtrj4304-0000-464a5dc2fb3d4fb395fe6aabdc0a5536', generation: '1' }, r31: { ref: 'p018-r31-ready', generation: '1' } } };
  const source: DeferredSpendEvidence = { identity: expectedIdentity, slices: [{ id: 'source-census', verdict: 'pass', evidenceRefs: refs, violations: [],
    coverage: { state: 'complete', population: ['source:fixture'], checked: ['source:fixture'], notChecked: [], notApplicable: [], residue: [], gaps: [],
      snapshotRef: 'snapshot:pg', pageRefs: refs, emptyPopulationEvidenceRefs: [] } }] };
  const lineage: DeferredSpendActionLineage = { snapshotRef: 'snapshot:pg', complete: true, historyComplete: true, evidenceRefs: refs,
    actors: [...scopeIds, 'independent'].map((id) => ({ id, generation: '1', principalId: `principal:${id}`, sessionId: `session:${id}`, workItemId: `WI:${id}`, evidenceRefs: refs })),
    edges: [{ from: 'original', to: 'successor', relation: 'continuation', evidenceRefs: refs }, { from: 'successor', to: 'child', relation: 'child', evidenceRefs: refs }], aliases: [] };
  beforeAll(async () => {
    db = await createOrgTestDb();
    for (const ws of [workspaceId, `${workspaceId}_foreign`]) {
      await db.adminSql`INSERT INTO harness_shared.workspace_host_connections (workspace_id,id,target,label,credential_ref,provider_config,status)
        VALUES (${ws},'fixture-connection','gcp','private fixture','fixture://never-resolve','{}','connected')`;
      await db.adminSql`INSERT INTO harness_shared.workspace_hosts (workspace_id,id,name,connection_id,target,scope_label,region,size,image,disk_gib,network,desired_state,observed_state)
        VALUES (${ws},${target.ref},'private fixture','fixture-connection','gcp','fixture','us-central1','e2-small','fixture-image',20,'default','absent','absent')`;
      for (const row of [record(ws, '01-read', 'original', 'observe'), record(ws, '02-cleanup', 'independent', 'destroy')]) {
        await db.adminSql`INSERT INTO harness_shared.workspace_host_operations (workspace_id,id,host_id,action,status,request,created_at)
          VALUES (${ws},${row.id},${target.ref},'destroy','succeeded',${db.adminSql.json(row)},${AT})`;
      }
      const event = record(ws, 'event-read', 'original', 'observe'); event.operationId = '01-read';
      await db.adminSql`INSERT INTO harness_shared.workspace_host_events (workspace_id,id,host_id,operation_id,occurred_at,phase,status,message,details)
        VALUES (${ws},${event.id},${target.ref},'01-read',${AT},'fixture','succeeded','private fixture',${db.adminSql.json(event)})`;
    }
    for (const [id, stream] of [[100, 'invocations'], [101, 'native']] as const) {
      const row = record(workspaceId, String(id), 'original', 'observe'); if (stream === 'native') row.invocationId = '100';
      await db.adminSql`INSERT INTO harness_shared.tool_invocations
        (id,workspace_id,harness_slug,plugin_name,tool_name,role,spawn_id,window_key,invoked_at,status,args_json,metadata_json,coord_owner_id,goal_id,goal_actor_class,serving_process_id,serving_build_sha)
        VALUES (${id},${workspaceId},'papercusp','fixture','fixture:read','operator','fixture','fixture',${AT},'ok',${db.adminSql.json(row)},${db.adminSql.json({ stream })},'original','WI:original','fixture','fixture:writer','fixture:writer-build')`;
    }
  }, 180_000);
  afterAll(async () => { await db?.cleanup(); });

  function assembly(options: { omitPage?: boolean; nativeGap?: boolean; lineageGap?: boolean } = {}) {
    const dependencies: DeferredSpendActionDependencies = {
      withSnapshot: async <T>(_identity: DeferredSpendEvidenceIdentity, read: (snapshot: DeferredSpendActionSnapshot) => Promise<T>): Promise<T> => {
        const result = await db.appSql.begin(async (tx) => {
          await tx`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`;
          await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
          const [settings] = await tx`SELECT current_setting('transaction_read_only') AS read_only, current_setting('transaction_isolation') AS isolation`;
          expect(settings).toMatchObject({ read_only: 'on', isolation: 'repeatable read' });
          async function rows(stream: DeferredSpendActionStream): Promise<DeferredSpendActionRecord[]> {
            // No workspace WHERE on RLS tables: actual RLS must exclude foreign same-ID rows.
            if (stream === 'operations') return (await tx`SELECT request AS row FROM harness_shared.workspace_host_operations
              WHERE created_at >= ${START} AND created_at <= ${END} ORDER BY id COLLATE "C"`).map((r) => r.row);
            if (stream === 'events') return (await tx`SELECT details AS row FROM harness_shared.workspace_host_events
              WHERE occurred_at >= ${START} AND occurred_at <= ${END} ORDER BY id COLLATE "C"`).map((r) => r.row);
            // Invocation ledger is explicitly workspace scoped in addition to its platform policy.
            return (await tx`SELECT args_json AS row FROM harness_shared.tool_invocations
              WHERE workspace_id=${workspaceId} AND metadata_json->>'stream'=${stream} AND invoked_at >= ${START} AND invoked_at <= ${END}
              ORDER BY id`).map((r) => r.row);
          }
          return read({ identity: expectedIdentity, readLineage: async () => ({ ...lineage, historyComplete: !options.lineageGap }),
            readCensus: async (stream) => { const all = await rows(stream); return { snapshotRef: 'snapshot:pg', complete: true, retentionComplete: true,
              window: expectedIdentity.observation.window, count: all.length, upperWatermark: all.at(-1)?.id ?? null, evidenceRefs: [`pg:census:${stream}`] }; },
            readPage: async (stream, after, upperWatermark) => { const all = (await rows(stream)).filter((r) => after === null || r.id > after);
              const page = all.slice(0, 1).map((row) => stream === 'native' && options.nativeGap ? { ...row, audit: { complete: false, evidenceRefs: refs } } : row);
              return { snapshotRef: 'snapshot:pg', after, upperWatermark, records: page,
                nextAfter: !options.omitPage && all.length > 1 ? all[0].id : null, evidenceRef: `pg:page:${stream}:${after}` }; },
          });
        });
        return result as T;
      },
    };
    return () => collectDeferredSpendActionBoundary(request, source, dependencies);
  }
  async function replaceCleanup(row: DeferredSpendActionRecord, check: () => Promise<void>) {
    await db.adminSql`UPDATE harness_shared.workspace_host_operations SET request=${db.adminSql.json(row)} WHERE workspace_id=${workspaceId} AND id='02-cleanup'`;
    try { await check(); } finally {
      await db.adminSql`UPDATE harness_shared.workspace_host_operations SET request=${db.adminSql.json(record(workspaceId, '02-cleanup', 'independent', 'destroy'))}
        WHERE workspace_id=${workspaceId} AND id='02-cleanup'`;
    }
  }
  it('DS-P008-ACTION-ATTRIBUTION baseline: full RLS population includes benign read and authorized unrelated same-host cleanup', async () => {
    const result = await assembly()(); expect(result.verdict).toBe('pass');
    expect(result.slices[1].coverage.checked).toContain('native:101');
    expect(result.slices[1].coverage.population.filter((id) => id.startsWith('operations:'))).toHaveLength(3);
  });
  it.each(scopeIds)('DS-P008-ACTION-ATTRIBUTION counterexample: stored %s prohibited action fails', async (actorId) => {
    await replaceCleanup(record(workspaceId, '02-cleanup', actorId, 'destroy'), async () => expect((await assembly()()).verdict).toBe('fail'));
  });
  it('DS-P008-UNCERTAIN-AUDIT baseline: full interval, joins and native invocation audit can pass', async () => {
    expect((await assembly()()).verdict).toBe('pass');
  });
  it('DS-P008-UNCERTAIN-AUDIT counterexamples: omitted pages, history or native audit remain unknown', async () => {
    for (const options of [{ omitPage: true }, { lineageGap: true }, { nativeGap: true }]) expect((await assembly(options)()).verdict).toBe('unknown');
  });
  it('DS-P008-UNCERTAIN-AUDIT counterexample: absent authorization/principal is not a clean unrelated exclusion', async () => {
    for (const field of ['authorization', 'writeTime'] as const) {
      const row = record(workspaceId, '02-cleanup', 'independent', 'destroy'); row[field] = null;
      await replaceCleanup(row, async () => expect((await assembly()()).verdict).toBe('unknown'));
    }
  });
  it('source boundary: leaves retained evidence unchanged, invokes no provider and PG rejects a write', async () => {
    const before = await db.adminSql`SELECT workspace_id,id,request FROM harness_shared.workspace_host_operations ORDER BY workspace_id,id`;
    const provider = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('provider trap'));
    try { expect((await assembly()()).verdict).toBe('pass'); expect(provider).not.toHaveBeenCalled(); }
    finally { provider.mockRestore(); }
    expect(await db.adminSql`SELECT workspace_id,id,request FROM harness_shared.workspace_host_operations ORDER BY workspace_id,id`).toEqual(before);
    await expect(db.appSql.begin(async (tx) => {
      await tx`SET TRANSACTION READ ONLY`;
      await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
      await tx`UPDATE harness_shared.workspace_host_operations SET status='failed' WHERE id='02-cleanup'`;
    })).rejects.toMatchObject({ code: '25006' });
  });
});
