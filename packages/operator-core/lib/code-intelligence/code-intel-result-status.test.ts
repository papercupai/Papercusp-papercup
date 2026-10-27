import { describe, expect, it } from 'vitest';
import {
  CODE_INTEL_UNKNOWN_REASONS,
  UNKNOWN_RATE_MIN_CALLS,
  classifyCodeIntelExit,
  classifyCodeIntelPayload,
  decideUnknownRateAlarm,
  isNativeCodeIntelTool,
  payloadOf,
  type CodeIntelExit,
  type CodeIntelUnknownReason,
} from './code-intel-result-status.ts';
import { NATIVE_CODE_INTEL_TOOLS } from './native-adoption.ts';

const textResult = (data: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(data) }] });
const answer = (over: Record<string, unknown> = {}) => ({
  backend: 'typescript',
  intent: 'callers',
  query: 'f',
  sites: [],
  truncation: { truncated: false, totalAvailable: 0, continuation: null },
  freshness: { health: 'healthy', indexedAt: null, staleVsDisk: false },
  ...over,
});

/** One exit per reason class, driven through the same classifier the recorder calls. */
function exitFor(toolName: string, reason: CodeIntelUnknownReason): CodeIntelExit {
  const base = { toolName, invocationId: `${toolName}:${reason}` };
  switch (reason) {
    case 'timeout':
      return { ...base, status: 'timeout', errorCode: 'timeout', errorMessage: 'tool timed out after 60s' };
    case 'cancelled':
      return { ...base, status: 'error', errorCode: 'aborted', errorMessage: 'caller aborted' };
    case 'exception':
      return { ...base, status: 'error', errorCode: 'internal', errorMessage: 'TypeError: x is undefined' };
    case 'scope-refused':
      return { ...base, status: 'invalid-input', errorCode: 'invalid_input', errorMessage: 'paths outside the authorized scope' };
    case 'index-missing':
      return { ...base, status: 'ok', resultSnapshot: textResult({ status: 'unknown', error: 'No index for this repository.' }) };
    case 'stale':
      return { ...base, status: 'ok', resultSnapshot: textResult(answer({ freshness: { health: 'healthy', indexedAt: null, staleVsDisk: true } })) };
    case 'partial':
      return { ...base, status: 'ok', resultSnapshot: textResult(answer({ truncation: { truncated: true, totalAvailable: 900, continuation: 'c' } })) };
  }
}

describe('code-intel result status (P-004, R-2)', () => {
  it('knows exactly the native code-intel tool list', () => {
    for (const tool of NATIVE_CODE_INTEL_TOOLS) expect(isNativeCodeIntelTool(tool)).toBe(true);
    expect(isNativeCodeIntelTool('coord:orient')).toBe(false);
  });

  for (const tool of NATIVE_CODE_INTEL_TOOLS) {
    describe(tool, () => {
      it('records a well-formed answer as measured, including an empty one', () => {
        expect(classifyCodeIntelExit({ toolName: tool, invocationId: 'a', status: 'ok', resultSnapshot: textResult(answer()) }))
          .toEqual({ status: 'measured', invocationId: 'a' });
      });

      for (const reason of CODE_INTEL_UNKNOWN_REASONS) {
        it(`records a ${reason} exit as unknown with reason ${reason}`, () => {
          const exit = exitFor(tool, reason);
          const status = classifyCodeIntelExit(exit);
          expect(status.status).toBe('unknown');
          expect(status.status === 'unknown' && status.reason).toBe(reason);
          expect(status.invocationId).toBe(exit.invocationId);
        });
      }

      it('never records a missing or malformed payload as measured', () => {
        for (const snapshot of [undefined, null, {}, { content: [] }, { content: [{ type: 'text', text: 'not json' }] }, textResult(42)]) {
          const status = classifyCodeIntelExit({ toolName: tool, invocationId: 'm', status: 'ok', resultSnapshot: snapshot });
          expect(status).toMatchObject({ status: 'unknown', reason: 'partial' });
        }
      });
    });
  }

  it('reads code:pack answers inside their artifact wrapper', () => {
    const wrapped = { answer: answer({ freshness: { health: 'healthy', indexedAt: null, staleVsDisk: true } }), artifact: { lines: 3 } };
    expect(classifyCodeIntelPayload(wrapped)).toMatchObject({ status: 'unknown', reason: 'stale' });
    expect(classifyCodeIntelPayload({ answer: answer(), artifact: {} })).toMatchObject({ status: 'measured' });
  });

  it('prefers structuredContent over the text block', () => {
    expect(payloadOf({ structuredContent: { a: 1 }, content: [{ type: 'text', text: '{"a":2}' }] })).toEqual({ a: 1 });
  });

  it('never emits a reason outside the fixed set', () => {
    const allowed = new Set<string>(CODE_INTEL_UNKNOWN_REASONS);
    const exits: CodeIntelExit[] = [
      { toolName: 'graph:query', status: 'quota-exceeded' },
      { toolName: 'graph:query', status: 'role-not-allowed' },
      { toolName: 'graph:query', status: 'refused', resultSnapshot: textResult({ status: 'unknown', error: 'something odd' }) },
      { toolName: 'graph:query', status: 'ok', resultSnapshot: textResult({ status: 'weird' }) },
      { toolName: 'graph:query', status: 'ok', resultSnapshot: textResult(answer({ discovery: { outcome: 'incomplete' } })) },
      { toolName: 'graph:query', status: 'ok', resultSnapshot: textResult(answer({ freshness: { health: 'unhealthy', indexedAt: null, staleVsDisk: null } })) },
    ];
    for (const exit of exits) {
      const status = classifyCodeIntelExit(exit);
      expect(status.status).toBe('unknown');
      if (status.status === 'unknown') expect(allowed.has(status.reason)).toBe(true);
    }
  });

  it('a refusal whose payload names a missing index keeps the sharper reason', () => {
    const status = classifyCodeIntelExit({
      toolName: 'graph:query',
      status: 'refused',
      resultSnapshot: textResult({ status: 'unknown', error: 'The repository is not indexed.' }),
    });
    expect(status).toMatchObject({ status: 'unknown', reason: 'index-missing' });
  });
});

describe('unknown-rate alarm decision (P-004, R-9)', () => {
  it('alarms above 20% of at least 50 calls (SPEC-P-004-B)', () => {
    expect(decideUnknownRateAlarm({ total: 50, unknown: 11 })).toMatchObject({ alarm: true, reason: 'above-threshold' });
    expect(decideUnknownRateAlarm({ total: 1000, unknown: 201 })).toMatchObject({ alarm: true });
  });

  it('does not alarm at exactly 20% or below 50 calls (SPEC-P-004-C)', () => {
    expect(decideUnknownRateAlarm({ total: 50, unknown: 10 })).toMatchObject({ alarm: false, reason: 'within-threshold' });
    expect(decideUnknownRateAlarm({ total: 1000, unknown: 200 })).toMatchObject({ alarm: false });
    expect(decideUnknownRateAlarm({ total: UNKNOWN_RATE_MIN_CALLS - 1, unknown: UNKNOWN_RATE_MIN_CALLS - 1 }))
      .toMatchObject({ alarm: false, reason: 'insufficient-calls' });
  });

  it('reports a missing or inconsistent denominator as malformed, never as clean', () => {
    for (const w of [{ total: undefined, unknown: 3 }, { total: 50, unknown: null }, { total: 10, unknown: 11 }, { total: -1, unknown: 0 }, { total: 50.5, unknown: 1 }]) {
      expect(decideUnknownRateAlarm(w)).toMatchObject({ alarm: false, reason: 'malformed-window' });
    }
  });
});
