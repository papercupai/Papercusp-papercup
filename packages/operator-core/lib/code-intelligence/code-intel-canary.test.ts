/**
 * code-intel-delivery-and-outcomes-2026-10-26 P-004 (R-9): the live canary's case table and
 * judge. The real-dispatch half runs live through the registered instrument; here its pure
 * logic is pinned against injected dispatch and row reads.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  CANARY_FORCED,
  CANARY_INVALID_OP,
  CANARY_UNFORCED,
  CANARY_VALID_ARGS,
  CODE_INTEL_CANARY_OWNER,
  canaryCases,
  canaryDispatchContext,
  judgeCanary,
  runCodeIntelCanary,
  type CanaryCaseSpec,
  type CanaryDeps,
  type CanaryRow,
} from './code-intel-canary';
import { dispatchProjectedTool, type ProjectedTool } from '@papercusp/tooldef';
import { CODE_INTEL_UNKNOWN_REASONS } from './code-intel-result-status';
import { NATIVE_CODE_INTEL_TOOLS } from './native-adoption';

/** The row the real recorder would write for a case that behaved as forced. */
function rowFor(spec: CanaryCaseSpec, callId: string): CanaryRow {
  const status = spec.forced === 'return'
    ? { status: 'measured', invocationId: callId }
    : { status: 'unknown', reason: spec.forced, invocationId: callId };
  return { toolName: spec.toolName, ownerId: CODE_INTEL_CANARY_OWNER, status };
}

describe('canaryCases', () => {
  it('covers every native tool with every forced class, including timeout and scope-refused', () => {
    const cases = canaryCases();
    expect(new Set(cases.map(c => c.toolName))).toEqual(new Set(NATIVE_CODE_INTEL_TOOLS));
    for (const toolName of NATIVE_CODE_INTEL_TOOLS) {
      expect(cases.filter(c => c.toolName === toolName).map(c => c.forced).sort()).toEqual([...CANARY_FORCED].sort());
    }
    expect(CANARY_FORCED).toContain('timeout');
    expect(CANARY_FORCED).toContain('scope-refused');
  });

  it('forces each class through its own lever', () => {
    for (const c of canaryCases()) {
      if (c.forced === 'timeout') expect(c.timeoutSec).toBeLessThan(0.01);
      else expect(c.timeoutSec).toBeUndefined();
      if (c.forced === 'cancelled') expect(c.abortAfterMs).toBeGreaterThan(0);
      else expect(c.abortAfterMs).toBeUndefined();
      if (c.forced === 'scope-refused') expect(c.args.op).toBe(CANARY_INVALID_OP);
      else expect(c.args).toEqual(CANARY_VALID_ARGS[c.toolName]);
    }
  });

  it('refuses a native tool that has no valid args', () => {
    expect(() => canaryCases(['graph:query', 'new:tool'])).toThrow(/new:tool/);
  });

  it('lists every reason it does not force, and only reasons in the set', () => {
    const forcedReasons = CANARY_FORCED.filter(f => f !== 'return');
    const listed = CANARY_UNFORCED.map(u => u.reason);
    expect([...forcedReasons, ...listed].sort()).toEqual([...CODE_INTEL_UNKNOWN_REASONS].sort());
    expect(listed).not.toContain('timeout');
    expect(listed).not.toContain('scope-refused');
  });
});

describe('judgeCanary', () => {
  const cases = canaryCases();
  const dispatched = cases.map((spec, i) => ({ spec, callId: `call-${i}` }));

  it('passes when every case recorded exactly one row of its forced class', () => {
    const j = judgeCanary(dispatched, dispatched.map(d => rowFor(d.spec, d.callId)));
    expect(j.ok).toBe(true);
    expect(j.failed).toBe(0);
    expect(j.cases).toHaveLength(cases.length);
  });

  it('fails a forced timeout recorded as measured', () => {
    const rows = dispatched.map(d => d.spec.forced === 'timeout' && d.spec.toolName === 'lsp:query'
      ? { toolName: d.spec.toolName, ownerId: CODE_INTEL_CANARY_OWNER, status: { status: 'measured', invocationId: d.callId } }
      : rowFor(d.spec, d.callId));
    const j = judgeCanary(dispatched, rows);
    expect(j.ok).toBe(false);
    expect(j.failed).toBe(1);
    expect(j.cases.find(c => !c.ok)).toMatchObject({ toolName: 'lsp:query', forced: 'timeout', why: 'expected unknown/timeout, recorded measured' });
  });

  it('fails a case with zero rows, two rows, or a reason outside the set', () => {
    const [a, b, c] = dispatched.filter(d => d.spec.forced === 'scope-refused');
    const rows = dispatched.flatMap(d => {
      if (d === a) return [];
      if (d === b) return [rowFor(d.spec, d.callId), rowFor(d.spec, d.callId)];
      if (d === c) return [{ toolName: d.spec.toolName, ownerId: CODE_INTEL_CANARY_OWNER, status: { status: 'unknown', reason: 'other', invocationId: d.callId } }];
      return [rowFor(d.spec, d.callId)];
    });
    const j = judgeCanary(dispatched, rows);
    expect(j.failed).toBe(3);
    expect(j.cases.filter(x => !x.ok).map(x => x.statusRows).sort()).toEqual([0, 1, 2]);
  });

  it('ignores rows from other owners and fails a case whose dispatch never started', () => {
    const rows = dispatched.map(d => ({ ...rowFor(d.spec, d.callId), ...(d.callId === 'call-0' ? { ownerId: 'su-someone' } : {}) }));
    const j = judgeCanary([...dispatched.slice(1), { spec: cases[0]!, callId: null }], rows);
    expect(j.failed).toBe(1);
    expect(j.cases.at(-1)).toMatchObject({ callId: null, ok: false, why: 'dispatch never started (no call id)' });
  });

  it('an empty case list is not a pass', () => {
    expect(judgeCanary([], []).ok).toBe(false);
  });

  it('names the error of a dispatch that threw, before or after it started', () => {
    const [first, second] = dispatched;
    const rows = dispatched.slice(1).map(d => rowFor(d.spec, d.callId));
    const j = judgeCanary(
      [{ ...first!, callId: null, error: 'TypeError: boom' }, { ...second!, error: 'TypeError: late' }, ...dispatched.slice(2)],
      rows,
    );
    expect(j.cases[0]).toMatchObject({ ok: false, why: 'dispatch threw before start: TypeError: boom' });
    // A row recorded for a call that threw after start is still judged on its row.
    expect(j.cases[1]).toMatchObject({ callId: 'call-1', statusRows: 1 });
  });

  it('fails a plain-return case recorded as unknown/exception, naming the dispatch error', () => {
    const ret = dispatched.find(d => d.spec.forced === 'return')!;
    const rows = dispatched.map(d => d === ret
      ? { toolName: d.spec.toolName, ownerId: CODE_INTEL_CANARY_OWNER, status: { status: 'unknown', reason: 'exception', invocationId: d.callId } }
      : rowFor(d.spec, d.callId));
    const j = judgeCanary(dispatched.map(d => d === ret ? { ...d, error: 'TypeError: x' } : d), rows);
    expect(j.ok).toBe(false);
    expect(j.failed).toBe(1);
    expect(j.cases.find(c => !c.ok)).toMatchObject({
      toolName: ret.spec.toolName, forced: 'return', why: 'expected measured, recorded unknown/exception; dispatch threw: TypeError: x',
    });
  });
});

describe('runCodeIntelCanary', () => {
  it('dispatches every case in order, flushes before reading, and judges the rows', async () => {
    const order: string[] = [];
    let n = 0;
    const sent: CanaryCaseSpec[] = [];
    const deps: CanaryDeps = {
      dispatch: vi.fn(async (spec: CanaryCaseSpec) => { order.push('dispatch'); sent.push(spec); return { callId: `c${n++}` }; }),
      flush: vi.fn(async () => { order.push('flush'); }),
      readRows: vi.fn(async (since: string) => { order.push(`read:${since}`); return sent.map((s, i) => rowFor(s, `c${i}`)); }),
      now: () => Date.parse('2026-10-27T06:00:00Z'),
    };
    const j = await runCodeIntelCanary(deps);
    expect(j.ok).toBe(true);
    expect(sent).toHaveLength(canaryCases().length);
    expect(order.slice(-2)).toEqual(['flush', 'read:2026-10-27T05:59:59.000Z']);
  });

  it('a throwing dispatch fails only its own case', async () => {
    let n = 0;
    const sent: Array<{ spec: CanaryCaseSpec; id: string | null }> = [];
    const deps: CanaryDeps = {
      dispatch: async spec => {
        if (spec.toolName === 'code:pack' && spec.forced === 'return') { sent.push({ spec, id: null }); throw new Error('boom'); }
        const id = `c${n++}`; sent.push({ spec, id }); return { callId: id };
      },
      flush: async () => {},
      readRows: async () => sent.filter(s => s.id).map(s => rowFor(s.spec, s.id!)),
    };
    const j = await runCodeIntelCanary(deps);
    expect(j.failed).toBe(1);
    expect(j.cases.find(c => !c.ok)).toMatchObject({ toolName: 'code:pack', forced: 'return', callId: null });
    expect(j.cases.find(c => !c.ok)?.why).toBe('dispatch threw before start: Error: boom');
  });

  it('keeps the call id and error a dispatch reports after start', async () => {
    let n = 0;
    const sent: Array<{ spec: CanaryCaseSpec; id: string }> = [];
    const deps: CanaryDeps = {
      dispatch: async spec => {
        const id = `c${n++}`; sent.push({ spec, id });
        return spec.toolName === 'graph:query' && spec.forced === 'return' ? { callId: id, error: 'TypeError: late' } : { callId: id };
      },
      flush: async () => {},
      readRows: async () => sent.map(s => s.spec.toolName === 'graph:query' && s.spec.forced === 'return'
        ? { toolName: s.spec.toolName, ownerId: CODE_INTEL_CANARY_OWNER, status: { status: 'unknown', reason: 'exception', invocationId: s.id } }
        : rowFor(s.spec, s.id)),
    };
    const j = await runCodeIntelCanary(deps);
    expect(j.failed).toBe(1);
    const bad = j.cases.find(c => !c.ok)!;
    expect(bad.callId).not.toBeNull();
    expect(bad.why).toBe('expected measured, recorded unknown/exception; dispatch threw: TypeError: late');
  });
});

describe('canaryDispatchContext', () => {
  // A tool that declares a capability, so the dispatch stack's capability check actually runs.
  const tool = (fn: ProjectedTool['fn']): ProjectedTool => ({
    pluginName: 'fixture',
    description: 'fixture',
    inputSchema: { type: 'object' },
    capabilities: ['code:read'],
    expose: { mcp: { name: 'graph:query' } },
    fn,
  });
  const ctxFor = (capabilities: readonly string[]) => canaryDispatchContext({
    workspaceId: 'w', harnessSlug: 'papercusp', capabilities, signal: new AbortController().signal,
  });

  // 2026-10-27: the canary's inline context had no principal.capabilities set, the real capability
  // check threw a TypeError, and every live probe run reported 12/12 canary cases "never started".
  it('passes the real dispatch stack capability check and runs the handler', async () => {
    const fn = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'ok' }] }));
    const t = tool(fn);
    const r = await dispatchProjectedTool(t, 'graph:query', {}, ctxFor(t.capabilities), { readQuotaState: undefined, recordInvocation: undefined });
    expect(r.error).toBeUndefined();
    expect(r.ok).toBe(true);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('grants exactly the capabilities it is given, nothing wider', async () => {
    const fn = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'ok' }] }));
    const r = await dispatchProjectedTool(tool(fn), 'graph:query', {}, ctxFor([]), { readQuotaState: undefined, recordInvocation: undefined });
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('missing_capability');
    expect(fn).not.toHaveBeenCalled();
    const principal = ctxFor(['code:read']).principal!;
    expect([...principal.capabilities]).toEqual(['code:read']);
    expect(principal.slug).toBe(CODE_INTEL_CANARY_OWNER);
  });
});
