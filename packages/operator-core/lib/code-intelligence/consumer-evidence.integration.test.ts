/**
 * P-007 integration test (GN-CONSUMER-ACCEPTANCE, requiredTestLayers unit+integration).
 *
 * consumer-evidence.test.ts pins the rule over hand-built records. This file drives
 * the REAL producer chain — the real GitNexus facade + real `runSelectiveAssist`
 * (stub dispatcher with envelope shapes measured from gitnexus 1.6.9) — into the
 * REAL evidence builder, evaluator and rating gate, and the REAL BAR-contract
 * completeness check (`acceptanceBarContractGaps`) for a BAR carrying the
 * code-owned METHOD. It proves the binding source/index/consumer -> verdict ->
 * existing acceptance outcome end to end, including the two negative cases the
 * spec names: a graph that was merely INVOKED, and a graph that returned NO callers.
 */
import { describe, expect, it } from 'vitest';
import { acceptanceBarContractGaps } from '../acceptance-bar-contract-completeness';
import type { GitnexusDispatch } from './gitnexus-facade';
import { runSelectiveAssist, type AssistIntent } from './selective-assist';
import {
  CONSUMER_EVIDENCE_METHOD,
  buildConsumerEvidence,
  evaluateConsumerEvidence,
  gateConsumerRating,
} from './consumer-evidence';

const INDEX_COMMIT = '0123456789abcdef0123456789abcdef01234567';
const FILE = 'packages/operator-core/lib/scheduler/get-next.ts';
const CONSUMER = 'packages/operator-core/lib/scheduler/claim-spec-store.ts';

const envelope = (body: unknown): unknown => ({ content: [{ text: JSON.stringify(body) }] });
const listRepos = (lastCommit = INDEX_COMMIT) =>
  envelope({ repositories: [{ name: 'papercusp', indexedAt: '2026-10-01T00:00:00.000Z', lastCommit, staleness: { commitsBehind: 0 } }] });
const contextWith = (callers: Array<[string, number]>) =>
  envelope({
    status: 'found',
    symbol: { uid: `Function:${FILE}:getNextWorkItem`, name: 'getNextWorkItem', kind: 'Function', filePath: FILE, startLine: 2778, endLine: 2787 },
    epistemic: 'exact',
    incoming: { calls: callers.map(([fp, line]) => ({ uid: `Function:${fp}:c`, name: 'c', filePath: fp, startLine: line })) },
    outgoing: { accesses: [] },
  });
const dispatchWith =
  (callers: Array<[string, number]>, onCall?: (tool: string) => void): GitnexusDispatch =>
  async (tool) => {
    onCall?.(tool);
    return tool === 'list_repos' ? listRepos() : contextWith(callers);
  };

const intent: AssistIntent = { kind: 'change', symbol: 'getNextWorkItem', path: FILE, exported: true, change: 'signature' };
const readSource = (p: string) => (p === CONSUMER ? 'await getNextWorkItem(args)' : null);
const ratingScale = ['healthy — evidence establishes the outcome', 'degraded', 'broken', 'unknown — no verdict'];
const gate = (record: unknown) => gateConsumerRating({ proposedRating: 'healthy', passRatings: ['healthy'], ratingScale, record });

const evidenceBase = {
  sourceRevision: INDEX_COMMIT,
  behavior: { checked: ['claim-spec consumer still resolves the next item'], notChecked: [] as string[] },
  tests: [{ path: 'packages/operator-core/lib/scheduler/get-next.test.ts', result: 'pass' as const }],
};

describe('real selective-assist -> consumer evidence -> existing acceptance outcome', () => {
  it('POSITIVE: a verified consumer, bound to index + source, keeps the passing rating', async () => {
    const result = await runSelectiveAssist(intent, { dispatch: dispatchWith([[CONSUMER, 547]]), currentRevision: () => INDEX_COMMIT, readSource });
    expect(result.outcome).toBe('graph-used');
    const record = buildConsumerEvidence(intent, result, evidenceBase);
    expect(record.consumers).toEqual([{ path: CONSUMER, line1: 548, corroboratedBy: 'source-read' }]);
    expect(record.identity).toEqual({ indexRevision: INDEX_COMMIT, sourceRevision: INDEX_COMMIT });
    expect(evaluateConsumerEvidence(record)).toEqual({ verdict: 'verified', gaps: [] });
    expect(gate(record)).toMatchObject({ rating: 'healthy', downgraded: false });
  });

  it('NEGATIVE: the graph was INVOKED but its consumers did not hold up against source -> nonpassing', async () => {
    const result = await runSelectiveAssist(intent, {
      dispatch: dispatchWith([['packages/gone/deleted.ts', 3]]),
      currentRevision: () => INDEX_COMMIT,
      readSource: () => null,
    });
    expect(result.outcome).toBe('graph-uncorroborated');
    const record = buildConsumerEvidence(intent, result, evidenceBase);
    expect(record.graph).toMatchObject({ invoked: true, unverifiedSiteCount: 1 });
    expect(record.consumers).toEqual([]);
    expect(evaluateConsumerEvidence(record).gaps.map((g) => g.gap)).toContain('graph-invocation-only');
    const g = gate(record);
    expect(g.downgraded).toBe(true);
    expect(g.rating).toBe('unknown — no verdict');
  });

  it('NEGATIVE: the graph returned ZERO callers -> not evidence of absence -> nonpassing', async () => {
    const result = await runSelectiveAssist(intent, { dispatch: dispatchWith([]), currentRevision: () => INDEX_COMMIT, readSource });
    expect(result.outcome).toBe('graph-empty');
    const record = buildConsumerEvidence(intent, result, evidenceBase);
    expect(gate(record).downgraded).toBe(true);
  });

  it('...and the same zero-callers answer passes only once an independent rg sweep also found none', async () => {
    const result = await runSelectiveAssist(intent, { dispatch: dispatchWith([]), currentRevision: () => INDEX_COMMIT, readSource });
    const record = buildConsumerEvidence(intent, result, {
      ...evidenceBase,
      absenceSweeps: [{ route: 'rg', query: 'getNextWorkItem', matches: 0 }],
    });
    expect(evaluateConsumerEvidence(record)).toEqual({ verdict: 'verified', gaps: [] });
  });

  it('NEGATIVE: a stale index is bound to its OWN revision, so the mismatch is visible', async () => {
    const STALE = 'fedcba9876543210fedcba9876543210fedcba98';
    const result = await runSelectiveAssist(intent, {
      dispatch: async (tool) => (tool === 'list_repos' ? listRepos(STALE) : contextWith([[CONSUMER, 547]])),
      currentRevision: () => INDEX_COMMIT,
      readSource,
    });
    expect(result.outcome).toBe('graph-stale');
    const record = buildConsumerEvidence(intent, result, evidenceBase);
    expect(record.identity.indexRevision).toBe(STALE);
    expect(evaluateConsumerEvidence(record).gaps.map((g) => g.gap)).toContain('index-source-mismatch');
    expect(gate(record).downgraded).toBe(true);
  });

  it('NEGATIVE: a backend that throws falls back, and unchecked behavior keeps the outcome nonpassing', async () => {
    const result = await runSelectiveAssist(intent, {
      dispatch: async () => {
        throw new Error('bridge down');
      },
      currentRevision: () => INDEX_COMMIT,
      readSource,
    });
    expect(result.outcome).toBe('graph-failed');
    const record = buildConsumerEvidence(intent, result, {
      ...evidenceBase,
      fallbackUsed: true,
      fallbackReason: 'bridge down',
      absenceSweeps: [{ route: 'lsp', query: 'getNextWorkItem', matches: 0 }],
      behavior: { checked: ['callers sweep via lsp'], notChecked: ['runtime behavior of the claim-spec consumer'] },
    });
    const e = evaluateConsumerEvidence(record);
    expect(e.gaps.map((g) => g.gap)).toEqual(['behavior-partially-unchecked']);
    expect(gate(record).downgraded).toBe(true);
  });

  it('a single-op navigate lookup never turns definition sites into consumers', async () => {
    const nav: AssistIntent = { kind: 'navigate', query: 'getNextWorkItem' };
    const result = await runSelectiveAssist(nav, {
      dispatch: dispatchWith([]),
      currentRevision: () => INDEX_COMMIT,
      readSource: (p) => (p === FILE ? [...Array(2778).fill('// filler'), 'export async function getNextWorkItem('].join('\n') : null),
    });
    const record = buildConsumerEvidence(nav, result, evidenceBase);
    expect(record.consumers).toEqual([]);
  });

  it('a skipped (nonuse) decision records the graph as never invoked', async () => {
    const calls: string[] = [];
    const nonuse: AssistIntent = { kind: 'navigate', query: 'some log line text' };
    const result = await runSelectiveAssist(nonuse, { dispatch: dispatchWith([], (t) => calls.push(t)), readSource });
    expect(calls).toEqual([]);
    const record = buildConsumerEvidence(nonuse, result, evidenceBase);
    expect(record.graph).toMatchObject({ invoked: false, outcome: 'not-invoked' });
    expect(evaluateConsumerEvidence(record).gaps.map((g) => g.gap)).toContain('consumers-not-resolved');
  });
});

describe('the METHOD rides the EXISTING BAR contract', () => {
  const bar = (over: Partial<Parameters<typeof acceptanceBarContractGaps>[0]> = {}) =>
    acceptanceBarContractGaps({
      role: 'outcome',
      method: CONSUMER_EVIDENCE_METHOD,
      check: {
        kind: 'tests',
        files: [
          'packages/operator-core/lib/code-intelligence/consumer-evidence.test.ts',
          'packages/operator-core/lib/code-intelligence/consumer-evidence.integration.test.ts',
        ],
      },
      requiredTestLayers: ['unit', 'integration'],
      automatedProofRequired: true,
      ...over,
    });

  it('a BAR carrying the code-owned METHOD + unit/integration check files is complete', () => {
    expect(bar()).toEqual([]);
  });

  it('negative controls: without the METHOD or the integration check file the contract is NOT complete', () => {
    expect(bar({ method: '' }).map((g) => g.gap)).toEqual(['method_missing']);
    expect(
      bar({
        check: { kind: 'tests', files: ['packages/operator-core/lib/code-intelligence/consumer-evidence.test.ts'] },
      }).map((g) => g.gap),
    ).toEqual(['check_layer_mismatch']);
  });
});
