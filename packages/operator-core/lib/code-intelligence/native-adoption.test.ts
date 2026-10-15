/**
 * P-033 / R-30 unit layer (native-code-intelligence-ecosystem-and-dream-2026-10-09): the pure
 * classification, summary and rating rules of the native adoption instrument, over fixture
 * ledger rows. The PG reader is covered by native-adoption.integration.test.ts.
 */
import { describe, expect, it } from 'vitest';
import {
  NATIVE_ADOPTION_CANNOT_OBSERVE,
  NATIVE_ADOPTION_INSTRUMENT_KEYS,
  NATIVE_ADOPTION_TARGET,
  classifyInvocationStatus,
  classifyShellLookup,
  nativeAdoptionCriterionForInstrument,
  rateNativeAdoption,
  summarizeNativeAdoption,
  type NativeAdoptionInvocation,
  type NativeAdoptionShellCommand,
  type NativeAdoptionTarget,
} from './native-adoption';
import { getRegisteredInstrument, platformComputedInstrumentKeys } from '../rubric-instrument-registry';

const WINDOW = { workspaceId: 'ws-test', windowStart: '2026-10-01T00:00:00.000Z', windowEnd: '2026-10-04T00:00:00.000Z' };
const at = '2026-10-02T12:00:00.000Z';

const inv = (over: Partial<NativeAdoptionInvocation> & Pick<NativeAdoptionInvocation, 'toolName'>): NativeAdoptionInvocation => ({
  ownerId: null, role: 'operator', status: 'ok', errorCode: null, durationMs: null, invokedAt: at, ...over,
});
const sh = (ownerId: string, command: string): NativeAdoptionShellCommand => ({ ownerId, command, at });

const INVOCATIONS: NativeAdoptionInvocation[] = [
  inv({ toolName: 'graph:query', ownerId: 'A', durationMs: 100, followedThrough: true }),
  inv({ toolName: 'lsp:query', ownerId: 'A', durationMs: 300, followedThrough: false }),
  inv({ toolName: 'lsp:query', ownerId: 'B', role: 'judge', status: 'role-not-allowed', errorCode: 'missing_capability' }),
  inv({ toolName: 'lsp:query', ownerId: 'C', status: 'invalid-input', errorCode: 'invalid_input' }),
  inv({ toolName: 'code:pack', ownerId: 'A', status: 'error', errorCode: 'internal' }),
  inv({ toolName: 'gitnexus.context', ownerId: 'D' }),
  inv({ toolName: 'gitnexus.cypher', ownerId: 'D' }),
  inv({ toolName: 'coord:send', ownerId: 'Z' }),
];
const SHELL: NativeAdoptionShellCommand[] = [
  sh('E', 'grep -rn "export function measureGateReuseAuditWindow" packages/operator-core/lib'),
  sh('E', 'cd /repo || exit 1; grep -rn "measureGateReuseAuditWindow(" packages'),
  sh('F', 'grep -n ERROR /var/log/syslog | tail -5'),
  sh('B', "rg -n 'interface RubricCriterion' packages/operator-core/lib"),
];

describe('classifyInvocationStatus', () => {
  it('separates success, access refusals, caller mistakes and real errors', () => {
    expect(classifyInvocationStatus('ok', null)).toBe('ok');
    expect(classifyInvocationStatus('role-not-allowed', 'missing_capability')).toBe('refused');
    expect(classifyInvocationStatus('error', 'missing_capability')).toBe('refused');
    expect(classifyInvocationStatus('invalid-input', 'invalid_input')).toBe('invalid-input');
    expect(classifyInvocationStatus('error', 'internal')).toBe('error');
    expect(classifyInvocationStatus(null, null)).toBe('error');
  });
});

describe('classifyShellLookup', () => {
  it.each([
    ['grep -rn "export function readNativeAdoptionWindow" packages/', 'definition'],
    ["rg -n 'class Foo\\b' src", 'definition'],
    ['git grep -n "def handle_request"', 'definition'],
    ['grep -rn "export async function x" .', 'definition'],
    ['sed -n 1,5p f.ts\ngrep -n "interface Rubric" lib/rubrics.ts', 'definition'],
    ['cd /x || exit 1; grep -rn "measureGateReuseAuditWindow(" packages', 'call-site'],
    ["rg 'fooBar\\(' src", 'call-site'],
  ])('%s → %s', (command, kind) => {
    expect(classifyShellLookup(command)).toBe(kind);
  });

  it.each([
    'grep -n ERROR /var/log/syslog',
    'node -e "console.log(foo())"',
    'ls | grep -c test',
    'echo "export function x" | wc -l',
    'sed -n 1,20p packages/operator-core/lib/scorecards.ts',
    'git log --oneline -5',
    '',
  ])('%j is not a code lookup', (command) => {
    expect(classifyShellLookup(command)).toBeNull();
  });

  it('prefers definition when one command holds both shapes', () => {
    expect(classifyShellLookup('grep -n "foo(" a.ts; grep -n "function foo" a.ts')).toBe('definition');
  });
});

describe('summarizeNativeAdoption', () => {
  const metrics = summarizeNativeAdoption({ window: WINDOW, invocations: INVOCATIONS, shellCommands: SHELL });

  it('counts native volume, reach and failure classes per operation', () => {
    expect(metrics.native).toMatchObject({
      calls: 5, ok: 2, refused: 1, invalidInput: 1, errored: 1,
      distinctAgents: 3, distinctOkAgents: 1, refusalRate: 0.2, errorRate: 0.2,
      p50Ms: 100, p95Ms: 300, refusalsByRole: { judge: 1 },
    });
    expect(metrics.native.byOp['graph:query']).toMatchObject({ calls: 1, ok: 1, distinctAgents: 1 });
    expect(metrics.native.byOp['lsp:query']).toMatchObject({ calls: 3, ok: 1, refused: 1, invalidInput: 1 });
    expect(metrics.native.byOp['code:pack']).toMatchObject({ calls: 1, errored: 1, p50Ms: null });
  });

  it('measures follow-through only over native OK calls that carry the proxy', () => {
    expect(metrics.native.followThrough).toEqual({ measuredCalls: 2, followed: 1, rate: 0.5 });
  });

  it('counts substitutes: direct GitNexus calls and raw-text lookups', () => {
    expect(metrics.substitutes.gitnexusDirect).toEqual({
      calls: 2, distinctAgents: 1, byOp: { 'gitnexus.context': 1, 'gitnexus.cypher': 1 },
    });
    expect(metrics.substitutes.rawTextLookups).toEqual({
      definition: 2, callSite: 1, total: 3, distinctAgents: 2, scannedCommands: 4,
    });
  });

  it('derives agent adoption and native call share, ignoring unrelated tools', () => {
    expect(metrics.adoption).toEqual({
      lookupAgents: 5, nativeAgents: 1, agentAdoptionRate: 0.2, lookups: 10, nativeCallShare: 2 / 7,
    });
    expect(metrics.cannotObserve).toBe(NATIVE_ADOPTION_CANNOT_OBSERVE);
    expect(metrics.cannotObserve.length).toBeGreaterThan(0);
  });

  it('reports null rates (not zero) for an empty window', () => {
    const empty = summarizeNativeAdoption({ window: WINDOW, invocations: [], shellCommands: [] });
    expect(empty.native.refusalRate).toBeNull();
    expect(empty.adoption.agentAdoptionRate).toBeNull();
    expect(empty.adoption.nativeCallShare).toBeNull();
    expect(empty.native.followThrough.rate).toBeNull();
  });
});

describe('rateNativeAdoption', () => {
  const metrics = summarizeNativeAdoption({ window: WINDOW, invocations: INVOCATIONS, shellCommands: SHELL });
  const target = (over: Partial<NativeAdoptionTarget> = {}): NativeAdoptionTarget => ({
    decisionRef: 'test#D-001', frozenAt: '2026-10-01T00:00:00.000Z',
    baselineWindow: { windowStart: WINDOW.windowStart, windowEnd: WINDOW.windowEnd },
    baseline: { agentAdoptionRate: 0.05, nativeCallShare: 0.05, refusalRate: 0.4, lookups: 100 },
    minLookups: 5, minAgentAdoptionRate: 0.1, minNativeCallShare: 0.2, maxRefusalRate: 0.3, ...over,
  });

  it('measured passes on any observed lookups; an empty window is unknown, never pass', () => {
    expect(rateNativeAdoption(metrics, null).measured.verdict).toBe('pass');
    const empty = summarizeNativeAdoption({ window: WINDOW, invocations: [], shellCommands: [] });
    expect(rateNativeAdoption(empty, null).measured).toMatchObject({ verdict: 'unknown', unknownReason: 'empty-population' });
  });

  it('good use is unknown until the target is frozen', () => {
    expect(rateNativeAdoption(metrics, null).goodUse).toMatchObject({ verdict: 'unknown', unknownReason: 'target-not-frozen' });
  });

  it('good use is inconclusive below the sample floor rather than adjusted', () => {
    expect(rateNativeAdoption(metrics, target({ minLookups: 50 })).goodUse)
      .toMatchObject({ verdict: 'unknown', unknownReason: 'insufficient-sample' });
  });

  it('good use passes only when every frozen bound holds', () => {
    expect(rateNativeAdoption(metrics, target()).goodUse.verdict).toBe('pass');
    const missed = rateNativeAdoption(metrics, target({ minAgentAdoptionRate: 0.5 })).goodUse;
    expect(missed.verdict).toBe('fail');
    expect(missed.reason).toContain('agent adoption');
    expect(rateNativeAdoption(metrics, target({ maxRefusalRate: 0.1 })).goodUse.verdict).toBe('fail');
    expect(rateNativeAdoption(metrics, target({ minNativeCallShare: 0.5 })).goodUse.verdict).toBe('fail');
  });
});

describe('frozen R-31 target (plan D-011)', () => {
  it('pins the baseline-derived bounds recorded in the decision', () => {
    expect(NATIVE_ADOPTION_TARGET).toMatchObject({
      decisionRef: 'native-code-intelligence-ecosystem-and-dream-2026-10-09#D-011',
      baselineWindow: { windowStart: '2026-10-11T06:00:00.000Z', windowEnd: '2026-10-14T06:00:00.000Z' },
      baseline: { agentAdoptionRate: 0.06, nativeCallShare: 0.0706, refusalRate: 0.177, lookups: 1857 },
      minLookups: 464, minAgentAdoptionRate: 0.12, minNativeCallShare: 0.14, maxRefusalRate: 0.088,
    });
  });

  it('derives each bound from the baseline by the recorded rule', () => {
    const t = NATIVE_ADOPTION_TARGET!;
    expect(t.minAgentAdoptionRate).toBeCloseTo(2 * t.baseline.agentAdoptionRate, 2);
    expect(t.minNativeCallShare).toBeCloseTo(2 * t.baseline.nativeCallShare, 2);
    // D-011 recorded the halved refusal rate (0.0885) rounded to 0.088 — same 2-decimal precision as the others.
    expect(t.maxRefusalRate).toBeCloseTo(t.baseline.refusalRate / 2, 2);
    expect(t.minLookups).toBe(Math.floor(t.baseline.lookups / 4));
  });

  it('is the default target used by rateNativeAdoption', () => {
    const metrics = summarizeNativeAdoption({ window: WINDOW, invocations: INVOCATIONS, shellCommands: SHELL });
    expect(rateNativeAdoption(metrics).goodUse).toMatchObject({ verdict: 'unknown', unknownReason: 'insufficient-sample' });
  });
});

describe('instrument registration', () => {
  it('maps each key to its criterion and back', () => {
    expect(nativeAdoptionCriterionForInstrument(NATIVE_ADOPTION_INSTRUMENT_KEYS.measured)).toBe('measured');
    expect(nativeAdoptionCriterionForInstrument(NATIVE_ADOPTION_INSTRUMENT_KEYS.goodUse)).toBe('goodUse');
    expect(nativeAdoptionCriterionForInstrument('code-intel:unknown')).toBeNull();
  });

  it('registers both keys as platform instruments resolved by scorecards', () => {
    for (const key of Object.values(NATIVE_ADOPTION_INSTRUMENT_KEYS)) {
      expect(platformComputedInstrumentKeys()).toContain(key);
      expect(getRegisteredInstrument(key)).toMatchObject({ evaluator: 'platform', resolvedBy: 'scorecards:instrument-snapshots' });
    }
  });
});
