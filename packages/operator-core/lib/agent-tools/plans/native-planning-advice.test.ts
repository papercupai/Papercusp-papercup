import { describe, expect, it } from 'vitest';
import type { PlanItem } from '@papercusp/plan-parser';
import type { PlanItemCoverage } from '../../plan-item-coverage';
import type { CodeIntelSourceEvidence } from '../../code-intelligence/contracts';
import { nativePlanGraphAdvice } from './plan-dag-parallelism';

const items: Pick<PlanItem, 'id' | 'storedStatus' | 'blockedBy'>[] = [
  { id: 'P-001', storedStatus: 'todo', blockedBy: [] },
  { id: 'P-002', storedStatus: 'todo', blockedBy: [] },
];
const scope = { symbol: 'api', file: 'producer.ts', taskPaths: [
  { itemId: 'P-001', paths: ['consumer.ts', 'shared.ts'] }, { itemId: 'P-002', paths: ['producer.ts', 'shared.ts'] },
] };
function evidence(reverse = false): CodeIntelSourceEvidence {
  const source = { site: { path: reverse ? 'producer.ts' : 'consumer.ts', line1: 1, kind: 'function', name: 'caller' }, contentHash: 'a'.repeat(64), versionedSymbolId: 'caller@1' };
  const target = { site: { path: reverse ? 'consumer.ts' : 'producer.ts', line1: 1, kind: 'function', name: 'api' }, contentHash: 'b'.repeat(64), versionedSymbolId: 'api@1' };
  return { schemaVersion: 1, sourceScope: { repositoryId: 'fixture', identityKind: 'local-root', sourceFingerprint: 'f'.repeat(64), paths: ['.'],
    supportingFiles: [source, target].map(site => ({ path: site.site.path, contentHash: site.contentHash, representation: 'full-source', language: 'typescript' })) },
    graphScope: { basis: 'compiler-project', sourceCompleteness: 'unverified', limitations: [] }, languageCapabilities: [], siteIdentities: [],
    relationships: [{ siteIndex: 0, kind: 'callees', origin: 'compiler', knowledge: 'inferred', runtimeExecution: 'unknown', source, target }] };
}
describe('native P013 planning advice', () => {
  it('orders a producer before its consumer while preserving inputs and authoritative peer claims', () => {
    const peer = { ref: 'plan#P-002', directlyClaimed: true, directHolder: 'peer', workers: ['peer'], links: [{ workItemId: 'WI-42', holder: 'peer', activity: 'progressing' }] } as PlanItemCoverage;
    const coverage = new Map([['plan#P-002', peer]]);
    const claims = { status: 'measured' as const, held: [{ path: 'shared.ts', owner: 'peer', intent: 'WI-42', coordinationDomain: '/fixture' }] };
    const original = structuredClone({ items, scope, peer, claims });
    const advice = nativePlanGraphAdvice(items, scope, evidence(), coverage, 'plan', claims);
    expect(advice.proposedOrder).toEqual(['P-002', 'P-001']);
    expect(advice.ordering).toContainEqual({ producer: 'P-002', consumer: 'P-001', sourcePath: 'consumer.ts', targetPath: 'producer.ts', kind: 'callees' });
    expect(advice.overlaps).toEqual([{ items: ['P-001', 'P-002'], paths: ['shared.ts'] }]);
    expect(advice.ownership[1].coverage?.directHolder).toBe('peer');
    expect(advice.fileClaims.held[0]).toEqual({ path: 'shared.ts', owner: 'peer', intent: 'WI-42', coordinationDomain: '/fixture' });
    expect({ items, scope, peer, claims }).toEqual(original);
  });
  it('does not infer source ordering from an unmeasured graph or mismatched source hashes', () => {
    expect(nativePlanGraphAdvice(items, scope, undefined, new Map(), 'plan')).toMatchObject({ status: 'unknown', ordering: [] });
    const graph = evidence();
    const invalid = { ...graph, sourceScope: { ...graph.sourceScope, supportingFiles: [] } };
    expect(nativePlanGraphAdvice(items, scope, invalid, new Map(), 'plan').ordering).toEqual([]);
  });
  it('reports a graph/dependency conflict without changing authoritative dependencies', () => {
    const conflicting = structuredClone(items); conflicting[1].blockedBy = ['P-001'];
    const advice = nativePlanGraphAdvice(conflicting, scope, evidence(), new Map(), 'plan');
    expect(advice.proposedOrder).toEqual([]); expect(advice.cyclesOrConflicts).toEqual(['P-001', 'P-002']);
    expect(conflicting[1].blockedBy).toEqual(['P-001']);
  });
});
