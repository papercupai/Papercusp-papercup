import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PUSH_LEG_FLAGS, type PushLegId } from './push-channel';
import { LIVENESS_WINDOW_MS } from './liveness';
import {
  LIVENESS_OPS, cannotObserveConditionKey, isDeclarationLookupPattern, isEligibleGrepRow, livenessConditionKey,
  runPushLegLivenessProbe, searchPatternOf,
  type LivenessAlarmEvent, type LivenessOp, type LivenessProbeDeps, type MeasureWindow, type SignalCounts,
} from './push-leg-liveness';

const WS = 'ws-test';
const NOW = Date.parse('2026-10-27T12:00:00Z');
const LEGS = Object.keys(PUSH_LEG_FLAGS) as PushLegId[];
const live: SignalCounts = { eligible: 100, outputs: 40, outsideLineageOutputs: 30 };
const quietOp: SignalCounts = { eligible: 0, outputs: 0, outsideLineageOutputs: 0 };

interface Fixture {
  legs?: Partial<Record<PushLegId, SignalCounts>>;
  ops?: Partial<Record<LivenessOp, SignalCounts>>;
  off?: PushLegId[];
  flagOnAt?: Partial<Record<PushLegId, number | null>>;
}
function harness(f: Fixture = {}) {
  const raised: LivenessAlarmEvent[] = [];
  const resolved: string[] = [];
  const windows = new Map<string, MeasureWindow>();
  const flagLeg = (flag: string) => LEGS.find(l => PUSH_LEG_FLAGS[l] === flag && !(l === 'clone' && flag === PUSH_LEG_FLAGS['first-touch']))!;
  const deps: LivenessProbeDeps = {
    enabled: async flag => !(f.off ?? []).some(l => PUSH_LEG_FLAGS[l] === flag),
    flagOnAt: async flag => { const leg = flagLeg(flag); return leg in (f.flagOnAt ?? {}) ? f.flagOnAt![leg]! : NOW - LIVENESS_WINDOW_MS; },
    measureLeg: async (leg, w) => { windows.set(leg, w); return f.legs?.[leg] ?? live; },
    measureOp: async (op, w) => { windows.set(op, w); return f.ops?.[op] ?? { eligible: 20, outputs: 18, outsideLineageOutputs: 10 }; },
    raise: async e => { raised.push(e); return true; },
    resolve: async k => { resolved.push(k); return true; },
    record: async () => {},
    runningBuildSha: 'abc123',
    now: () => NOW,
  };
  return { deps, raised, resolved, windows, keys: () => raised.map(e => e.conditionKey) };
}

describe('push-leg liveness check (P-003, R-1)', () => {
  it('SPEC-P-003: an ON push leg with zero pushes over 7 days raises an alarm stating its eligible-trigger count', async () => {
    const h = harness({ legs: { resume: { eligible: 412, outputs: 0, outsideLineageOutputs: 0 } } });
    const r = await runPushLegLivenessProbe(WS, h.deps);
    const alarm = h.raised.find(e => e.conditionKey === livenessConditionKey(WS, 'resume'));
    expect(alarm).toBeDefined();
    expect(alarm!.body).toContain('eligible triggers 412');
    expect(alarm!.body).toContain('outputs 0');
    expect(r.verdict).toBe('fail');
  });

  it('SPEC-P-003-B: an ON push leg with at least one push in the window raises no liveness alarm', async () => {
    const h = harness({ legs: { grep: { eligible: 10, outputs: 1, outsideLineageOutputs: 1 } } });
    await runPushLegLivenessProbe(WS, h.deps);
    expect(h.keys()).not.toContain(livenessConditionKey(WS, 'grep'));
  });

  it('SPEC-P-003-C: a code-intel op with calls and zero measured results over 7 days raises a liveness alarm', async () => {
    const h = harness({ ops: { 'lsp:query': { eligible: 78, outputs: 0, outsideLineageOutputs: 0 } } });
    await runPushLegLivenessProbe(WS, h.deps);
    const alarm = h.raised.find(e => e.conditionKey === livenessConditionKey(WS, 'lsp:query'));
    expect(alarm?.body).toContain('eligible triggers 78');
  });

  it('SPEC-P-003-D: a code-intel op with no calls in the 7-day window raises no liveness alarm', async () => {
    const h = harness({ ops: { 'code:pack': quietOp } });
    await runPushLegLivenessProbe(WS, h.deps);
    expect(h.keys()).not.toContain(livenessConditionKey(WS, 'code:pack'));
  });

  it('alarms a live-but-starved leg below the 0.05 delivery ratio', async () => {
    const h = harness({ legs: { 'first-touch': { eligible: 1000, outputs: 40, outsideLineageOutputs: 40 } } });
    await runPushLegLivenessProbe(WS, h.deps);
    expect(h.raised.find(e => e.conditionKey === livenessConditionKey(WS, 'first-touch'))?.body).toContain('delivery ratio 0.040');
  });

  it('treats a leg with zero eligible triggers as insufficient data, never an alarm', async () => {
    const h = harness({ legs: { completion: { eligible: 0, outputs: 0, outsideLineageOutputs: 0 } } });
    const r = await runPushLegLivenessProbe(WS, h.deps);
    expect(h.keys()).not.toContain(livenessConditionKey(WS, 'completion'));
    expect(r.observation.verdicts.find(v => v.signal === 'completion')?.status).toBe('insufficient-data');
  });

  it('never alarms an OFF leg, and an OFF switch disposes its open alarm', async () => {
    const h = harness({ off: ['notes'], legs: { notes: { eligible: 50, outputs: 0, outsideLineageOutputs: 0 } } });
    await runPushLegLivenessProbe(WS, h.deps);
    expect(h.keys()).not.toContain(livenessConditionKey(WS, 'notes'));
    expect(h.resolved).toContain(livenessConditionKey(WS, 'notes'));
  });

  it('an unmeasurable eligible count fails the check through one aggregated condition, never passing', async () => {
    const h = harness({ legs: { incident: { eligible: null, outputs: 3, outsideLineageOutputs: 3 } } });
    const r = await runPushLegLivenessProbe(WS, h.deps);
    expect(r.observation.verdicts.find(v => v.signal === 'incident')?.status).toBe('cannot-observe');
    const blind = h.raised.find(e => e.conditionKey === cannotObserveConditionKey(WS));
    expect(blind?.summary).toContain('incident');
    expect(r.verdict).toBe('fail');
  });

  it('passes only when first-touch, resume and interface are live and nothing alarms', async () => {
    const r = await runPushLegLivenessProbe(WS, harness().deps);
    expect(r.verdict).toBe('pass');
    expect(r.observation.raised).toEqual([]);
  });

  it('a single healthy run never disposes an alarm', async () => {
    const h = harness();
    await runPushLegLivenessProbe(WS, h.deps);
    expect(h.resolved).toEqual([]);
  });

  it('measures every PUSH_LEG_FLAGS leg and every code-intel op exactly once', async () => {
    const h = harness();
    const r = await runPushLegLivenessProbe(WS, h.deps);
    expect(r.observation.verdicts.map(v => v.signal).sort()).toEqual([...LEGS, ...LIVENESS_OPS].sort());
  });

  it('counts eligible triggers only after the flag went ON inside the window', async () => {
    const onAt = NOW - 2 * 86_400_000;
    const h = harness({ flagOnAt: { intent: onAt } });
    await runPushLegLivenessProbe(WS, h.deps);
    expect(h.windows.get('intent')?.start).toBe(onAt);
    expect(h.windows.get('grep')?.start).toBe(NOW - LIVENESS_WINDOW_MS);
  });

  it('an unmeasured flag-on time is cannot-observe, not a full-window guess', async () => {
    const h = harness({ flagOnAt: { resume: null } });
    const r = await runPushLegLivenessProbe(WS, h.deps);
    expect(r.observation.verdicts.find(v => v.signal === 'resume')?.status).toBe('cannot-observe');
    expect(h.windows.has('resume')).toBe(false);
  });
});

describe('grep leg eligibility (D-013 pinned rule)', () => {
  it.each([
    'export function buildBrief', 'function\\s+buildBrief', '^class PushChannel', 'interface\\s+SignalVerdict\\b',
    'type LegId', 'const CODE_INTEL', 'enum Status', 'evaluateLiveness\\(', 'runPushLegLivenessProbe (',
  ])('a declaration or identifier-call lookup is eligible: %s', p => expect(isDeclarationLookupPattern(p)).toBe(true));

  it.each([
    'TODO', 'push-channel', 'function', 'fn\\(', 'if (', 'const x', 'import .* from', 'foo.bar', '\\.ts$',
  ])('anything else is not: %s', p => expect(isDeclarationLookupPattern(p)).toBe(false));

  it('reads the pattern out of grep, rg and git grep command lines', () => {
    expect(searchPatternOf(`grep -rn "export function buildBrief" packages/`)).toBe('export function buildBrief');
    expect(searchPatternOf(`cd x && rg -n -g '*.ts' 'evaluateLiveness\\(' lib`)).toBe('evaluateLiveness\\(');
    expect(searchPatternOf(`git -C libs grep -e "class Foo" -- src`)).toBe('class Foo');
    expect(searchPatternOf(`ls -la | head`)).toBeNull();
    expect(isEligibleGrepRow({ command: `grep -rn "TODO" .` })).toBe(false);
    expect(isEligibleGrepRow({ pattern: 'interface SignalCounts' })).toBe(true);
  });
});

describe('interface leg independent detector (D-013 import boundary)', () => {
  it('interface-eligibility.ts imports nothing from the push path or the peer-edit impact derivation', () => {
    const src = readFileSync(fileURLToPath(new URL('./interface-eligibility.ts', import.meta.url)), 'utf8');
    const specifiers = [...src.matchAll(/(?:import|export)[^'"]*?from\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g)].map(m => m[1] ?? m[2]);
    expect(specifiers.length).toBeGreaterThan(0);
    expect(specifiers.filter(s => /push-channel|peer-edit-impact/.test(s))).toEqual([]);
  });
});
