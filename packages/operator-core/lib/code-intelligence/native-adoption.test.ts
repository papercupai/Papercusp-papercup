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
  CANNOT_OBSERVE_LEGS, LEG_OUTCOME_TABLE, LEG_OUTCOME_MIN_SAMPLE, LEG_OUTCOMES_INSTRUMENT_KEY, PUSH_LEG_DESIGN_TABLE_SHA256,
  computeLegOutcomes, rateLegOutcomes, legOutcomeScheduleVerdict, legOutcomeScheduleIntervalMs, legOutcomeCheckFingerprint,
  extractPushLegDesignTable, parsePushLegDesignTable, pushLegDesignDivergence, pushLegDesignTableHash,
  type LegAction, type LegOutcome, type LegTrigger,
} from './native-adoption';
import { getRegisteredInstrument, platformComputedInstrumentKeys } from '../rubric-instrument-registry';
import { PUSH_LEG_FLAGS, type PushLegId } from './push-channel';
import { FLAGS } from '@papercusp/flags';
import { readFileSync } from 'node:fs';

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

// ── P-013 (code-intel-delivery-and-outcomes-2026-10-26 R-7 / R-10): per-leg outcome chains ──

const H = 3_600_000;
const D = 24 * H;
const LEGS = Object.keys(PUSH_LEG_FLAGS) as PushLegId[];
const SCORED = { windowStart: '2026-10-10T00:00:00.000Z', windowEnd: '2026-10-17T00:00:00.000Z' };
const EXPOSED_AT = Date.parse('2026-10-11T00:00:00.000Z');
const BASELINE_AT = Date.parse('2026-10-05T00:00:00.000Z');
const isoMs = (ms: number) => new Date(ms).toISOString();
// One path per trigger, so a trigger's window never sees a neighbouring trigger's actions.
const trig = (leg: string, i: number, exposed: boolean, owner = 'agent-a'): LegTrigger => ({
  id: `${leg}-${exposed ? 'x' : 'b'}-${i}`, leg, ownerId: owner, exposed, paths: [`src/${leg}-${exposed ? 'x' : 'b'}${i}.ts`],
  at: isoMs((exposed ? EXPOSED_AT : BASELINE_AT) + i * H),
});
const act = (kind: LegAction['kind'], _leg: string, from: LegTrigger, afterMs: number, owner: string | null = 'agent-a', path = from.paths[0]!): LegAction =>
  ({ kind, ownerId: owner, path, at: isoMs(Date.parse(from.at) + afterMs) });

/** Golden fixture: 20 exposed (+20 baseline for 'avoided' legs) per leg, with known chains and negatives. */
function goldenFixture(): { triggers: LegTrigger[]; actions: LegAction[] } {
  const triggers: LegTrigger[] = [];
  const actions: LegAction[] = [];
  for (const leg of LEGS) {
    const spec = LEG_OUTCOME_TABLE[leg];
    const exposed = Array.from({ length: 20 }, (_, i) => trig(leg, i, true));
    triggers.push(...exposed);
    if (spec.resultKey === 'time to first correct edit') {
      exposed.slice(0, 5).forEach(t => actions.push(act('correct-edit', leg, t, 2 * H)));
      // +36 h: outside the 1-day window, inside a 2-day one (the D-014 boundary).
      exposed.slice(5, 15).forEach(t => actions.push(act('correct-edit', leg, t, 36 * H)));
      actions.push(act('correct-edit', leg, exposed[15]!, H, 'agent-b')); // another agent: not attributed
      actions.push(act('correct-edit', leg, exposed[16]!, H, 'agent-a', 'src/elsewhere.ts')); // another path: not attributed
      actions.push(act('touch', leg, exposed[17]!, H / 2)); // follow-through without a correct edit
    } else if (spec.resultKey === 'interface follow-through rate') {
      exposed.slice(0, 12).forEach(t => actions.push(act('touch', leg, t, H)));
      exposed.slice(12, 15).forEach(t => actions.push(act('touch', leg, t, H, 'agent-b')));
      exposed.slice(15, 17).forEach(t => actions.push(act('touch', leg, t, 36 * H)));
    } else if (spec.resultKey !== 'cannot-observe') {
      const kind = spec.resultKey === 'clones avoided' ? 'clone' as const : 'gate-red' as const;
      const baseline = Array.from({ length: 20 }, (_, i) => trig(leg, i, false));
      triggers.push(...baseline);
      baseline.slice(0, 10).forEach(t => actions.push(act(kind, leg, t, 2 * H, kind === 'clone' ? 'agent-a' : 'gate')));
      exposed.slice(0, 4).forEach(t => actions.push(act(kind, leg, t, 2 * H, kind === 'clone' ? 'agent-a' : 'gate')));
      exposed.slice(4, 8).forEach(t => actions.push(act(kind, leg, t, 36 * H, kind === 'clone' ? 'agent-a' : 'gate')));
      exposed.slice(8, 10).forEach(t => actions.push(act(kind, leg, t, 2 * H, kind === 'clone' ? 'agent-b' : 'gate', 'src/elsewhere.ts')));
    }
  }
  return { triggers, actions };
}
const byLeg = (outcomes: LegOutcome[]) => new Map(outcomes.map(o => [o.leg, o]));
const wider = Object.fromEntries(LEGS.map(leg => [leg, LEG_OUTCOME_TABLE[leg].attributionWindowDays + 1])) as Record<PushLegId, number>;

describe('P-013 leg outcome table covers the push-leg registry (R-7)', () => {
  it('maps exactly the PUSH_LEG_FLAGS keys, each to a named key, a control and a stated window/denominator/minimum', () => {
    expect(Object.keys(LEG_OUTCOME_TABLE).sort()).toEqual([...LEGS].sort());
    for (const leg of LEGS) {
      const spec = LEG_OUTCOME_TABLE[leg];
      expect(['time to first correct edit', 'gate reds avoided', 'clones avoided', 'interface follow-through rate', 'cannot-observe']).toContain(spec.resultKey);
      expect(spec.minSample, leg).toBe(LEG_OUTCOME_MIN_SAMPLE);
      expect(spec.attributionWindowDays, leg).toBeGreaterThan(0);
      expect(spec.denominator.length, leg).toBeGreaterThan(20);
      // D-014: an 'avoided' key always names its control population.
      if (spec.resultKey.endsWith('avoided')) expect(spec.control, leg).toBe('pre-exposure baseline');
      expect(spec.resultKey === 'cannot-observe', leg).toBe(CANNOT_OBSERVE_LEGS.includes(leg));
    }
    expect([...CANNOT_OBSERVE_LEGS]).toEqual(['notes']);
  });

  it('each Design flag cell names the FLAGS member the leg is gated by', () => {
    for (const leg of LEGS) {
      const name = LEG_OUTCOME_TABLE[leg].flag.replace(/ \(shared\)$/, '') as keyof typeof FLAGS;
      expect(FLAGS[name], leg).toBe(PUSH_LEG_FLAGS[leg]);
    }
  });
});

describe('P-013 Design push-leg table pin (R-7 doc-claims)', () => {
  const copy = readFileSync(new URL('./push-leg-design-table.md', import.meta.url), 'utf8');
  const table = extractPushLegDesignTable(copy)!;

  it('the tree copy hashes to the pinned hash and agrees with the code map row for row', () => {
    expect(table).not.toBeNull();
    expect(pushLegDesignTableHash(table)).toBe(PUSH_LEG_DESIGN_TABLE_SHA256);
    const rows = parsePushLegDesignTable(table);
    expect(rows.map(r => r.leg).sort()).toEqual([...LEGS].sort());
    expect(pushLegDesignDivergence(rows)).toEqual([]);
  });

  it('fails on a renamed result key, a missing row, an extra row, a wrong control or a wrong flag', () => {
    const rows = parsePushLegDesignTable(table);
    const edit = (leg: string, patch: Partial<(typeof rows)[number]>) => rows.map(r => (r.leg === leg ? { ...r, ...patch } : r));
    expect(pushLegDesignDivergence(edit('interface', { resultKey: 'cross-agent breakages avoided' })).join(' ')).toMatch(/interface: Design result key/);
    expect(pushLegDesignDivergence(rows.filter(r => r.leg !== 'clone')).join(' ')).toMatch(/clone is missing/);
    expect(pushLegDesignDivergence([...rows, { ...rows[0]!, leg: 'reuse-provenance' }]).join(' ')).toMatch(/reuse-provenance is not a push leg/);
    expect(pushLegDesignDivergence(edit('incident', { control: 'none: not an avoided key' })).join(' ')).toMatch(/incident: Design control/);
    expect(pushLegDesignDivergence(edit('grep', { flag: 'CODE_INTEL_PUSH_RESUME' })).join(' ')).toMatch(/grep: Design flag/);
    expect(pushLegDesignDivergence(edit('notes', { resultKey: 'cannot-observe: some other reason' })).join(' ')).toMatch(/notes: Design result key/);
    // A table edit changes the hash the live instrument compares with the pin.
    expect(pushLegDesignTableHash(table.replace('interface follow-through rate', 'cross-agent breakages avoided'))).not.toBe(PUSH_LEG_DESIGN_TABLE_SHA256);
  });

  it('extracts only the push-leg table, stopping at the first non-table line', () => {
    const md = `## Design\n\n### Other\n| a |\n\n### Push-leg table (x)\n\nprose\n\n${table}\n\nreuse-<provider> rows...\n| stray |\n`;
    expect(extractPushLegDesignTable(md)).toBe(table);
    expect(extractPushLegDesignTable('## Design\nno table here')).toBeNull();
  });
});

describe('P-013 outcome computation over the golden fixture (R-7 truth table)', () => {
  const { triggers, actions } = goldenFixture();
  const outcomes = computeLegOutcomes({ ...SCORED, triggers, actions });
  const legs = byLeg(outcomes);

  it('emits one outcome per PUSH_LEG_FLAGS leg with exactly its Design-table result key', () => {
    expect(outcomes.map(o => o.leg).sort()).toEqual([...LEGS].sort());
    for (const leg of LEGS) {
      expect(legs.get(leg)!.resultKey, leg).toBe(LEG_OUTCOME_TABLE[leg].resultKey);
      expect(legs.get(leg)!.result.key, leg).toBe(LEG_OUTCOME_TABLE[leg].resultKey);
      expect(legs.get(leg)!.exposure, leg).toBe(20);
    }
  });

  it('time to first correct edit: median over the recipient\'s own correct edits on a cited path inside 1 d', () => {
    for (const leg of ['grep', 'first-touch', 'intent', 'resume'] as const) {
      const o = legs.get(leg)!;
      // 5 at +2 h attributed; 10 at +36 h, another agent's edit and another path's edit are not.
      expect(o.result, leg).toMatchObject({ status: 'measured', value: 2 * H, unit: 'ms', sample: 20 });
      expect(o.followThrough, leg).toEqual({ measured: 20, positive: 6, rate: 6 / 20 });
    }
  });

  it('interface follow-through rate: only the recipient, only inside the window', () => {
    const o = legs.get('interface')!;
    expect(o.control).toBe('none');
    expect(o.result).toMatchObject({ status: 'measured', value: 12 / 20, unit: 'share', sample: 20 });
  });

  it('gate reds / clones avoided: pre-exposure baseline share minus exposed share', () => {
    for (const leg of ['incident', 'completion', 'antipattern', 'clone'] as const) {
      const o = legs.get(leg)!;
      expect(o.control, leg).toBe('pre-exposure baseline');
      expect(o.result, leg).toMatchObject({ status: 'measured', unit: 'share-difference', sample: 20 });
      expect((o.result as { value: number }).value, leg).toBeCloseTo(0.5 - 0.2, 10);
      expect((o.result as { detail: string }).detail, leg).toContain('2026-10-04T00:00:00.000Z');
    }
  });

  it('notes is cannot-observe with the Design-table reason, and still reports exposure', () => {
    const o = legs.get('notes')!;
    expect(o.result).toEqual({ status: 'cannot-observe', key: 'cannot-observe', reason: LEG_OUTCOME_TABLE.notes.cannotObserveReason });
    expect(o.exposure).toBe(20);
  });

  it('D-014 boundary: widening each attribution window by one day changes the fixture result', () => {
    const widened = byLeg(computeLegOutcomes({ ...SCORED, triggers, actions, attributionWindowDays: wider }));
    for (const leg of LEGS.filter(l => !CANNOT_OBSERVE_LEGS.includes(l))) {
      expect(widened.get(leg)!.result, leg).not.toEqual(legs.get(leg)!.result);
      expect(widened.get(leg)!.attributionWindowDays, leg).toBe(2);
    }
    expect(widened.get('grep')!.result).toMatchObject({ value: 36 * H });
    expect(widened.get('interface')!.result).toMatchObject({ value: 14 / 20 });
    expect((widened.get('incident')!.result as { value: number }).value).toBeCloseTo(0.5 - 0.4, 10);
  });

  it('rejects an invalid window', () => {
    expect(() => computeLegOutcomes({ windowStart: SCORED.windowEnd, windowEnd: SCORED.windowStart, triggers, actions })).toThrow(/valid/);
  });
});

describe('P-013 insufficient-data and unmeasured (SPEC-P-013-B)', () => {
  const { triggers, actions } = goldenFixture();
  const observable = LEGS.filter(l => !CANNOT_OBSERVE_LEGS.includes(l));

  it('zero exposure reports insufficient-data, never zero benefit or a number', () => {
    const outcomes = byLeg(computeLegOutcomes({ ...SCORED, triggers: triggers.filter(t => !t.exposed), actions }));
    for (const leg of observable) {
      expect(outcomes.get(leg)!.result, leg).toMatchObject({ status: 'insufficient-data', reason: 'zero exposure in the scored window' });
      expect(outcomes.get(leg)!.result).not.toHaveProperty('value');
    }
  });

  it('19 exposed triggers (one below the minimum) report insufficient-data; 20 measure', () => {
    const drop = new Set(LEGS.map(leg => `${leg}-x-19`));
    const outcomes = byLeg(computeLegOutcomes({ ...SCORED, triggers: triggers.filter(t => !drop.has(t.id)), actions }));
    for (const leg of observable) expect(outcomes.get(leg)!.result.status, leg).toBe('insufficient-data');
  });

  it('fewer than 20 eligible triggers from the independent source report insufficient-data', () => {
    const eligibleTriggers = Object.fromEntries(LEGS.map(leg => [leg, 19]));
    const outcomes = byLeg(computeLegOutcomes({ ...SCORED, triggers, actions, eligibleTriggers }));
    for (const leg of observable) expect(outcomes.get(leg)!.result, leg).toMatchObject({ status: 'insufficient-data', reason: expect.stringMatching(/^19 eligible/) });
  });

  it('a baseline below the minimum leaves an avoided key insufficient-data', () => {
    const outcomes = byLeg(computeLegOutcomes({ ...SCORED, triggers: triggers.filter(t => t.id !== 'incident-b-0'), actions }));
    expect(outcomes.get('incident')!.result).toMatchObject({ status: 'insufficient-data', reason: expect.stringMatching(/^19 baseline/) });
  });

  it('a reader limit reports unmeasured with its reason, never a number', () => {
    const outcomes = byLeg(computeLegOutcomes({ ...SCORED, triggers, actions, unmeasured: { grep: 'no correct-edit ledger' } }));
    expect(outcomes.get('grep')!.result).toEqual({ status: 'unmeasured', key: 'time to first correct edit', reason: 'no correct-edit ledger' });
  });
});

describe('P-013 rating (R-10 more-than-half rule)', () => {
  const { triggers, actions } = goldenFixture();
  const measured = computeLegOutcomes({ ...SCORED, triggers, actions });

  it('passes when every observable leg is measured; cannot-observe is excluded from both sides', () => {
    expect(rateLegOutcomes(measured)).toMatchObject({ verdict: 'pass', insufficient: [], unmeasured: [] });
  });

  it('is unknown when more than half of the observable legs are insufficient-data, pass at exactly half', () => {
    const starve = (legs: readonly string[]) => computeLegOutcomes({ ...SCORED, actions,
      triggers: triggers.filter(t => !(legs.includes(t.leg) && t.exposed)) });
    // 9 observable legs (notes excluded): 4 insufficient is not more than half, 5 is.
    expect(rateLegOutcomes(starve(['grep', 'first-touch', 'intent', 'resume'])).verdict).toBe('pass');
    expect(rateLegOutcomes(starve(['grep', 'first-touch', 'intent', 'resume', 'interface']))).toMatchObject({ verdict: 'unknown' });
  });

  it('is unknown when any leg is unmeasured or a leg has no outcome', () => {
    expect(rateLegOutcomes(computeLegOutcomes({ ...SCORED, triggers, actions, unmeasured: { clone: 'x' } })).verdict).toBe('unknown');
    expect(rateLegOutcomes(measured.filter(o => o.leg !== 'grep'))).toMatchObject({ verdict: 'unknown', reason: expect.stringContaining('no outcome computed: grep') });
  });
});

describe('P-013 re-score schedule and score freshness (SPEC-P-013-C / -D)', () => {
  const daily = { kind: 'cron', cron: '40 6 * * *', tzid: 'UTC', action: { system: 'rubric-rescore' } };
  const now = Date.parse('2026-10-27T12:00:00.000Z');

  it('a leg outcome check with no schedule, or a set-but-unarmed one, is not armed (SPEC-P-013-C)', () => {
    expect(legOutcomeScheduleVerdict({ schedule: null, active: null, latestScoreAt: isoMs(now - H), now })).toMatchObject({ status: 'no-schedule', armed: false });
    expect(legOutcomeScheduleVerdict({ schedule: daily, active: false, latestScoreAt: isoMs(now - H), now })).toMatchObject({ status: 'unarmed', armed: false });
    expect(legOutcomeScheduleVerdict({ schedule: daily, active: true, latestScoreAt: isoMs(now - H), now })).toMatchObject({ status: 'fresh', armed: true, intervalMs: D });
  });

  it('an interval over 24 h or an unreadable one does not count', () => {
    expect(legOutcomeScheduleVerdict({ schedule: { kind: 'interval', intervalSec: 2 * 86_400 }, active: true, latestScoreAt: null, now }).status).toBe('interval-too-long');
    expect(legOutcomeScheduleVerdict({ schedule: { kind: 'cron', cron: '0 6 * * 1' }, active: true, latestScoreAt: null, now }).status).toBe('interval-unknown');
    expect(legOutcomeScheduleIntervalMs({ kind: 'cron', cron: '15 * * * *' })).toBe(H);
    expect(legOutcomeScheduleIntervalMs({ intervalSec: 3600 })).toBe(H);
  });

  it('a check with no score, or a latest score older than one interval, is not fresh (SPEC-P-013-D)', () => {
    expect(legOutcomeScheduleVerdict({ schedule: daily, active: true, latestScoreAt: null, now }).status).toBe('no-score');
    expect(legOutcomeScheduleVerdict({ schedule: daily, active: true, latestScoreAt: isoMs(now - 25 * H), now }).status).toBe('stale');
    expect(legOutcomeScheduleVerdict({ schedule: daily, active: true, latestScoreAt: isoMs(now - 23 * H), now }).status).toBe('fresh');
  });
});

describe('P-013 check fingerprint (R-10)', () => {
  const blob = 'a'.repeat(40);
  const table = 'b'.repeat(64);

  it('carries both the module blob and the Design-table hash, and is unknown without either', () => {
    expect(legOutcomeCheckFingerprint(blob, table)).toBe(`native-adoption.ts@${blob}+design@${table}`);
    expect(legOutcomeCheckFingerprint(null, table)).toBeNull();
    expect(legOutcomeCheckFingerprint(blob, null)).toBeNull();
    expect(legOutcomeCheckFingerprint('HEAD', table)).toBeNull();
  });

  it('is not a constant: changing either input changes it', () => {
    const base = legOutcomeCheckFingerprint(blob, table);
    expect(legOutcomeCheckFingerprint('c'.repeat(40), table)).not.toBe(base);
    expect(legOutcomeCheckFingerprint(blob, 'd'.repeat(64))).not.toBe(base);
  });

  it('is a registered platform instrument with a scheduled rescore', () => {
    expect(platformComputedInstrumentKeys()).toContain(LEG_OUTCOMES_INSTRUMENT_KEY);
    expect(getRegisteredInstrument(LEG_OUTCOMES_INSTRUMENT_KEY)).toMatchObject({ evaluator: 'platform' });
  });
});
