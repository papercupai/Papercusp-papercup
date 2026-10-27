import { vi } from 'vitest';
import {
  DEFERRED_SPEND_ACCEPTANCE_PLAN as plan, DEFERRED_SPEND_INSTRUMENT_KEYS as keys,
  measureDeferredSpendAcceptance, collectDeferredSpendAcceptanceEvidence, type DeferredSpendAcceptanceInputs,
} from './deferred-spend-acceptance-instruments';
import {
  deferredSpendEvidenceIdentitySchema, deferredSpendFingerprint,
} from './deferred-spend-acceptance-contract';
import { deferredSpendSourceHash, deferredSpendSourceManifest } from './deferred-spend-source-census';
import { DEFERRED_SPEND_RETAINED_RUNS } from './deferred-spend-population';
import { type DeferredSpendActionRecord,
  type DeferredSpendActionLineage, type DeferredSpendActionStream } from './deferred-spend-action-boundary';
import type { Rubric } from '../rubrics';

const start = '2026-10-25T19:00:00Z', end = '2026-10-25T20:00:00Z', at = '2026-10-25T20:00:02Z';
type Mutable<T> = T extends (...args: never[]) => unknown ? T : T extends readonly (infer E)[] ? Mutable<E>[]
  : T extends object ? { -readonly [K in keyof T]: Mutable<T[K]> } : T;
export function deferredSpendAcceptanceFixture() {
  const provenance = { method: 'reviewed-source-read', selector: 'independent-base-candidate', evidenceRefs: ['review:selectors'] };
  const base = 'a'.repeat(40), candidate = 'b'.repeat(40);
  const request = { workspaceId: 'ws', harness: 'papercusp', planSlug: plan as typeof plan, rubricRef: 'acceptance-deferred-spend',
    rubricRevision: 7, criteriaHash: 'c'.repeat(64), subjectRef: plan, windowStart: start, windowEnd: end };
  const scope = { workspaceId: request.workspaceId, harness: request.harness, planSlug: plan,
    rubricRef: request.rubricRef, rubricRevision: 7, criteriaHash: request.criteriaHash };
  const files = [
    { revision: candidate, path: 'tsconfig.json', text: JSON.stringify({ compilerOptions: {}, include: ['src/**/*.ts'] }), contentHash: '' },
    { revision: candidate, path: 'src/collector.ts', text: "export function collect() { return 'consistent-read-only'; }", contentHash: '' },
  ];
  for (const file of files) file.contentHash = deferredSpendSourceHash(file.text);
  const members = files.filter(file => file.path.startsWith('src/')).map(({ path, contentHash }) => ({ path, contentHash }));
  const tsconfigs = [{ path: 'tsconfig.json', contentHash: files[0].contentHash, provenance }];
  const projectConfiguration = { tsconfigs, projectReferences: [], provenance,
    contentHash: deferredSpendFingerprint({ tsconfigs, projectReferences: [] }) };
  const migrationRegistry = { revision: candidate, entries: [], contentHash: deferredSpendFingerprint([]), provenance };
  const sourceIdentity = deferredSpendEvidenceIdentitySchema.parse({ schemaVersion: 'deferred-spend-evidence-v1', scope,
    subject: { kind: 'source', ref: plan }, observation: { id: 'observation', observedAt: at,
      window: { startAt: start, endAt: end }, serving: { hostId: 'fixture', processId: 'test:1', buildId: candidate, runtimeGeneration: 'fixture' },
      snapshot: { id: 'snapshot', acquiredAt: at, scopeHash: deferredSpendFingerprint(scope), consistency: 'consistent-read-only', evidenceRefs: ['snapshot:fixture'] } },
    sourceManifestHash: deferredSpendFingerprint(deferredSpendSourceManifest(files)),
    configurationHash: deferredSpendFingerprint({ projectConfiguration, migrationRegistry, packages: [] }), censusSelectors: {
      base: { revision: base, treeHash: 'a'.repeat(64), provenance }, candidate: { revision: candidate, treeHash: 'b'.repeat(64), provenance },
      roots: { repositoryRoot: '/repo', workspaceRoot: '/workspace',
        contentHash: deferredSpendFingerprint({ repositoryRoot: '/repo', workspaceRoot: '/workspace' }), provenance },
      projectConfiguration, migrationRegistry, productionRoots: [{ path: 'src', contentHash: deferredSpendFingerprint(members), provenance }],
      changedPaths: { method: 'reviewed-base-to-candidate-diff', baseRevision: base, candidateRevision: candidate,
        populationHash: deferredSpendFingerprint([]), provenance, entries: [] },
    } });
  const identity = structuredClone(sourceIdentity);
  identity.subject.kind = 'live';
  const deferral = { status: 'deferred', actorId: 'historical', reason: 'billing delayed',
    procedureRef: 'runbook:deferred', reconcileAfter: end };
  const hosts = DEFERRED_SPEND_RETAINED_RUNS.map(id => ({ workspaceId: 'ws', id, connectionId: 'existing-connection',
    costSignals: [{ kind: 'workspace-host-canary-cost-evidence-v1', runId: id,
      spendSettlement: structuredClone(deferral), preRunZeroBaseline: { cents: 0, observedAt: start, providerEvidenceRef: 'baseline:zero' },
      completion: { completedAt: end }, spendObservations: [], spendReconciliation: { status: 'retryable', reason: 'no-data' } }] }));
  const actorIds = ['original', 'acceptance', 'independent'];
  const lineage: DeferredSpendActionLineage = { snapshotRef: 'snapshot', complete: true, historyComplete: true,
    evidenceRefs: ['lineage:complete'], edges: [], aliases: [], actors: actorIds.map(id => ({
      id, generation: '1', principalId: 'principal:' + id, sessionId: 'session:' + id,
      workItemId: 'WI:' + id, evidenceRefs: ['actor:' + id],
    })) };
  const boundaries = { r7: { ref: 'retained-r7', generation: '1' }, g6: { ref: 'retained-g6', generation: '1' },
    r31: { ref: 'retained-r31', generation: '1' } };
  const row = (id: string, actorId: string, action: DeferredSpendActionRecord['action']): DeferredSpendActionRecord => ({
    id, workspaceId: 'ws', occurredAt: '2026-10-25T19:30:00Z', action, target: boundaries.r7,
    operationId: null, invocationId: null, writeTime: { actorId, actorGeneration: '1', principalId: 'principal:' + actorId,
      sessionId: 'session:' + actorId, workItemId: 'WI:' + actorId, sourceRef: 'source:write-time', processId: 'writer:1', buildId: 'writer' },
    authorization: null, audit: { complete: true, evidenceRefs: ['audit:complete'] }, evidenceRefs: ['row:' + id],
  });
  const independent = row('02-independent', 'independent', 'destroy');
  independent.authorization = { id: 'authorization:independent', actorId: 'independent', workItemId: 'WI:independent',
    issuedAt: '2026-10-25T19:10:00Z', action: 'destroy', target: boundaries.r7, separateCausalRoot: true,
    independentOf: ['original', 'acceptance'], lineageRefs: ['authorization:causal-root'], evidenceRefs: ['authorization:grant'] };
  const records: Record<DeferredSpendActionStream, DeferredSpendActionRecord[]> = {
    operations: [], events: [], resources: [], requests: [], admissions: [], credentials: [], invocations: [], native: [],
  };
  records.operations.push(row('01-read', 'original', 'observe'), independent);
  const hostReads = vi.fn(), actionReads = vi.fn();
  const inputs: Mutable<DeferredSpendAcceptanceInputs> = { identity,
    source: { request: { expectedIdentity: structuredClone(sourceIdentity),
      entrypoints: [{ path: 'src/collector.ts', symbol: 'collect' }], allowances: [],
      controls: [{ id: 'read-only-collector', path: 'src/collector.ts', symbol: 'collect', kind: 'literal', value: 'consistent-read-only' }] },
      snapshot: { identity: sourceIdentity, files, roots: [{ root: 'src', members }], packages: [], evidenceRefs: ['source:complete'] } },
    population: { request: { targets: DEFERRED_SPEND_RETAINED_RUNS.map(id => ({
      hostId: id, runId: id, originalDeferral: deferral, evidenceRefs: ['deferral:independent-baseline'],
    })) }, dependencies: { withSnapshot: async (expected, read) => { hostReads(); return read({
      identity: expected,
      census: async () => ({ snapshotRef: 'snapshot', upperWatermark: hosts.at(-1)!.id, hostCount: hosts.length, evidenceRefs: ['host:census'] }),
      readHosts: async (after, upperWatermark) => ({ snapshotRef: 'snapshot', configurationHash: expected.configurationHash,
        after, upperWatermark, nextAfter: null, hosts, evidenceRef: 'hosts:complete' }),
      readConnection: async id => ({ workspaceId: 'ws', id, target: 'gcp', readable: true, providerConfig: {}, evidenceRefs: ['connection:retained'] }),
      readJobs: async () => ({ snapshotRef: 'snapshot', complete: true, records: [], evidenceRefs: ['jobs:complete-empty'] }),
    }); } } },
    action: { request: { implementation: [{ actorId: 'original', startedAt: start, evidenceRefs: ['implementation:original'] }],
      acceptance: [{ actorId: 'acceptance', startedAt: '2026-10-25T19:01:00Z', evidenceRefs: ['acceptance:continuation'] }], boundaries },
      dependencies: { withSnapshot: async (expected, read) => { actionReads(); return read({
        identity: expected, readLineage: async () => lineage,
        readCensus: async stream => ({ snapshotRef: 'snapshot', complete: true, retentionComplete: true,
          window: expected.observation.window, count: records[stream].length, upperWatermark: records[stream].at(-1)?.id ?? null,
          evidenceRefs: ['census:' + stream] }),
        readPage: async (stream, after, upperWatermark) => ({ snapshotRef: 'snapshot', after, upperWatermark, nextAfter: null,
          records: records[stream], evidenceRef: 'page:' + stream }),
      }); } } },
  };
  const read = vi.fn(async () => inputs), persist = vi.fn(async (_harness: string, _path: string, _body: string) => {});
  const rubric = { rubricId: request.rubricRef, workspaceId: 'ws', revision: 7, criteriaHash: request.criteriaHash,
    subjectPlan: plan, subjectHarnessSlug: 'papercusp', criteria: Object.entries(keys).map(([key, instrumentKey]) =>
      ({ key, check: { kind: 'instrument', instrumentKey } })) } as unknown as Rubric;
  const subject = { kind: 'plan' as const, ref: plan, windowStart: start, windowEnd: end };
  return { request, identity, sourceIdentity, inputs, hosts, records, row, hostReads, actionReads, read, persist, rubric, subject,
    run: () => measureDeferredSpendAcceptance(request, { read, persist }),
    compose: () => collectDeferredSpendAcceptanceEvidence(inputs) };
}

