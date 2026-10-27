/** P007 source acceptance: throwaway migrated Postgres, real RLS/read-only transactions. */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { createWorkspaceHostSpendObservation, evaluateWorkspaceHostSpendFinality } from '@papercusp/deployment-driver';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { deferredSpendEvidenceIdentitySchema, deferredSpendFingerprint, type DeferredSpendEvidenceIdentity } from './deferred-spend-acceptance-contract';
import {
  collectDeferredSpendPopulation, DEFERRED_SPEND_RETAINED_RUNS, DEFERRED_SPEND_STABILITY_WINDOW_MS,
  type DeferredSpendPopulationDependencies, type DeferredSpendPopulationSnapshot,
} from './deferred-spend-population';

const [R4, R5] = DEFERRED_SPEND_RETAINED_RUNS;
const START = '2026-09-08T00:00:00Z', END = '2026-09-08T01:00:00Z';
const originalDeferral = { status: 'deferred', actorId: 'historical-actor', procedureRef: 'runbook:deferred', reason: 'export delayed', reconcileAfter: '2026-09-08T02:00:00Z' };
const descriptor = { schemaVersion: 'gcp-billing-export-v1', projectId: 'billing-project', datasetId: 'billing', tableId: 'export', labelKey: 'run_id', maximumBytesBilled: '1000000' };
const observations = ['2026-09-10T01:32:35.890Z', '2026-09-10T07:32:49.159Z'].map((observedAt, i) => createWorkspaceHostSpendObservation({
  currency: 'USD', grossMicros: '451', creditMicros: '-451', netMicros: '0', observedAt,
  providerEvidenceRef: `gcp://bigquery/projects/billing-project/jobs/job-${i}`,
}));
function identity(workspaceId: string) {
  const scope = { workspaceId, harness: 'papercusp', planSlug: 'deferred-spend', rubricRef: 'acceptance', rubricRevision: 7, criteriaHash: 'a'.repeat(64) };
  const provenance = { method: 'independent-fixture-selection', selector: 'reviewed-source-fixture', evidenceRefs: ['fixture:selector'] };
  const base = 'a'.repeat(40), candidate = 'b'.repeat(40), hash = 'a'.repeat(64);
  const content = (path: string) => ({ path, contentHash: hash, provenance });
  return deferredSpendEvidenceIdentitySchema.parse({
    schemaVersion: 'deferred-spend-evidence-v1', scope, subject: { kind: 'source', ref: 'integration:retained-population' },
    observation: { id: 'observation', observedAt: '2026-10-25T20:00:02Z', window: { startAt: START, endAt: '2026-10-25T20:00:00Z' },
      serving: { hostId: 'isolated-pg', processId: 'integration:1', buildId: 'test-source', runtimeGeneration: 'test-generation' },
      snapshot: { id: 'snapshot:pg', acquiredAt: '2026-10-25T20:00:01Z', scopeHash: deferredSpendFingerprint(scope), consistency: 'consistent-read-only', evidenceRefs: ['pg:repeatable-read-read-only'] } },
    sourceManifestHash: hash, configurationHash: deferredSpendFingerprint(descriptor),
    censusSelectors: { base: { revision: base, treeHash: hash, provenance }, candidate: { revision: candidate, treeHash: hash, provenance },
      roots: { repositoryRoot: '/repo', workspaceRoot: '/workspace', contentHash: hash, provenance },
      projectConfiguration: { contentHash: hash, provenance, tsconfigs: [content('tsconfig.json')], projectReferences: [] },
      migrationRegistry: { revision: candidate, contentHash: hash, provenance, entries: [] }, productionRoots: [content('src')],
      changedPaths: { method: 'reviewed-base-to-candidate-diff', baseRevision: base, candidateRevision: candidate, populationHash: deferredSpendFingerprint([]), provenance, entries: [] } },
  });
}

describe('P007 retained population (isolated Postgres/RLS)', () => {
  let db: OrgTestDb;
  const workspaceId = `population_${randomBytes(6).toString('hex')}`;
  const foreignWorkspace = `${workspaceId}_foreign`;
  beforeAll(async () => {
    db = await createOrgTestDb();
    for (const [ws, ids] of [[workspaceId, [R4, R5, 'positive-control-host']], [foreignWorkspace, [R4]]] as const) {
      for (const id of ids) {
        const connectionId = `actual-connection:${id}`;
        await db.adminSql`INSERT INTO harness_shared.workspace_host_connections
          (workspace_id,id,target,label,credential_ref,provider_config,status)
          VALUES (${ws},${connectionId},'gcp','population fixture','fixture://never-resolve',${db.adminSql.json({ billingExport: descriptor })},'connected')`;
        const history = id === R5 ? observations : [];
        const signals = id === 'positive-control-host' ? [{ kind: 'unrelated-cost', runId: 'unrelated' }] : [
          { kind: 'unrelated-cost', runId: 'other-run' },
          { kind: 'workspace-host-canary-cost-evidence-v1', runId: id, spendSettlement: originalDeferral,
            preRunZeroBaseline: { observedAt: START, cents: 0, providerEvidenceRef: 'fixture:baseline' }, completion: { completedAt: END }, spendObservations: history,
            spendReconciliation: id === R5 ? { status: 'settled', finality: evaluateWorkspaceHostSpendFinality(history, DEFERRED_SPEND_STABILITY_WINDOW_MS) } : { status: 'retryable', reason: 'no-data' } },
        ];
        await db.adminSql`INSERT INTO harness_shared.workspace_hosts
          (workspace_id,id,name,connection_id,target,scope_label,region,size,image,disk_gib,network,desired_state,observed_state,cost_signals)
          VALUES (${ws},${id},'population fixture',${connectionId},'gcp','billing-project','us-central1','e2-small','fixture-image',20,'default','absent','absent',${JSON.stringify(signals)}::jsonb)`;
      }
    }
  }, 180_000);
  afterAll(async () => { await db?.cleanup(); });

  function assembly(omitPage = false) {
    const expectedIdentity = identity(workspaceId);
    const request = { expectedIdentity, targets: [R4, R5].map((id) => ({ hostId: id, runId: id, originalDeferral, evidenceRefs: ['historical:independent-deferral'] })) };
    const reads: string[] = [];
    const dependencies: DeferredSpendPopulationDependencies = {
      withSnapshot: async <T>(_wanted: DeferredSpendEvidenceIdentity, read: (snapshot: DeferredSpendPopulationSnapshot) => Promise<T>): Promise<T> => {
        const result = await db.appSql.begin(async (tx) => {
        await tx`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`;
        await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
        const snapshot: DeferredSpendPopulationSnapshot = {
          identity: expectedIdentity,
          census: async () => {
            const [settings] = await tx`SELECT current_setting('transaction_read_only') AS read_only, current_setting('transaction_isolation') AS isolation`;
            expect(settings).toMatchObject({ read_only: 'on', isolation: 'repeatable read' });
            const [r] = await tx`SELECT count(*)::int AS count, max(id) AS watermark FROM harness_shared.workspace_hosts WHERE workspace_id=${workspaceId}`;
            return { snapshotRef: 'snapshot:pg', upperWatermark: r.watermark, hostCount: r.count, evidenceRefs: ['pg:count-and-watermark'] };
          },
          readHosts: async (after, upperWatermark) => {
            reads.push(`page:${after}`);
            // Deliberately omit the workspace WHERE here: real RLS must still exclude the foreign R4.
            const rows = await tx`SELECT workspace_id AS "workspaceId", id, connection_id AS "connectionId", cost_signals AS "costSignals"
              FROM harness_shared.workspace_hosts WHERE (${after}::text IS NULL OR id > ${after}) AND id <= ${upperWatermark} ORDER BY id LIMIT 1`;
            const last = rows.at(-1)?.id;
            const [remaining] = await tx`SELECT count(*)::int AS count FROM harness_shared.workspace_hosts WHERE id > ${last ?? upperWatermark} AND id <= ${upperWatermark}`;
            return { snapshotRef: 'snapshot:pg', configurationHash: expectedIdentity.configurationHash, upperWatermark, after,
              nextAfter: !omitPage && remaining.count > 0 ? last : null, hosts: rows, evidenceRef: `pg:page:${after ?? 'start'}` };
          },
          readConnection: async (id) => {
            reads.push(`connection:${id}`);
            const [row] = await tx`SELECT workspace_id AS "workspaceId", id, target, provider_config AS "providerConfig" FROM harness_shared.workspace_host_connections WHERE id=${id}`;
            return row ? { ...row, readable: true, evidenceRefs: ['pg:connection-row'] } : null;
          },
          readJobs: async (target) => ({ snapshotRef: 'snapshot:pg', complete: true, evidenceRefs: ['fixture:retained-authoritative-job-census'], records: target.runId === R5 ? observations.map((observation, i) => ({
            workspaceId, hostId: R5, runId: R5, usageStartAt: START, usageEndAt: END,
            endpoint: 'https://bigquery.googleapis.com/bigquery/v2', descriptor, configurationHash: deferredSpendFingerprint(descriptor),
            jobReference: { projectId: 'billing-project', jobId: `job-${i}` }, observation, authenticity: 'verified', evidenceRefs: [`fixture:job-artifact:${i}`],
          })) : [] }),
        };
          return read(snapshot);
        });
        return result as T;
      },
    };
    return { request, dependencies, reads };
  }
  async function retainedRows() {
    return db.adminSql`SELECT workspace_id,id,cost_signals FROM harness_shared.workspace_hosts WHERE workspace_id IN (${workspaceId},${foreignWorkspace}) ORDER BY workspace_id,id`;
  }
  it('DS-P007-RETAINED-COVERAGE baseline: exhausts pages with real RLS, unrelated positive control and both retained runs', async () => {
    const a = assembly();
    const result = await collectDeferredSpendPopulation(a.request, a.dependencies);
    expect(result.verdict).toBe('pass');
    expect(result.slices[0].coverage.pageRefs).toHaveLength(3);
    expect(result.slices[0].coverage.population.filter((member) => member.startsWith('host:'))).toHaveLength(3);
    expect(result.slices[0].coverage.population).toContain('signal:positive-control-host:0');
    expect(a.reads).toContain(`connection:actual-connection:${R5}`);
  });
  it('DS-P007-RETAINED-COVERAGE counterexample: a missing page remains unknown under real RLS', async () => {
    const a = assembly(true); const result = await collectDeferredSpendPopulation(a.request, a.dependencies);
    expect(result.verdict).toBe('unknown');
    expect(result.slices[0].coverage.notChecked).toContain(`run:${R5}`);
  });
  it('DS-P007-READ-ONLY baseline: preserves retained rows and does not call a provider', async () => {
    const before = await retainedRows();
    const provider = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('provider trap'));
    try {
      const a = assembly(); expect((await collectDeferredSpendPopulation(a.request, a.dependencies)).verdict).toBe('pass');
      expect(await retainedRows()).toEqual(before);
      expect(provider).not.toHaveBeenCalled();
    } finally { provider.mockRestore(); }
  });
  it('DS-P007-READ-ONLY counterexample: the scoped database rejects a forbidden retained-row write', async () => {
    await expect(db.appSql.begin(async (tx) => {
      await tx`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`;
      await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
      await tx`UPDATE harness_shared.workspace_hosts SET name='forbidden-write' WHERE id=${R4}`;
    })).rejects.toMatchObject({ code: '25006' });
  });
  it('DS-P007-SETTLEMENT-FINALITY baseline: recomputes retained exact accounting through the read-only assembly', async () => {
    const a = assembly(); const result = await collectDeferredSpendPopulation(a.request, a.dependencies);
    expect(result.targets[1].finality).toMatchObject({ status: 'settled', observation: { grossMicros: '451', creditMicros: '-451', netMicros: '0', budgetCents: 1 } });
  });
  it('DS-P007-SETTLEMENT-FINALITY counterexample: missing authoritative provenance cannot pass the database assembly', async () => {
    const a = assembly(); const original = a.dependencies.withSnapshot;
    const dependencies: DeferredSpendPopulationDependencies = { withSnapshot: (wanted, read) => original(wanted, (snapshot) => read({ ...snapshot,
      readJobs: async () => ({ snapshotRef: 'snapshot:pg', complete: false, records: [], evidenceRefs: ['fixture:missing-provenance'] }),
    })) };
    expect((await collectDeferredSpendPopulation(a.request, dependencies)).verdict).toBe('unknown');
  });
});
