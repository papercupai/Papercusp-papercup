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
  summarizeNativePushOutcomes,
  nativePushFollowThrough,
  NATIVE_PUSH_INSTRUMENT_KEYS, nativePushCriterionForInstrument, rateNativePushOutcomes,
  type NativePushOutcomeRow,
  type NativeAdoptionInvocation,
  type NativeAdoptionShellCommand,
  type NativeAdoptionTarget,
} from './native-adoption';
import { getRegisteredInstrument, platformComputedInstrumentKeys } from '../rubric-instrument-registry';

const WINDOW = { workspaceId: 'ws-test', windowStart: '2026-10-01T00:00:00.000Z', windowEnd: '2026-10-04T00:00:00.000Z' };
const at = '2026-10-02T12:00:00.000Z';

describe('P-041 recorded follow-through', () => {
  const input = { leg: 'grep', subject: 'Foo', citedPaths: ['src/foo.ts'], suggestedCall: null,
    activities: [{ tool: 'Read', status: 'ok', detail: { file: 'src/foo.ts' } }], executedTests: [] };

  it('counts an exact cited path, with independent same-symbol grep evidence', () => {
    expect(nativePushFollowThrough(input)).toEqual({ actedOn: true, grepAfterPush: false });
    expect(nativePushFollowThrough({ ...input, activities: [
      ...input.activities, { tool: 'Bash', status: 'ok', detail: { command: 'rg -n "Foo" src' } },
    ] })).toEqual({ actedOn: true, grepAfterPush: true });
  });

  it('does not turn no telemetry, errors or unknown absolute paths into negatives', () => {
    expect(nativePushFollowThrough({ ...input, activities: [] })).toEqual({ actedOn: null, grepAfterPush: null });
    expect(nativePushFollowThrough({ ...input, activities: [{ tool: 'Read', status: 'error', detail: { file: 'src/foo.ts' } }] }).actedOn).toBeNull();
    expect(nativePushFollowThrough({ ...input, activities: [{ tool: 'Read', status: 'ok', detail: { file: '/another/src/foo.ts' } }] }).actedOn).toBeNull();
    expect(nativePushFollowThrough({ ...input, activities: [{ tool: 'Read', status: 'ok', detail: { file: 'src/other.ts' } }] }).actedOn).toBe(false);
  });

  it('places absolute native paths only under the exact registered root of the activity harness', () => {
    const repoRoots = new Map([['papercusp', '/repo/papercusp']]);
    const read = (file: string, harness: string | null = 'papercusp') =>
      nativePushFollowThrough({ ...input, repoRoots, activities: [{ tool: 'Read', status: 'ok', detail: { file }, harness }] }).actedOn;
    expect(read('/repo/papercusp/src/foo.ts')).toBe(true);
    expect(read('/repo/papercusp/src/other.ts')).toBe(false);
    // Sibling checkout sharing a name prefix, a suffix-only match, and a harness with no root stay unknown.
    expect(read('/repo/papercusp-release/src/foo.ts')).toBeNull();
    expect(read('/elsewhere/src/foo.ts')).toBeNull();
    expect(read('/repo/papercusp/src/foo.ts', 'other-harness')).toBeNull();
    expect(read('/repo/papercusp/src/foo.ts', null)).toBeNull();
    expect(read('/repo/papercusp/../papercusp/src/foo.ts')).toBeNull();
    // Without a root map the historical behaviour holds: absolute stays unknown.
    expect(nativePushFollowThrough({ ...input, activities: [{ tool: 'Read', status: 'ok', detail: { file: '/repo/papercusp/src/foo.ts' }, harness: 'papercusp' }] }).actedOn).toBeNull();
  });

  it('reads both papercusp-su MCP spellings and the capability:read file_path key', () => {
    const repoRoots = new Map([['papercusp', '/repo/papercusp']]);
    for (const tool of ['mcp__papercusp_su__capability_read', 'mcp__papercusp-su__capability_read']) {
      expect(nativePushFollowThrough({ ...input, repoRoots, activities: [{ tool, status: 'ok', detail: { file_path: 'src/foo.ts' }, harness: 'papercusp' }] }).actedOn).toBe(true);
      expect(nativePushFollowThrough({ ...input, repoRoots, activities: [{ tool, status: 'ok', detail: { file_path: '/repo/papercusp/src/other.ts' }, harness: 'papercusp' }] }).actedOn).toBe(false);
    }
    expect(nativePushFollowThrough({ ...input, activities: [{ tool: 'mcp__papercusp_su__capability_bash', status: 'ok', detail: { command: 'rg -n "Foo" src' } }] }).grepAfterPush).toBe(true);
  });

  it('treats a spilled tool-output page as neither a hit nor a gap', () => {
    const repoRoots = new Map([['papercusp', '/repo/papercusp']]);
    const scratch = { tool: 'mcp__papercusp_su__capability_read', status: 'ok', detail: { uri: 'papercusp://scratch/ws/x.spill' }, harness: 'papercusp' };
    expect(nativePushFollowThrough({ ...input, repoRoots, activities: [scratch, { tool: 'Read', status: 'ok', detail: { file: '/repo/papercusp/src/other.ts' }, harness: 'papercusp' }] }).actedOn).toBe(false);
    expect(nativePushFollowThrough({ ...input, repoRoots, activities: [{ ...scratch, detail: { uri: 'file:///repo/papercusp/src/other.ts' } }] }).actedOn).toBeNull();
  });

  it('never guesses symbol identity from non-grep leg subjects', () => {
    expect(nativePushFollowThrough({ ...input, leg: 'interface' }).grepAfterPush).toBeNull();
  });

  it('requires exact literal search patterns and preserves uncertainty for truncated/complex input', () => {
    for (const command of ['rg -n other "Foo"', 'rg -e "Foo|Bar" src', `rg other ${'x'.repeat(500)}`]) {
      expect(nativePushFollowThrough({ ...input, activities: [{ tool: 'Bash', status: 'ok', detail: { command } }] }).grepAfterPush).toBeNull();
    }
    expect(nativePushFollowThrough({ ...input, activities: [{ tool: 'Grep', status: 'ok', detail: { pattern: 'Foo' } }] }).grepAfterPush).toBe(true);
    expect(nativePushFollowThrough({ ...input, activities: [{ tool: 'Bash', status: 'ok', detail: { command: 'rg Other src' } }] }).grepAfterPush).toBe(false);
  });

  it('counts suggested tests only with completed execution evidence', () => {
    const suggested = { ...input, activities: [], suggestedCall: 'testing:run {"files":["src/foo.test.ts"]}' };
    expect(nativePushFollowThrough(suggested).actedOn).toBeNull();
    expect(nativePushFollowThrough({ ...suggested, executedTests: ['src/other.test.ts'] }).actedOn).toBeNull();
    expect(nativePushFollowThrough({ ...suggested, executedTests: ['src/foo.test.ts'] }).actedOn).toBe(true);
    expect(nativePushFollowThrough({ ...suggested, suggestedCall: 'testing:run invalid' }).actedOn).toBeNull();
  });

  it('scores a suggested-test push as not acted on only when the window rules the test out', () => {
    const other = { tool: 'Read', status: 'ok', detail: { file: 'src/other.ts' } };
    const suggested = { ...input, leg: 'first-touch', activities: [other],
      suggestedCall: 'testing:run {"files":["src/foo.test.ts"]}', testRequests: 0 };
    // Fully observed window: no shell, no test request, no cited read -> a real negative.
    expect(nativePushFollowThrough(suggested).actedOn).toBe(false);
    // Not measured, any test request (linked or not), or any shell command -> unknown.
    expect(nativePushFollowThrough({ ...suggested, testRequests: undefined }).actedOn).toBeNull();
    expect(nativePushFollowThrough({ ...suggested, testRequests: 1 }).actedOn).toBeNull();
    for (const tool of ['Bash', 'mcp__papercusp_su__capability_bash', 'exec_command']) {
      expect(nativePushFollowThrough({ ...suggested,
        activities: [other, { tool, status: 'ok', detail: { command: 'npm run test:file -- src/foo.test.ts' } }] }).actedOn).toBeNull();
    }
    // An unparseable suggestion cannot be ruled out; a cited read or executed test still wins.
    expect(nativePushFollowThrough({ ...suggested, suggestedCall: 'testing:run invalid' }).actedOn).toBeNull();
    expect(nativePushFollowThrough({ ...suggested, activities: [{ tool: 'Read', status: 'ok', detail: { file: 'src/foo.ts' } }] }).actedOn).toBe(true);
    expect(nativePushFollowThrough({ ...suggested, testRequests: 1, executedTests: ['src/foo.test.ts'] }).actedOn).toBe(true);
    // No telemetry stays unknown even when no test was requested.
    expect(nativePushFollowThrough({ ...suggested, activities: [] }).actedOn).toBeNull();
  });
});

describe('P-041 push-outcome summary', () => {
  const row = (id: string, over: Partial<NativePushOutcomeRow> = {}): NativePushOutcomeRow => ({
    id, workspaceId: WINDOW.workspaceId, leg: 'grep', pushedAt: at,
    windowComplete: true, actedOn: false, grepAfterPush: false, ...over,
  });

  it('keeps each leg and each measured denominator separate', () => {
    const result = summarizeNativePushOutcomes({ window: WINDOW, rows: [
      row('1', { actedOn: true, grepAfterPush: null }), row('2', { grepAfterPush: true }),
      row('3', { leg: 'interface', actedOn: null, grepAfterPush: null }),
    ] });
    expect(result.byLeg.grep).toEqual({ issued: 2, closedWindows: 2,
      actedOn: { measured: 2, positive: 1, rate: 0.5 },
      grepAfterPush: { measured: 1, positive: 1, rate: 1 } });
    expect(result.byLeg.interface?.actedOn).toEqual({ measured: 0, positive: 0, rate: null });
    expect(result.byLeg.interface?.grepAfterPush.rate).toBeNull();
  });

  it('does not turn an open window into a positive or a negative', () => {
    const result = summarizeNativePushOutcomes({ window: WINDOW, rows: [
      row('1', { windowComplete: false, actedOn: true, grepAfterPush: false }),
    ] });
    expect(result.byLeg.grep).toEqual({ issued: 1, closedWindows: 0,
      actedOn: { measured: 0, positive: 0, rate: null },
      grepAfterPush: { measured: 0, positive: 0, rate: null } });
  });

  it('excludes foreign, invalid and out-of-window rows, and counts a ledger id once', () => {
    const one = row('1');
    const result = summarizeNativePushOutcomes({ window: WINDOW, rows: [one, { ...one },
      row('2', { workspaceId: 'other' }), row('3', { pushedAt: WINDOW.windowEnd }),
      row('4', { pushedAt: '2026-09-30T00:00:00Z' }), row('5', { pushedAt: 'invalid' }),
    ] });
    expect(result.byLeg.grep?.issued).toBe(1);
    expect(result.byLeg.grep?.actedOn.rate).toBe(0);
    expect(summarizeNativePushOutcomes({ window: WINDOW, rows: [] }).byLeg).toEqual({});
  });

  it('refuses invalid windows and conflicting evidence rather than choosing a verdict', () => {
    expect(() => summarizeNativePushOutcomes({ window: { ...WINDOW, windowEnd: WINDOW.windowStart }, rows: [] })).toThrow();
    expect(() => summarizeNativePushOutcomes({ window: WINDOW, rows: [row('1'), row('1', { actedOn: true })] })).toThrow(/Conflicting/);
    expect(() => summarizeNativePushOutcomes({ window: WINDOW, rows: [row('')] })).toThrow(/ledger id/);
  });

  it('registers all three new measurement criteria with recurring rescore support', () => {
    for (const [criterion, key] of Object.entries(NATIVE_PUSH_INSTRUMENT_KEYS)) {
      expect(nativePushCriterionForInstrument(key)).toBe(criterion);
      expect(platformComputedInstrumentKeys()).toContain(key);
      expect(getRegisteredInstrument(key)).toMatchObject({ evaluator: 'platform', rescore: { windowMs: 72 * 60 * 60_000 } });
    }
    expect(nativePushCriterionForInstrument(NATIVE_ADOPTION_INSTRUMENT_KEYS.goodUse)).toBeNull();
  });

  it('grades measurement availability without inventing a usefulness threshold or zero for missing legs', () => {
    const measured = summarizeNativePushOutcomes({ window: WINDOW, rows: [row('1')] });
    for (const criterion of ['issued', 'actedOn', 'grepAfterPush'] as const) {
      expect(rateNativePushOutcomes(measured, criterion).verdict).toBe('pass');
      expect(rateNativePushOutcomes(summarizeNativePushOutcomes({ window: WINDOW, rows: [] }), criterion).verdict).toBe('unknown');
    }
    const partial = summarizeNativePushOutcomes({ window: WINDOW, rows: [row('1'), row('2', { leg: 'interface', actedOn: null })] });
    expect(rateNativePushOutcomes(partial, 'actedOn').verdict).toBe('unknown');
    expect(rateNativePushOutcomes(partial, 'grepAfterPush').verdict).toBe('pass');
    expect(rateNativePushOutcomes(summarizeNativePushOutcomes({ window: WINDOW, rows: [row('1', { leg: 'interface' })] }), 'grepAfterPush').verdict).toBe('unknown');
  });
});

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
